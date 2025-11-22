import "../instrument.js";
import * as Sentry from "@sentry/node";
import { MAX_RETRY, TEMP_DIR } from "../constants.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import {
  S3Client,
  PutObjectCommand,
  ObjectCannedACL,
} from "@aws-sdk/client-s3";
import ffmpeg from "fluent-ffmpeg";
import { spawn } from "child_process";
import getShakaPath from "./shaka-packager.js";
import { promise as fastq } from "fastq";
import formatTime from "../utils/format-time.js";
import slugify from "slugify";
import subsrt from "subsrt-ts";

const ALL_SUBTITLE_EXT = ["srt", "vtt", "webvtt"];
const THUMBNAIL_INTERVAL_SECONDS = 5;

const downloadQueue = fastq(downloadWorker, 5);
const uploadQueue = fastq(uploadWorker, 50);

type Quality = {
  height: number;
  bitrate: number;
};

type S3 = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  path: string;
  acl?: ObjectCannedACL;
  endpoint?: string;
};

type Subtitle = {
  url: string;
  language: string;
};

export type ConverterParams = {
  source: string;
  defaultAudioLang: string;
  subtitles: Subtitle[];
  qualities: Quality[];
  s3: S3;
  /**
   * Optional uploads in addition to HLS artifacts.
   * - ENCODED_AUDIOS: uploads each extracted audio as /{lang}/encoded_audio.{ext}
   * - ENCODED_VIDEOS: uploads each encoded video as /{height}/encoded_video.{ext}
   */
  extraUploads?: ("ENCODED_AUDIOS" | "ENCODED_VIDEOS")[];
  processId?: number;
  onStart?: () => void;
  callbackUrl?: string;
};

async function main() {
  const fileParams = process.argv[2];
  const fileOutputMetadata = process.argv[3];

  if (!fileParams) return;
  if (!fileOutputMetadata) return;

  try {
    const paramsString = fs.readFileSync(fileParams, "utf8");
    const params: ConverterParams = JSON.parse(paramsString);

    if (params.source && process.env.SENTRY_DSN) {
      Sentry.setTag("source", params.source);
    }

    const result = await converter(params);

    fs.writeFileSync(fileOutputMetadata, JSON.stringify(result));
  } catch (error) {
    console.error("error", error);

    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error);
      await Sentry.flush();
    }

    process.exit(1);
  }
}

main();

