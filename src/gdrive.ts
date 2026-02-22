import { google, drive_v3 } from 'googleapis';
import * as path from 'path';
import { Readable } from 'stream';
import { GoogleDriveConfig, GoogleDriveCredentials } from './types';

/**
 * Validates Google Drive credentials and folder accessibility BEFORE download.
 * Throws a descriptive error if credentials are invalid or the folder cannot be reached.
 *
 * Two credential types are supported (auto-detected):
 *   - type: "service_account"  → Google Workspace / Shared Drives
 *   - type: "oauth2"           → Personal Google Drive (client_id + client_secret + refresh_token)
 */
export async function validateGoogleDrive(gdrive: GoogleDriveConfig): Promise<void> {
  const drive = createDriveClient(gdrive.credentials);

  try {
    await drive.files.get({
      fileId: gdrive.folderId,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });
  } catch (err: unknown) {
    const message = extractGoogleError(err);
    throw new Error(`Google Drive validation failed: ${message}`);
  }
}

/**
 * Uploads a readable stream to Google Drive and makes it publicly readable.
 * Returns the shareable URL and file ID.
 *
 * Accepts a Node.js Readable (e.g. yt-dlp stdout) — no temp file needed.
 */
export async function uploadStreamToGoogleDrive(
  stream: Readable,
  fileName: string,
  gdrive: GoogleDriveConfig,
): Promise<{ driveUrl: string; driveFileId: string }> {
  const drive = createDriveClient(gdrive.credentials);
  const mimeType = guessMimeType(fileName);

  let uploadedFile: drive_v3.Schema$File;

  try {
    const res = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: fileName,
        parents: [gdrive.folderId],
      },
      media: {
        mimeType,
        body: stream,
      },
      fields: 'id, name, webViewLink',
    });
    uploadedFile = res.data;
  } catch (err: unknown) {
    const message = extractGoogleError(err);
    throw new Error(`Google Drive upload failed: ${message}`);
  }

  if (!uploadedFile.id) {
    throw new Error('Google Drive upload succeeded but returned no file ID');
  }

  // Make file readable by anyone with the link
  try {
    await drive.permissions.create({
      fileId: uploadedFile.id,
      supportsAllDrives: true,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
    });
  } catch (err: unknown) {
    console.warn('[gdrive] Could not set public permission:', extractGoogleError(err));
  }

  const driveUrl =
    uploadedFile.webViewLink ??
    `https://drive.google.com/file/d/${uploadedFile.id}/view`;

  return { driveUrl, driveFileId: uploadedFile.id };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function createDriveClient(creds: GoogleDriveCredentials): drive_v3.Drive {
  if (creds.type === 'oauth2') {
    const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret);
    oauth2.setCredentials({ refresh_token: creds.refresh_token });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return google.drive({ version: 'v3', auth: oauth2 as any });
  }

  // Service account
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const auth = new google.auth.GoogleAuth({
    credentials: creds as any,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return google.drive({ version: 'v3', auth: auth as any });
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return map[ext] ?? 'application/octet-stream';
}

function extractGoogleError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e['message']) return String(e['message']);
    const errors = (e['errors'] as Array<Record<string, unknown>> | undefined)?.[0];
    if (errors?.['message']) return String(errors['message']);
  }
  return String(err);
}
