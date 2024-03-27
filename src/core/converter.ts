import { CONCURRENCY, TEMP_DIR } from "../constants.js"
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from 'ffprobe-static';
import { promise as fastq } from "fastq";

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

    const id = Math.random().toString(36).slice(2);
    const tempDir = path.join(TEMP_DIR, id);

    if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }

    fs.mkdirSync(tempDir, { recursive: true });

    let sourcePath = path.join(tempDir, 'source');

    const result = await downloadFile(source, sourcePath);

    if (!result) {
        throw new Error('download failed');
    }

    const extension = (await getFileType(sourcePath)).ext;
    const oldSourcePath = sourcePath;
    sourcePath = `${sourcePath}.${extension}`;
    fs.renameSync(oldSourcePath, sourcePath);

    const sourceInfo = await getVideoInfos(sourcePath);
    let stream = sourceInfo.streams.find(stream => stream.codec_type === 'video' && stream.height);

    if (!stream) {
        stream = sourceInfo.streams.find(stream => stream.codec_type === 'video');
    }

    if (!stream) {
        throw new Error('stream not found');
    }

    qualities = qualities.filter(quality => stream?.height ? quality.height <= stream.height : true);

    const hlsFolder = path.join(tempDir, 'hls');

    const qualitiesM3u8: { path: string, height: number, bitrate: number }[] = [];

    const queueConvert = fastq(async (i) => {
        const quality = qualities[i];
        const targetPath = path.join(hlsFolder, `quality-${i + 1}`);
        const result = await hlsConvert(sourcePath, targetPath, quality);

        if (!result) {
            throw new Error('hls convert failed');
        }

        qualitiesM3u8.push({
            path: result,
            height: quality.height,
            bitrate: quality.bitrate
        })
    }, CONCURRENCY);

    for (let i = 0; i < qualities.length; i++) {
        queueConvert.push(i);
    }

    await queueConvert.drained();

    const playlistPath = path.join(hlsFolder, 'playlist.m3u8');

    if (fs.existsSync(playlistPath)) {
        fs.rmSync(playlistPath);
    }

    await buildPlaylist(qualitiesM3u8, playlistPath, hlsFolder);
    await uploadFolder(hlsFolder, s3);

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`[CONVERTER] ${source} completed`);
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

async function buildPlaylist(qualitiesM3u8: { path: string, height: number, bitrate: number }[], playlistPath: string, hlsFolder: string) {
    let content = '#EXTM3U\n';

    for (const quality of qualitiesM3u8) {
        const videoInfos = await getVideoInfos(quality.path);
        const videoStream = videoInfos.streams[0];
        const relative = path.relative(hlsFolder, quality.path);

        const bandwidth = quality.bitrate * 1024 * 8;

        content += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${videoStream.width}x${videoStream.height}\n${relative}\n`;
    }

    fs.writeFileSync(playlistPath, content);
}

async function getFileType(filePath: string) {
    const fileType = await import('file-type');
    const result = await fileType.fileTypeFromFile(filePath);

    if (!result) {
        throw new Error('file type not found');
    }

    return result;
}

async function uploadFolder(folderPath: string, s3: S3, subPath?: string) {
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
            await uploadFolder(filePath, s3, path.join(subPath || '', file));
        } else {
            const key = path.join(s3.path, subPath || '', file);
            console.log(`[CONVERTER] ${key} uploading...`);
            await client.send(new PutObjectCommand({
                Bucket: s3.bucket,
                Key: key,
                Body: fs.readFileSync(filePath),
            }));
            console.log(`[CONVERTER] ${key} uploaded`);
        }
    }

    fs.rmSync(folderPath, { recursive: true, force: true });
    console.log(`[CONVERTER] ${folderPath} uploaded to s3://${s3.bucket}/${s3.path}`);
}

async function hlsConvert(sourcePath: string, targetPath: string, quality: Quality) {
    if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
    }

    fs.mkdirSync(targetPath, { recursive: true });

    const result = path.join(targetPath, 'video.m3u8');

    await new Promise((resolve, reject) => {
        ffmpeg()
            .input(sourcePath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .format('hls')
            .videoBitrate(`${quality.bitrate}k`)
            .audioBitrate('128k')
            .size(`?x${quality.height}`)
            .outputOptions([
                '-hls_time 2',
                '-hls_list_size 0',
                `-hls_segment_filename ${path.join(targetPath, 'segment-%d.ts')}`,
                '-hls_segment_type mpegts',
                '-hls_allow_cache 1',
                '-hls_flags delete_segments',
            ])
            .output(result)
            .on('start', () => {
                console.log(`[CONVERTER] ${sourcePath} ${quality.height}x${quality.bitrate} started...`);
            })
            .on('progress', (progress: any) => {
                if (progress.percent) {
                    console.log(`[CONVERTER] ${sourcePath} ${quality.height}x${quality.bitrate} progress: ${progress.percent}%`);
                } else {
                    console.log(`[CONVERTER] ${sourcePath} ${quality.height}x${quality.bitrate} progress: ${progress.timemark}`);
                }
            })
            .on('end', () => {
                console.log(`[CONVERTER] ${sourcePath} ${quality.height}x${quality.bitrate} done...`);
                resolve(true);
            })
            .on('error', (error: any) => {
                console.log(`[CONVERTER] ${quality.height}x${quality.bitrate} failed...`, error);
                reject(error);
            })
            .run();
    });

    return result;
}

function downloadFile(url: string, path: string) {
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(path);
        axios({
            url,
            method: 'GET',
            responseType: 'stream',
            onDownloadProgress: progress => {
                const percent = Math.floor((progress.loaded / (progress.total || 1)) * 100);
                console.log(`[CONVERTER] ${percent}% from ${url} downloaded...`);
            }
        }).then(response => {
            response.data.pipe(writer);
            writer.on('finish', () => {
                writer.close();
                resolve(true);
            });
            writer.on('error', (error) => {
                console.log(`[CONVERTER] ${url} download failed...`, error);
                reject(false);
            });
        })
            .catch((error) => {
                console.log(`[CONVERTER] ${url} download failed...`, error);
                reject(false);
            })
    });
}