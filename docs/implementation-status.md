# Implementation status vs. the plan

Milestones M0–M6 of [`implementation-plan.md`](implementation-plan.md) are implemented and tested, with the
deviations below. M7 (scale-out) is intentionally not started.

## Where this build differs from the plan

| # | Plan | This build | Why / impact |
|---|---|---|---|
| 1 | **libvips** (mozjpeg, libimagequant, HEIC/AVIF/WebP encode) via govips (§3, §8.1, D8, D9) | **Pure-Go** `imaging.GoStd` behind the `imaging.Processor` interface. | The build machine has no libvips/pkg-config/sudo, and the repo must build and test anywhere with `CGO_ENABLED=0`. **Consequences:** HEIC/HEIF and AVIF uploads are rejected with `415` on this default build (**`Dockerfile.vips` / `-tags vips` accepts them**: `imaging.Vips` decodes via libheif, auto-rotates and hands a JPEG — PNG when there is alpha — to the normal pipeline; AVIF is *not* re-encoded as AVIF as plan §8.1 says; Debian's libvips, not a from-source build with mozjpeg/libimagequant); variants are `jpg`/`png` only (`webp`/`avif` → 404); JPEG uses the standard encoder at q80 (no mozjpeg trellis, so ≈10–15 % larger than mozjpeg); PNG is recompressed losslessly (no libimagequant palette quantisation, so screenshots shrink less than the plan's 50–80 %); ICC profiles are *kept* (not converted to sRGB) — also on re-encoded JPEG/PNG and in `jpg`/`png` variants, when the profile matches the output colour model; WebP/GIF are stored as uploaded with metadata stripped (GIF: comment/plain-text/XMP extensions removed, animation kept, total frame pixels capped at 2 × `MAX_IMAGE_PIXELS`). EXIF/GPS stripping, orientation, the 5 %-saving rule, pixel limits and `optimize=false` all work. **To close the rest of the gap:** mozjpeg/libimagequant/WebP-AVIF variants need a from-source libvips and a full `Processor` (variants are still delegated to `GoStd`). |
| 2 | sqlc, goose | Hand-written pgx SQL in `internal/db`; a ~60-line embedded migrator (`-- +migrate up`, advisory lock, `schema_migrations`) | Fewer build-time tools; same safety (multi-replica-safe migrate at start). `make migrate-new` scaffolds a file. |
| 3 | ristretto, caarlos0/env, testcontainers-go | small TTL map for keys, stdlib env parsing, docker-compose Postgres for tests | Fewer dependencies. |
| 4 | strong `ETag` from sha256 | originals: `ETag` = hex(size)-hex(mtime-ns); variants: hex(size)-fnv(key), no `Last-Modified` | The read path has no DB access, so the hash is not available there. Variant mtimes are refreshed on hits (at most daily) so the `variant_lru` trim is a real LRU; their ETag therefore must not depend on mtime. |
| 5 | DOCX `Content-Disposition` with original filename | download named `<id>.docx` on `/f` and `/p`; sensitive (`/s`) uses the sanitized original name | Same reason (no DB on the fast path). |
| 6 | PDF CSP to be verified | PDFs get `default-src 'none'` **without** `sandbox` | Chromium's PDF viewer does not render under `sandbox`. **Verify in a real browser** after deploy. |
| 7 | `DELETE` "always 204" vs error table "404 unknown id" | existing file in any state → 204 (idempotent); unknown id → 404 | Resolves the contradiction. |
| 8 | Variant path `variants/{id}/…` | `variants/{public\|private}/{id}/…` | **Security fix found in testing:** without the visibility segment a cached variant of a private file would be reachable through the public `/i/` route. Regression-tested. |
| 9 | audit table INSERT/SELECT-only DB role | trigger blocks `UPDATE`; `DELETE` stays allowed for the retention job | The retention job needs `DELETE`, and a second DB role would complicate Coolify setup. Tightening with a dedicated retention role is possible later. |
| 10 | quota reconcile and disk reconcile as two weekly jobs | one weekly `reconcile` job (also available as `admin reconcile [--dry-run]`) that does both | Same behaviour, one schedule. Quota counters are corrected under the counter's row lock (safe with concurrent uploads); rowless orphans moved to trash are deleted after `TRASH_RETENTION`; scans run with a 10 min statement timeout instead of 5 s. A failed periodic job retries after 10 min; each periodic job runs in its own loop. |
| 11 | tables | added `REQUIRE_ACCOUNT` config (used by §7.1), `files.meta` (MP4 faststart flag), `idempotency_keys`, `job_runs` | Required by features the plan describes but did not schema. |
| 12 | `Idempotency-Key` | concurrent identical keys are serialized by an in-process lock + DB lookup; a key reused with different query parameters → `422 idempotency_key_reused` (fingerprint column, now in migration 0001) | Correct for the planned single replica; for multiple replicas add a DB unique-claim step. |
| 13 | `air` hot reload, lefthook | not configured; `make dev` uses `go run` | Optional tooling. |

