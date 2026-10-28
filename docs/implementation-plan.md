# Media Server — Implementation Plan

> Status: Draft v1 · Date: 2026-10-10 · Owner: Rakibul
>
> A central media service used by all internal backends to upload, serve, and delete
> images, short videos, PDFs and DOCX files (≤ 10 MB each). Written in Go, deployed
> on a Hostinger VPS via Coolify, fronted by Cloudflare.
>
> **Update 2026-10-22:** the server now serves a single backend. The multi-tenant parts of this plan
> (the `tenants` table, per-tenant keys, quotas and limits) were removed. The upload policy now comes from env
> config. See `docs/api/CHANGELOG.md` v1.3.

---

## 0. Decisions (confirmed)

| # | Decision | Choice |
|---|---|---|
| D1 | File visibility | **Public + private** from day one. Private = HMAC-signed, expiring URLs. |
| D2 | Who uploads | **Only our backends**, authenticated with per-tenant API keys. No browser uploads. |
| D3 | Image handling | Store original (normalized, EXIF stripped) + **on-the-fly resized variants** from a fixed allowlist, cached on disk and on Cloudflare. |
| D4 | API key management | **Postgres + admin CLI** (create / list / rotate / revoke). Keys stored hashed. |
| D5 | Storage | **Local NVMe disk** via a persistent Coolify volume, behind a `Storage` interface (S3/R2 driver later). |
| D6 | Metadata DB | **PostgreSQL** (Coolify-managed). Also used as the job queue. No Redis. |
| D7 | CDN | **Cloudflare** (proxied DNS) in front of the media domain. |
| D8 | Image compression | **In-house with libvips** (mozjpeg, libimagequant), same resolution, on upload. No external service (§8.1). |
| D9 | HEIC/HEIF (iPhone) | **Accepted**, converted to JPEG on upload so all browsers can display it (§8.1). |
| D10 | Accounts (agencies) | Files carry an `account` (e.g. `agency_42`) set by the client. **Per-account quotas** enforced from DB counters, reconciled weekly (§7.5). |
| D11 | Visibility tiers | **public / private / sensitive.** Sensitive (passport, NID, visa, KYC) = encrypted at rest, 5-min signed URLs, never cached, every URL issue and view audit-logged (§9.4). |
| D12 | Virus scanning | **Not in v1** (ClamAV needs ~1–1.5 GB RAM). Hook kept for later; images are re-encoded so only pdf/docx are at risk. |

## 0.1 Assumptions (change these if wrong)

- Media domain: `media.unfaa.com` (confirmed).
  - Management API base: `https://media.unfaa.com/api/v1`
  - File delivery: `https://media.unfaa.com/f/...`, `/i/...`, `/p/...` (kept short and outside `/api`
    so CDN rules stay simple).
- Volume: small (not a concern for v1). A single VPS + local disk is enough.
- Allowed types (final for v1): `jpeg, png, webp, gif, avif, heic/heif` (HEIC stored as JPEG) · `mp4, webm` · `pdf, docx`.
  No other document types. SVG is **rejected** (XSS risk).
- Videos are a minor use case: accepted and served correctly (see §8.2), no transcoding.
- Max file size: 10 MB for every type (per-tenant override possible, never above 10 MB).
- Soft-delete retention (trash window): 7 days.
- Unconfirmed upload TTL (orphan cleanup): 24 hours.
- Backends that run on the same Coolify server upload via the **internal Docker network**
  (`http://media-server:8080`), not through Cloudflare.

---

## 1. Goals & Non-Goals

### Goals
1. Correct, safe uploads: size limit enforced while streaming, content-type verified by magic bytes.
2. Very fast reads: no DB access on the read path, `sendfile` from disk, CDN-cached.
3. Proper deletion: immediate 404, CDN purge, recoverable for 7 days, then permanent removal.
4. No orphaned files or rows: two-phase confirm, orphan sweeper, weekly reconcile.
5. Survives deploys/restarts (persistent volume) and VPS loss (offsite backups).
6. Horizontally scalable later without API changes (stateless app + swappable storage).

### Non-Goals (v1)
- Browser direct uploads, resumable/chunked uploads (files are small).
- Video transcoding / HLS. Videos are served as uploaded.
- Content deduplication across uploads.
- A web admin UI (CLI only).

---

## 2. Architecture

```
                        ┌──────────────────────── Hostinger VPS (Coolify) ───────────────────────┐
 Your backends ─────────┼─► Traefik ─► media-server (Go) ──► /data  (persistent bind mount)      │
 (API key, internal     │                  │    │                ├─ public/   ├─ private/          │
  network or HTTPS)     │                  │    │                ├─ variants/ ├─ trash/  └─ tmp/   │
                        │                  │    └──► PostgreSQL (tenants, keys, files, jobs)      │
 Browsers ─► Cloudflare ┼─► Traefik ───────┘                                                      │
   (≈95% cache hits)    │                                                                         │
                        └─────────────────────────────────────────────────────────────────────────┘
                              nightly: restic ─► Backblaze B2 / R2  (files)
                              nightly: Coolify DB backup ─► B2 / R2 (Postgres)
```

### Request paths

| Path | Purpose | Auth | DB on request? | CDN |
|---|---|---|---|---|
| `POST/GET/DELETE /api/v1/...` | Management API | API key | Yes | Bypass |
| `GET /f/{id}.{ext}` | Public original | None | **No** | Cache |
| `GET /i/{id}/{w}.{fmt}` | Public image variant | None | **No** | Cache |
| `GET /p/{id}.{ext}?exp&kid&sig` | Private original | Signed URL | **No** | Bypass |
| `GET /p/{id}/{w}.{fmt}?exp&kid&sig` | Private image variant | Signed URL | **No** | Bypass |
| `GET /s/{id}.{ext}?g&exp&kid&sig` | Sensitive original (decrypted on the fly) | Signed URL + grant | Yes (audit log, async) | Bypass |
| `GET /healthz`, `/readyz` | Liveness / readiness | None | readyz only | Bypass |
| `GET /metrics` (port 9090) | Prometheus | Not exposed publicly | No | — |

**Key principle:** the URL deterministically maps to a file path on disk. Reads are a
`stat` + `sendfile`. Deletion works by moving the file out of the served tree.

---

## 3. Tech Stack

| Concern | Library / Tool | Notes |
|---|---|---|
| Language | Go (latest stable) | |
| Router | `github.com/go-chi/chi/v5` | stdlib-compatible `http.Handler` |
| DB driver | `github.com/jackc/pgx/v5` (`pgxpool`) | |
| Queries | `sqlc` | Type-safe generated code from SQL |
| Migrations | `github.com/pressly/goose/v3` | SQL files embedded with `embed.FS` |
| IDs | `github.com/google/uuid` → **UUIDv7** | Time-ordered, unguessable enough with 74 random bits; timestamp used for disk layout |
| MIME sniffing | `github.com/gabriel-vasile/mimetype` | Detects docx inside zip correctly |
| Images | `github.com/davidbyttow/govips/v2` (libvips) | Wrapped behind `ImageProcessor` interface so it can be swapped (e.g. `bimg`, `imgproxy`) |
| In-memory cache | `github.com/dgraph-io/ristretto/v2` | API key → tenant lookups |
| Dedup concurrent work | `golang.org/x/sync/singleflight` | Variant generation |
| Rate limiting | `golang.org/x/time/rate` | Per API key token bucket |
| Config | `github.com/caarlos0/env/v11` | 12-factor env config, validated at startup |
| Logging | `log/slog` (JSON handler) | |
| Metrics | `github.com/prometheus/client_golang` | |
| Testing | `testing`, `testcontainers-go` (Postgres), `httptest` | |
| Lint | `golangci-lint` | |
| Load test | `k6` or `vegeta` | |

---

## 4. Project Layout

