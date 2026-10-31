#New Media Server APIs (v1)

This document covers the endpoints that are actually registered in the server today (`src/app/routes/index.ts`,
`src/app/modules/*/**.route.ts`). For the deeper design notes see `docs/api/`.

- **Base URL:** `{{mediaBaseUrl}}` (e.g. `https://media-server.unfaa.com`)
- **API prefix:** `/api/v1`
- **Auth:** `Authorization: Bearer <api key>` on every `/api/v1/files` and `/api/v1/accounts` call
- **Bodies:** JSON (`Content-Type: application/json`), except the upload, which is `multipart/form-data`
- **IDs:** file ids are UUIDv7; account refs are your own strings (`[A-Za-z0-9_.:@-]`, ≤ 128 chars)
- **Times:** RFC 3339, UTC
- **Request id:** every response has `X-Request-Id`. Send your own to correlate, and quote it when reporting a problem.

## Endpoint summary

| Method | Path                            | Scope            | Purpose                                                               |
| ------ | ------------------------------- | ---------------- | --------------------------------------------------------------------- |
| POST   | `/api/v1/files`                 | `files:write`    | Upload one file                                                       |
| GET    | `/api/v1/files`                 | `files:read`     | List files (cursor paginated)                                         |
| GET    | `/api/v1/files/:id`             | `files:read`     | Get one file                                                          |
| POST   | `/api/v1/files/:id/confirm`     | `files:write`    | Confirm a pending file                                                |
| POST   | `/api/v1/files/confirm`         | `files:write`    | Confirm up to 100 files at once                                       |
| POST   | `/api/v1/files/:id/refs`        | `files:write`    | Add an owner reference                                                |
| DELETE | `/api/v1/files/:id/refs`        | `files:delete`   | Remove an owner reference (deletes the file when it was the last one) |
| POST   | `/api/v1/files/delete-by-owner` | `files:delete`   | Remove all references under an owner prefix                           |
| DELETE | `/api/v1/files/:id`             | `files:delete`   | Delete a file (soft delete, goes to trash)                            |
| POST   | `/api/v1/files/:id/restore`     | `files:delete`   | Restore a file from trash                                             |
| PUT    | `/api/v1/accounts/:ref`         | `accounts:write` | Create an account or update its quota                                 |
| GET    | `/api/v1/accounts/:ref`         | `accounts:read`  | Get an account's quota and usage                                      |
| DELETE | `/api/v1/accounts/:ref`         | `accounts:write` | Delete an account and all its files                                   |
| GET    | `/f/:id.:ext`                   | none             | Public file delivery                                                  |
| GET    | `/i/:id/:w.:fmt`                | none             | Public resized image variant                                          |
| GET    | `/healthz`                      | none             | Liveness                                                              |
| GET    | `/readyz`                       | none             | Readiness (database and storage)                                      |


---

## Authentication and rate limits

Every `/api/v1/files*` and `/api/v1/accounts*` request needs:

```
Authorization: Bearer msk_xxxxxxxxxxxxxxxx
```

API keys carry scopes: `files:read`, `files:write`, `files:delete`, `accounts:read`, `accounts:write`.

| Situation                                                     | Response                           |
| ------------------------------------------------------------- | ---------------------------------- |
| Missing, invalid, revoked or expired key                      | `401 unauthorized`                 |
| Key lacks the endpoint's scope                                | `403 forbidden_scope`              |
| Over the per-key rate (`RATE_LIMIT_RPS`, burst of 2×)         | `429 rate_limited` + `Retry-After` |
| Too many failed key attempts from one IP (burst 30, then 1/s) | `429 rate_limited` + `Retry-After` |

Never send the API key from a browser. Only your backend should call these endpoints.

---

## File object

Most `/files` endpoints return this shape:

```json
{
  "id": "0192f3c4-7a1b-7c2e-9d10-5b6c7d8e9f00",
  "status": "active",
  "visibility": "public",
  "kind": "image",
  "mime": "image/png",
  "size": 482113,
  "original_size": 1904220,
  "compressed": true,
  "sha256": "9f86d081884c7d65…",
  "width": 1600,
  "height": 1067,
  "url": "https://media-server.unfaa.com/f/0192f3c4-7a1b-7c2e-9d10-5b6c7d8e9f00.png",
  "variants_url_template": "https://media-server.unfaa.com/i/0192f3c4-7a1b-7c2e-9d10-5b6c7d8e9f00/{w}.{fmt}",
  "account": "agency_42",
  "purpose": "avatar",
  "original_name": "photo.png",
  "refs": ["user:123:avatar"],
  "ref_count": 1,
  "created_at": "2026-10-28T08:00:00.000Z",
  "confirmed_at": "2026-10-28T08:00:00.000Z",
  "deleted_at": null
}
```

