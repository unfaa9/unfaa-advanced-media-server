# Unfaa Media Server: implemented features

> **Applies to:** API v1 (Node/TypeScript build) · **Base URL:** `https://media.unfaa.com` (local: `http://localhost:5000`)
> **Postman:** [`media-server.postman_collection.json`](media-server.postman_collection.json) (import it, then set `mediaBaseUrl` and `apiKey`)

This server is a Node port of the Go media server described in [`../docs/`](../docs/api/README.md). It stores, compresses, serves and deletes **images, short videos, PDFs and DOCX files** (≤ 15 MB each) for our backends. Backends upload and manage files with an API key. Browsers only read files through Cloudflare-cached public URLs.

---

## 1. Status at a glance

| Area | Status |
|---|---|
| Code for every feature below | ✅ Written, compiles (`npx tsc`) |
| Unit tests (media validation, compression, metadata stripping, rate limiter) | ✅ 11/11 pass (`npm test`) |
| Database-backed flows (upload, refs, dedup, quotas, delete/restore, jobs) | ⏳ **Not run yet.** Needs a dev `DATABASE_URL` |
| Integration tests, `curl.sh` end-to-end run | ⏳ Not written or run yet |
| Restic backup script, reverse-proxy config file | ❌ Not written (described in §11) |

## 2. How this differs from the Go docs

| Go docs | This server | Why |
|---|---|---|
| `public`, `private`, `sensitive` tiers | **Public only.** `visibility` is optional; anything except `public` → `400` | Product decision |
| Signed URLs (`/p`, `/s`), encryption at rest, audit logs, `audit:read` scope | **Not implemented** | Follows from public-only |
| One `owner_ref` per file; `DELETE` removes the file | **Many references per file.** The file is deleted when the last reference is removed (§5) | Same image shared by many users |
| Every upload is a new file | **Dedup by content:** identical bytes in the same account reuse the existing file (§6) | Saves disk and quota |
| `optimize=false` opt-out | **Always compressed** (§4) | Product decision |
| WebP/AVIF variants and HEIC only on the libvips build | WebP and AVIF variants **always** available (sharp ships libvips + mozjpeg + libimagequant). HEIC is still rejected | sharp's bundled libvips has no HEVC decoder |
| Docker on Coolify | **PM2** on a VPS behind a reverse proxy and Cloudflare | Product decision |
| `actor` / `optimize` query params, `actor` in `delete-by-owner` | **Rejected with `400`** (unknown parameter) | No audit log to write them to |

---

## 3. Authentication, scopes and limits

Every `/api/v1/files` and `/api/v1/accounts` call needs:

```
Authorization: Bearer msk_<43 base62 characters>
```

- **Key handling:** keys are created only with the admin CLI (§10) and shown **once**. Only a SHA-256 hash is stored.
- **Expiry and revocation:** keys can expire. A revoked key stops working within **60 s** (in-memory cache).
- **Wrong keys:** an unknown, revoked or expired key returns `401` with `WWW-Authenticate: Bearer`.

| Scope | Allows |
|---|---|
| `files:write` | upload, confirm, add reference |
| `files:read` | get / list files |
| `files:delete` | force delete, remove reference, delete-by-owner, restore |
| `accounts:write` | create, update, delete accounts |
| `accounts:read` | read account usage |

A missing scope returns `403 forbidden_scope`.

| Limit | Value | Error |
|---|---|---|
| File size | `MAX_FILE_BYTES` (default and maximum 15 MB), enforced while streaming | `413 file_too_large` |
| Parts per upload | exactly one part, named `file` | `400 invalid_request` |
| Image size | 50 MP (`MAX_IMAGE_PIXELS`). Animated: 2× across all frames | `422 invalid_content` |
| Allowed kinds | `ALLOWED_KINDS` (default `image,video,document`) | `415 unsupported_type` |
| Rate limit per key | `RATE_LIMIT_RPS` (default 20/s, burst 40) | `429 rate_limited` + `Retry-After` |
| Failed auth per client IP | burst 30, then 1/s. Blocks **all** requests from that IP while exceeded | `429 rate_limited` |
| Account quota | per account, default 5 GB | `507 quota_exceeded` |
| Disk guard | free disk < `MIN_FREE_DISK_PERCENT` (10 %) | `507 quota_exceeded` |
| Batch confirm | ≤ 100 ids | `400` |
| List page size | ≤ 200 (larger values are clamped) | — |
| Idempotency window | 24 h | — |

---