async function converter({
  source,
  qualities,
  s3,
  onStart,
  defaultAudioLang,
  subtitles: originalSubtitles,
  extraUploads,
}: ConverterParams) {
  const baseFolder = fs.mkdtempSync(path.join(TEMP_DIR, "_"));

  if (onStart) {
    onStart();
  }

  const sourceRawPath = path.join(baseFolder, "source");
  console.log(`[CONVERTER] downloading source ${source} to ${sourceRawPath}`);
  await downloadFile(source, sourceRawPath);
  const sourceType = await getFileType(sourceRawPath);
  const sourcePath = `${sourceRawPath}.${sourceType.ext}`;
  fs.renameSync(sourceRawPath, sourcePath);
  const sourceDuration = await getVideoDuration(sourcePath);

  const sourceInfos = await getVideoInfos(sourcePath);

  const videoTracks = sourceInfos.streams.filter(
    (stream) => stream.codec_type === "video" && stream.codec_name !== "mjpeg"
  );

  const audioTracks = sourceInfos.streams.filter(
    (stream) => stream.codec_type === "audio"
  );

  if (!videoTracks.length) {
    throw new Error("no video tracks found");
  }

  const videoTrack = videoTracks.sort(
    (a, b) => (b.height || 0) - (a.height || 0)
  )[0];

  const filteredQualities = qualities.filter(
    (quality) => quality.height <= (videoTrack.height || 0)
  );

  if (!filteredQualities.length) {
    throw new Error("no quality found");
  }

  const audios: { path: string; lang: string; title?: string }[] = [];
  const audioPromises = [];
  for (const audioTrack of audioTracks) {
    audioPromises.push(
      (async () => {
        const audioPath = await extractAudioTrack({
          sourcePath,
          audioTrack,
          baseFolder,
        });
        audios.push({
          path: audioPath,
          lang: audioTrack.tags?.language || "und",
          title: audioTrack.tags?.title,
        });
      })()
    );
  }

  const subtitles: { path: string; language: string }[] = [];
  const subtitlePromises = [];
  for (const subtitle of originalSubtitles) {
    subtitlePromises.push(
      (async () => {
        const subtitlePath = await downloadSubtitle(subtitle, baseFolder);

        if (!subtitlePath) {
          console.log(`[CONVERTER] failed to convert subtitle ${subtitlePath}`);
          return;
        }

        console.log(`[CONVERTER] subtitle ${subtitlePath} was processed!`);
        subtitles.push({
          path: subtitlePath,
          language: subtitle.language,
        });
      })()
    );
  }

  const videos: { path: string; height: number; bitrate: number }[] = [];
  const videoPromises = [];
  for (const quality of filteredQualities) {
    videoPromises.push(
      (async () => {
        const videoPath = await convertVideo({
          sourcePath,
          videoTrack,
          baseFolder,
          quality,
        });
        videos.push({
          path: videoPath,
          height: quality.height,
          bitrate: quality.bitrate,
        });
      })()
    );
  }

  const allPromises = [...audioPromises, ...subtitlePromises, ...videoPromises];
  await runPromises(allPromises, () => deleteFolder(baseFolder));

  const thumbnailsFolder = fs.mkdtempSync(path.join(baseFolder, "_thumbnails"));
  const thumbnailsPath = path.join(thumbnailsFolder, "thumbnails_%03d.jpg");
  await extractThumbnails(
    sourcePath,
    thumbnailsPath,
    THUMBNAIL_INTERVAL_SECONDS
  );

  const thumbnails = fs
    .readdirSync(thumbnailsFolder)
    .filter((file) => file.endsWith(".jpg"))
    .map((file) => path.join(thumbnailsFolder, file));

  const thumbnailUrls: string[] = [];
  for (const thumbnail of thumbnails) {
    const fileName = path.basename(thumbnail);

    thumbnailUrls.push(thumbnail);
    uploadQueue.push({
      s3,
      subPath: "thumbnails",
      file: fileName,
      filePath: thumbnail,
      client: new S3Client({
        region: s3.region,
        endpoint: s3.endpoint,
        credentials: {
          accessKeyId: s3.accessKeyId,
          secretAccessKey: s3.secretAccessKey,
        },
        forcePathStyle: true,
      }),
    });
  }

  await uploadQueue.drained();
  console.log(
    `[CONVERTER] Thumbnails uploaded to s3://${s3.bucket}/${s3.path}/thumbnails`
  );

  const hlsFolder = fs.mkdtempSync(path.join(baseFolder, "_"));
  await hlsFy({
    videos,
    audios,
    hlsFolder,
    defaultAudioLang,
    subtitles,
    thumbnails: thumbnailUrls,
  });
  console.log("[CONVERTER] HLS files created with thumbnails");

  await uploadFolder(hlsFolder, s3);

  // Handle extra uploads when requested
  const shouldUploadEncodedAudios = Array.isArray(extraUploads)
    ? extraUploads.includes("ENCODED_AUDIOS")
    : false;
  const shouldUploadEncodedVideos = Array.isArray(extraUploads)
    ? extraUploads.includes("ENCODED_VIDEOS")
    : false;

  const encodedAudios: { key: string; lang: string; title?: string }[] = [];
  const encodedVideos: { key: string; height: number; bitrate: number }[] = [];

  if (shouldUploadEncodedAudios || shouldUploadEncodedVideos) {
    const client = new S3Client({
      region: s3.region,
      endpoint: s3.endpoint,
      credentials: {
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
      },
      forcePathStyle: true,
    });

    if (shouldUploadEncodedAudios) {
      for (const audio of audios) {
        const audioExt = path.extname(audio.path) || ".mp4";
        const file = `encoded_audio${audioExt}`;
        const subPath = audio.lang || "und";
        const key = path.join(s3.path, subPath || "", file).replace(/\\/g, "/");
        encodedAudios.push({ key, lang: audio.lang, title: audio.title });
        uploadQueue.push({
          s3,
          subPath,
          file,
          filePath: audio.path,
          client,
        });
      }
    }

    if (shouldUploadEncodedVideos) {
      for (const video of videos) {
        const videoExt = path.extname(video.path) || ".mp4";
        const file = `encoded_video${videoExt}`;
        const subPath = String(video.height);
        const key = path.join(s3.path, subPath || "", file).replace(/\\/g, "/");
        encodedVideos.push({
          key,
          height: video.height,
          bitrate: video.bitrate,
        });
        uploadQueue.push({
          s3,
          subPath,
          file,
          filePath: video.path,
          client,
        });
      }
    }

    await uploadQueue.drained();
  }

  deleteFolder(baseFolder);

  return {
    sourceDuration,
    audioTracks: audios.map((a) => ({ lang: a.lang, title: a.title })),
    qualities: videos.map((v) => ({ height: v.height, bitrate: v.bitrate })),
    encodedAudios,
    encodedVideos,
  };
}