```
media-server/
├── cmd/
│   └── media-server/
│       └── main.go              # subcommands: serve | migrate | admin | healthcheck
├── internal/
│   ├── config/                  # env parsing + validation
│   ├── httpapi/                 # router, handlers, middleware, problem+json errors
│   │   ├── middleware/          # request id, logging, recover, auth, ratelimit, timeouts
│   │   ├── files.go             # /api/v1/files handlers
│   │   ├── serve.go             # /f, /i, /p handlers
│   │   └── health.go
│   ├── auth/                    # API key parse/hash/verify, scopes, key cache
│   ├── signing/                 # HMAC signed URL create/verify, key rotation (kid)
│   ├── media/                   # type allowlist, sniffing, validation, kind mapping
│   ├── imaging/                 # ImageProcessor interface + libvips impl, variant spec
│   ├── storage/                 # Storage interface, local driver, layout (key derivation)
│   ├── files/                   # domain service: upload, confirm, delete, restore
│   ├── db/                      # sqlc generated code + queries/*.sql
│   ├── jobs/                    # worker loop, sweepers, reconcile, cdn purge
│   ├── cdn/                     # Purger interface + Cloudflare impl + noop impl
│   └── admin/                   # CLI command implementations
├── migrations/                  # goose SQL migrations (embedded)
├── testdata/                    # sample + malicious fixture files
├── docs/
├── Dockerfile
├── .dockerignore
├── sqlc.yaml
├── .golangci.yml
├── Makefile
└── .github/workflows/ci.yml
```

Conventions:
- `internal/` everything; no exported packages until an SDK is needed.
- Handlers are thin: parse → call domain service (`files`) → render. Business rules live in `files`.
- Interfaces are defined by the consumer (`files` defines what it needs from `storage`, `cdn`, `imaging`).
- `context.Context` passed through every I/O call; no globals except the logger.
- Errors wrapped with `%w`; domain errors are typed sentinels mapped to HTTP status in one place.

---

## 4.1 Go Development Environment

| Item | Convention |
|---|---|
| Go version | Latest stable, pinned in `go.mod` (`go` + `toolchain` lines) so local, CI and Docker use the same version |
| Dev tools | Pinned with Go's `tool` directive in `go.mod` (`go get -tool ...`): `sqlc`, `goose`, `golangci-lint`, `govulncheck`, `air`. Run via `go tool <name>` — no global installs |
| Native deps | libvips (`sudo apt install libvips-dev` / `dnf install vips-devel`). Alternative: VS Code Dev Container with libvips preinstalled |
| Local services | `compose.yaml` with Postgres only; app runs natively with `air` hot reload |
| Config | `.env.example` committed (no secrets); `.env` git-ignored; loaded only in dev |
| Local storage | `./.data/` (git-ignored) as `STORAGE_PATH`; `CDN_PROVIDER=none` |
| Formatting | `gofmt` + `goimports` (enforced by `golangci-lint`) |
| Git hooks | `lefthook` (optional): `golangci-lint run` + `go test ./...` on pre-push |

`Makefile` targets:

```make
make dev          # docker compose up -d postgres && go tool air
make test         # go test -race -cover ./...
make test-int     # integration tests (testcontainers)
make lint         # go tool golangci-lint run
make vuln         # go tool govulncheck ./...
make generate     # go tool sqlc generate
make migrate-new name=add_x   # go tool goose -dir migrations create add_x sql
make build        # docker build -t media-server:dev .
```

`.golangci.yml` enables at least: `errcheck, govet, staticcheck, gosec, revive, bodyclose,
sqlclosecheck, contextcheck, errorlint, gocritic, misspell, unparam`.

Go code conventions:
- Accept interfaces, return structs; small interfaces defined where they are used.
- No package-level mutable state; dependencies wired explicitly in `main.go` (no DI framework).
- `context.Context` is the first parameter on every I/O function; respect cancellation.
- Errors: wrap with `fmt.Errorf("...: %w", err)`; check with `errors.Is/As`; never `panic` in request paths.
- Every goroutine has an owner and a stop path (`errgroup` + context) — no leaks on shutdown.
- Table-driven tests; `t.Parallel()` where safe; `-race` always on in CI.

---

## 5. Data Model (PostgreSQL)

```sql
-- 0001_init.sql
CREATE TABLE tenants (
    id              uuid PRIMARY KEY,
    slug            text        NOT NULL UNIQUE,            -- e.g. "shop", "crm"
    name            text        NOT NULL,
    quota_bytes     bigint      NOT NULL DEFAULT 21474836480, -- 20 GB
    used_bytes      bigint      NOT NULL DEFAULT 0,
    max_file_bytes  bigint      NOT NULL DEFAULT 10485760     -- 10 MB
                    CHECK (max_file_bytes <= 10485760),
    allowed_kinds   text[]      NOT NULL DEFAULT '{image,video,document}',
    rate_limit_rps  integer     NOT NULL DEFAULT 20,
    created_at      timestamptz NOT NULL DEFAULT now(),
    disabled_at     timestamptz
);

CREATE TABLE api_keys (
    id            uuid PRIMARY KEY,
    tenant_id     uuid        NOT NULL REFERENCES tenants(id),
    name          text        NOT NULL,                 -- "shop-backend-prod"
    prefix        text        NOT NULL,                 -- first 12 chars, for display/lookup logs
    key_hash      bytea       NOT NULL UNIQUE,          -- sha256(full key)
    scopes        text[]      NOT NULL,                 -- {files:write, files:read, files:delete, accounts:read, accounts:write, audit:read}
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz,
    expires_at    timestamptz,
    revoked_at    timestamptz
);

-- An account = one customer of a client app (e.g. one agency). Created on first upload.
CREATE TABLE accounts (
    id           uuid PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenants(id),
    ref          text        NOT NULL,                  -- client's id, e.g. "agency_42"
    quota_bytes  bigint,                                -- NULL = unlimited (tenant quota still applies)
    used_bytes   bigint      NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
    file_count   integer     NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz,
    UNIQUE (tenant_id, ref)
);

CREATE TYPE file_status AS ENUM ('pending', 'active', 'deleted', 'purged');
CREATE TYPE file_visibility AS ENUM ('public', 'private', 'sensitive');

CREATE TABLE files (
    id             uuid PRIMARY KEY,                    -- UUIDv7
    tenant_id      uuid            NOT NULL REFERENCES tenants(id),
    account_id     uuid            REFERENCES accounts(id), -- NULL = tenant-level file
    visibility     file_visibility NOT NULL,
    status         file_status     NOT NULL DEFAULT 'pending',
    kind           text            NOT NULL,            -- image | video | document
    mime           text            NOT NULL,
    ext            text            NOT NULL,            -- canonical ext from sniffed type
    size_bytes     bigint          NOT NULL,            -- stored size (after compression)
    original_size_bytes bigint     NOT NULL,            -- size as uploaded
    sha256         bytea           NOT NULL,
    width          integer,
    height         integer,
    original_name  text,                                -- sanitized, display/download only
    purpose        text,                                -- free label: avatar, invoice, ...
    owner_ref      text,                                -- set by the client on confirm, e.g. "user:123:avatar"
    created_at     timestamptz     NOT NULL DEFAULT now(),
    confirmed_at   timestamptz,
    deleted_at     timestamptz,
    purged_at      timestamptz,
    enc_kid        text,                                -- sensitive only: master key id
    enc_dek        bytea                                -- sensitive only: AES key wrapped by master key
);

CREATE INDEX files_tenant_created_idx ON files (tenant_id, created_at DESC);
CREATE INDEX files_pending_idx ON files (created_at) WHERE status = 'pending';
CREATE INDEX files_deleted_idx ON files (deleted_at) WHERE status = 'deleted';
CREATE INDEX files_account_idx ON files (account_id, created_at DESC);
CREATE INDEX files_owner_ref_idx ON files (tenant_id, owner_ref text_pattern_ops)
    WHERE status IN ('pending', 'active');

CREATE TABLE jobs (
    id            bigserial   PRIMARY KEY,
    kind          text        NOT NULL,                 -- cdn_purge | ...
    payload       jsonb       NOT NULL,
    run_at        timestamptz NOT NULL DEFAULT now(),
    attempts      integer     NOT NULL DEFAULT 0,
    max_attempts  integer     NOT NULL DEFAULT 10,
    last_error    text,
    locked_until  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE attempts < max_attempts;

-- Sensitive files: one grant per signed URL issued (who asked, why, until when).
CREATE TABLE access_grants (
    id          uuid PRIMARY KEY,
    file_id     uuid        NOT NULL REFERENCES files(id),
    tenant_id   uuid        NOT NULL,
    account_id  uuid,
    actor       text        NOT NULL,                   -- client's user id, e.g. "staff_17"
    reason      text,                                   -- optional, e.g. "visa processing"
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit trail for sensitive files (and admin actions).
CREATE TABLE audit_logs (
    id          bigserial   PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    tenant_id   uuid        NOT NULL,
    account_id  uuid,
    file_id     uuid,
    grant_id    uuid,
    event       text        NOT NULL,   -- uploaded | url_issued | viewed | view_denied | deleted | restored | purged
    actor       text,                   -- from the client (url_issued/deleted) or NULL for anonymous views
    ip          inet,
    user_agent  text,
    detail      jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_logs_file_idx    ON audit_logs (file_id, at DESC);
CREATE INDEX audit_logs_account_idx ON audit_logs (account_id, at DESC);
```

