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
 * Always prefers pre-muxed mp4 to enable clean stdout streaming.
 */
export function buildYtdlpFormat(quality: VideoQuality = 'best'): string {
  const heightMap: Record<string, string> = {
    '1080p': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best',
    '720p':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]/best',
    '480p':  'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]/best[height<=480]/best',
    '360p':  'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]/best[height<=360]/best',
  };
  return heightMap[quality] ?? 'best[ext=mp4]/best';
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
 */
export async function streamToGDrive(
  url: string,
  quality: VideoQuality = 'best',
  gdrive: GoogleDriveConfig,
  title: string,
): Promise<{ driveUrl: string; driveFileId: string }> {
  const format = buildYtdlpFormat(quality);
  const fileName = `${sanitizeFileName(title)}.mp4`;

  console.log(`[downloader] Streaming "${title}" → Google Drive (format: ${format})`);

  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', [
      '-f', format,
      '--merge-output-format', 'mp4',
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
 */
export async function downloadLocally(
  url: string,
  quality: VideoQuality = 'best',
  outputDir: string,
  title: string,
): Promise<string> {
  fs.mkdirSync(outputDir, { recursive: true });

  const format = buildYtdlpFormat(quality);
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
