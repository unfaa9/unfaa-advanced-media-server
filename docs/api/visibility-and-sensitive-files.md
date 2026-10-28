# Visibility tiers: public, private, sensitive

> API v1

Choose per upload with `visibility=`; it cannot change afterwards (re-upload to change tier).

| | `public` | `private` | `sensitive` |
|---|---|---|---|
| Typical use | avatars, product photos, marketing | invoices, internal documents | passport, NID, visa, KYC |
| URL | permanent, unguessable id | signed, expiring (default 15 min, max 7 d) | signed + grant, **max 5 min** |
| Browser/CDN caching | 7 d browser / 1 y edge | none at CDN, ≤ 5 min browser | **never** (`no-store`) |
| Encrypted at rest | no | no | **yes** (AES-256-GCM envelope) |
| Image variants | yes | yes | **no** |
| Audit trail | no | no | **every issue and every view** |
| `actor` required | no | no | **yes** |

"Unguessable" means a UUIDv7 with 74 random bits — enough against guessing, **not** a substitute for
visibility: anyone who obtains a public URL can read the file.

## Sensitive files

### Uploading

```bash
curl -X POST "$MEDIA/api/v1/files?visibility=sensitive&confirm=true&account=agency_42&actor=staff_9&purpose=passport" \
  -H "Authorization: Bearer $KEY" -F "file=@passport.jpg"
```
`actor` (your end-user's id) is mandatory. Images are still normalized and stripped of EXIF/GPS.
The server answers `400` if the sensitive tier is not enabled on the deployment.

### Reading

```json
POST /api/v1/files/{id}/signed-url
{ "actor": "staff_17", "reason": "visa processing", "ttl": 120 }
```
- `actor` is **required**; `reason` optional (≤ 500 chars). `ttl` ≤ 300 s (default 300). No `variant`.
- The server records an **access grant** and a `url_issued` audit event, and returns
  `https://media.unfaa.com/s/{id}.{ext}?g=<grant>&exp=…&kid=…&sig=…`.
- Each request to the URL writes a `viewed` audit event (grant, actor, IP, user agent); failed attempts write
  `view_denied`. Expired → `410`, tampered → `403`.
- You MUST authorize the human *before* requesting the URL, and MUST pass the real user as `actor`.
- Responses: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`.

### Audit logs  (scope `audit:read`)

```
GET /api/v1/files/{id}/audit-logs?event=&from=&to=&cursor=&limit=
GET /api/v1/accounts/{ref}/audit-logs?event=viewed&from=2026-10-01T00:00:00Z
```
Events: `uploaded`, `url_issued`, `viewed`, `view_denied`, `deleted`, `restored`, `purged`. Newest first;
`next_cursor` for paging (`limit` ≤ 500). Logs are append-only and kept 365 days (they outlive the file).
This answers "who viewed our passports?" for an agency.

### Not in v1

Per-view watermarks, single-use URLs, IP binding.
