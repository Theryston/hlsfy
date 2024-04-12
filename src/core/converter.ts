import { MAX_RETRY, TEMP_DIR } from "../constants.js"
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import ffmpeg from 'fluent-ffmpeg';
import { spawn } from 'child_process';
import getShakaPath from "./shaka-packager.js";
import { promise as fastq } from "fastq";
import decompress from "decompress";

const ALL_SUBTITLE_EXT = ['.srt', '.sub', '.sbv', '.ass', '.ssa', '.vtt', '.txt', '.smi', '.webvtt']
const CUDA_OPTIONS = ['-vsync', '0', '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']

const downloadQueue = fastq(downloadWorker, 1);
const uploadQueue = fastq(uploadWorker, 50);


type Quality = {
    height: number
    bitrate: number
}

type S3 = {
    bucket: string
    region: string
    accessKeyId: string
    secretAccessKey: string
    path: string
    endpoint?: string
}

type Subtitle = {
    url: string
    language: string
}

export type ConverterParams = {
    source: string
    defaultAudioLang: string
    subtitles: Subtitle[]
    qualities: Quality[]
    s3: S3
    processId?: number
    onStart?: () => void
}

export async function converter({ source, qualities, s3, onStart, defaultAudioLang, subtitles: originalSubtitles }: ConverterParams) {
    const baseFolder = fs.mkdtempSync(path.join(TEMP_DIR, '_'));
    const start = Date.now();

    try {
        if (onStart) {
            onStart();
        }

        const sourceRawPath = path.join(baseFolder, 'source');
        await downloadFile(source, sourceRawPath);
        const sourceType = await getFileType(sourceRawPath);
        const sourcePath = `${sourceRawPath}.${sourceType.ext}`;
        fs.renameSync(sourceRawPath, sourcePath);
        const subtitleFolder = fs.mkdtempSync(path.join(baseFolder, '_'));

        const sourceInfos = await getVideoInfos(sourcePath);
        const videoTracks = sourceInfos.streams.filter(stream => stream.codec_type === 'video');
        const audioTracks = sourceInfos.streams.filter(stream => stream.codec_type === 'audio');

        if (!videoTracks.length) {
            throw new Error('no video tracks found');
        }

        const videoTrack = videoTracks.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        const filteredQualities = qualities.filter(quality => quality.height <= (videoTrack.height || 0));

        if (!filteredQualities.length) {
            throw new Error('no quality found');
        }

        const audios: { path: string, lang: string }[] = [];
        const audioPromises = [];
        for (const audioTrack of audioTracks) {
            audioPromises.push((async () => {
                const audioPath = await extractAudioTrack({ sourcePath, audioTrack, baseFolder });
                audios.push({
                    path: audioPath,
                    lang: audioTrack.tags?.language || 'und',
                });
            })());
        }

        const subtitles: { path: string, language: string }[] = [];
        const subtitlePromises = [];
        for (const subtitle of originalSubtitles) {
            subtitlePromises.push((async () => {
                const ext = path.extname(subtitle.url).split('?')[0] || '.vtt';
                let subtitlePath = path.join(subtitleFolder, `${subtitle.language}${ext}`);
                await downloadFile(subtitle.url, subtitlePath);

                if (!['.vtt', '.webvtt'].includes(ext)) {
                    subtitlePath = await convertToVtt(subtitlePath, baseFolder);
                }

                console.log(`[CONVERTER] subtitle ${subtitlePath} was processed!`);
                subtitles.push({
                    path: subtitlePath,
                    language: subtitle.language,
                });
            })());
        }

        const videos: { path: string, height: number, bitrate: number }[] = [];
        const videoPromises = [];
        for (const quality of filteredQualities) {
            videoPromises.push((async () => {
                const videoPath = await convertVideo({ sourcePath, videoTrack, baseFolder, quality });
                videos.push({
                    path: videoPath,
                    height: quality.height,
                    bitrate: quality.bitrate,
                });
            })());
        }

        const allPromises = [...audioPromises, ...subtitlePromises, ...videoPromises];
        await Promise.all(allPromises);

        const hlsFolder = fs.mkdtempSync(path.join(baseFolder, '_'));
        await hlsFy({ videos, audios, hlsFolder, defaultAudioLang, subtitles });
        console.log('[CONVERTER] HLS files created');

        await uploadFolder(hlsFolder, s3);

        console.log('[CONVERTER] Done');
    } finally {
        const end = Date.now();
        const duration = end - start;
        console.log(`[CONVERTER] the process for ${source} took ${formatTime(duration)}`);
        fs.rmSync(baseFolder, { recursive: true, force: true });
    }
}