function deleteFolder(path: string) {
  console.log(`[CONVERTER] deleting ${path}`);
  fs.rmSync(path, { recursive: true, force: true });
}

async function runPromises(
  allPromises: Promise<any>[],
  onError: (error: any) => void
) {
  const start = Date.now();
  try {
    await Promise.all(allPromises);
    console.log(
      `[CONVERTER] all promises processed in: ${formatTime(Date.now() - start)}`
    );
  } catch (error) {
    console.error(error);

    if (onError) {
      onError(error);
    }

    console.log(`[CONVERTER] failed in: ${formatTime(Date.now() - start)}`);

    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error);
      await Sentry.flush();
    }

    process.exit(1);
  }
}

async function downloadSubtitle(
  subtitle: Subtitle,
  baseFolder: string
): Promise<string | null> {
  const urlObject = new URL(subtitle.url);
  const pathname = urlObject.pathname;
  const ext = pathname.split(".").pop()?.trim().toLowerCase();

  if (!ext) {
    console.log(`[CONVERTER] subtitle ${subtitle.url} has no extension`);
    return null;
  }

  if (!ALL_SUBTITLE_EXT.includes(ext)) {
    console.log(
      `[CONVERTER] subtitle ${subtitle.url} has unsupported extension ${ext}`
    );
    return null;
  }

  const subtitlePath = path.join(baseFolder, `${subtitle.language}.${ext}`);
  await downloadFile(subtitle.url, subtitlePath);

  const subtitleText = fs.readFileSync(subtitlePath, "utf8");

  const vtt = subsrt.convert(subtitleText, { format: ext, to: "vtt" });

  const vttPath = path.join(baseFolder, `${subtitle.language}.vtt`);

  if (subtitlePath !== vttPath) {
    fs.unlinkSync(subtitlePath);
  }

  fs.writeFileSync(vttPath, vtt);
  return vttPath;
}

