# Operations: deployment, Cloudflare, backups, runbook

Implements plan §15, §16 and §19.

## 1. Deploy on Coolify (Hostinger VPS)

1. **Postgres** — New Resource → PostgreSQL (latest major). Enable scheduled backups to Backblaze B2 / R2
   (daily, keep 14).
2. **App** — New Resource → from Git → build pack **Dockerfile**. For WebP/AVIF variants, HEIC input and the SSIM quality guard use `Dockerfile.vips` instead (libvips; same env vars, `IMAGE_MIN_SSIM`, `IMAGE_WEBP_QUALITY`, `IMAGE_AVIF_QUALITY`).
   - Domain `https://media.unfaa.com`, port `8080`, health check path `/readyz`.
   - **Persistent storage:** bind mount host `/data/coolify/media-files` → container `/data`. Once, on the host:
     ```bash
     mkdir -p /data/coolify/media-files && chown -R 10001:10001 /data/coolify/media-files
     ```
   - Environment variables: see `.env.example`; generate secrets with `head -c32 /dev/urandom | base64`.
     Required: `DATABASE_URL` (Coolify internal URL), `PUBLIC_BASE_URL`, `SIGNING_KEYS`, `CF_ZONE_ID`,
     `CF_API_TOKEN`, `CDN_PROVIDER=cloudflare`, `APP_ENV=production`; optional: `SENSITIVE_MASTER_KEYS`.
   - Migrations run automatically at start under a Postgres advisory lock (safe with several replicas).
   - Auto-deploy on push to `main` (GitHub webhook).
   - The image runs as uid 10001; enable "read-only root filesystem" if your Coolify version offers it
     (only `/data` is written).
3. **Backends on the same server** join the same Docker network and call `http://<service-name>:8080`.
   Do not publish port 9090 (metrics) through Traefik.
4. **Uptime Kuma** (Coolify one-click): monitor `https://media.unfaa.com/healthz` and `/readyz`.
5. **Backend key** — set the upload policy env vars (`MAX_FILE_BYTES`, `ALLOWED_KINDS`, `RATE_LIMIT_RPS`,
   `REQUIRE_ACCOUNT`) if the defaults don't fit, then in the container terminal:
   ```bash
   media-server admin key create --name backend-prod \
     --scopes files:read,files:write,files:delete,accounts:read,accounts:write,audit:read --expires 365d
   ```

### Scaling out later

The app is stateless apart from the volume: background jobs and migrations are multi-replica safe. To run
more than one replica you first need shared storage — implement the S3/R2 driver behind
`storage.Storage` (plan M7); with a local disk keep a single replica.

## 2. Cloudflare

- DNS: `media` A record → VPS IP, **proxied**. SSL/TLS **Full (strict)**.
- Cache Rules:
  - `/f/*`, `/i/*` → *Eligible for cache*, respect origin headers (`CDN-Cache-Control`).
  - `/p/*`, `/s/*`, `/api/v1/*`, `/healthz`, `/readyz` → **Bypass cache**.
- WAF rate-limiting rule on `/i/*` per IP (variant generation is the only CPU-heavy public route).
- API token: **Zone → Cache Purge** only → `CF_API_TOKEN`.
- Optional: firewall the VPS so 80/443 accept only [Cloudflare IPs](https://www.cloudflare.com/ips/) (+ the
  Docker network). The built-in `TRUSTED_PROXIES=cloudflare` list is a snapshot; review it when Cloudflare
  publishes changes.
- Client IP resolution (audit `ip`, per-IP limits): starting from the TCP peer the server walks
  `X-Forwarded-For` back through `TRUSTED_PROXIES` (Traefik, Docker network). `CF-Connecting-IP` is honoured
  **only if that walk ends at a Cloudflare edge address**, so a client that bypasses Cloudflare and hits the VPS
  IP directly cannot forge its address. Requires `cloudflare` in `TRUSTED_PROXIES` and Traefik to append the
  peer to `X-Forwarded-For` (its default).
- Check Cloudflare's current CDN terms regarding serving video from self-serve plans. Short clips at modest
  volume are typical; if video grows, move delivery to R2 or Stream.

## 3. Backups and restore

- **Files:** `deploy/restic-backup.sh` via host cron (nightly): restic → B2/R2, excludes `variants/` and `tmp/`;
  retention 7 daily / 4 weekly / 6 monthly; weekly `restic check`.
