# Serving files and URLs

> API v1 · Delivery lives outside `/api` so CDN rules stay simple.

| URL | Who can read | Cached by CDN |
|---|---|---|
| `GET /f/{id}.{ext}` | anyone — **public** original | yes |
| `GET /i/{id}/{w}.{fmt}` | anyone — **public** image variant | yes |
| `GET /p/{id}.{ext}?exp&kid&sig` | holder of a signed URL — **private** original | no |
| `GET /p/{id}/{w}.{fmt}?exp&kid&sig` | signed URL — **private** image variant | no |
| `GET /s/{id}.{ext}?g&exp&kid&sig` | signed URL + access grant — **sensitive** | no (`no-store`) |

Public reads never touch the database: the URL maps straight to a file on disk. `GET`, `HEAD` and `Range`
(seeking in video) are supported; `If-None-Match` returns `304`.

## Images: variants

Never serve a 4 000 px original to a 64 px avatar. Request a size:

```
https://media.unfaa.com/i/{id}/{w}.{fmt}
```

- `w` ∈ **64, 128, 256, 512, 768, 1024, 1536, 2048**; anything else → `404`.
- `fmt`: `jpg` and `png` always; **`webp`** and **`avif`** on the libvips build (otherwise `404` — check
  `variants_url_template` and the [CHANGELOG](CHANGELOG.md)). WebP is ≈ 40–50 % and AVIF ≈ 75–80 % smaller than
  the same `jpg`; every lossy variant is re-encoded until it is visually lossless (SSIM ≥ 0.98 against the source).
  Use `<picture>` to let the browser pick (below).
- Never upscaled: asking for 2048 on a 1000 px image returns 1000 px wide.
- The first request for a size renders it (≈ 100–300 ms) and caches it on disk; later requests are file reads.
  GIF, video and documents have no variants.

```html
<img
  src="https://media.unfaa.com/i/0192f3c4-…/512.jpg"
  srcset="https://media.unfaa.com/i/0192f3c4-…/256.jpg 256w,
          https://media.unfaa.com/i/0192f3c4-…/512.jpg 512w,
          https://media.unfaa.com/i/0192f3c4-…/1024.jpg 1024w"
  sizes="(max-width: 600px) 100vw, 512px" loading="lazy" alt="…">
```

```html
<picture>
  <source type="image/avif" srcset="https://media.unfaa.com/i/0192f3c4-…/512.avif 512w, https://media.unfaa.com/i/0192f3c4-…/1024.avif 1024w">
  <source type="image/webp" srcset="https://media.unfaa.com/i/0192f3c4-…/512.webp 512w, https://media.unfaa.com/i/0192f3c4-…/1024.webp 1024w">
  <img src="https://media.unfaa.com/i/0192f3c4-…/512.jpg" sizes="(max-width: 600px) 100vw, 512px" loading="lazy" alt="…">
</picture>
```

Variants are always sRGB and metadata-free; the stored original keeps its format (only EXIF/GPS are removed).

## Headers on public files

| Header | Value |
|---|---|
| `Cache-Control` | `public, max-age=604800, immutable` (browser 7 d) |
| `CDN-Cache-Control` | `max-age=31536000` (edge 1 y; purged on delete) |
| `ETag` / `Last-Modified` | present → conditional requests work |
| `Content-Type` | canonical type of the stored file |
| `Content-Disposition` | `inline` (`attachment` for DOCX) |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` (PDF: `default-src 'none'`) |
| `Access-Control-Allow-Origin` | `*` (GET only) |

Because URLs contain the immutable id, **a URL never changes content**. To change an image upload a new one.

## Private files: signed URLs

Private files have no permanent URL. Ask for one **after** your own permission check:

### `POST /api/v1/files/{id}/signed-url`  (scope `files:read`)

```json
{ "ttl": 900, "variant": { "w": 640, "fmt": "jpg" } }
```
- `ttl` seconds: private default **900** (15 min), max **604 800** (7 days). Out of range → `400`.
- `variant` optional, images only (same allowed values as above).
- Response: `{ "url": "https://media.unfaa.com/p/…?exp=…&kid=k1&sig=…", "expires_at": "…" }`.

Behaviour:

- The signature covers the path and expiry; any change → `403`. Expired → `410`.
- The check happens when the request *starts*: a download that began before expiry completes; a new `Range`
  request after expiry needs a new URL.
- Responses carry `Cache-Control: private, max-age=min(remaining, 300)`; Cloudflare bypasses `/p/*`.
- Do not log, store or share signed URLs; generate one per page view.
- Calling `signed-url` on a **public** file simply returns its permanent URL.

Sensitive files: see [visibility-and-sensitive-files.md](visibility-and-sensitive-files.md).