async function hlsFy({
  videos,
  audios,
  hlsFolder,
  defaultAudioLang,
  subtitles,
  thumbnails,
}: {
  videos: { path: string; height: number; bitrate: number }[];
  audios: { path: string; lang: string; title?: string }[];
  hlsFolder: string;
  defaultAudioLang: string;
  subtitles: { path: string; language: string }[];
  thumbnails: string[];
}) {
  const hlsAudioPaths = audios.map((audio, i) => {
    const titleSlug =
      slugify.default?.(audio.title || audio.lang, { lower: true }) ||
      audio.lang;
    let folder = path.join(hlsFolder, titleSlug);

    if (fs.existsSync(folder)) {
      folder = path.join(hlsFolder, `${i}-${titleSlug}`);
    } else {
      fs.mkdirSync(folder, { recursive: true });
    }

    return {
      m3u8: path.join(folder, "audio.m3u8"),
      folder,
      in: audio.path,
      title: audio.title,
    };
  });
  const hlsVideoPaths = videos.map((video, i) => {
    let folder = path.join(hlsFolder, video.height.toString());

    if (fs.existsSync(folder)) {
      folder = path.join(hlsFolder, `${i}-${video.height}`);
    } else {
      fs.mkdirSync(folder, { recursive: true });
    }

    return {
      m3u8: path.join(folder, "video.m3u8"),
      folder,
      in: video.path,
    };
  });
  const hlsSubtitlesPaths = subtitles.map((subtitle, i) => {
    let folder = path.join(hlsFolder, "subtitles");

    if (fs.existsSync(folder)) {
      folder = path.join(hlsFolder, `subtitles-${i}`);
    } else {
      fs.mkdirSync(folder, { recursive: true });
    }

    return {
      m3u8: path.join(folder, "subtitles.m3u8"),
      folder,
      in: subtitle.path,
      language: subtitle.language,
    };
  });

  const packager = getShakaPath();

  const defaultAudioLocale = new Intl.Locale(defaultAudioLang);
  const defaultAudio = audios.find((audio) => {
    if (audio.lang === "und") {
      return false;
    }

    const audioLocale = new Intl.Locale(audio.lang);
    return defaultAudioLocale.language === audioLocale.language;
  });

  const defaultLang = defaultAudio?.lang;
  const audiosStr = hlsAudioPaths.map(
    (audio) =>
      `in=${audio.in},stream=audio,segment_template=${audio.folder}/$Number$.ts,playlist_name=${audio.m3u8},hls_group_id=audio${audio.title ? `,hls_name=${audio.title}` : ""}`
  );
  const subtitlesStr = hlsSubtitlesPaths.map(
    (subtitle) =>
      `in=${subtitle.in},stream=text,segment_template=${subtitle.folder}/$Number$.webvtt,playlist_name=${subtitle.m3u8},hls_group_id=text,hls_name=${new Intl.Locale(subtitle.language).language}`
  );
  const videosStr = hlsVideoPaths.map(
    (video) =>
      `in=${video.in},stream=video,segment_template=${video.folder}/$Number$.ts,playlist_name=${video.m3u8},hls_group_id=video`
  );

  const masterPlaylistPath = path.join(hlsFolder, "playlist.m3u8");

  const args = [
    ...audiosStr,
    ...videosStr,
    ...subtitlesStr,
    ...(defaultLang ? ["--default_language", defaultLang] : ""),
    "--hls_master_playlist_output",
    masterPlaylistPath,
  ];

  console.log("[CONVERTER] Creating HLS file with args:", args.join(" "));

  await new Promise<void>((resolve, reject) => {
    spawn(packager, args, { stdio: "inherit" }).on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Packager exited with code ${code}`));
      }
    });
  });

  const thumbnailsOutputFolder = path.join(hlsFolder, "thumbnails");
  fs.mkdirSync(thumbnailsOutputFolder, { recursive: true });

  for (const thumbnailPath of thumbnails) {
    const fileName = path.basename(thumbnailPath);
    const destPath = path.join(thumbnailsOutputFolder, fileName);
    fs.copyFileSync(thumbnailPath, destPath);
  }

  generateThumbnailsPlaylist(thumbnailsOutputFolder);

  let masterPlaylist = fs.readFileSync(masterPlaylistPath, "utf8");

  masterPlaylist += `\n#EXT-X-THUMBNAILS:uri=thumbnails/thumbnails.m3u8\n`;

  fs.writeFileSync(masterPlaylistPath, masterPlaylist);

  console.log("[CONVERTER] Thumbnails foram adicionadas ao fluxo HLS.");
}

function generateThumbnailsPlaylist(thumbnailsFolder: string) {
  const thumbnailsPlaylistPath = path.join(thumbnailsFolder, "thumbnails.m3u8");

  const files = fs
    .readdirSync(thumbnailsFolder)
    .filter((file) => file.endsWith(".jpg") || file.endsWith(".png"))
    .sort((a, b) => {
      const aMatch = a.match(/_(\d+)\.jpg$/);
      const bMatch = b.match(/_(\d+)\.jpg$/);
      const aNum = aMatch ? parseInt(aMatch[1], 10) : 0;
      const bNum = bMatch ? parseInt(bMatch[1], 10) : 0;
      return aNum - bNum;
    });

  let playlistContent = "#EXTM3U\n#EXT-X-VERSION:3\n";

  const thumbnailDuration = THUMBNAIL_INTERVAL_SECONDS;

  for (const file of files) {
    playlistContent += `#EXTINF:${thumbnailDuration},\nthumbnails/${file}\n`;
  }

  fs.writeFileSync(thumbnailsPlaylistPath, playlistContent, "utf8");
}

async function convertVideo({
  sourcePath,
  videoTrack,
  baseFolder,
  quality,
  attempts,
}: {
  sourcePath: string;
  videoTrack: ffmpeg.FfprobeStream;
  baseFolder: string;
  quality: Quality;
  attempts?: number;
}) {
  if (!attempts) {
    attempts = 0;
  }

  if (!videoTrack) {
    throw new Error("no video track found");
  }

  if (videoTrack.codec_type !== "video") {
    throw new Error("not a video track");
  }

  const videoFolderPath = fs.mkdtempSync(path.join(baseFolder, "_"));
  const videoPath = path.join(videoFolderPath, "video.mp4");
  const videoTrackId = videoTrack.index;

  return new Promise<string>((resolve, reject) => {
    ffmpeg(sourcePath)
      .outputOptions([`-map 0:${videoTrackId}`])
      .videoCodec("libx264")
      .videoBitrate(quality.bitrate)
      .size(`?x${quality.height}`)
      .on("progress", (progress) => {
        console.log(
          `[CONVERTER|${quality.height}] ${sourcePath} - ${progress.percent || 0}% converted...`
        );
      })
      .on("end", () => {
        resolve(videoPath);
      })
      .on("error", async (err) => {
        if (attempts < MAX_RETRY) {
          console.log(
            `[CONVERTER|${quality.height}] ${sourcePath} - ${err.message} - retrying...`
          );
          resolve(
            await convertVideo({
              sourcePath,
              videoTrack,
              baseFolder,
              quality,
              attempts: attempts + 1,
            })
          );
        } else {
          reject(err);
        }
      })
      .save(videoPath);
  });
}

async function extractAudioTrack({
  sourcePath,
  audioTrack,
  baseFolder,
  attempts,
}: {
  sourcePath: string;
  audioTrack: ffmpeg.FfprobeStream;
  baseFolder: string;
  attempts?: number;
}) {
  if (!attempts) {
    attempts = 0;
  }

  if (!audioTrack) {
    throw new Error("no audio track found");
  }

  if (audioTrack.codec_type !== "audio") {
    throw new Error("not an audio track");
  }

  const audioFolderPath = fs.mkdtempSync(path.join(baseFolder, "_"));
  const audioPath = path.join(audioFolderPath, "audio.mp4");
  const audioTrackId = audioTrack.index;

  return new Promise<string>((resolve, reject) => {
    ffmpeg(sourcePath)
      .outputOptions([`-map 0:${audioTrackId}`])
      .audioChannels(1)
      .audioCodec("aac")
      .audioBitrate(audioTrack.avg_bit_rate || "128k")
      .output(audioPath)
      .on("progress", (progress) => {
        console.log(
          `[CONVERTER|${audioTrack.tags.language || "und"}] ${sourcePath} - ${progress.percent || 0}% audio extracted...`
        );
      })
      .on("end", () => {
        resolve(audioPath);
      })
      .on("error", async (err) => {
        if (attempts < MAX_RETRY) {
          console.log(
            `[CONVERTER|${audioTrack.tags.language || "und"}] ${sourcePath} - ${err.message} - retrying...`
          );
          resolve(
            await extractAudioTrack({
              sourcePath,
              audioTrack,
              baseFolder,
              attempts: attempts + 1,
            })
          );
        } else {
          reject(err);
        }
      })
      .run();
  });
}

async function getVideoInfos(videoPath: string) {
  return new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) {
        reject(err);
      }
      resolve(data);
    });
  });
}