- **DB:** Coolify scheduled backups (above).
- **Sensitive master keys** are stored separately (Coolify env + offline password manager) and never in the
  file backup.
- The two backups are taken at slightly different times; `admin reconcile` resolves the drift.
- **Monthly restore drill:** restore both into a scratch environment, run
  `media-server admin reconcile --dry-run`, fetch a sample of public URLs and one sensitive file.

## 4. Observability

Logs are JSON (`request_id, method, path, route, status, bytes, duration_ms, file_id`). Authorization
headers, API keys, query strings and signed URLs are never logged.

Prometheus on `METRICS_ADDR` (`:9090`, internal only): `http_requests_total`, `http_request_duration_seconds`,
`media_uploads_total`, `media_upload_bytes_total`, `media_compression_saved_bytes_total`,
`media_variant_generations_total`, `media_variant_duration_seconds`, `media_disk_free_bytes`,
`media_files_total{status}`, `media_jobs_total`, `media_jobs_pending`, `media_jobs_dead`, `media_missing_files`,
`media_quota_drift_bytes`.

Alerts: `/readyz` down · disk free < 20 % · `media_jobs_dead > 0` or cdn_purge failures · `media_missing_files > 0` ·
5xx rate > 1 %.

## 5. Background jobs

| Job | Schedule | What |
|---|---|---|
| `cdn_purge` | continuous | calls the Cloudflare purge API; exponential backoff 30 s → 1 h with jitter; 10 attempts |
| `orphan_sweep` | 15 min | purges `pending` files older than `PENDING_TTL` (24 h) |
| `trash_purge` | 1 h | permanently removes files deleted longer than `TRASH_RETENTION` (7 d) |
| `tmp_sweep` | 1 h | removes `tmp/` files older than 1 h (crashed uploads) |
| `variant_lru` | daily | trims the variant cache to 80 % of `VARIANT_CACHE_MAX_BYTES` when over |
| `audit_retention` | daily | deletes audit rows/grants older than `AUDIT_LOG_RETENTION` |
| `idempotency_expiry` | daily | drops idempotency keys > 24 h |
| `reconcile` | weekly | disk vs DB (orphans → trash, missing bytes logged) **and** quota counters recomputed |

Schedules are claimed with an atomic UPDATE, so each tick runs once even with several replicas.

## 6. Runbook

| Situation | Action |
|---|---|
| Disk filling up | Check `media_disk_free_bytes`; lower `VARIANT_CACHE_MAX_BYTES`; review account quotas; plan R2 migration (M7) |
| Leaked API key | `media-server admin key revoke --id …` (effective ≤ 60 s) |
| Leaked signing secret | Put a new kid first in `SIGNING_KEYS` (`k2:…,k1:…`), redeploy, remove `k1` after the max private TTL (7 d) |
| Must remove a file *now* (legal) | `media-server admin file purge --id …`, then confirm the `cdn_purge` job finished (`media_jobs_pending`) or purge in the Cloudflare dashboard. Browsers keep their copy ≤ 7 d |
| CDN purge failing | Check token permission and `media_jobs_dead`; jobs retry automatically; manual purge in the dashboard |
| Sensitive master key compromised | Put a new key first in `SENSITIVE_MASTER_KEYS` (`m2:…,m1:…`), redeploy, `media-server admin rewrap-keys`, remove `m1`. (Rewrapping protects data at rest going forward; consider whether exposed backups need re-encryption.) |
| "Who viewed our passports?" | `GET /api/v1/accounts/{ref}/audit-logs?event=viewed` |
| `media_missing_files > 0` | Bytes missing for active rows: restore those paths from restic; logs name the file ids |
| Quota looks wrong | `media-server admin reconcile --dry-run` shows drift; run without the flag to fix |
| VPS lost | New VPS + Coolify → restore the Postgres backup → `restic restore` into `/data/coolify/media-files` → deploy → `admin reconcile --dry-run` |
| Key leaked or misused | `admin key revoke --id …` (≤ 60 s) |

## 7. Admin CLI reference

```
media-server migrate up
media-server admin key create --name N [--scopes a,b] [--expires 365d]   # prints the key ONCE
media-server admin key list
media-server admin key revoke --id UUID
media-server admin file purge --id UUID
media-server admin reconcile [--dry-run]
media-server admin rewrap-keys
media-server healthcheck | version
```
