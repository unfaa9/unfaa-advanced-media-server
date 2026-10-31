# Errors

> API v1

Errors use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) `application/problem+json`:

```json
{
  "type": "https://media.unfaa.com/docs/errors#file_too_large",
  "title": "Request Entity Too Large",
  "status": 413,
  "code": "file_too_large",
  "detail": "file exceeds the 15728640-byte limit",
  "request_id": "9c1f2e3a4b5d6f708192a3b4"
}
```

Branch on **`code`** (stable), show `detail` to developers only, and log `request_id`.

| HTTP | `code` | When | What to do |
|---|---|---|---|
| 400 | `invalid_request` | missing/invalid params, not multipart, >1 file part, bad TTL, `actor` missing | fix the request; don't retry |
| 401 | `unauthorized` | missing/invalid/revoked/expired key | check the key; don't retry in a loop |
| 403 | `forbidden_scope` | key lacks the scope | request the right scope |
| 404 | `not_found` | unknown id or unknown account | treat as gone |
| 409 | `invalid_state` | confirm a deleted file, restore a non-deleted/purged file | fix your flow |
| 413 | `file_too_large` | over `MAX_FILE_BYTES` (≤ 15 MB) | tell the user |
| 415 | `unsupported_type` | detected type not allowed / kind not in `ALLOWED_KINDS` | tell the user which formats are accepted |
| 422 | `invalid_content` | corrupt image, decompression bomb (incl. animated GIFs over the frame-pixel budget), bad MP4/PDF/DOCX | ask for another file |
| 422 | `idempotency_key_reused` | the `Idempotency-Key` was already used within 24 h for an upload with **different query parameters** | bug in your client: use a new key per distinct upload |
| 429 | `rate_limited` | over the per-key rate, or too many failed API-key attempts from your IP | wait `Retry-After`, retry with backoff |
| 507 | `quota_exceeded` | account quota or server disk guard | free space / raise the quota |
| 500/503 | `internal` / `unavailable` | server fault | retry with backoff + the same `Idempotency-Key` |

## Retry guidance

- **Retry** (with exponential backoff + jitter): network errors, `429`, `500`, `502`, `503`, `504`.
- **Never retry unchanged**: `400`, `401`, `403`, `404`, `409`, `413`, `415`, `422`, `507`.
- Uploads: always send an `Idempotency-Key` so a retry cannot create a duplicate.
- `DELETE`, `confirm` are idempotent — retry freely.

## Delivery URL errors (not JSON)

| Status | Meaning |
|---|---|
| `404` | unknown/deleted file, bad id or extension, disallowed variant size, or a private/sensitive file on the wrong route |
| `403` | bad signature (or invalid sensitive grant) |
| `410` | signed URL expired — ask your backend for a new one |
| `429` | sensitive route rate limit (per IP) |