## 4. Uploading: `POST /api/v1/files`

The body is `multipart/form-data` with **exactly one part named `file`**. Options go in the query string, so the body can stream to disk without buffering.

| Query param | Default | Meaning |
|---|---|---|
| `confirm` | `false` | `true` = `active` immediately; `false` = `pending` until confirmed. Pending files are removed after 24 h |
| `purpose` | — | Free label, `[A-Za-z0-9_.:@-]`, ≤ 128 chars |
| `owner_ref` | — | First reference, `<entity>:<id>:<field>` (e.g. `user:123:avatar`), ≤ 255 printable chars |
| `account` | — | Your customer id (e.g. `agency_42`). Sets the quota and the dedup scope. Required when `REQUIRE_ACCOUNT=true` |
| `visibility` | `public` | Optional. Only `public` is accepted |

Header `Idempotency-Key` (≤ 255 chars, recommended):
- **Replay:** a retry within 24 h with the same key, same query and **same bytes** returns the first response with `Idempotent-Replay: true`.
- **Reuse:** the same key with different parameters or a different file returns `422 idempotency_key_reused`.
- **Concurrency:** concurrent requests with the same key are serialized.

```bash
curl -sS -X POST "$MEDIA/api/v1/files?confirm=true&purpose=avatar&owner_ref=user:123:avatar&account=agency_42" \
  -H "Authorization: Bearer $KEY" -H "Idempotency-Key: avatar-123-$(uuidgen)" -F "file=@photo.jpg"
```

**Response:** `201 Created` (new file) or `200 OK` (deduplicated, §6):

```json
{
  "id": "0192f3c4-7a1b-7c2e-9d10-5b6c7d8e9f00",
  "status": "active",
  "visibility": "public",
  "kind": "image",
  "mime": "image/jpeg",
  "size": 482113,
  "original_size": 1904220,
  "compressed": true,
  "sha256": "9f86d0…",
  "width": 1600,
  "height": 1067,
  "url": "https://media.unfaa.com/f/0192f3c4-….jpg",
  "variants_url_template": "https://media.unfaa.com/i/0192f3c4-…/{w}.{fmt}",
  "account": "agency_42",
  "purpose": "avatar",
  "original_name": "photo.jpg",
  "refs": ["user:123:avatar"],
  "ref_count": 1,
  "created_at": "2026-10-27T08:00:00.000Z",
  "confirmed_at": "2026-10-27T08:00:00.000Z",
  "deleted_at": null
}
```

- **Field presence:** `url` and `variants_url_template` appear only while the file is `pending` or `active`. `variants_url_template` appears only for JPEG, PNG and WebP images. Videos also return `meta.faststart`.
- **`sha256`:** the hash of the **stored** bytes, after compression.

### What the server does to each file

| Step | Detail |
|---|---|
| Type check | **Magic bytes only** (`file-type`). Filename, extension and `Content-Type` are ignored. SVG, HTML, XML, MOV, AVI, MKV, HEIC and others → `415` |
| Allowed | JPEG, PNG, WebP, GIF · MP4 (incl. M4V), WebM · PDF · DOCX |
| Images | Decoded with the pixel limit (bombs/corrupt → `422`) · EXIF orientation applied · EXIF/GPS/XMP/comments removed · ICC colour profile kept · **re-compressed at the same resolution** |
| JPEG | mozjpeg, quality 80 (`IMAGE_JPEG_QUALITY`) |
| PNG | Palette quantisation (libimagequant, like TinyPNG). Used only if it stays visually close (PSNR ≥ 38 dB); otherwise lossless max-compression. Photos saved as PNG therefore stay lossless |
| WebP | Re-encoded at quality 80, or lossless if the source was lossless |
| GIF | Re-encoded with animation kept. Total frame pixels capped at 2 × `MAX_IMAGE_PIXELS` |
| Never bigger | The re-encode is kept only if it is ≥ 5 % smaller (`IMAGE_MIN_SAVING_PERCENT`). Otherwise the **original pixels** are kept and metadata is stripped losslessly at the byte level |
| MP4 | Top-level boxes checked (`ftyp` first, `moov` + `mdat` present, sizes add up). `meta.faststart` is `true` when `moov` comes before `mdat`. Stored as-is |
| WebM | EBML header and Segment element checked. Stored as-is |
| PDF | `%PDF-` header and `%%EOF` near the end. Stored as-is |
| DOCX | Must contain `[Content_Types].xml` and `word/document.xml`. Rejected: macros (`vbaProject.bin`), path traversal, more than 5000 entries, more than 200 MB unpacked, or a compression ratio above 200 |
| Write | Temp file → fsync → atomic rename into `files/YYYY/MM/DD/<id>.<ext>`, in the same DB transaction that inserts the row |