Rules:
- Every `/api/v1` query is scoped by `tenant_id`. A file of another tenant returns **404**, never 403.
- `used_bytes` (tenant **and** account) is updated in the same transaction as file insert /
  delete / restore / purge, using a guarded atomic update (see §7.5).
- `audit_logs` is append-only: the app's DB role has `INSERT, SELECT` only on it.
- Rows are never hard-deleted; `purged` rows stay as tombstones (audit + IDs never reused).

---

## 6. Storage Layout & Interface

```
/data
├── tmp/                                   # in-flight uploads (same filesystem → atomic rename)
├── public/2026/10/10/0192f3c4-....webp    # date derived from UUIDv7 timestamp
├── private/2026/10/10/0192f3c4-....pdf
├── sensitive/2026/10/10/0192f3c4-....jpg.enc  # AES-256-GCM encrypted
├── variants/0192f3c4-.../640.webp         # generated image variants, one dir per file
└── trash/public/2026/10/10/0192f3c4-....webp
```

- The storage key is **derived from the ID + ext + visibility**, so the read path never needs the DB.
- Date-based sharding keeps directories small.
- `tmp/` lives on the same volume so `os.Rename` is atomic.

```go
type Storage interface {
    // Put moves a fully-written temp file into place atomically.
    Commit(ctx context.Context, tmpPath, key string) error
    Open(ctx context.Context, key string) (File, error)        // File: io.ReadSeekCloser + Stat
    Move(ctx context.Context, fromKey, toKey string) error     // used for trash/restore
    Delete(ctx context.Context, key string) error
    DeletePrefix(ctx context.Context, prefix string) error     // variants/{id}/
    Walk(ctx context.Context, prefix string, fn WalkFunc) error // reconcile
    Usage(ctx context.Context) (DiskUsage, error)
}
```

Durability for writes: write to `tmp/` → `fsync(file)` → `rename` → `fsync(parent dir)`.

Future S3/R2 driver: implements the same interface; serving then uses range-proxying or
redirects to presigned URLs. This is a driver swap + `rclone copy`, not an API change.

---

## 7. API Specification (`/api/v1`)

Conventions:
- Auth: `Authorization: Bearer msk_<tenant-slug>_<32 random bytes base62>`.
- Errors: **RFC 9457** `application/problem+json` with a stable `code` field.
- Every response carries `X-Request-Id` (generated or propagated).
- Times in RFC 3339 UTC. IDs are UUID strings.

### 7.1 Upload — `POST /api/v1/files`

Query params (so the body can be streamed): `visibility=public|private` (required),
`purpose=<label>` (optional), `confirm=true|false` (default `false`),
`optimize=true|false` (default `true`; `false` stores the image byte-for-byte except metadata stripping),
`account=<ref>` (optional, e.g. `agency_42`; required if the tenant sets `require_account`),
`actor=<user id>` (required when `visibility=sensitive`, written to the audit log).
`visibility` accepts `public | private | sensitive`.
Body: `multipart/form-data` with exactly **one** part named `file`.

```http
POST /api/v1/files?visibility=public&purpose=avatar&confirm=true
Authorization: Bearer msk_shop_...
Content-Type: multipart/form-data; boundary=...
```

`201 Created`
```json
{
  "id": "0192f3c4-7a1b-7c2e-9d10-5b6c7d8e9f00",
  "status": "active",
  "visibility": "public",
  "kind": "image",
  "mime": "image/webp",
  "size": 482113,
  "original_size": 1904220,
  "compressed": true,
  "sha256": "9f86d0...",
  "width": 1600,
  "height": 1067,
  "url": "https://media.unfaa.com/f/0192f3c4-....webp",
  "variants_url_template": "https://media.unfaa.com/i/0192f3c4-.../{w}.{fmt}",
  "created_at": "2026-10-10T08:00:00Z"
}
```
For private files `url` is omitted; use the signed-URL endpoint.

Supports `Idempotency-Key` header (stored 24h per tenant) so backend retries don't create duplicates.

### 7.2 Other endpoints

| Method & Path | Scope | Description |
|---|---|---|
| `GET /api/v1/files/{id}` | files:read | Metadata |
| `GET /api/v1/files?cursor&limit&purpose&status` | files:read | Cursor-paginated list (by id, UUIDv7 = time order) |
| `POST /api/v1/files/{id}/confirm` `{ "owner_ref": "user:123:avatar" }` | files:write | `pending → active`, optionally tags the owner. Idempotent |
| `POST /api/v1/files/confirm` `{ "ids": [...], "owner_ref": "..." }` | files:write | Batch confirm (≤ 100) |
| `DELETE /api/v1/files/{id}` | files:delete | Soft delete. **Idempotent** → always `204` |
| `POST /api/v1/files/delete-by-owner` `{ "owner_ref_prefix": "user:123:" }` | files:delete | Soft-delete every pending/active file of an owner (e.g. account deletion). Returns count. Prefix must be ≥ 3 chars and end with `:` |
| `POST /api/v1/files/{id}/restore` | files:delete | Restore within trash window |
| `POST /api/v1/files/{id}/signed-url` `{ "ttl": 900, "variant": {"w":640,"fmt":"webp"}, "actor": "staff_17", "reason": "..." }` | files:read | Signed URL. **private:** default 15 min, max 7 days. **sensitive:** max 5 min, `actor` required, no variants, creates an access grant + audit entry |
| `GET /api/v1/files/{id}/audit-logs?cursor&limit` | audit:read | Audit trail of one sensitive file |
| `PUT /api/v1/accounts/{ref}` `{ "quota_bytes": 5368709120 }` | accounts:write | Create/update an account and its quota (e.g. when an agency changes plan). `null` = unlimited |
| `GET /api/v1/accounts/{ref}` | accounts:read | `{ quota_bytes, used_bytes, file_count, usage_percent }` |
| `DELETE /api/v1/accounts/{ref}` | accounts:write | Soft-delete **all** files of the account (normal trash window), then mark the account deleted |
| `GET /api/v1/accounts/{ref}/audit-logs?from&to&event&cursor` | audit:read | Audit trail of all sensitive files of an account |

### 7.3 Error codes

| HTTP | code | When |
|---|---|---|
| 400 | `invalid_request` | Missing/invalid params, not multipart, >1 file part |
| 401 | `unauthorized` | Missing/invalid/revoked/expired key |
| 403 | `forbidden_scope` | Key lacks scope; tenant disabled |
| 404 | `not_found` | Unknown id or other tenant's id |
| 409 | `invalid_state` | e.g. confirm a deleted file, restore a purged file |
| 413 | `file_too_large` | Exceeds tenant `max_file_bytes` |
| 415 | `unsupported_type` | Sniffed type not in allowlist / kind not allowed for tenant |
| 422 | `invalid_content` | Corrupt image, decompression bomb, dimension limit |
| 429 | `rate_limited` | Includes `Retry-After` |
| 507 | `quota_exceeded` | Tenant quota or disk free-space guard |