function formatTime(ms: number) {
    let hours = Math.floor(ms / 3600000);
    let minutes = Math.floor((ms % 3600000) / 60000);
    let seconds = Math.floor(((ms % 3600000) % 60000) / 1000);

    let hoursStr = hours < 10 ? "0" + hours : hours;
    let minutesStr = minutes < 10 ? "0" + minutes : minutes;
    let secondsStr = seconds < 10 ? "0" + seconds : seconds;

    return `${hoursStr}:${minutesStr}:${secondsStr}`
}

async function convertToVtt(subtitlePath: string, baseFolder: string) {
    const originalExt = path.extname(subtitlePath).split('?')[0] || '.vtt';

    const isCompressedFolder = ['.zip', '.gz', '.tgz', '.tar', '.tar.gz', '.tar.bz2', '.tar.xz'].includes(originalExt);

    if (isCompressedFolder) {
        const unCompressedFolder = fs.mkdtempSync(path.join(baseFolder, '_'));
        const files = await extractArchive(subtitlePath, unCompressedFolder);
        const subtitleFile = files.find(file => ALL_SUBTITLE_EXT.includes(path.extname(file.path).split('?')[0] || '.vtt'));

        if (!subtitleFile) {
            throw new Error('no subtitle file found');
        }

        subtitlePath = path.join(unCompressedFolder, subtitleFile.path);
    }

    const subtitleTempFolder = fs.mkdtempSync(path.join(baseFolder, '_'));
    const vttFilePath = `${subtitleTempFolder}/subtitle.vtt`;

    return new Promise<string>((resolve, reject) => {
        ffmpeg(subtitlePath)
            .addInputOptions(process.env.CUDA ? CUDA_OPTIONS : [])
            .outputOptions(['-f', 'webvtt'])
            .output(vttFilePath)
            .on('end', () => {
                resolve(vttFilePath);
            })
            .on('error', (error) => {
                reject(error);
            })
            .run();
    });
}

async function extractArchive(sourcePath: string, tempFolder: string) {
    const archive = await decompress(sourcePath, tempFolder);
    return archive;
}

async function hlsFy({ videos, audios, hlsFolder, defaultAudioLang, subtitles }: { videos: { path: string, height: number, bitrate: number }[], audios: { path: string, lang: string }[], hlsFolder: string, defaultAudioLang: string, subtitles: { path: string, language: string }[] }) {
    const hlsAudioPaths = audios.map((audio, i) => {
        let folder = path.join(hlsFolder, audio.lang);

        if (fs.existsSync(folder)) {
            folder = path.join(hlsFolder, `${i}-${audio.lang}`);
        } else {
            fs.mkdirSync(folder, { recursive: true });
        }

        return {
            m3u8: path.join(folder, 'audio.m3u8'),
            folder,
            in: audio.path
        }
    });
    const hlsVideoPaths = videos.map((video, i) => {
        let folder = path.join(hlsFolder, video.height.toString());

        if (fs.existsSync(folder)) {
            folder = path.join(hlsFolder, `${i}-${video.height}`);
        } else {
            fs.mkdirSync(folder, { recursive: true });
        }

        return {
            m3u8: path.join(folder, 'video.m3u8'),
            folder,
            in: video.path
        }
    });
    const hlsSubtitlesPaths = subtitles.map((subtitle, i) => {
        let folder = path.join(hlsFolder, 'subtitles');

        if (fs.existsSync(folder)) {
            folder = path.join(hlsFolder, `subtitles-${i}`);
        } else {
            fs.mkdirSync(folder, { recursive: true });
        }

        return {
            m3u8: path.join(folder, 'subtitles.m3u8'),
            folder,
            in: subtitle.path,
            language: subtitle.language
        }
    })

    const packager = getShakaPath();

    const defaultAudioLocale = new Intl.Locale(defaultAudioLang);
    const defaultAudio = audios.find(audio => {
        if (audio.lang === 'und') {
            return false;
        }

        const audioLocale = new Intl.Locale(audio.lang);
        return defaultAudioLocale.language === audioLocale.language;
    });

    const defaultLang = defaultAudio?.lang;
    const audiosStr = hlsAudioPaths.map(audio => `in=${audio.in},stream=audio,segment_template=${audio.folder}/$Number$.ts,playlist_name=${audio.m3u8},hls_group_id=audio`);
    const subtitlesStr = hlsSubtitlesPaths.map(subtitle => `in=${subtitle.in},stream=text,segment_template=${subtitle.folder}/$Number$.webvtt,playlist_name=${subtitle.m3u8},hls_group_id=text,hls_name=${(new Intl.Locale(subtitle.language)).language}`);
    const videosStr = hlsVideoPaths.map(video => `in=${video.in},stream=video,segment_template=${video.folder}/$Number$.ts,playlist_name=${video.m3u8},hls_group_id=video`);

    const args = [
        ...audiosStr,
        ...videosStr,
        ...subtitlesStr,
        ...(defaultLang ? ['--default_language', defaultLang] : ''),
        '--hls_master_playlist_output',
        path.join(hlsFolder, 'playlist.m3u8')
    ]

    console.log('[CONVERTER] Creating HLS file with args:', args.join(' '));

    await new Promise<void>((resolve, reject) => {
        spawn(packager, args, { stdio: 'inherit' })
            .on('exit', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject();
                }
            })
    })
}