Compression finishes **before** the response, so the returned URL always points at the final bytes.

---

## 5. File lifecycle and shared references

```
           upload(confirm=false)            confirm
 (none) ──────────────────────► pending ──────────────► active
                                   │ 24 h unconfirmed      │ last reference removed,
                                   ▼                       │ or force DELETE
                                 purged                    ▼
                                                        deleted ──restore (≤ 7 days)──► active
                                                           │ 7 days
                                                           ▼
                                                         purged   (bytes + variants removed; row kept)
```

| State | Served at `/f`? | Counts toward quota? |
|---|---|---|
| `pending` | yes | yes |
| `active` | yes | yes |
| `deleted` | **no (404 immediately)** | no |
| `purged` | no | no |

### References: one file, many owners

A file holds a set of `owner_ref`s (table `file_refs`). The same image can be used by several users or records, and it stays until **the last owner releases it**.

| Endpoint | Scope | Behaviour |
|---|---|---|
| `POST /files?owner_ref=…` / `POST /files/{id}/confirm {owner_ref}` | `files:write` | Adds that reference (idempotent) |
| `POST /files/{id}/refs` `{ "owner_ref": "user:456:avatar" }` | `files:write` | Attaches another owner. `409 invalid_state` if the file is deleted |
| `DELETE /files/{id}/refs` `{ "owner_ref": "user:456:avatar" }` (or `?owner_ref=`) | `files:delete` | Removes one owner → `{ id, removed, remaining_refs, status }`. If this removed the **last** reference and the file was pending or active, the file is deleted (trash + CDN purge). Removing an owner the file doesn't have deletes nothing |
| `POST /files/delete-by-owner` `{ "owner_ref_prefix": "user:123:" }` | `files:delete` | Removes every reference under the prefix and deletes only the files left with **no** references → `{ refs_removed, files_deleted, deleted }`. The prefix must be ≥ 3 chars and end with `:`. `%` and `_` are literal |
| `DELETE /files/{id}` | `files:delete` | **Force delete.** Returns `409 has_references` while references exist, unless `?force=true`. `204` on success. Idempotent for already deleted or purged files. Unknown id → `404` |

- **Concurrency:** every reference change locks the file row (`SELECT … FOR UPDATE`). Two owners removing their references at the same time delete the file exactly once, and a reference added concurrently is never lost.
- **Files without references:** a file confirmed without any `owner_ref` has zero references. It is removed only by an explicit `DELETE` or by `DELETE /accounts/{ref}`. The weekly reconcile reports how many such files exist.

### Other lifecycle endpoints

| Endpoint | Scope | Behaviour |
|---|---|---|
| `GET /files/{id}` | `files:read` | File object incl. `refs` and `ref_count` |
| `GET /files?cursor=&limit=50&status=&purpose=&account=&owner_ref=` | `files:read` | Newest first → `{ data, next_cursor }`. `owner_ref` = files that have that exact reference |
| `POST /files/{id}/confirm` `{ owner_ref? }` | `files:write` | `pending → active`, idempotent for `active`. `409 invalid_state` for deleted or purged |
| `POST /files/confirm` `{ ids: [≤100], owner_ref? }` | `files:write` | All-or-nothing: an unknown id → `404`, a deleted one → `409`, and nothing changes. Returns `{ data: [...] }` |
| `POST /files/{id}/restore` | `files:delete` | `deleted → active` within 7 days, if the bytes are still in trash. Re-checks the quota (`507`) and revives a deleted account. `409` if outside the window, or if an identical live copy now exists in the account |

**Recommended client flows:**
- **Avatar:** upload with `confirm=true&owner_ref=user:123:avatar` → store the id → remove the old avatar's reference.
- **Gallery:** upload images as pending → save your post → `POST /files/confirm` with `owner_ref=post:77:images`.
- **Delete user:** `delete-by-owner` with prefix `user:123:`.

Send removals from a transactional outbox (see [`../docs/api/recipes/outbox-pattern.md`](../docs/api/recipes/outbox-pattern.md)). The removal calls are idempotent, so retries are safe.

---

## 6. Dedup by content

