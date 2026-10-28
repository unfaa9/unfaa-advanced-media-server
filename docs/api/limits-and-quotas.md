# Limits and quotas

> API v1

| Limit | Value | Error |
|---|---|---|
| File size | **10 MB** per file (`MAX_FILE_BYTES` may set a lower limit, never higher) | `413 file_too_large` |
| Files per request | exactly 1 | `400` |
| Image size | 50 megapixels; corrupt/oversized → | `422 invalid_content` |
| Allowed kinds | `ALLOWED_KINDS` (default `image,video,document`) | `415 unsupported_type` |
| Account storage quota | set per account via API (default 5 GB) | `507 quota_exceeded` |
| Server disk low (< 10 % free) | protective stop for all uploads | `507 quota_exceeded` |
| Rate limit | per API key, token bucket: `RATE_LIMIT_RPS` (default 20 rps, burst 2×) | `429 rate_limited` + `Retry-After` |
| Batch confirm | ≤ 100 ids | `400` |
| Signed URL TTL | private ≤ 7 d, sensitive ≤ 5 min | `400` |
| `GET /files` page size | ≤ 200 | clamped |
| Idempotency window | 24 h | — |

Failed authentication is also throttled per client IP (burst of 30 failures, then 1 per second): a backend
retrying with a revoked key will see `429` for **all** requests from that IP until it stops. Fix the key first.

On `429` wait `Retry-After` seconds, then retry with backoff and jitter. The public delivery URLs (`/f`, `/i`)
are not rate limited by the origin (Cloudflare protects them).

For bulk imports throttle your uploader to ~half your `rate_limit_rps` and use `Idempotency-Key`s so a crashed
import can resume.