### 7.4 Client Integration Contract (how "unused" files are detected)

The media server **cannot know** whether a client app still uses a file — only the client
backend knows that. So responsibility is split by a clear contract:

| Responsibility | Owner |
|---|---|
| Storing bytes, serving, caching, deleting on request, cleaning orphans/trash | Media server |
| Knowing which record uses which file, and calling confirm/delete at the right time | Client backend |

**Rules every client backend must follow:**

1. **Store the file `id`** (and optionally the URL) in your own DB — never only the URL.
2. **Upload → save record → confirm.** Upload returns a `pending` file. Only after your own
   DB transaction that references it commits, call `confirm` (with `owner_ref`).
   If the user abandons the form, never confirm → the media server deletes it after 24 h.
   For simple one-step flows (e.g. avatar saved immediately), upload with `confirm=true`.
3. **Replace → delete old.** When a record's file changes (new avatar), confirm the new one,
   then `DELETE` the old id.
4. **Record deleted → delete files.** When a post/product is deleted, delete its file ids.
   When a user account is deleted, call `delete-by-owner` with `owner_ref_prefix: "user:123:"`.
5. **Deletes must be reliable:** use the **transactional outbox** pattern — in the same DB
   transaction that removes/changes the record, insert a row "delete media <id>" into an
   outbox table; a worker sends the `DELETE` and retries until 204. `DELETE` is idempotent,
   so retries are safe.
6. **Permissions are the client's job.** The media server knows tenants and accounts, not
   end-users or roles. The client backend MUST check that the logged-in user may see a file
   *before* requesting a signed URL, and MUST pass that user as `actor` for sensitive files.
7. **Active files never expire by time.** A confirmed avatar stays forever, however long the
   user is inactive — it is removed only when the client deletes it.

**`owner_ref` convention:** `<entity>:<id>:<field>` — e.g. `user:123:avatar`,
`product:987:gallery`, `invoice:55:pdf`. Free text for the media server, but consistent per
tenant. It enables bulk deletion and debugging ("which files belong to user 123?").

**Typical flows:**

```
Avatar change:   upload(confirm=true, ref=user:123:avatar) → save new id in users table
                 → outbox DELETE old id
Create post:     upload ×N (pending) → user submits → INSERT post + images
                 → confirm(ids, ref=post:77:images)
Abandoned form:  upload (pending) → never confirmed → auto-deleted after 24 h
Delete post:     DELETE post row + outbox DELETE each image id
Delete account:  delete user + outbox delete-by-owner("user:123:")
```

**Safety net (optional, later):** a client-driven reconcile — the client sends the list of
ids it still references for an `owner_ref_prefix`; the media server reports (dry-run) or
deletes active files under that prefix that are not in the list.

### 7.5 Accounts (agencies) & Quotas

A client app usually serves many customers (e.g. travel **agencies**). The media server tracks
them as **accounts** inside a tenant, so quotas and bulk deletion work per customer.

- The client passes `account=agency_42` on upload. The account row is auto-created on first
  use with the tenant's default quota; the client sets real limits with
  `PUT /api/v1/accounts/agency_42 { "quota_bytes": 5368709120 }` when the plan changes
  (Basic 5 GB, Pro 20 GB, ...). Plans/pricing stay in the client app; the media server only
  stores the byte limit.
- **What counts:** stored size (after compression — customers benefit from compression) of
  `pending` + `active` files. Deleting a file releases its bytes immediately; restoring
  re-checks the quota (507 `quota_exceeded` if no room).
- **Enforcement is atomic** — in the upload transaction:
  ```sql
  UPDATE accounts SET used_bytes = used_bytes + $size, file_count = file_count + 1
  WHERE id = $id AND (quota_bytes IS NULL OR used_bytes + $size <= quota_bytes)
  RETURNING used_bytes;   -- 0 rows → 507 quota_exceeded
  ```
  Same guarded update for the tenant. No race between concurrent uploads.
- **Before upload:** `GET /api/v1/accounts/{ref}` lets the client show "4.2 GB of 5 GB used".
- **Reconcile (weekly job):** recompute `SUM(size_bytes)` / `COUNT(*)` per account from `files`
  and compare with counters; fix drift and emit `media_quota_drift_bytes`. Files on disk vs DB
  are already reconciled by §10.2. (Counting from the DB is the only practical source of truth
  on local disk; object-storage "prefix size" APIs are slow and inconsistent across providers.)
- **Lowering a quota below usage** is allowed: existing files stay, new uploads are rejected.
- **Account deletion:** `DELETE /api/v1/accounts/{ref}` → all files soft-deleted (restorable for
  7 days), then purged by the normal trash job.

### 7.6 Developer Documentation (Markdown guide for client teams)

Human-readable docs for developers who integrate their backends — not Swagger/Postman.
Plain Markdown in the repo (renders on GitHub), versioned with the code.

```
docs/
├── implementation-plan.md          # this file (internal)
└── api/
    ├── README.md                   # overview, base URLs, 5-minute quick start, table of contents
    ├── authentication.md           # getting a key, Bearer header, scopes, rotation, what to do if leaked
    ├── uploading.md                # POST /files, allowed types, 10 MB limit, compression (§8.1),
    │                               # optimize=false, idempotency keys, internal vs public URL
    ├── file-lifecycle.md           # ★ the rules: pending → active → deleted → purged, confirm,
    │                               # owner_ref convention, 24 h orphan cleanup, "active never expires"
    ├── deleting.md                 # DELETE, restore (7 days), delete-by-owner, CDN purge timing,
    │                               # 7-day browser-cache caveat, transactional outbox pattern
    ├── serving-and-urls.md         # /f, /i variants (allowed widths/formats), <img srcset> example,
    │                               # private files + signed URLs, caching behaviour
    ├── videos-and-documents.md     # mp4/webm guidance (H.264+AAC, faststart), pdf/docx behaviour
    ├── errors.md                   # problem+json format, every error code, retry guidance
    ├── limits-and-quotas.md        # size, tenant/account quotas, rate limits, Retry-After
    ├── accounts.md                 # accounts (agencies), setting quotas, usage, account deletion
    ├── visibility-and-sensitive-files.md  # public vs private vs sensitive, TTLs, actor, audit logs
    ├── integration-checklist.md    # ✅ list a client team must tick before going live
    ├── recipes/
    │   ├── avatar-upload.md        # upload(confirm=true) → save → delete old
    │   ├── post-with-gallery.md    # pending uploads → submit → batch confirm
    │   ├── account-deletion.md     # delete-by-owner
    │   └── outbox-pattern.md       # reliable deletes with a code example
    ├── examples/                   # runnable snippets: curl, TypeScript (fetch), Go
    └── CHANGELOG.md                # API changes per version, deprecations
```

Writing conventions:
- Every endpoint section has the same shape: **what it does → request → parameters table →
  curl example → response example → errors → notes/gotchas**.
- Rules use RFC 2119 words: **MUST**, **SHOULD**, **MAY** (e.g. "You MUST store the file id").
- Examples use real paths (`https://media.unfaa.com/api/v1/...`) and fake keys (`msk_shop_xxx`).
- Lifecycle explained with a state diagram and the "who is responsible for what" table (§7.4).
- Each doc page states the API version it applies to.

Maintenance rules:
- **Docs are part of Definition of Done:** any PR that changes API behaviour updates the
  matching `docs/api/*.md` page and `CHANGELOG.md` in the same PR (PR template checkbox).
- Examples in `docs/api/examples/` are executed against the staging/local server in CI
  (M6) so they never go stale.
- Breaking changes only in a new version (`/api/v2`); old version deprecated with a date in
  `CHANGELOG.md` and a `Deprecation` response header.

---

## 8. Upload Pipeline (step by step)