- **Matching:** a file matches when its **uploaded** bytes (`upload_sha256`, hashed before compression) are identical to a live (`pending`/`active`) file **in the same account**. Files without an account dedupe among themselves. The lookup happens before compression, so duplicates cost no CPU.
- **On a match:**
  - The new upload is discarded.
  - Its `owner_ref` is added to the existing file.
  - A pending file is promoted to `active` if `confirm=true`.
  - The response is **`200`** with the existing file plus `"deduplicated": true`.
  - The quota is **not** charged again.
- **Different accounts** never share a file, so each agency's quota stays exact.
- **Race safety:** a partial unique index `(account, upload_sha256) WHERE status IN ('pending','active')` makes concurrent identical uploads produce exactly one file.

---

## 7. Delivery and Cloudflare CDN

| URL | What | Notes |
|---|---|---|
| `GET /f/{id}.{ext}` | Original | `GET`, `HEAD`, `Range` (206, video seeking), `If-None-Match` → 304 |
| `GET /i/{id}/{w}.{fmt}` | Image variant | `w` ∈ 64, 128, 256, 512, 768, 1024, 1536, 2048 · `fmt` ∈ `jpg`, `png`, `webp`, `avif`. Anything else → 404 |

- **No DB on the read path:** delivery reads straight from disk. The URL maps to the file path, so deleted files 404 immediately.
- **Variant rendering:** never upscaled, always sRGB and metadata-free, and transparent images get a white background in `jpg`. The first request renders the variant and caches it at `variants/<id>/<w>.<fmt>`. Concurrent requests for the same variant share one render, and renders are bounded to one per CPU.
- **Which files have variants:** JPEG, PNG and WebP originals. GIF, video and documents have none (404).

**Headers on public responses:**