async function convertVideo({ sourcePath, videoTrack, baseFolder, quality, attempts }: { sourcePath: string, videoTrack: ffmpeg.FfprobeStream, baseFolder: string, quality: Quality, attempts?: number }) {
    if (!attempts) {
        attempts = 0;
    }

    if (!videoTrack) {
        throw new Error('no video track found');
    }

    if (videoTrack.codec_type !== 'video') {
        throw new Error('not a video track');
    }

    const videoFolderPath = fs.mkdtempSync(path.join(baseFolder, '_'));
    const videoPath = path.join(videoFolderPath, 'video.mp4');
    const videoTrackId = videoTrack.index;
    let width = await getResponsiveWidth(quality.height, sourcePath);
    width = width % 2 === 1 ? width + 1 : width;
    const height = quality.height % 2 === 1 ? quality.height + 1 : quality.height;
    const videoScale = `${width}:${height}`
    console.log(`[CONVERTER|${height}] ${sourcePath} - ${width}x${height} converted...`);

    return new Promise<string>((resolve, reject) => {
        ffmpeg(sourcePath)
            .addInputOptions(process.env.CUDA ? CUDA_OPTIONS : [])
            .outputOptions([
                `-map 0:${videoTrackId}`,
                '-c:v', process.env.CUBA ? 'h264_nvenc' : 'libx264',
                `-b:v ${quality.bitrate}k`,
                '-vf', process.env.CUBA ? `scale_npp=${videoScale}` : `scale=${videoScale}`,
            ])
            .on('progress', (progress) => {
                console.log(`[CONVERTER|${height}] ${sourcePath} - ${progress.percent || 0}% converted...`);
            })
            .on('end', () => {
                resolve(videoPath);
            })
            .on('error', async (err) => {
                if (attempts < MAX_RETRY) {
                    console.log('[CONVERTER] retrying...');
                    resolve(await convertVideo({ sourcePath, videoTrack, baseFolder, quality, attempts: attempts + 1 }));
                } else {
                    reject(err);
                }
            })
            .save(videoPath);
    })
}

async function getResponsiveWidth(height: number, sourcePath: string) {
    const sourceInfos = await getVideoInfos(sourcePath);
    const videoTrack = sourceInfos.streams.filter(stream => stream.codec_type === 'video').sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    if (!videoTrack || !videoTrack.height || !videoTrack.width) {
        throw new Error('no video track found');
    }

    const aspectRatio = videoTrack.height / videoTrack.width;
    const responsiveWidth = Math.round(height / aspectRatio);

    return responsiveWidth;
}