1. **Auth + rate limit** middleware → tenant + scopes resolved (key cache, 60s TTL).
2. **Disk guard:** reject with 507 if free disk < `MIN_FREE_DISK` (e.g. 10%).
3. `r.Body = http.MaxBytesReader(w, r.Body, maxFileBytes + 64KB)` (multipart overhead).
4. Use `r.MultipartReader()` (**streaming**, never `ParseMultipartForm`). Accept exactly one part `file`.
5. Stream the part into `/data/tmp/{id}.upload` through an `io.MultiWriter` that:
   - computes SHA-256,
   - captures the first 3 KB for sniffing,
   - counts bytes (reject > limit with 413).
6. **Sniff** with `mimetype` on the header bytes → must be in the allowlist and in the tenant's
   `allowed_kinds`. The client's filename/extension/Content-Type are **ignored** for type decisions.
   Canonical extension comes from the sniffed type.
7. **Per-kind validation / normalization**
   - **Image** (jpeg/png/webp/avif/heic): load with libvips with a pixel limit
     (`MAX_IMAGE_PIXELS`, e.g. 50 MP) → auto-rotate by EXIF orientation → **strip all metadata**
     → **compress in-house (same resolution; HEIC → JPEG) — see §8.1** → record width/height.
     GIF: validate + strip metadata, keep animation, no compression or variants in v1.
   - **Video** (mp4/webm): see §8.2.
   - **PDF / DOCX**: sniff only. (Optional phase: ClamAV scan.)
8. **Transaction:** check quota → insert `files` row (`pending` or `active` if `confirm=true`)
   → increment `used_bytes`.
9. **Commit file:** fsync + atomic rename into `public/` or `private/`.
   If commit fails → roll back the transaction; if the transaction fails → delete temp file.
   (Ordering: write file first, then commit DB; the reconcile job catches any crash in between.)
10. Always `defer` cleanup of the temp file on any error path.

Sanitize `original_name`: strip path components & control characters, cap length at 255,
NFC-normalize. Used only for `Content-Disposition`.

### 8.1 Image compression on upload (self-hosted, no external service)

Clients upload **raw, uncompressed images** (straight from phone/camera/design tools). The media
server compresses them **itself, inside our own container** — no TinyPNG, Cloudinary or any
third-party API is called. Goal: a 4 MB raw photo becomes ~1 MB with **the same width/height,
no visible quality loss**, done once at upload so every later read is already small.

#### Pipeline (synchronous, inside the upload request)

```
raw upload ─► sniff type ─► decode (libvips, pixel limit) ─► auto-rotate (EXIF orientation)
          ─► ICC profile → sRGB ─► strip metadata (EXIF/GPS/XMP)
          ─► encode with format-specific optimizer ─► size check (keep smaller) ─► store
```

#### Encoders per format

| Input | Output | Technique | Default |
|---|---|---|---|
| JPEG | JPEG | **mozjpeg** encoder: trellis quantisation, optimized Huffman tables, progressive scan, quant table 3, 4:2:0 chroma subsampling | quality **80** |
| PNG | PNG | **libimagequant** lossy palette quantisation (same algorithm as pngquant/TinyPNG) + zlib effort 10. If the quality target can't be met (photo saved as PNG), fall back to lossless re-compression | quality 65–80 |
| HEIC/HEIF (iPhone) | **JPEG** | Decoded via libheif, then the JPEG path above. Converted because only Safari can display HEIC | quality 80 |
| WebP | WebP | Lossy re-encode (lossless if source is lossless) | quality 80, effort 4 |
| AVIF | AVIF | Re-encode | quality 55, effort 4 |
| GIF | GIF | Untouched in v1 (animated) | — |

#### Rules
1. **Resolution never changes** on the stored original. Resizing happens only in variants (§9.2).
   Optional safety cap `IMAGE_MAX_DIMENSION` (default `0` = off) for absurdly large camera files.
2. **Format never changes**, except HEIC/HEIF → JPEG. Format conversion for delivery
   (e.g. `.webp`) happens only in variants.
3. **Never bigger:** if the result is not at least **5 % smaller**, keep the original bytes
   (metadata still stripped). Already-optimized images are never degraded twice.
4. **Colors stay correct:** ICC profiles are converted to sRGB before stripping.
5. **Opt-out:** `optimize=false` per upload for pixel-exact assets.
6. **Synchronous:** compression finishes before the response, so the returned URL always points
   at the final file (required because public URLs are cached as `immutable`).
7. **Bounded CPU/RAM:** shares the libvips semaphore with variants (`NumCPU` concurrent jobs);
   libvips streams pixels in tiles, so a 10 MB image needs tens of MB of RAM, not hundreds.
8. Tunable via env (`IMAGE_JPEG_QUALITY`, `IMAGE_PNG_QUALITY`, ...), no code change needed.
9. Response returns `original_size` and `size`; metric `media_compression_saved_bytes_total`.

#### Build requirements (Dockerfile, M4)
The distro libvips package uses libjpeg-turbo (no trellis) and may lack libimagequant, so the
build stage **compiles libvips from source** against:
`mozjpeg`, `libimagequant`, `libspng`, `libwebp`, `libheif` (+ `libde265` decoder, `aom` for AVIF),
`lcms2`, `libexif`. A startup **self-test** encodes a tiny JPEG/PNG and checks the features are
present; the process refuses to start if they are missing (prevents silent quality regressions).

#### Quality verification (tests, M4)
- Fixture set: raw phone JPEGs, HEIC, PNG screenshots, PNG with transparency, photo-as-PNG,
  already-compressed JPEG, CMYK JPEG, rotated (EXIF orientation 6/8) image.
- Assertions: same dimensions, no metadata, size reduced (or original kept), and visual
  similarity measured with **DSSIM** (≤ 0.01 threshold, tune with real samples).
- Expected: raw phone JPEG 60–75 % smaller; PNG screenshots 50–80 % smaller;
  cost ≈ 100–500 ms per upload.

#### Later improvement (optional)
**Adaptive quality** (like TinyJPG / `jpeg-recompress`): binary-search the lowest JPEG quality
that still meets a DSSIM target per image — typically another 10–20 % saving, at ~3× CPU.

#### Why this approach (alternatives considered)

| Option | Verdict | Reason |
|---|---|---|
| **libvips in-process (chosen)** | ✅ | Fastest & lowest-memory image library; same engine used by imgproxy and sharp; one library for compression *and* variants; no network hop; data never leaves our server; free |
| TinyPNG / Kraken API | ❌ | Paid per image, adds network latency and an external dependency, sends user images to a third party (privacy), service outage = upload failure |
| Cloudinary / imgix / Cloudflare Images | ❌ (for now) | Excellent but paid and vendor lock-in; we already have the VPS and the volume is small |
| Pure-Go (`image/jpeg`, `disintegration/imaging`) | ❌ | No CGO is nice, but encoders are basic: no mozjpeg, no palette quantisation, no HEIC/AVIF; files 20–40 % larger and slower |
| ImageMagick | ❌ | Much slower and more RAM-hungry than libvips; long history of security CVEs |
| Shelling out to `mozjpeg`/`pngquant` binaries | ❌ | Works, but process-per-image overhead, temp files, harder error handling; libvips gives the same encoders in-process |
| Separate `imgproxy` container | ⏸ later | Great for variants at scale, but it doesn't compress originals on upload; revisit in M7 if variant load grows |
| Compress in the user's browser | ❌ | Clients are backends, quality would vary per app, and can't be trusted |
| Async compression after upload | ❌ | The URL would change content after being cached as `immutable`; sync is simple and fast enough for ≤ 10 MB |

The biggest bandwidth win on top of this is still serving variants: `/i/{id}/1024.webp` is
typically another 25–35 % smaller and sized for the actual screen.

### 8.2 Video handling (minimal, best-practice)

Videos are a minor use case, so v1 keeps it simple but correct:

- **Accepted:** `video/mp4` (incl. `.m4v` sniffed as mp4) and `video/webm`. QuickTime `.mov`,
  AVI, MKV etc. are rejected — ask clients to export MP4 (H.264 + AAC), the format every
  browser plays.
