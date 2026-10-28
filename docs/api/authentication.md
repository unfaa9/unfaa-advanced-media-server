# Authentication

> API v1

Every `/api/v1` call needs an API key:

```
Authorization: Bearer msk_<43 base62 characters>
```

The media server serves exactly **one backend**: only that backend uploads and deletes files. Keys are
created by the platform team with the admin CLI; you never create them yourself. The full key is shown **once** — store it in your secret manager
(Coolify env var), never in Git, logs, frontend code or a browser.

## Scopes

| Scope | Allows |
|---|---|
| `files:write` | upload, confirm |
| `files:read` | get/list metadata, request signed URLs |
| `files:delete` | delete, delete-by-owner, restore |
| `accounts:write` | create/update/delete accounts and their quotas |
| `accounts:read` | read account usage |
| `audit:read` | read audit logs of sensitive files |

Give each backend component the minimum it needs (e.g. a read-only reporting service gets `files:read`).
A missing scope returns `403 forbidden_scope`.

## Key properties

- Keys may have an expiry; an expired key returns `401 unauthorized`.
- Only a SHA-256 hash is stored server-side; a lost key cannot be recovered — request a new one.
- Revocation takes effect within **60 seconds** (key cache).
- Unauthenticated, wrong, revoked and expired keys all return `401` with `WWW-Authenticate: Bearer`.
- Requests are rate limited per key (see [limits-and-quotas](limits-and-quotas.md)).

## Rotation (no downtime)

1. Ask for a second key.
2. Deploy the new key to your backend.
3. Ask for the old key to be revoked.

## If a key leaks

Tell the platform team immediately: they revoke it (`media-server admin key revoke`), effective ≤ 60 s.
Files are not affected. Anyone holding the key could have uploaded/deleted files, so check
recent activity with `GET /files`.

## Public vs. internal base URL

Backends on the same Coolify server SHOULD upload through `http://media-server:8080` (internal network).
Browsers use only the public delivery URLs (`/f`, `/i`, `/p`, `/s`) which need no key.
