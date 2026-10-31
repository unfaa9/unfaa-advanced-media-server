# Uploading

> API v1

## `POST /api/v1/files`

Uploads exactly one file. Scope: `files:write`. Only backends upload — **never** expose your API key to a browser.

### Request

`multipart/form-data` with **exactly one part named `file`**. Options go in the query string so the body can
stream:

| Parameter | Required | Description |
|---|---|---|
| `visibility` | yes | `public`, `private` or `sensitive` — see [visibility](visibility-and-sensitive-files.md) |
| `confirm` | no (`false`) | `true` = active immediately; `false` = `pending` until you call confirm ([lifecycle](file-lifecycle.md)) |
| `purpose` | no | free label, e.g. `avatar`, `invoice` (`[A-Za-z0-9_.:@-]`, ≤ 128) |
| `owner_ref` | no | `<entity>:<id>:<field>`, e.g. `user:123:avatar`. Enables bulk delete |
| `account` | no* | your customer id, e.g. `agency_42` — quotas are per account. *Required if the server runs with `REQUIRE_ACCOUNT=true`* |
| `actor` | sensitive only | your end-user's id (e.g. `staff_17`), written to the audit log |
| `optimize` | no (`true`) | `false` keeps image pixels untouched (metadata is still stripped) |

Header `Idempotency-Key: <≤255 chars>` (optional but **recommended**): retries with the same key within 24 h
return the original response (`Idempotent-Replay: true`) instead of creating a duplicate. A retry MUST send the
same query parameters (order does not matter) **and the same file bytes**; reusing a key for an upload with
different parameters or content returns `422 idempotency_key_reused`. The replayed body is the response of the first upload — it does not reflect later
confirm/delete calls; use `GET /api/v1/files/{id}` for the current state.

```bash
curl -sS -X POST "https://media.unfaa.com/api/v1/files?visibility=public&purpose=product&account=agency_42" \
  -H "Authorization: Bearer $KEY" \
  -H "Idempotency-Key: order-1001-img-1" \
  -F "file=@shoe.png"
```

### Response `201 Created`

```json
{
  "id": "0192f3c4-7a1b-7c2e-9d10-5b6c7d8e9f00",
  "status": "pending",
  "visibility": "public",
  "kind": "image",
  "mime": "image/png",
  "size": 482113,
  "original_size": 1904220,
  "compressed": true,
  "sha256": "9f86d0…",
  "width": 1600,
  "height": 1067,
  "url": "https://media.unfaa.com/f/0192f3c4-7a1b-7c2e-9d10-5b6c7d8e9f00.png",
  "variants_url_template": "https://media.unfaa.com/i/0192f3c4-7a1b-7c2e-9d10-5b6c7d8e9f00/{w}.{fmt}",
  "account": "agency_42",
  "purpose": "product",
  "original_name": "shoe.png",
  "created_at": "2026-10-10T08:00:00Z"
}
```

`url` and `variants_url_template` exist only for **public** files. Videos also return `meta.faststart`.

### What the server does to your file

| Step | Detail |
|---|---|
| Type check | By **magic bytes only**. Your filename, extension and `Content-Type` are ignored. |
| Allowed | JPEG, PNG, WebP, GIF · MP4, WebM · PDF · DOCX. Everything else → `415`. SVG/HTML/XML are rejected. |
| Size | ≤ **15 MB** (hard limit, enforced while streaming) → `413 file_too_large` |
| Images | Validated (pixel limit 50 MP, corrupt/bomb → `422`), **EXIF/GPS/comments stripped**, EXIF **orientation applied**, then re-compressed at the **same resolution**. If compression would not save ≥ 5 % the original pixels are kept. |
| DOCX | Must be a real Word package; macro-enabled files and zip bombs are rejected. |
| PDF/MP4/WebM | Structure checked; stored as-is. |

> **Build note (current release):** compression is lossy for JPEG (quality 80) and lossless for PNG; WebP and
> GIF are stored as uploaded (metadata stripped). HEIC/HEIF and AVIF uploads are **rejected with `415` on the default
> build** — the libvips build (`Dockerfile.vips`) accepts them and stores JPEG (PNG if the image has transparency);
> otherwise convert client-side (iOS can do this when exporting). See [CHANGELOG](CHANGELOG.md).

Compression happens **before** the response, so `url` always points at the final bytes. Read `size` /
`original_size` to see the saving.

### Errors

`400` bad params / not multipart / more than one file part · `401` · `403` · `413` too large · `415` type not
allowed (or that kind is not in `ALLOWED_KINDS`) · `422` corrupt content · `429` · `507` quota/disk. Details in
[errors.md](errors.md).

### Gotchas

- A `pending` file that you never confirm is **deleted after 24 h** — see [file-lifecycle](file-lifecycle.md).
- Send the multipart body as a stream from your HTTP client; don't base64 it.
- Filenames are sanitized and only used for download headers on sensitive files.
- On `5xx` or network errors retry with the **same** `Idempotency-Key`.