- **Structure check (pure Go, no ffmpeg):** walk top-level MP4 boxes (`ftyp`, `moov`, `mdat`)
  to confirm the file is a well-formed container and record whether `moov` comes before
  `mdat` (**faststart**). Non-faststart files are still accepted but flagged in metadata,
  since they must be downloaded further before playback starts.
- **Serving:** `http.ServeContent` gives Range requests (seeking), `206 Partial Content`,
  `Accept-Ranges: bytes`. Content-Disposition `inline`.
- **No transcoding, no thumbnails, no HLS** in v1.
- **If video becomes important later (M7+):** add `ffmpeg` in a separate worker to
  (1) remux to faststart (`-c copy -movflags +faststart`, cheap, lossless),
  (2) extract duration/dimensions with `ffprobe`, (3) generate a poster image,
  (4) consider Cloudflare Stream or R2 for heavy video delivery.

---

## 9. Serving (the fast path)

### 9.1 Originals — `/f/{id}.{ext}` and `/p/{id}.{ext}`
1. Validate `id` is a UUIDv7 and `ext` is an allowed extension (else 404, no disk access).
2. (`/p` only) verify signature + expiry (constant-time compare) → else 403/410.
3. Derive key → `Open` → `http.ServeContent` (handles **Range**, `If-None-Match`,
   `If-Modified-Since`, HEAD; uses `sendfile` for `*os.File`).
4. Headers:

