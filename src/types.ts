/**
 * Service account credentials (for Google Workspace / Shared Drives).
 * Pass the full downloaded service account JSON key object.
 */
export interface ServiceAccountCredentials {
  type: 'service_account';
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  [key: string]: unknown;
}

/**
 * OAuth2 credentials (for personal Google Drive accounts).
 * Obtain client_id/client_secret from Google Cloud Console → OAuth2 client,
 * then generate a refresh_token via the OAuth2 playground or your own flow.
 */
export interface OAuth2Credentials {
  type: 'oauth2';
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export type GoogleDriveCredentials = ServiceAccountCredentials | OAuth2Credentials;

export interface GoogleDriveConfig {
  /** Service account JSON key OR OAuth2 credentials object */
  credentials: GoogleDriveCredentials;
  /** Google Drive folder ID to upload into */
  folderId: string;
}

export type VideoQuality = 'best' | '1080p' | '720p' | '480p' | '360p';

export interface DownloadRequest {
  /** YouTube video URL */
  url: string;
  /** Video quality — defaults to "best" */
  quality?: VideoQuality;
  /** Output format — only "mp4" is supported for streaming */
  format?: 'mp4';
  /** If provided, stream directly to Google Drive; otherwise save locally */
  googleDrive?: GoogleDriveConfig;
}

export type JobStatus = 'queued' | 'in_progress' | 'success' | 'failed';

export interface JobResult {
  jobId: string;
  status: JobStatus;
  title?: string;
  localPath?: string;
  driveUrl?: string;
  driveFileId?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
}