async function extractAudioTrack({ sourcePath, audioTrack, baseFolder, attempts }: { sourcePath: string, audioTrack: ffmpeg.FfprobeStream, baseFolder: string, attempts?: number }) {
    if (!attempts) {
        attempts = 0;
    }

    if (!audioTrack) {
        throw new Error('no audio track found');
    }

    if (audioTrack.codec_type !== 'audio') {
        throw new Error('not an audio track');
    }

    const audioFolderPath = fs.mkdtempSync(path.join(baseFolder, '_'));
    const audioPath = path.join(audioFolderPath, 'audio.mp4');
    const audioTrackId = audioTrack.index;

    return new Promise<string>((resolve, reject) => {
        ffmpeg(sourcePath)
            .addInputOptions(process.env.CUDA ? CUDA_OPTIONS : [])
            .outputOptions([`-map 0:${audioTrackId}`])
            .audioChannels(1)
            .audioCodec('aac')
            .audioBitrate(audioTrack.avg_bit_rate || '128k')
            .output(audioPath)
            .on('progress', (progress) => {
                console.log(`[CONVERTER|${audioTrack.tags.language || 'und'}] ${sourcePath} - ${progress.percent || 0}% audio extracted...`);
            })
            .on('end', () => {
                resolve(audioPath);
            })
            .on('error', async (err) => {
                if (attempts < MAX_RETRY) {
                    console.log('[CONVERTER] retrying...');
                    resolve(await extractAudioTrack({ sourcePath, audioTrack, baseFolder, attempts: attempts + 1 }));
                } else {
                    reject(err);
                }
            })
            .run();
    })
}

async function getVideoInfos(videoPath: string) {
    return new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, data) => {
            if (err) {
                reject(err);
            }
            resolve(data);
        });
    })
}

async function getFileType(filePath: string) {
    const fileType = await import('file-type');
    const result = await fileType.fileTypeFromFile(filePath);

    if (!result) {
        throw new Error('file type not found');
    }

    return result;
}

async function uploadWorker({ s3, subPath, file, filePath, client, attempts }: { s3: S3, subPath?: string, file: string, filePath: string, client: S3Client, attempts?: number }) {
    if (!attempts) {
        attempts = 0;
    }

    try {
        const key = path.join(s3.path, subPath || '', file);
        console.log(`[CONVERTER] uploading ${key}...`);
        const command = new PutObjectCommand({
            Bucket: s3.bucket,
            Key: key,
            Body: fs.readFileSync(filePath),
        })
        await client.send(command);
        console.log(`[CONVERTER] ${key} was uploaded!`);
    } catch (error) {
        if (attempts < MAX_RETRY) {
            console.log('[CONVERTER] retrying...');
            await uploadWorker({ s3, subPath, file, filePath, client, attempts: attempts + 1 });
        } else {
            throw error;
        }
    }
}

async function uploadFolder(folderPath: string, s3: S3, subPath?: string) {
    try {
        const client = new S3Client({
            region: s3.region,
            endpoint: s3.endpoint,
            credentials: {
                accessKeyId: s3.accessKeyId,
                secretAccessKey: s3.secretAccessKey
            },
        });

        const files = fs.readdirSync(folderPath);
        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
                uploadFolder(filePath, s3, path.join(subPath || '', file));
            } else {
                uploadQueue.push({ s3, subPath, file, filePath, client });
            }
        }

        await uploadQueue.drained();

        console.log(`[CONVERTER] ${folderPath} uploaded to s3://${s3.bucket}/${s3.path}${subPath ? `/${subPath}` : ''}`);
    } catch (error) {
        throw error;
    }
}

async function downloadFile(url: string, path: string) {
    await downloadQueue.push({ url, path });
}

async function downloadWorker({ url, path }: { url: string, path: string }) {
    const writer = fs.createWriteStream(path);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        onDownloadProgress: progress => {
            const percent = Math.floor((progress.loaded / (progress.total || 1)) * 100);
            console.log(`[CONVERTER] ${percent}% from ${url} downloaded...`);
        }
    });

    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
        writer.on('finish', () => {
            writer.close();
            resolve(true);
        });

        writer.on('error', (error) => {
            console.log(`[CONVERTER] ${url} download failed...`, error);
            reject(false);
        });
    })
}