| Header | Public (`/f`, `/i`) | Private (`/p`) |
|---|---|---|
| `Cache-Control` | `public, max-age=604800, immutable` (browser 7d) | `private, max-age=min(remaining TTL, 300)` |
| `CDN-Cache-Control` | `max-age=31536000` (edge 1y) | — |
| `ETag` | `"<sha256-prefix>"` (strong) | same |
| `Content-Type` | stored canonical mime | same |
| `Content-Disposition` | `inline` for image/video/pdf, `attachment` for docx; `filename*=UTF-8''...` | same |
| `X-Content-Type-Options` | `nosniff` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` (verify PDF inline viewing in Chrome/Firefox; relax for PDFs only if needed) | same |
| `Cross-Origin-Resource-Policy` | `cross-origin` | `cross-origin` |
| `Access-Control-Allow-Origin` | `*` (GET only) | configurable allowlist |

Why browser 7d / edge 1y: Cloudflare can be purged on delete; browsers cannot. 7 days bounds
how long an already-viewed deleted file can linger in a user's browser cache.

### 9.2 Image variants — `/i/{id}/{w}.{fmt}` and `/p/{id}/{w}.{fmt}`
- Path-based (no query strings) → clean CDN cache keys and a **finite, enumerable** set of URLs
  for purging.
- Allowlist: `w ∈ {64, 128, 256, 512, 768, 1024, 1536, 2048}`, `fmt ∈ {webp, jpg, png, avif}`
  (avif behind a flag — slow to encode). Anything else → 404.
- Never upscale: if `w` > original width, encode at original width.
- Flow: check `variants/{id}/{w}.{fmt}` on disk → hit: serve. Miss: `singleflight` keyed by
  path → semaphore (`NumCPU` concurrent libvips jobs) → resize (`thumbnail` from file,
  shrink-on-load) → write via tmp + rename → serve.
- Source must exist under `public/` (for `/i`) or `private/` (for `/p`) — so deleted files
  can't generate variants.
- Variant disk cache is disposable: deleted on file delete; optional LRU sweep if it grows
  beyond `VARIANT_CACHE_MAX_BYTES`.

### 9.3 Signed URLs (private files)
```
/p/{id}.{ext}?exp=1760090000&kid=k1&sig=<base64url(HMAC-SHA256(secret[kid], canonical))>
canonical = "GET\n" + path + "\n" + exp
```
- `kid` enables secret rotation: keep `SIGNING_KEYS=k2:<secret>,k1:<old>`; sign with the
  first, verify with any.
- Expired → 410; bad signature → 403. Signature comparison via `hmac.Equal`.
- Cloudflare: **bypass cache** for `/p/*`.
- TTL: private default **15 min** (client may request up to `PRIVATE_URL_MAX_TTL`, 7 days).
- The signature is checked when the request **starts**; a download that started before
  expiry completes normally. Resuming (a new Range request) after expiry needs a new URL.

### 9.4 Sensitive files (passport, NID, visa, KYC)

| Control | Implementation |
|---|---|
| Encryption at rest | **Envelope encryption.** Per-file random 256-bit DEK; file encrypted with **AES-256-GCM** (chunked, 64 KB segments, so it streams); DEK wrapped with the master key (`SENSITIVE_MASTER_KEYS`, with `kid` for rotation) and stored in `files.enc_dek`. A leaked disk/backup alone is useless. |
| Master key handling | Only in Coolify env vars + a separate offline copy (password manager). **Never** stored in the same backup as the files — losing it = losing all sensitive files. |
| Short URLs | Signed URL max **5 min**, path `/s/{id}.{ext}?g={grant}&exp&kid&sig` (grant id is part of the signature). |
| Who asked | `signed-url` requires `actor` (client's user id) + optional `reason` → `access_grants` row + `url_issued` audit event. |
| Every view logged | Each `/s` request writes a `viewed` (or `view_denied`) audit event with grant, IP, user agent. Writes go through a buffered channel and are batch-inserted, so the response isn't slowed; on shutdown the buffer is flushed. |
| No caching anywhere | `Cache-Control: no-store`, `Pragma: no-cache`; Cloudflare bypass for `/s/*`. |
| No leakage | `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Content-Disposition` from sanitized name. |
| No variants | Variant endpoints return 404 for sensitive files (fewer copies, fewer URLs). Images are still normalized + compressed (EXIF/GPS stripped) on upload. |
| Lifecycle events | `uploaded`, `deleted`, `restored`, `purged` also audited, with `actor` when provided. |
| Audit retention | `AUDIT_LOG_RETENTION` (default **365 days**), daily cleanup job. Audit rows survive file purge. |
| Serving | Decrypt into memory (files ≤ 10 MB) → `http.ServeContent` from a `bytes.Reader`, so Range requests still work. No `sendfile` — acceptable, sensitive files are rarely viewed. |

Not in v1: per-view watermarking, single-use URLs, IP binding. Can be added on the grant later.

---

## 10. Deletion & Cleanup Lifecycle

```
            upload(confirm=false)          confirm
  (none) ───────────────────────► pending ─────────► active
                                    │  24h unconfirmed   │ DELETE
                                    ▼                    ▼
                                  deleted ◄──────────────┘
                                    │  restore (≤7d) → back to active
                                    │  7 days
                                    ▼
                                  purged  (file + variants removed, quota released)
```

### 10.1 `DELETE /api/v1/files/{id}` (synchronous part)
1. Transaction: `status='deleted', deleted_at=now()` (no-op if already deleted/purged → 204).
2. Move file `public/...` → `trash/public/...` (origin now returns 404 immediately).
3. Delete `variants/{id}/`.
4. Insert `cdn_purge` job with the full URL list: original + all allowlisted variant URLs
   (8 widths × enabled formats). Batched per Cloudflare's per-request URL limit.
5. Return 204.

### 10.2 Background worker (in-process, safe with multiple replicas)
Single goroutine loop per job type with tickers; each picks work with
`SELECT ... FOR UPDATE SKIP LOCKED LIMIT n`.

| Job | Schedule | Action |
|---|---|---|
| `cdn_purge` | continuous | Call Cloudflare purge API; exponential backoff with jitter on failure; give up after `max_attempts` → metric + log error |
| Orphan sweeper | every 15 min | `pending` older than 24h → same as DELETE but skip trash window (purge directly) |
| Trash purger | every 1 h | `deleted` older than 7 days → remove trash file, set `purged` (quota was already released on delete; `purged` audit event for sensitive files) |
| Audit retention | daily | delete `audit_logs` / expired `access_grants` older than `AUDIT_LOG_RETENTION` |
| Quota reconcile | weekly | recompute account/tenant `used_bytes` + `file_count` from `files`, fix drift (§7.5) |
| Reconcile | weekly | Walk `public/` + `private/`: files with no `active/pending` row and older than 24h → move to trash + log. Rows `active` with missing file → log + `media_missing_files` metric |
| Temp sweeper | every 1 h | Delete `tmp/*` older than 1 h (crashed uploads) |
| Variant cache LRU | daily | If over max size, delete least-recently-modified variants |
| Idempotency keys | daily | Expire > 24h |

All destructive jobs log `{file_id, tenant, action}` and are covered by metrics.

---

## 11. Security Checklist

- [ ] Media served from a **dedicated domain** (no app cookies, no shared origin).
- [ ] Type detection by magic bytes only; strict allowlist; **SVG/HTML/XML rejected**.
- [ ] `nosniff`, CSP sandbox, `attachment` for docx.
- [ ] Size limit enforced while streaming (`MaxBytesReader`), image pixel limit (decompression bombs).
- [ ] Image metadata (EXIF/GPS) stripped.
- [ ] API keys: 32 random bytes, shown once, stored as SHA-256; scopes; expiry; revocation;
      `last_used_at` (updated at most once per minute).
- [ ] Tenant isolation on every query; cross-tenant → 404.
- [ ] Rate limit per API key; Cloudflare WAF rate limit on `/i/*` as a second layer.
- [ ] Constant-time signature checks; signing key rotation via `kid`.
- [ ] Path traversal impossible: keys are derived from validated UUID + allowlisted ext only.
- [ ] Container runs as **non-root** (uid 10001), read-only root FS, only `/data` writable.
- [ ] `/metrics` on a separate port not exposed through Traefik.
- [ ] Trust `CF-Connecting-IP` only when the peer is in Cloudflare's IP ranges (config `TRUSTED_PROXIES`).
- [ ] Secrets only in Coolify env vars; never logged. Logs redact `Authorization`.
- [ ] Optional: firewall the VPS so ports 80/443 accept only Cloudflare IPs (+ internal network).
- [ ] Sensitive files encrypted at rest (AES-256-GCM envelope), master key stored separately from backups.
- [ ] Sensitive URL TTL ≤ 5 min, `actor` mandatory, every issue/view audit-logged; audit table append-only.
- [ ] Account isolation: account-scoped endpoints only touch files of that `(tenant, account)`.

---

## 12. HTTP Server Hardening & Performance

- `http.Server` timeouts: `ReadHeaderTimeout 5s`, `ReadTimeout 60s` (upload routes),
  `IdleTimeout 120s`; `WriteTimeout` set per route via `http.ResponseController`
  (serve routes: generous for slow video clients).
- `MaxHeaderBytes 16KB`.
- Graceful shutdown on `SIGTERM`: stop accepting, drain in-flight (25s), stop workers, close pool.
- `pgxpool`: max conns ≈ 10 (small VPS), statement timeout 5s.
- libvips: disable its operation cache, set concurrency to 1 per job, global semaphore = NumCPU.
- Middleware order: `RequestID → RealIP → Recoverer → Logger → (route-specific) Auth → RateLimit`.
  Serve routes skip auth/rate-limit middleware entirely.
- Targets (origin, disk-cached, on VPS): `/f` p99 < 10 ms; variant cache hit p99 < 10 ms;
  variant miss (1024 webp from 4 MP jpeg) p99 < 300 ms; upload of 5 MB image p99 < 1.5 s.

---

## 13. Configuration (env vars)

| Var | Example | Notes |
|---|---|---|
| `APP_ENV` | `production` | |
| `HTTP_ADDR` | `:8080` | |
| `METRICS_ADDR` | `:9090` | not exposed publicly |
| `PUBLIC_BASE_URL` | `https://media.unfaa.com` | used to build returned URLs |
| `DATABASE_URL` | `postgres://...` | from Coolify Postgres resource |
| `STORAGE_DRIVER` | `local` | `s3` later |
| `STORAGE_PATH` | `/data` | **must** be the persistent mount |
| `MIN_FREE_DISK_PERCENT` | `10` | upload guard |
| `MAX_IMAGE_PIXELS` | `50000000` | |
| `IMAGE_JPEG_QUALITY` | `80` | upload compression (§8.1) |
| `IMAGE_PNG_QUALITY` | `65-80` | libimagequant min-max |
| `IMAGE_WEBP_QUALITY` | `80` | |
| `IMAGE_AVIF_QUALITY` | `55` | |
| `IMAGE_MIN_SAVING_PERCENT` | `5` | keep original if saving is smaller |
| `VARIANT_WIDTHS` | `64,128,256,512,768,1024,1536,2048` | |
| `VARIANT_FORMATS` | `webp,jpg,png` | add `avif` to enable |
| `VARIANT_CACHE_MAX_BYTES` | `10737418240` | 10 GB |
| `SIGNING_KEYS` | `k1:<base64 32B>` | first = active |
| `TRASH_RETENTION` | `168h` | |
| `PENDING_TTL` | `24h` | |
| `CDN_PROVIDER` | `cloudflare` | `none` in dev |
| `CF_ZONE_ID`, `CF_API_TOKEN` | | token scoped to *Cache Purge* only |
| `TRUSTED_PROXIES` | `cloudflare,10.0.0.0/8` | |
| `LOG_LEVEL` | `info` | |
| `PRIVATE_URL_DEFAULT_TTL` | `15m` | |
| `PRIVATE_URL_MAX_TTL` | `168h` | |
| `SENSITIVE_URL_TTL` | `5m` | hard maximum for sensitive |
| `SENSITIVE_MASTER_KEYS` | `m1:<base64 32B>` | first = active; keep an offline copy |
| `AUDIT_LOG_RETENTION` | `8760h` | 365 days |
| `DEFAULT_ACCOUNT_QUOTA_BYTES` | `5368709120` | applied to auto-created accounts; `0` = unlimited |

Config is validated at startup; the process refuses to start on invalid config
(e.g. `STORAGE_PATH` not writable, missing signing key).

---

## 14. Admin CLI

Same binary, run from the Coolify container terminal:

```bash
media-server migrate up
media-server admin tenant create --slug shop --name "Shop" --quota 20GB --kinds image,document
media-server admin tenant list
media-server admin tenant disable --slug shop
media-server admin key create --tenant shop --name shop-backend-prod --scopes files:read,files:write,files:delete,accounts:read,accounts:write,audit:read [--expires 365d]
#   → prints the full key ONCE
media-server admin key list --tenant shop
media-server admin key revoke --id <key-id>
media-server admin file purge --id <file-id>      # emergency: skip trash window
media-server admin reconcile --dry-run
media-server admin rewrap-keys                    # after rotating SENSITIVE_MASTER_KEYS
```

Key rotation procedure: create new key → deploy it to the client backend → revoke old key.

---

## 15. Deployment on Coolify (Hostinger VPS)

### 15.1 Dockerfile (outline)
- **libvips stage:** compile mozjpeg + libvips from source with libimagequant, libspng, libwebp,
  libheif, aom, lcms2, libexif (§8.1); install into `/usr/local`.
- **Build stage:** `golang:<ver>-bookworm` + headers from the libvips stage; `CGO_ENABLED=1`;
  `go build -trimpath -ldflags="-s -w -X main.version=$GIT_SHA"`.
- **Runtime stage:** `debian:bookworm-slim` + compiled libvips and its runtime libs from the libvips stage + `ca-certificates` + `tzdata`;
  create user `10001`; copy binary; `USER 10001`; `EXPOSE 8080`;
  `HEALTHCHECK CMD ["/usr/local/bin/media-server", "healthcheck"]`.
- `.dockerignore` excludes `.git`, `testdata`, `docs`.

### 15.2 Coolify setup
1. **Postgres:** New Resource → PostgreSQL (latest major). Enable scheduled backups to
   Backblaze B2 / R2 (daily, keep 14).
2. **App:** New Resource → from Git repo → Build pack **Dockerfile**.
   - Domain: `https://media.unfaa.com`, port `8080`.
   - **Persistent Storage:** bind mount host `/data/coolify/media-files` → container `/data`.
     On the host, once: `mkdir -p /data/coolify/media-files && chown -R 10001:10001 /data/coolify/media-files`.
   - Env vars from §13. Connect to the Postgres resource via its internal URL.
   - Health check path `/readyz`.
   - Migrations: run automatically at startup (`serve` runs `migrate up` under a Postgres
     advisory lock) — safe with multiple replicas.
   - Auto-deploy on push to `main` (GitHub webhook).
3. **Client backends on the same Coolify server:** connect them to the same Docker network and
   use `http://<media-service-name>:8080` for API calls (faster, bypasses Cloudflare limits).
4. **Uptime Kuma** (Coolify one-click): monitor `https://media.unfaa.com/healthz` and `/readyz`.

### 15.3 Cloudflare setup
- DNS `media` A record → VPS IP, **proxied**. SSL/TLS mode **Full (strict)**.
- Cache Rules:
  - `/f/*`, `/i/*` → *Eligible for cache*, respect origin headers (`CDN-Cache-Control`).
  - `/p/*`, `/s/*`, `/api/v1/*`, `/healthz`, `/readyz` → *Bypass cache*.
- WAF rate-limiting rule on `/i/*` per IP.
- API token with **Zone → Cache Purge** permission only.
- ⚠ Check Cloudflare's current CDN terms regarding serving video from the self-serve plans.
  Short clips at modest volume are typical; if video traffic grows large, move video delivery
  to R2 (+ custom domain) or Cloudflare Stream.

### 15.4 Backups & restore
- **Files:** host cron nightly: `restic backup /data/coolify/media-files --exclude variants --exclude tmp`
  → B2/R2. Retention: 7 daily, 4 weekly, 6 monthly. `restic check` weekly.
- **DB:** Coolify scheduled backups (above).
- **Restore drill (monthly):** restore both into a scratch environment, run
  `admin reconcile --dry-run`, verify a sample of URLs.
- DB and file backups are taken at slightly different times; reconcile resolves the drift.

---

## 16. Observability

- **Logs:** JSON via `slog`: `request_id, tenant, method, path, status, bytes, duration_ms, file_id`.
  Never log keys, signatures, or full signed URLs.
- **Metrics:**
  - `http_requests_total{route,code}`, `http_request_duration_seconds{route}`
  - `media_uploads_total{tenant,kind,result}`, `media_upload_bytes_total{tenant}`
  - `media_variant_generations_total{result}`, `media_variant_duration_seconds`
  - `media_disk_free_bytes`, `media_files_total{status}` (periodic gauge)
  - `media_jobs_total{kind,result}`, `media_jobs_pending{kind}`, `media_missing_files`
- **Alerts** (Uptime Kuma / Grafana later): readyz down, disk free < 20%, cdn_purge failures,
  missing files > 0, 5xx rate > 1%.

---

## 17. Testing Strategy

| Level | What |
|---|---|
| Unit | key derivation from UUIDv7; signing/verify (expiry, kid rotation, tamper); allowlist & sniffing; filename sanitization; variant spec parsing; error → HTTP mapping |
| Fixtures (`testdata/`) | valid jpeg/png/webp/avif/gif/mp4/webm/pdf/docx; **malicious**: HTML renamed `.jpg`, SVG with script, polyglot, zip renamed `.docx`, PNG decompression bomb, truncated JPEG, 10 MB + 1 byte file, EXIF-GPS jpeg (assert stripped) |
| Integration (`testcontainers-go`) | full upload → serve → delete → 404 → restore → purge cycle; orphan sweeper; quota accounting; concurrent uploads; tenant isolation; idempotency key replay |
| HTTP behavior | Range requests on mp4, `If-None-Match` → 304, HEAD, correct headers per type |
| Crash safety | kill between file commit and DB commit → reconcile fixes |
| Load | k6: 500 rps on `/f` cache-miss at origin; variant miss storm on one image (singleflight works) |
| CI | `golangci-lint`, `go test -race ./...`, `govulncheck`, docker build |

---

## 18. Implementation Milestones

Each milestone ends with passing tests, the matching `docs/api/` pages written or updated (§7.6), and a deploy to Coolify.

| # | Milestone | Deliverables | Done when |
|---|---|---|---|
| M0 | Skeleton | repo, Makefile, config, slog, chi, `/healthz` `/readyz`, Dockerfile, CI, Coolify deploy with volume + Postgres | Redeploy keeps a test file in `/data`; CI green |
| M1 | DB & admin | goose migrations, sqlc, tenants/api_keys/accounts, admin CLI, auth middleware + key cache, rate limit | Key created via CLI authenticates; revoked key → 401 |
| M2 | Upload & serve originals | streaming upload, sniffing, validation, storage local driver, `/f` + headers, Range, problem+json, idempotency | All fixture tests pass; malicious fixtures rejected |
| M3 | Private & sensitive files, accounts | `/p`, signing endpoint, kid rotation; sensitive tier (encryption, `/s`, grants, audit log + API); accounts API + atomic quotas | Expired/tampered → 410/403; sensitive file unreadable on disk; every view audited; concurrent uploads never exceed quota |
| M4 | Images | normalization + compression on upload (rotate, strip, sRGB, §8.1), variants `/i` + `/p` variants, singleflight, semaphore, variant cache | Latency targets met; EXIF stripped |
| M5 | Lifecycle | confirm (+ owner_ref), delete, delete-by-owner, restore, jobs table, worker, CDN purge, orphan/trash/tmp sweepers, reconcile | Full lifecycle integration test passes |
| M6 | Production readiness | complete `docs/api` guide + integration checklist + CI-run examples, metrics, alerts, Cloudflare rules, backups + restore drill, load test, runbook | Restore drill succeeds; load test meets targets |
| M7 (later) | Scale-out | S3/R2 driver, multiple replicas, optional ClamAV, ffprobe metadata, client SDK (Go/TS) | — |

---

## 19. Runbook (short)

| Situation | Action |
|---|---|
| Disk filling up | Check `media_disk_free_bytes`; shrink variant cache; raise tenant quotas carefully; plan R2 migration (M7) |
| Leaked API key | `admin key revoke --id ...` (effective within key-cache TTL, ≤ 60 s) |
| Leaked signing secret | Add new `kid` first in `SIGNING_KEYS`, redeploy, remove old after max TTL |
| Must remove a file *now* (legal) | `admin file purge --id ...` + verify Cloudflare purge job succeeded |
| CDN purge failing | Check token permissions; jobs retry automatically; manual purge in dashboard |
| Sensitive master key compromised | Add new key first in `SENSITIVE_MASTER_KEYS`, redeploy, run `admin rewrap-keys` (re-wraps DEKs only, files untouched), remove old key |
| Agency asks "who viewed our passports?" | `GET /api/v1/accounts/{ref}/audit-logs?event=viewed` |
| VPS lost | New VPS + Coolify → restore Postgres backup → `restic restore` into `/data/coolify/media-files` → deploy → `admin reconcile --dry-run` |

---

## 20. Resolved Items

| # | Question | Answer |
|---|---|---|
| 1 | Media domain | `media.unfaa.com`, API at `/api/v1` |
| 2 | Extra document types | Not needed — pdf, docx only |
| 3 | 7-day browser cache for public files | Accepted |
| 4 | Video depth | Minimal best-practice handling (§8.2); revisit if video becomes important |
| 5 | Expected volume | Small — single VPS + local disk is sufficient |
| 6 | Per-agency quotas | Yes — accounts with DB-counted quotas, weekly reconcile (§7.5) |
| 7 | Sensitive tier | Yes — encryption, 5-min URLs, full audit log (§9.4) |
| 8 | Virus scanning (ClamAV) | Deferred — not in v1 |

## 21. Open Items

1. Audit log retention: default 365 days — confirm whether a legal requirement (e.g. KYC rules) needs longer.