async function getFileType(filePath: string) {
  const fileType = await import("file-type");
  const result = await fileType.fileTypeFromFile(filePath);

  if (!result) {
    throw new Error("file type not found");
  }

  return result;
}

async function uploadWorker({
  s3,
  subPath,
  file,
  filePath,
  client,
  attempts,
}: {
  s3: S3;
  subPath?: string;
  file: string;
  filePath: string;
  client: S3Client;
  attempts?: number;
}) {
  if (!attempts) {
    attempts = 0;
  }

  const key = path.join(s3.path, subPath || "", file).replace(/\\/g, "/");
  try {
    console.log(`[CONVERTER] uploading ${key}...`);
    const command = new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: fs.readFileSync(filePath),
      ACL: s3.acl,
    });
    await client.send(command);
    console.log(`[CONVERTER] ${key} was uploaded!`);
  } catch (error: any) {
    if (attempts < MAX_RETRY) {
      console.log(`[CONVERTER] ${key} - ${error.message} - retrying...`);
      await uploadWorker({
        s3,
        subPath,
        file,
        filePath,
        client,
        attempts: attempts + 1,
      });
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
        secretAccessKey: s3.secretAccessKey,
      },
      forcePathStyle: true,
    });

    const files = fs.readdirSync(folderPath);
    for (const file of files) {
      const filePath = path.join(folderPath, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        uploadFolder(filePath, s3, path.join(subPath || "", file));
      } else {
        uploadQueue.push({ s3, subPath, file, filePath, client });
      }
    }

    await uploadQueue.drained();

    console.log(
      `[CONVERTER] ${folderPath} uploaded to s3://${s3.bucket}/${s3.path}${subPath ? `/${subPath}` : ""}`
    );
  } catch (error) {
    throw error;
  }
}

