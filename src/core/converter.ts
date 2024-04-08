import { MAX_RETRY, TEMP_DIR } from "../constants.js"
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from 'ffprobe-static';
import { spawn } from 'child_process';
import getShakaPath from "./shaka-packager.js";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

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

export type ConverterParams = {
    source: string
    qualities: Quality[]
    s3: S3
    onStart?: () => void
}

export async function converter({ source, qualities, s3, onStart }: ConverterParams) {
    if (onStart) {
        onStart();
    }

    const baseFolder = fs.mkdtempSync(path.join(TEMP_DIR, '_'));
    const sourceRawPath = path.join(baseFolder, 'source');
    await downloadFile(source, sourceRawPath);
    const sourceType = await getFileType(sourceRawPath);
    const sourcePath = `${sourceRawPath}.${sourceType.ext}`;
    fs.renameSync(sourceRawPath, sourcePath);

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

    const audios = [];
    for (const audioTrack of audioTracks) {
        const audioPath = await extractAudioTrack({ sourcePath, audioTrack, baseFolder });
        audios.push({
            path: audioPath,
            lang: audioTrack.tags?.language || 'und',
        });
    }

    const videos = [];
    for (const quality of filteredQualities) {
        const videoPath = await convertVideo({ sourcePath, videoTrack, baseFolder, quality });
        videos.push({
            path: videoPath,
            height: quality.height,
            bitrate: quality.bitrate,
        });
    }

    const hlsFolder = fs.mkdtempSync(path.join(baseFolder, '_'));

    await hlsFy({ videos, audios, hlsFolder });
    console.log('[CONVERTER] HLS files created');

    await uploadFolder(hlsFolder, s3);

    fs.rmSync(baseFolder, { recursive: true, force: true });
    console.log('[CONVERTER] Done');
}

async function hlsFy({ videos, audios, hlsFolder }: { videos: { path: string, height: number, bitrate: number }[], audios: { path: string, lang: string }[], hlsFolder: string }) {
    const hlsAudioPaths = audios.map(audio => {
        const folder = path.join(hlsFolder, audio.lang);

        return {
            m3u8: path.join(folder, 'audio.m3u8'),
            folder,
            in: audio.path
        }
    });
    const hlsVideoPaths = videos.map(video => {
        const folder = path.join(hlsFolder, video.height.toString());

        return {
            m3u8: path.join(folder, 'video.m3u8'),
            folder,
            in: video.path
        }
    });

    const packager = getShakaPath();

    const audiosStr = hlsAudioPaths.map(audio => `in=${audio.in},stream=audio,segment_template=${audio.folder}/$Number$.ts,playlist_name=${audio.m3u8},hls_group_id=audio`);
    const videosStr = hlsVideoPaths.map(video => `in=${video.in},stream=video,segment_template=${video.folder}/$Number$.ts,playlist_name=${video.m3u8},hls_group_id=video`);

    const args = [
        ...audiosStr,
        ...videosStr,
        '--hls_master_playlist_output',
        path.join(hlsFolder, 'playlist.m3u8')
    ]

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

    return new Promise<string>((resolve, reject) => {
        ffmpeg(sourcePath)
            .outputOptions(['-map 0:' + videoTrackId])
            .videoCodec('libx264')
            .videoBitrate(quality.bitrate)
            .size(`?x${quality.height}`)
            .output(videoPath)
            .on('progress', (progress) => {
                console.log(`[CONVERTER] ${progress.percent || 0}% from ${sourcePath} converted...`);
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
            .run();
    })
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
            .outputOptions([`-map 0:${audioTrackId}`])
            .audioChannels(1)
            .audioCodec('aac')
            .audioBitrate(audioTrack.avg_bit_rate || '128k')
            .output(audioPath)
            .on('progress', (progress) => {
                console.log(`[CONVERTER] ${progress.percent || 0}% audio extracted...`);
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

async function uploadFolder(folderPath: string, s3: S3, subPath?: string, attempts?: number) {
    if (!attempts) {
        attempts = 0;
    }

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
        const promises = [];
        for (const file of files) {
            const filePath = path.join(folderPath, file);
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
                await uploadFolder(filePath, s3, path.join(subPath || '', file));
            } else {
                const key = path.join(s3.path, subPath || '', file);
                const command = new PutObjectCommand({
                    Bucket: s3.bucket,
                    Key: key,
                    Body: fs.readFileSync(filePath),
                })
                promises.push(client.send(command));
                console.log(`[CONVERTER] ${key} added to promises...`);
            }
        }

        await Promise.all(promises);
        console.log(`[CONVERTER] ${folderPath} uploaded to s3://${s3.bucket}/${s3.path}${subPath ? `/${subPath}` : ''}`);
    } catch (error) {
        if (attempts < MAX_RETRY) {
            console.log('[CONVERTER] retrying...');
            await uploadFolder(folderPath, s3, subPath, attempts + 1);
        } else {
            throw error;
        }
    }
}

async function downloadFile(url: string, path: string) {
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