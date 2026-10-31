# Media Server API — developer guide

> Applies to: **API v1** · Base URL: `https://media.unfaa.com/api/v1`
> Inside the Coolify Docker network use `http://media-server:8080/api/v1` (faster, skips Cloudflare).

The media server stores, serves and deletes **images, short videos, PDFs and DOCX files** (≤ 15 MB each)
for our backends. Your backend uploads; browsers only ever *read* via CDN-cached URLs.

Keywords **MUST**, **SHOULD**, **MAY** are used as in RFC 2119.

## 5-minute quick start

```bash
export MEDIA=https://media.unfaa.com
export KEY=msk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # from the platform team

# 1. Upload (public image, confirmed immediately)
curl -sS -X POST "$MEDIA/api/v1/files?visibility=public&confirm=true&purpose=avatar&owner_ref=user:123:avatar" \
  -H "Authorization: Bearer $KEY" -F "file=@photo.jpg"
# → { "id": "0192f3c4-…", "url": "https://media.unfaa.com/f/0192f3c4-….jpg", … }

# 2. Store the *id* in your own database, put the url in your HTML:
#    <img src="https://media.unfaa.com/i/0192f3c4-…/512.jpg">

# 3. Delete it when the record that owns it is deleted
curl -sS -X DELETE "$MEDIA/api/v1/files/0192f3c4-…" -H "Authorization: Bearer $KEY"   # → 204
```

## Table of contents

| Page | Read it when… |
|---|---|
| [authentication.md](authentication.md) | getting a key, scopes, rotating or revoking |
| [uploading.md](uploading.md) | writing the upload call |
| [**file-lifecycle.md**](file-lifecycle.md) | **everyone: the rules your backend must follow** |
| [deleting.md](deleting.md) | deleting, restoring, CDN purge timing |
| [serving-and-urls.md](serving-and-urls.md) | rendering files, image sizes, signed URLs |
| [videos-and-documents.md](videos-and-documents.md) | mp4/webm/pdf/docx specifics |
| [visibility-and-sensitive-files.md](visibility-and-sensitive-files.md) | passports, NIDs, KYC, invoices |
| [accounts.md](accounts.md) | per-agency quotas, usage, account deletion |
| [limits-and-quotas.md](limits-and-quotas.md) | sizes, quotas, rate limits |
| [errors.md](errors.md) | every error code and what to do |
| [integration-checklist.md](integration-checklist.md) | before you go live |
| [recipes/](recipes/) | avatar, gallery, account deletion, outbox |
| [examples/](examples/) | runnable curl / TypeScript / Go |
| [media-server.postman_collection.json](media-server.postman_collection.json) | trying the API in Postman (import, set `mediaBaseUrl` and `apiKey`) |
| [CHANGELOG.md](CHANGELOG.md) | API changes and deprecations |

## Endpoint map

| Method & path | Scope | Page |
|---|---|---|
| `POST /files` | `files:write` | [uploading](uploading.md) |
| `GET /files/{id}` · `GET /files` | `files:read` | [file-lifecycle](file-lifecycle.md) |
| `POST /files/{id}/confirm` · `POST /files/confirm` | `files:write` | [file-lifecycle](file-lifecycle.md) |
| `DELETE /files/{id}` · `POST /files/delete-by-owner` · `POST /files/{id}/restore` | `files:delete` | [deleting](deleting.md) |
| `POST /files/{id}/signed-url` | `files:read` | [serving-and-urls](serving-and-urls.md) |
| `GET /files/{id}/audit-logs` · `GET /accounts/{ref}/audit-logs` | `audit:read` | [sensitive](visibility-and-sensitive-files.md) |
| `PUT/GET/DELETE /accounts/{ref}` | `accounts:write` / `accounts:read` | [accounts](accounts.md) |

Conventions: JSON bodies, times in RFC 3339 UTC, IDs are UUIDs, every response carries `X-Request-Id`
(send your own to correlate; quote it when reporting problems), errors are `application/problem+json`.