async function downloadFile(url: string, path: string) {
  await downloadQueue.push({ url, path });
}

async function downloadWorker({
  url,
  path,
  attempts,
}: {
  url: string;
  path: string;
  attempts?: number;
}) {
  if (!attempts) attempts = 0;

  const writer = fs.createWriteStream(path);
  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
    });

    const fileSize = response.headers["content-length"];

    response.data.pipe(writer);

    let percent = 0;
    let totalBytes = 0;
    let lastPercent = 0;

    response.data.on("data", (chunk: any) => {
      if (!fileSize) {
        console.log(`[CONVERTER] ${url} - got new ${chunk.length} bytes`);
        return;
      }

      totalBytes += chunk.length;
      percent = Math.floor((totalBytes / fileSize) * 100);

      if (percent !== lastPercent) {
        console.log(`[CONVERTER] ${url} - ${percent.toFixed(2)}% received`);
        lastPercent = percent;
      }
    });

    await new Promise<void>((resolve, reject) => {
      writer.on("finish", () => {
        writer.close();
        resolve();
      });

      writer.on("error", async (error) => {
        if (attempts < MAX_RETRY) {
          console.log(`[CONVERTER] ${url} download failed... retrying...`);
          return await downloadWorker({ url, path, attempts: attempts + 1 });
        }

        console.log(`[CONVERTER] ${url} download failed...`, error);
        reject(error);
      });
    });
  } catch (error: any) {
    if (attempts < MAX_RETRY) {
      console.log(`[CONVERTER] ${url} download failed... retrying...`);
      await downloadWorker({ url, path, attempts: attempts + 1 });
    } else {
      console.log(`[CONVERTER] ${url} download failed...`, error);
      throw error;
    }
  }
}

async function extractThumbnails(
  videoPath: string,
  outputPattern: string,
  intervalSeconds: number
): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const timemarks = await generateTimemarks(videoPath, intervalSeconds);
      console.log("[CONVERTER] Timemarks:", timemarks);

      if (timemarks.length === 0) {
        throw new Error("No timemarks generated for thumbnail extraction.");
      }

      const filenamePattern =
        path.basename(outputPattern, path.extname(outputPattern)) +
        "%03d" +
        path.extname(outputPattern);

      ffmpeg(videoPath)
        .on("end", () => {
          console.log("[CONVERTER] Thumbnails extraction completed.");
          resolve();
        })
        .on("error", (err) => {
          console.error(
            "[CONVERTER] Failed to extract thumbnails:",
            err.message
          );
          reject(err);
        })
        .screenshots({
          count: timemarks.length,
          timemarks,
          filename: filenamePattern,
          folder: path.dirname(outputPattern),
          size: "320x240",
        });
    } catch (err) {
      console.error("[CONVERTER] Error during thumbnails extraction:", err);
      reject(err);
    }
  });
}

async function generateTimemarks(
  videoPath: string,
  intervalSeconds: number
): Promise<string[]> {
  const duration = await getVideoDuration(videoPath);
  const timemarks: string[] = [formatTimeSeconds(0)];

  for (let i = intervalSeconds; i < duration; i += intervalSeconds) {
    timemarks.push(formatTimeSeconds(i));
  }

  return timemarks;
}

async function getVideoDuration(videoPath: string): Promise<number> {
  const metadata = await getVideoInfos(videoPath);
  return metadata.format.duration || 0;
}

function formatTimeSeconds(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = (seconds % 60).toFixed(3);
  return `${padZero(hrs)}:${padZero(mins)}:${padZero(secs)}`;
}

function padZero(num: number | string, size: number = 2): string {
  let s = num.toString();
  while (s.length < size) s = "0" + s;
  return s;
}