| Header | Value |
|---|---|
| `Cache-Control` | `public, max-age=604800, immutable` (browser 7 days) |
| `CDN-Cache-Control` | `max-age=31536000` (Cloudflare edge 1 year; purged on delete) |
| `ETag` | Originals: size + mtime. Variants: size + key, because the LRU touches mtime |
| `Content-Type` | Canonical type of the stored file |
| `Content-Disposition` | `inline`; DOCX: `attachment; filename="<id>.docx"` |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` (PDF: `default-src 'none'`, so Chrome's viewer works) |
| `Access-Control-Allow-Origin` | `*` |
| `Cross-Origin-Resource-Policy` | `cross-origin` |

### CDN purge on delete (`CDN_PROVIDER`)

| `CDN_PROVIDER` | Behaviour |
|---|---|
| `none` (default) | No purge. Use for local development |
| `cloudflare` | Requires `CF_ZONE_ID` **and** `CF_API_TOKEN` (token permission: *Zone → Cache Purge* only). The server **refuses to start** if either is missing |

- **What is purged:** whenever a file really leaves the served tree (last reference removed, force delete, account delete, orphan sweep, admin purge), a `cdn_purge` job is queued **in the same DB transaction**. It covers the original URL plus every variant URL: 8 widths × 4 formats, sent in batches of 30.
- **Retries:** the worker calls the Cloudflare purge API with exponential backoff (30 s → 1 h, ±20 % jitter) and up to 10 attempts. After that the job stays in the table as dead and is counted by `media_jobs_dead`.
- **Browser caveat:** browsers can't be purged. A user who already viewed a deleted public file may still see it from their own cache for up to 7 days.

---

## 8. Accounts and quotas

| Endpoint | Scope | Behaviour |
|---|---|---|
| `PUT /api/v1/accounts/{ref}` `{ "quota_bytes": 21474836480 }` | `accounts:write` | Create or update. `quota_bytes` is required; `null` = unlimited. Lowering it below usage is allowed: existing files stay, new uploads get `507` |
| `GET /api/v1/accounts/{ref}` | `accounts:read` | `{ ref, quota_bytes, used_bytes, file_count, usage_percent, deleted }` (`usage_percent` is `null` when unlimited) |
| `DELETE /api/v1/accounts/{ref}` | `accounts:write` | Soft-deletes **all** live files of the account (regardless of references; 7-day trash) and marks it deleted → `{ deleted_files }` |

- **Auto-creation:** an account is created on its first upload with `DEFAULT_ACCOUNT_QUOTA_BYTES` (5 GB; `0` = unlimited).
- **What counts:** the **stored** (compressed) size of `pending` + `active` files. Deleting releases bytes immediately, and restoring re-checks the quota.
- **Atomic enforcement:** `UPDATE … WHERE used_bytes + size <= quota_bytes`, so concurrent uploads can never exceed the quota.
- **Deletion races:** uploading again revives a deleted account. The account row lock serializes uploads against account deletion.
- **Drift:** counters are recomputed weekly by `reconcile`.

---

## 9. Errors

`/api/v1/files` and `/api/v1/accounts` return RFC 9457 `application/problem+json`. Every response carries an `X-Request-Id` header; send your own to correlate requests.

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

| HTTP | `code` | When | Retry? |
|---|---|---|---|
| 400 | `invalid_request` | Bad or unknown params, not multipart, ≠ 1 file part, empty file, bad JSON | no |
| 401 | `unauthorized` | Missing, invalid, revoked or expired key | no |
| 403 | `forbidden_scope` | Key lacks the scope | no |
| 404 | `not_found` | Unknown file id, account or route | no |
| 409 | `invalid_state` | Confirming a deleted file, restoring outside the window, etc. | no |
| 409 | `has_references` | `DELETE /files/{id}` without `force=true` while references exist | no |
| 413 | `file_too_large` | Over `MAX_FILE_BYTES` | no |
| 415 | `unsupported_type` | Detected type not allowed, or kind not in `ALLOWED_KINDS` | no |
| 422 | `invalid_content` | Corrupt image, bomb, bad MP4/PDF/DOCX, macro DOCX | no |
| 422 | `idempotency_key_reused` | Same key, different params or bytes | no |
| 429 | `rate_limited` | Per-key rate or failed-auth throttle (`Retry-After` sent) | yes, after `Retry-After` |
| 507 | `quota_exceeded` | Account quota or disk guard | no |
| 500 | `internal` | Server fault | yes, with the same `Idempotency-Key` |

Delivery URLs (`/f`, `/i`) answer a plain-text `404` for unknown or deleted files and for disallowed sizes or formats.

---

## 10. Operations

### Background jobs (in-process)

Each periodic job is claimed with an atomic `UPDATE` on `job_runs`, so a tick runs once even if two processes share the DB. A failed run retries after 10 minutes.

| Job | Every | What |
|---|---|---|
| `cdn_purge` worker | 5 s poll | Sends queued purges to Cloudflare. Jobs are claimed with `FOR UPDATE SKIP LOCKED` |
| `orphan_sweep` | 15 min | Purges `pending` files older than `PENDING_TTL_HOURS` (24) |
| `trash_purge` | 1 h | Permanently removes files deleted more than `TRASH_RETENTION_HOURS` (168) ago |
| `tmp_sweep` | 1 h | Removes `tmp/` leftovers older than 1 h (crashed uploads) |
| `variant_lru` | 1 day | Trims the variant cache to 80 % of `VARIANT_CACHE_MAX_BYTES` (10 GB), least recently used first |
| `idempotency_expiry` | 1 day | Drops idempotency keys older than 24 h |
| `reconcile` | 7 days | Moves orphan files on disk (no live row, > 24 h old) to trash · reports live rows with missing bytes · fixes account usage drift · counts active files without references |
| `storage_gauges` | 1 min | Disk-free and files-by-status metrics |

### Admin CLI

In production run `npm run admin -- …` (`node dist/cli.js admin …`). In dev use `npm run admin:dev -- …`.

```bash
npm run admin -- key create --name backend-prod --expires 365d   # all scopes by default; prints the key ONCE
npm run admin -- key create --name reports --scopes files:read
npm run admin -- key list
npm run admin -- key revoke --id <uuid>          # effective ≤ 60 s
npm run admin -- file purge --id <uuid>          # emergency/legal removal now (+ CDN purge)
npm run admin -- reconcile --dry-run             # report only; drop --dry-run to fix
```

### Health and metrics

- **`GET /healthz`:** the process is up.
- **`GET /readyz`:** the DB answers and the storage volume is writable; otherwise `503` with a `checks` object.
- **Prometheus:** `http://127.0.0.1:${METRICS_PORT}/metrics` (default 9090). It binds to localhost only and must never be proxied. Metrics:
  - HTTP: `http_requests_total`, `http_request_duration_seconds`.
  - Uploads: `media_uploads_total{kind,result}`, `media_upload_bytes_total`, `media_compression_saved_bytes_total`.
  - Variants: `media_variant_generations_total`, `media_variant_duration_seconds`.
  - Storage: `media_disk_free_bytes`, `media_files_total{status}`, `media_missing_files`, `media_quota_drift_bytes`.
  - Jobs: `media_jobs_total`, `media_jobs_pending`, `media_jobs_dead`.
