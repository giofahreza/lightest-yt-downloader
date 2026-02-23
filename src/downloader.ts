import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleDriveConfig, VideoQuality } from './types';
import { uploadStreamToGoogleDrive } from './gdrive';

export interface VideoInfo {
  title: string;
  ext: string;
  id: string;
}

/**
 * Fetches video metadata from YouTube without downloading.
 * Runs: yt-dlp --dump-json <url>
 */
export function getVideoInfo(url: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', ['--dump-json', '--no-playlist', url]);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp info failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      try {
        const info = JSON.parse(stdout) as Record<string, unknown>;
        resolve({
          title: String(info['title'] ?? 'video'),
          ext: String(info['ext'] ?? 'mp4'),
          id: String(info['id'] ?? ''),
        });
      } catch {
        reject(new Error(`Failed to parse yt-dlp JSON output: ${stdout.slice(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}. Is yt-dlp installed and in PATH?`));
    });
  });
}

/**
 * Maps a quality string to a yt-dlp format selector.
 *
 * For streaming=true: Returns ONLY pre-muxed formats (no merging) to avoid MPEG-TS output.
 * For streaming=false: Can use video+audio merging for better quality.
 */
export function buildYtdlpFormat(quality: VideoQuality = 'best', streaming: boolean = false): string {
  if (streaming) {
    // For streaming to stdout: MUST use height-constrained formats for reliability
    // All qualities capped at 720p for Google Drive streaming compatibility
    const streamMap: Record<string, string> = {
      'highest': 'best[height<=720][ext=mp4]/best[height<=720]', // capped at 720p
      'best': 'best[height<=720][ext=mp4]/best[height<=720]',    // capped at 720p
      '1080p': 'best[height<=720][ext=mp4]/best[height<=720]',   // capped at 720p
      '720p': 'best[height<=720][ext=mp4]/best[height<=720]',
      'mid': 'best[height<=720][ext=mp4]/best[height<=720]',
      '480p': 'best[height<=480][ext=mp4]/best[height<=480]',
      '360p': 'best[height<=360][ext=mp4]/best[height<=360]',
      'lowest': 'worst[ext=mp4]/worst',
    };
    return streamMap[quality] ?? 'best[height<=720][ext=mp4]/best[height<=720]';
  } else {
    // For local download: Can merge video+audio for better quality
    const localMap: Record<string, string> = {
      'highest': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      'best': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '1080p': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]',
      '720p': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
      'mid': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
      '480p': 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]',
      '360p': 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[height<=360]',
      'lowest': 'worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst[ext=mp4]/worst',
    };
    return localMap[quality] ?? 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  }
}

/**
 * Sanitizes a video title into a safe filename.
 */
export function sanitizeFileName(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 200);
}

/**
 * Streams video from YouTube directly to Google Drive — no local temp file.
 * Spawns yt-dlp with -o - (stdout) and pipes to the Drive upload stream.
 * Uses height-constrained formats (720p or lower) which work reliably for streaming.
 */
export async function streamToGDrive(
  url: string,
  quality: VideoQuality = 'best',
  gdrive: GoogleDriveConfig,
  title: string,
): Promise<{ driveUrl: string; driveFileId: string }> {
  const format = buildYtdlpFormat(quality, true); // streaming=true: pre-muxed only
  const qualityPrefix = quality === 'highest' ? 'high_' : quality === 'lowest' ? 'low_' : '';
  const fileName = `${qualityPrefix}${sanitizeFileName(title)}.mp4`;

  console.log(`[downloader] Streaming "${title}" → Google Drive (quality: ${quality}, format: ${format})`);

  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', [
      '-f', format,
      '-o', '-',
      '--no-playlist',
      url,
    ]);

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      stderr += line;
      process.stderr.write(`[yt-dlp] ${line}`);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}. Is yt-dlp installed and in PATH?`));
    });

    // Pipe stdout directly to Drive upload
    uploadStreamToGoogleDrive(child.stdout, fileName, gdrive)
      .then((result) => {
        child.on('close', (code) => {
          if (code !== 0 && code !== null) {
            console.warn(`[downloader] yt-dlp exited with code ${code} after stream completed`);
          }
          resolve(result);
        });
        // If child already closed before promise resolved, resolve immediately
        if (child.exitCode !== null) {
          resolve(result);
        }
      })
      .catch((err) => {
        child.kill();
        reject(new Error(`GDrive stream upload failed: ${(err as Error).message}\nyt-dlp stderr: ${stderr.slice(-500)}`));
      });
  });
}

/**
 * Downloads video to a local file in outputDir.
 * Returns the absolute path to the saved file.
 * Can use video+audio merging for better quality.
 */
export async function downloadLocally(
  url: string,
  quality: VideoQuality = 'best',
  outputDir: string,
  title: string,
): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });

  const format = buildYtdlpFormat(quality, false); // streaming=false, can use merging
  const safeTitle = sanitizeFileName(title);
  const outputPath = path.join(outputDir, `${safeTitle}.mp4`);

  console.log(`[downloader] Downloading "${title}" → ${outputPath} (format: ${format})`);

  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', [
      '-f', format,
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--no-playlist',
      url,
    ]);

    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk.toString());
    });

    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[yt-dlp] ${chunk.toString()}`);
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}. Is yt-dlp installed and in PATH?`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp download failed with exit code ${code}`));
        return;
      }
      resolve(outputPath);
    });
  });
}