## Compression update (2026-10-19)

On the libvips build (`Dockerfile.vips`): `webp`/`avif` variants, guarded JPEG re-encode of originals (progressive,
optimized Huffman) and an SSIM quality guard (`IMAGE_MIN_SSIM`, default 0.98) that raises quality until the result
is visually lossless. Still not done: mozjpeg/libimagequant (Debian libvips), WebP/AVIF *originals*, lossy PNG. Note:
`.dockerignore` used to drop `*_test.go`, so `Dockerfile.vips --target test` ran no tests; fixed.

## Hardening after the first review (2026-10-17)

- `/s/*` verifies the HMAC before any DB lookup; only validly signed (incl. expired) requests are audited, so
  forged URLs can neither probe ids nor flood `audit_logs`.
- Client IP: `CF-Connecting-IP` is trusted only when the `X-Forwarded-For` walk through `TRUSTED_PROXIES` ends at
  a Cloudflare edge (bypassing Cloudflare via the VPS IP no longer spoofs the audit IP / per-IP limits).
- API keys: data race on the cache's `touched` field fixed; key-guessing floods no longer evict valid keys;
  failed auth is throttled per IP.
- Account deletion cannot leave racing uploads live in a deleted account; restoring a file revives its account.
- CI: integration tests fail (not skip) without Postgres (`REQUIRE_TEST_DB`), `docs/api/examples/curl.sh` runs
  against a real server (`tools/ci/e2e.sh`, `make e2e`), stricter Docker smoke test, pinned golangci-lint, PR
  template with the docs checkbox.

- Lint: `golangci-lint v2.15.0` reports 0 issues (unchecked closes, contextcheck, gosec with reasons).
- Idempotency fingerprint covers query *and* file bytes (`v2:` digest; pre-existing query-only rows still compare).
- Quota reconcile: dry runs take no lock; applying holds a counter's row lock for at most `CounterLockTimeout`
  (30 s), skipping the counter until the next run if the recount is slower.

## What was verified

- `go vet`, `gofmt`, `staticcheck` clean; `govulncheck`: **no vulnerabilities** (Go pinned to 1.27.2, which
  fixes ten stdlib advisories present in 1.27.1).
- `go test -race ./...`: unit tests (signing incl. rotation/tamper, envelope encryption incl. truncation and
  segment swapping, JPEG/PNG/WebP metadata stripping, EXIF orientation, sniffing, config validation,
  storage path-traversal, middleware, CDN client, admin CLI, key rewrap) and **integration tests against a
  real Postgres and real disk**: full upload → serve → delete → 404 → restore → purge cycle,
  scopes, malicious fixtures (HTML-as-JPG, SVG, fake DOCX, PNG bomb, truncated files, 10 MB + 1), two-part
  and interrupted uploads, EXIF stripped/rotated, variants (no upscale, singleflight, no leakage of private
  variants), private signed URLs (tamper/expiry), sensitive tier (ciphertext on disk, audit trail, range
  requests, append-only), accounts and **concurrent quota race** (12 parallel uploads, exactly the quota
  fits), idempotency under concurrency, batch-confirm atomicity, delete-by-owner, orphan sweeper, trash
  purger, CDN purge worker with backoff and dead-lettering, reconcile (orphans, missing files, quota drift).
- Real binary: migrate → CLI key → upload → serve → graceful SIGTERM; Docker image builds
  (27.6 MB, distroless), runs as uid 10001 with a read-only root filesystem, `/readyz` OK; `/metrics` is not
  reachable on the public port; `docs/api/examples/curl.sh` passes end to end.
- Load (dev laptop, generator on the same host, 64 connections, 928 KB file): `/f` ≈ 25k rps, p99 9.8 ms;
  cached variant ≈ 67k rps, p99 4.3 ms; variant miss (2400×1600 → 1024) ≈ 150 ms. Re-run `tools/loadtest`
  on the VPS to get production numbers.

## Not done / needs a human

- **Deploy-time items**, documented but not executable from here: Coolify resources, Cloudflare cache/WAF
  rules and API token, restic cron + bucket, Uptime Kuma, the monthly restore drill.
- Run `golangci-lint` (config provided, CI step wired); it is not installed on the build machine.
- Verify PDF inline viewing and `Range` video playback in real browsers behind Cloudflare.
- Decide **Open Item 1**: audit retention is 365 days (`AUDIT_LOG_RETENTION`); confirm against any KYC rule.
- Memory: each concurrent image job decodes into RAM (up to ~200 MB at the 50 MP limit); concurrency is
  `NumCPU`. On a small VPS lower `MAX_IMAGE_PIXELS` (e.g. 25 MP) if memory is tight.
- M7: S3/R2 driver, replicas, ClamAV hook, ffprobe metadata, client SDKs, libvips processor.
