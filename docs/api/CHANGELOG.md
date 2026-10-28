# API changelog

Breaking changes ship only in a new version (`/api/v2`); the old version is deprecated here with a date and a
`Deprecation` response header.

## v1.3 — 2026-10-22

- The server now serves a **single backend**; tenants are gone. API keys look like `msk_<43 base62 characters>`
  (no slug). The upload policy (max file size, allowed kinds, rate limit, require-account) is set by the
  `MAX_FILE_BYTES`, `ALLOWED_KINDS`, `RATE_LIMIT_RPS` and `REQUIRE_ACCOUNT` env vars. There is no server-wide
  storage quota any more: per-account quotas and the disk guard still apply.

## v1.2 — 2026-10-19

- On the libvips build (`Dockerfile.vips`) variants can be requested as **`webp`** and **`avif`** (and `jpg`/`png`
  as before): `/i/{id}/{w}.webp`. Typically ≈ 40–50 % (WebP) and ≈ 75–80 % (AVIF) smaller than the same `jpg`.
  The default build still returns `404` for them; `variants_url_template` shows what is available.
- Quality guard: every lossy variant (and every re-encoded JPEG original) is compared to the decoded source and
  re-encoded at a higher quality until it is visually lossless (SSIM ≥ `IMAGE_MIN_SSIM`, default 0.98). Variants are
  sRGB, auto-rotated and metadata-free. JPEG originals are only replaced when the guarded re-encode is ≥
  `IMAGE_MIN_SAVING_PERCENT` smaller.

## v1.1 — 2026-10-17

- Idempotency now also compares the uploaded file's content: the same key with the same parameters but a
  different file returns `422 idempotency_key_reused`. A retry must therefore send the same bytes; a replay
  needs a valid multipart body again.
- On the libvips build (`Dockerfile.vips`), HEIC/HEIF and AVIF uploads are accepted and stored as JPEG (PNG when
  the image has transparency). The default build still answers `415`.

- New error `422 idempotency_key_reused`: an `Idempotency-Key` reused within 24 h for an upload with different
  query parameters is rejected instead of replaying the first response.
- Failed API-key attempts are throttled per client IP (`429 rate_limited`).
- Restoring a file of a deleted account revives the account; account deletion also removes uploads that raced
  with it.
- Images: re-encoded JPEG/PNG originals and `jpg`/`png` variants keep the source ICC colour profile (no more
  washed-out Display-P3 photos). GIF comments/XMP are now stripped; animated GIFs over the frame-pixel budget
  (2 × `MAX_IMAGE_PIXELS` across all frames) are rejected with `422 invalid_content`.
- Variant responses use a content ETag and no `Last-Modified` (cache revalidation unaffected).

## v1 — initial release

- Upload (`public`/`private`/`sensitive`), confirm (single + batch), get/list, delete, restore,
  delete-by-owner, signed URLs, accounts + quotas, audit logs.
- Delivery: `/f`, `/i` (public), `/p` (private, signed), `/s` (sensitive, signed + grant).

### Known limitations of this build

| Area | Current behaviour | Planned |
|---|---|---|
| Image formats | JPEG/PNG/WebP/GIF accepted. **HEIC/HEIF and AVIF are rejected (`415`)** on the default build; accepted (stored as JPEG, or PNG with alpha) on the libvips build | — |
| Variants | `jpg`, `png` | `webp`, `avif` with libvips |
| JPEG compression | standard encoder, quality 80 | mozjpeg (smaller files at same quality) |
| PNG compression | lossless recompression | palette quantisation (libimagequant) |
| WebP / GIF | stored as uploaded (animation kept), metadata stripped | — |
| Virus scanning | none | optional ClamAV (M7) |