| Field                    | Notes                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| `status`                 | `pending` → `active` → `deleted` → `purged` (see [Lifecycle](#file-lifecycle)) |
| `kind`                   | `image`, `video` or `document`                                                 |
| `size` / `original_size` | Stored bytes vs. uploaded bytes. `compressed` is `true` when stored is smaller |
| `width` / `height`       | Images only, otherwise `null`                                                  |
| `url`                    | Present only while the file is `pending` or `active`                           |
| `variants_url_template`  | Present only for live images, except GIF                                       |
| `meta`                   | Present only for videos (e.g. `faststart`)                                     |
| `refs` / `ref_count`     | Owner references attached to the file                                          |

Store the **`id`** in your database. Build URLs from it, or store `url`.

---

## Files

### POST `/api/v1/files`: upload

Scope `files:write`. Uploads exactly one file.

**Body:** `multipart/form-data` with **exactly one part named `file`**, and that part must be a file. Any other
form field, or a second file, is rejected. All options go in the **query string**.

**Query parameters**

| Param        | Required                       | Default  | Description                                                                                             |
| ------------ | ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `confirm`    | no                             | `false`  | `true` makes the file `active` immediately. With `false` it stays `pending` until you confirm it        |
| `purpose`    | no                             | –        | Free-form label, e.g. `avatar`, `invoice` (`[A-Za-z0-9_.:@-]`, ≤ 128)                                   |
| `owner_ref`  | no                             | –        | Owner reference such as `user:123:avatar` (printable ASCII, no spaces, ≤ 255). Enables ref-based delete |
| `account`    | only if `REQUIRE_ACCOUNT=true` | –        | Your customer id, e.g. `agency_42`. Quotas are tracked per account and the account is auto-created      |
| `visibility` | no                             | `public` | Only `public` is supported for now                                                                      |

Unknown query parameters are rejected (`400`).

**Headers**

| Header            | Description                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorization`   | `Bearer <key>`                                                                                                                                                                                                                                  |
| `Idempotency-Key` | Optional, 1–255 chars, recommended. A retry with the same key, the same query params and the same bytes returns the original response with `Idempotent-Replay: true`. The same key with a different upload returns `422 idempotency_key_reused` |

Don't set `Content-Type` yourself. Let your HTTP client generate it so the multipart boundary is included.

**Example**

```bash
curl -X POST "{{mediaBaseUrl}}/api/v1/files?confirm=true&purpose=avatar&owner_ref=user:123:avatar&account=agency_42" \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: user-123-avatar-1" \
  -F "file=@./avatar.png"
```

In Postman: Body → form-data → one row, key `file`, type **File**, with nothing else enabled.

**Responses**

- `201 Created`: new file, returns the [file object](#file-object).
- `200 OK`: the same bytes already exist for this account (deduplicated). You get the existing file back, with
  your `owner_ref` added and, if `confirm=true`, the file confirmed.

**What the server does with the file**

| Step               | Detail                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type detection     | By magic bytes only. Filename, extension and `Content-Type` are ignored                                                                                                            |
| Allowed types      | JPEG, PNG, WebP, GIF · MP4, WebM · PDF · DOCX. Anything else returns `415`. Kinds can be limited with `ALLOWED_KINDS`                                                              |
| Size limit         | `MAX_FILE_BYTES` (default 15 MB), enforced while streaming → `413`                                                                                                                 |
| Images             | Pixel limit (`MAX_IMAGE_PIXELS`), metadata stripped, orientation applied, re-compressed at the same resolution. Kept as-is if the saving would be below `IMAGE_MIN_SAVING_PERCENT` |
| Video / PDF / DOCX | Structure validated and stored as uploaded                                                                                                                                         |
| Disk / quota       | Rejected with `507` if the account quota is exceeded or free disk falls below `MIN_FREE_DISK_PERCENT`                                                                              |

---

### GET `/api/v1/files`: list

Scope `files:read`. Returns newest first.

| Query       | Description                                |
| ----------- | ------------------------------------------ |
| `limit`     | 1–200, default 50                          |
| `cursor`    | The `next_cursor` from the previous page   |
| `status`    | `pending`, `active`, `deleted` or `purged` |
| `purpose`   | Filter by purpose                          |
| `account`   | Filter by account ref                      |
| `owner_ref` | Files that have this exact reference       |

```bash
curl "{{mediaBaseUrl}}/api/v1/files?account=agency_42&status=active&limit=20" -H "Authorization: Bearer $KEY"
```

```json
{ "data": [{ "id": "…", "status": "active" }], "next_cursor": "0192f3c4-…" }
```

`next_cursor` is `null` on the last page.

---

### GET `/api/v1/files/:id`: get one

Scope `files:read`. Returns the [file object](#file-object), or `404 not_found`.

```bash
curl "{{mediaBaseUrl}}/api/v1/files/0192f3c4-…" -H "Authorization: Bearer $KEY"
```

---

### POST `/api/v1/files/:id/confirm`: confirm one

Scope `files:write`. Moves a `pending` file to `active`. Confirming an already active file is a no-op, so
retrying is safe.

Body (optional):

```json
{ "owner_ref": "user:123:avatar" }
```

`owner_ref`, when given, is added as a reference at the same time.

Returns the file object. A `deleted` or `purged` file returns `409 invalid_state`.

---

### POST `/api/v1/files/confirm`: confirm many

Scope `files:write`. All-or-nothing: if any id is unknown (`404`) or not live (`409`), nothing changes.

```json
{ "ids": ["0192f3c4-…", "0192f3c5-…"], "owner_ref": "product:55:gallery" }
```

`ids` takes 1–100 entries. `owner_ref` is optional and is added to every file.

Response: `{ "data": [ <file object>, … ] }`

---

### POST `/api/v1/files/:id/refs`: add a reference

Scope `files:write`. Use this when another record starts using the same file. Adding an existing reference is
a no-op.

```json
{ "owner_ref": "post:88:cover" }
```

Returns the file object. Returns `409 invalid_state` if the file is not live.

---

### DELETE `/api/v1/files/:id/refs`: remove a reference

Scope `files:delete`. Removes one owner's reference. **If it was the last reference, the file is deleted**
(it goes to trash).

Send `owner_ref` in the JSON body or as a query param. Use the query param when a proxy strips DELETE bodies.

```bash
curl -X DELETE "{{mediaBaseUrl}}/api/v1/files/0192f3c4-…/refs?owner_ref=user:123:avatar" \
  -H "Authorization: Bearer $KEY"
```

```json
{
  "id": "0192f3c4-…",
  "removed": true,
  "remaining_refs": 0,
  "status": "deleted"
}
```

---

### POST `/api/v1/files/delete-by-owner`: bulk remove by prefix

Scope `files:delete`. Removes every reference that starts with the prefix. Only files left with **no**
references are deleted. Use this when deleting a user, product and so on.

```json
{ "owner_ref_prefix": "user:123:" }
```

The prefix must be 3–255 chars and **must end with `:`**.

```json
{ "refs_removed": 4, "files_deleted": 3, "deleted": 3 }
```

---

### DELETE `/api/v1/files/:id`: delete

Scope `files:delete`. Soft-deletes the file. The bytes move to trash, the file stops being served, a CDN purge
is queued, and its size leaves the account's quota. Deleting an already deleted file returns `204` again, so
retrying is safe.

| Query   | Description                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------ |
| `force` | `true` deletes even when references remain. Without it, a referenced file returns `409 has_references` |

Response: `204 No Content`.

---

### POST `/api/v1/files/:id/restore`: restore

Scope `files:delete`. Brings a `deleted` file back to `active`, but only within the trash window
(`TRASH_RETENTION_HOURS`, default 168 h = 7 days). Otherwise returns `409 invalid_state`.

Returns the file object.

---

## Accounts

Accounts are your customers (agencies, tenants). Uploads with `account=<ref>` create the account
automatically with `DEFAULT_ACCOUNT_QUOTA_BYTES`.

**Account object**

```json
{
  "ref": "agency_42",
  "quota_bytes": 5368709120,
  "used_bytes": 104857600,
  "file_count": 37,
  "usage_percent": 1.95,
  "deleted": false
}
```

`quota_bytes: null` means unlimited, but the server disk guard still applies.

### PUT `/api/v1/accounts/:ref`: create or update the quota

Scope `accounts:write`.

```json
{ "quota_bytes": 10737418240 }
```

`quota_bytes` is required: an integer ≥ 0, or `null` for unlimited. Setting it below current usage is allowed;
further uploads then fail with `507`. Returns the account object.

### GET `/api/v1/accounts/:ref`: get usage

Scope `accounts:read`. Returns the account object, or `404 not_found`.

### DELETE `/api/v1/accounts/:ref`: delete account

Scope `accounts:write`. Soft-deletes **every live file of the account, ignoring references**, then marks the
account deleted. Files stay restorable during the normal trash window.

```json
{ "deleted_files": 37 }
```

---

## Public delivery (no auth)

These are the URLs that browsers and CDNs load. They aren't under `/api/v1` and need no key.

### GET `/f/:id.:ext`: original file

```
https://media-server.unfaa.com/f/0192f3c4-7a1b-7c2e-9d10-5b6c7d8e9f00.png
```

- `Cache-Control: public, max-age=604800, immutable` (browser 7 days), `CDN-Cache-Control: max-age=31536000`
- `Access-Control-Allow-Origin: *`, `X-Content-Type-Options: nosniff`, restrictive CSP
- DOCX is served as `attachment`; everything else is `inline`
- Supports `Range` requests, which video seeking needs
- Unknown, deleted or malformed ids return a plain-text `404`

### GET `/i/:id/:w.:fmt`: resized image variant

```
https://media-server.unfaa.com/i/0192f3c4-…/512.webp
```

- `w` must be one of `VARIANT_WIDTHS` (default `64,128,256,512,768,1024,1536,2048`)
- `fmt` must be one of `VARIANT_FORMATS` (default `jpg,png,webp,avif`)
- Any other combination returns `404`
- Rendered on first request, then cached on disk (`VARIANT_CACHE_MAX_BYTES`, LRU)
- Not available for GIF, video or documents

Fill `variants_url_template` from the upload response, e.g. `{w}` → `512` and `{fmt}` → `webp`.

### GET `/healthz` and GET `/readyz`

- `/healthz` → `200 { "status": "ok" }` while the process is up.
- `/readyz` → `200` when both the database and the storage volume are OK, otherwise `503`:

```json
{ "status": "ok", "checks": { "database": "ok", "storage": "ok" } }
```

---

## File lifecycle

```
upload (confirm=false) → pending ──confirm──→ active ──delete / last ref removed──→ deleted ──trash window ends──→ purged
upload (confirm=true)  ─────────────────────→ active                                  │
                                                     ←────────── restore ────────────┘
```

- A `pending` file that is never confirmed is removed after `PENDING_TTL_HOURS` (default 24 h).
- `deleted` files can be restored for `TRASH_RETENTION_HOURS` (default 7 days), then the bytes are purged.
  The row stays as a `purged` tombstone.
- Recommended flow: upload with `confirm=false`, save the `id` in your database, then confirm it. A crash in
  between leaves no orphaned files.

---

## Errors

`/api/v1/files` and `/api/v1/accounts` errors use `application/problem+json` (RFC 9457):

```json
{
  "type": "https://media-server.unfaa.com/docs/errors#invalid_request",
  "title": "Bad Request",
  "status": 400,
  "code": "invalid_request",
  "detail": "exactly one part named \"file\" is required",
  "request_id": "a2bffb7fac7f1fcc49a0cfa2"
}
```

Branch on `code`, show `detail` to developers only, and log `request_id`.

| HTTP      | `code`                     | When                                                                                                              | Retry?                                           |
| --------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 400       | `invalid_request`          | Bad or unknown params, not multipart, wrong or extra multipart parts, empty file, missing `account` when required | No                                               |
| 401       | `unauthorized`             | Missing or invalid API key                                                                                        | No                                               |
| 403       | `forbidden_scope`          | Key lacks the scope                                                                                               | No                                               |
| 404       | `not_found`                | Unknown file, account or route                                                                                    | No                                               |
| 409       | `invalid_state`            | Confirming a deleted file, restoring outside the trash window, and so on                                          | No                                               |
| 409       | `has_references`           | `DELETE /files/:id` on a file that still has refs (use `force=true` or remove the refs)                           | No                                               |
| 413       | `file_too_large`           | Over `MAX_FILE_BYTES`                                                                                             | No                                               |
| 415       | `unsupported_type`         | Type not allowed, or that kind is disabled                                                                        | No                                               |
| 422       | `invalid_content`          | Corrupt file, decompression bomb, invalid MP4/PDF/DOCX                                                            | No                                               |
| 422       | `idempotency_key_reused`   | Same `Idempotency-Key` used for a different upload                                                                | No (use a new key)                               |
| 429       | `rate_limited`             | Too many requests. See `Retry-After`                                                                              | Yes, after the wait                              |
| 507       | `quota_exceeded`           | Account quota or server disk full                                                                                 | No                                               |
| 500 / 503 | `internal` / `unavailable` | Server fault                                                                                                      | Yes, with backoff and the same `Idempotency-Key` |

Delivery URLs (`/f`, `/i`) return plain-text `404 Not Found` instead of JSON.

---

## Not implemented yet

The design docs in `docs/api/` describe some features that have **no route in the server yet**. Calling them
returns `404 not_found`:

- `POST /files/:id/signed-url` (signed URLs)
- `GET /files/:id/audit-logs`, `GET /accounts/:ref/audit-logs`
- `visibility=private` / `sensitive` (only `public` is accepted)
- Upload params `actor` and `optimize` (rejected as unknown params)
