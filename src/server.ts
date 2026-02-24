/**
 * yt-downloader — HTTP API Server
 *
 * POST /download
 *   Body: { url, quality?, format?, googleDrive?: { credentials, folderId }, webhookUrl? }
 *   Returns: { jobId, status: "queued" }
 *
 * GET /status/:jobId
 *   Returns: { jobId, status, title?, localPath?, driveUrl?, driveFileId?, error?, createdAt, completedAt? }
 *
 * Google Drive validation (credentials + folder access) happens BEFORE any download
 * starts, so the request fails fast with a clear error if Drive is misconfigured.
 *
 * If no googleDrive payload is given, the output file is saved locally and
 * the response includes the absolute local path.
 *
 * If webhookUrl is provided, a POST request with the job result will be sent
 * to that URL when the download completes (success or failed).
 */

import express, { Request, Response } from 'express';
import * as crypto from 'crypto';
import { config } from './config';
import { validateGoogleDrive } from './gdrive';
import { getVideoInfo, streamToGDrive, downloadLocally } from './downloader';
import { DownloadRequest, JobResult } from './types';

const app = express();
app.use(express.json({ limit: '1mb' }));

// ─── IN-MEMORY JOB STORE ──────────────────────────────────────────────────────

const jobs = new Map<string, JobResult>();

// ─── WEBHOOK CALLBACK ─────────────────────────────────────────────────────────

async function sendWebhookCallback(webhookUrl: string, job: JobResult): Promise<void> {
  try {
    console.log(`[webhook] Sending callback to ${webhookUrl}...`);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(job),
    });

    if (!response.ok) {
      console.warn(`[webhook] Callback failed with status ${response.status}: ${response.statusText}`);
    } else {
      console.log(`[webhook] Callback sent successfully to ${webhookUrl}`);
    }
  } catch (err) {
    console.error(`[webhook] Failed to send callback to ${webhookUrl}: ${(err as Error).message}`);
  }
}

// ─── CORE JOB PROCESSOR ───────────────────────────────────────────────────────

async function processJob(jobId: string, req: DownloadRequest): Promise<void> {
  const job = jobs.get(jobId)!;
  job.status = 'in_progress';
  console.log(`[server] Processing job ${jobId}: ${req.url}`);

  try {
    // 1. Fetch video metadata
    console.log(`[server] Fetching video info...`);
    const info = await getVideoInfo(req.url);
    job.title = info.title;
    console.log(`[server] Video: "${info.title}" (id: ${info.id})`);

    const quality = req.quality ?? 'best';

    if (req.googleDrive) {
      // 2a. Stream directly to Google Drive — no local file
      console.log(`[server] Streaming to Google Drive folder ${req.googleDrive.folderId}...`);
      const { driveUrl, driveFileId } = await streamToGDrive(req.url, quality, req.googleDrive, info.title);
      job.driveUrl = driveUrl;
      job.driveFileId = driveFileId;
      console.log(`[server] Uploaded to Drive: ${driveUrl}`);
    } else {
      // 2b. Download locally
      const localPath = await downloadLocally(req.url, quality, config.outputDir, info.title);
      job.localPath = localPath;
      console.log(`[server] Saved locally: ${localPath}`);
    }

    job.status = 'success';
    job.completedAt = new Date().toISOString();
    console.log(`[server] Job ${jobId} completed successfully`);

  } catch (err) {
    const message = (err as Error).message;
    console.error(`[server] Job ${jobId} failed: ${message}`);
    job.status = 'failed';
    job.error = message;
    job.completedAt = new Date().toISOString();
  } finally {
    // Send webhook callback if webhookUrl was provided
    if (req.webhookUrl) {
      await sendWebhookCallback(req.webhookUrl, job);
    }
  }
}

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────

/**
 * POST /download
 * Submit a download job. Validates credentials before queuing. Returns 202 immediately.
 */
app.post('/download', async (req: Request, res: Response) => {
  const body = req.body as DownloadRequest;

  // Validate required url field
  if (!body.url || typeof body.url !== 'string') {
    res.status(400).json({ error: '"url" is required and must be a string' });
    return;
  }

  // Validate quality if provided
  const validQualities = ['highest', 'best', '1080p', '720p', 'mid', '480p', '360p', 'lowest'];
  if (body.quality && !validQualities.includes(body.quality)) {
    res.status(400).json({ error: `"quality" must be one of: ${validQualities.join(', ')}` });
    return;
  }

  // Validate format if provided
  if (body.format && body.format !== 'mp4') {
    res.status(400).json({ error: '"format" must be "mp4"' });
    return;
  }

  // Validate webhookUrl if provided
  if (body.webhookUrl) {
    try {
      new URL(body.webhookUrl);
    } catch {
      res.status(400).json({ error: '"webhookUrl" must be a valid URL' });
      return;
    }
  }

  // Structural validation of googleDrive credentials
  if (body.googleDrive) {
    const creds = body.googleDrive.credentials;
    if (!creds || typeof creds !== 'object') {
      res.status(400).json({ error: '"googleDrive.credentials" must be a credentials object' });
      return;
    }
    const credsType = (creds as Record<string, unknown>)['type'];
    if (credsType !== 'service_account' && credsType !== 'oauth2') {
      res.status(400).json({ error: '"googleDrive.credentials.type" must be "service_account" or "oauth2"' });
      return;
    }
    if (credsType === 'oauth2') {
      const o = creds as Record<string, unknown>;
      if (!o['client_id'] || !o['client_secret'] || !o['refresh_token']) {
        res.status(400).json({ error: 'OAuth2 credentials require "client_id", "client_secret", and "refresh_token"' });
        return;
      }
    }
    if (!body.googleDrive.folderId || typeof body.googleDrive.folderId !== 'string') {
      res.status(400).json({ error: '"googleDrive.folderId" is required when googleDrive is provided' });
      return;
    }

    // Live credential + folder validation BEFORE queuing any download
    try {
      console.log(`[server] Validating Google Drive credentials and folder access...`);
      await validateGoogleDrive(body.googleDrive);
      console.log(`[server] Google Drive OK`);
    } catch (err) {
      const message = (err as Error).message;
      res.status(422).json({ error: message });
      return;
    }
  }

  // Enqueue job
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  const job: JobResult = {
    jobId,
    status: 'queued',
    createdAt: now,
  };
  jobs.set(jobId, job);

  // Start processing asynchronously (fire-and-forget)
  processJob(jobId, body).catch((err) => {
    console.error(`[server] Unexpected error in processJob: ${(err as Error).message}`);
  });

  res.status(202).json({ jobId, status: 'queued' });
});

/**
 * GET /status/:jobId
 * Poll for job result.
 */
app.get('/status/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(req.params['jobId'] as string);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  res.json(job);
});

/**
 * GET /health
 */
app.get('/health', (_req, res) => {
  res.json({ ok: true, jobs: jobs.size });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`=== yt-downloader API Server ===`);
  console.log(`Listening on http://localhost:${config.port}`);
  console.log(`POST /download      — submit a download job`);
  console.log(`GET  /status/:jobId — poll result`);
  console.log(`GET  /health        — server health\n`);
  console.log(`Local output dir: ${config.outputDir}`);
  console.log(`System requirement: yt-dlp must be installed and in PATH\n`);
});
