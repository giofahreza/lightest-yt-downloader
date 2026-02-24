# Webhook Callback Guide

## Overview

The yt-downloader now supports webhook callbacks, allowing you to receive automatic notifications when download jobs complete. This is ideal for workflow automation tools like n8n, Make, Zapier, or custom applications.

## How It Works

1. **Submit a download job** with an optional `webhookUrl` parameter
2. **Receive immediate response** with `jobId` and status `"queued"`
3. **Webhook gets called automatically** when the job completes (success or failed)
4. **Process the result** in your workflow automation tool

## API Usage

### Request Format

```http
POST /download
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "quality": "best",
  "format": "mp4",
  "webhookUrl": "https://your-n8n-instance.com/webhook/your-webhook-id",
  "googleDrive": {
    "credentials": { ... },
    "folderId": "FOLDER_ID"
  }
}
```

### Webhook Payload

When the job completes, a POST request will be sent to your `webhookUrl` with this payload:

**Success Example:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "success",
  "title": "Amazing Video Title",
  "driveUrl": "https://drive.google.com/file/d/1abc.../view",
  "driveFileId": "1abc123def456",
  "createdAt": "2026-02-24T09:30:00.000Z",
  "completedAt": "2026-02-24T09:32:15.000Z"
}
```

**Failure Example:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "title": "Video Title",
  "error": "Video not found or unavailable",
  "createdAt": "2026-02-24T09:30:00.000Z",
  "completedAt": "2026-02-24T09:30:45.000Z"
}
```

**Local Download Example:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "success",
  "title": "Video Title",
  "localPath": "/app/downloads/Video_Title_abc123.mp4",
  "createdAt": "2026-02-24T09:30:00.000Z",
  "completedAt": "2026-02-24T09:32:15.000Z"
}
```

## n8n Integration

### Step 1: Create Webhook in n8n

1. Add a **Webhook** node to your workflow
2. Set **HTTP Method** to `POST`
3. Set **Path** to something like `/youtube-download-complete`
4. Copy the **Webhook URL** (e.g., `https://your-n8n.com/webhook/youtube-download-complete`)

### Step 2: Trigger Download from n8n

Add an **HTTP Request** node:

**Configuration:**
- **Method**: `POST`
- **URL**: `http://192.168.77.254:3000/download` (your yt-downloader server)
- **Body Content Type**: `JSON`
- **Body**:
  ```json
  {
    "url": "{{ $json.videoUrl }}",
    "quality": "best",
    "webhookUrl": "https://your-n8n.com/webhook/youtube-download-complete",
    "googleDrive": {
      "credentials": {{ $json.driveCredentials }},
      "folderId": "{{ $json.folderId }}"
    }
  }
  ```

### Step 3: Process Webhook Response

The webhook node will receive the job result. You can then:
- Check if `status === "success"` or `status === "failed"`
- Use `driveUrl` to share the file
- Use `driveFileId` for further Google Drive operations
- Use `localPath` if downloaded locally
- Handle errors from the `error` field

### Example n8n Workflow

```
[Trigger]
   ↓
[HTTP Request - Submit Download with webhookUrl]
   ↓
[End - Returns jobId]

---

[Webhook - Receives completion callback]
   ↓
[Switch - Check if status === "success"]
   ├─ Success → [Process video URL/path]
   └─ Failed → [Send error notification]
```

## Testing with curl

### Submit a download with webhook:

```bash
curl -X POST http://localhost:3000/download \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "quality": "720p",
    "webhookUrl": "https://webhook.site/your-unique-url"
  }'
```

You can use [webhook.site](https://webhook.site) to test and inspect webhook payloads.

## Error Handling

- If the webhook URL is invalid, the request will be rejected with HTTP 400
- If the webhook callback fails (network error, server down), it will be logged but won't affect the download job
- The job status will still be saved and can be polled via `GET /status/:jobId`

## Security Considerations

1. **Use HTTPS** for webhook URLs in production
2. **Validate webhook payloads** in your receiving application
3. **Consider adding authentication** (e.g., API key in webhook URL or custom headers)
4. **Rate limit** your webhook endpoint to prevent abuse

## Webhook vs Polling

| Feature | Webhook | Polling |
|---------|---------|---------|
| Efficiency | ✅ High (push-based) | ❌ Low (repeated requests) |
| Latency | ✅ Immediate notification | ❌ Depends on poll interval |
| Server Load | ✅ Minimal | ❌ Higher |
| Complexity | ⚠️ Requires public endpoint | ✅ Simple |
| Reliability | ⚠️ Network dependent | ✅ More reliable |

**Recommendation**: Use webhooks for automation workflows (n8n, Make, Zapier) and polling for simple scripts or testing.

## Support

For issues or questions, check the logs with:
```bash
pm2 logs yt-downloader
```

Look for `[webhook]` prefixed messages to debug webhook callbacks.