- **Logs:** pino JSON with the request id, method, path (no query string) and status. `Authorization`, cookies and `Idempotency-Key` are redacted.

### Client IP and proxies

- **Default walk:** `X-Forwarded-For` is walked back through `TRUSTED_PROXIES` (default `loopback`).
- **Behind Cloudflare:** add `cloudflare` to `TRUSTED_PROXIES`. `CF-Connecting-IP` is then trusted **only** when the walk ends at a Cloudflare edge address, so clients hitting the VPS IP directly can't forge it. This client IP drives the failed-auth throttle.

### Graceful shutdown

On `SIGTERM`/`SIGINT`, the server stops accepting connections, drains in-flight requests (25 s grace), stops the job loops and closes the DB pool.

---

## 11. Deployment (PM2, no Docker)

1. **Postgres:** create a database and set `DATABASE_URL`.
2. **Persistent disk:** set `STORAGE_PATH` to a persistent volume (e.g. `/mnt/data/media`). The server creates `tmp/`, `files/`, `variants/` and `trash/` inside it. Keep `tmp/` on the same volume so renames stay atomic.
3. **Build and start:**
   ```bash
   npm ci && npm run build && npm run db:migrate
   pm2 start ecosystem.config.js --env production   # fork mode, 1 instance
   ```
   Run **one instance**: rate limits, idempotency locks and variant de-duplication live in process memory.
4. **Reverse proxy** (nginx/Caddy) → `localhost:$PORT`. Allow request bodies ≥ 11 MB (nginx: `client_max_body_size 11m`). Health check path: `/readyz`.
5. **Cloudflare:**
   - DNS `media` record **proxied**, SSL **Full (strict)**.
   - Cache rules: `/f/*`, `/i/*` → eligible for cache (respect origin headers). `/api/*`, `/healthz`, `/readyz` → bypass.
   - WAF rate-limit rule on `/i/*` (variant rendering is the only CPU-heavy public route).
   - API token with *Zone → Cache Purge* only → `CF_API_TOKEN`. Then set `CDN_PROVIDER=cloudflare` and `TRUSTED_PROXIES=loopback,cloudflare`.
6. **First key:** `npm run admin -- key create --name backend-prod --expires 365d`.
7. **Backups (not scripted yet):** run nightly restic of `STORAGE_PATH`, excluding `variants/` and `tmp/`, plus Postgres dumps. After a restore, run `npm run admin -- reconcile --dry-run`.

All environment variables are documented in [`../.env.example`](../.env.example). The config is validated at startup, and the process exits on invalid values.

---

## 12. Legacy endpoints (removed)

The old `/api/v1/uploadImg`, `/api/v1/uploadVideo` routes and the static `/uploads/img/*`, `/uploads/videos/*` mounts
were removed on 2026-10-31. Every client uses `/api/v1/files`.

---

## 13. Code map

| Path | Purpose |
|---|---|
| `src/app/modules/files/` | Upload, list/get, confirm, references, delete/restore/purge (`files.service.ts`) |
| `src/app/modules/accounts/` | Accounts API and the atomic quota helpers (`accounts.quota.ts`) |
| `src/app/modules/delivery/` | `/f` and `/i` with CDN headers |
| `src/app/modules/health/` | `/healthz`, `/readyz` |
| `src/app/middlewares/` | `apiKeyAuth` (+ `requireScope`, rate limits), `problemErrorHandler`, `requestId` |
| `src/lib/media/` | Sniffing, image compression, metadata stripping, MP4/WebM/PDF/DOCX validation |
| `src/lib/variants/` | Variant rendering with singleflight |
| `src/lib/storage/` | Disk layout (paths derived from id + ext) and atomic file operations |
| `src/lib/upload/` | Streaming multipart receiver, idempotency |
| `src/lib/cdn/` | URL list + Cloudflare purge client |
| `src/lib/auth/`, `src/lib/net/` | API keys, token buckets, client-IP resolution |
| `src/jobs/` | Scheduler, CDN purge worker, sweepers, reconcile |
| `src/cli.ts` | Admin CLI |
| `prisma/schema.prisma`, `prisma/migrations/0001_init/` | Tables `api_keys`, `accounts`, `files`, `file_refs`, `jobs`, `job_runs`, `idempotency_keys`, plus hand-written partial/unique indexes |
| `test/unit/` | Vitest unit tests |
| `ecosystem.config.js` | PM2 config |
