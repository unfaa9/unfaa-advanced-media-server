# File lifecycle — the rules your backend MUST follow

> API v1 · **Read this page before integrating.**

The media server cannot know whether your application still uses a file — only your backend knows. So the
responsibility is split:

| Responsibility | Owner |
|---|---|
| Storing bytes, serving, caching, deleting on request, cleaning orphans and trash | **Media server** |
| Knowing which record uses which file, and calling confirm/delete at the right time | **Your backend** |

## States

```
            upload(confirm=false)          confirm
  (none) ───────────────────────► pending ─────────► active
                                    │  24h unconfirmed   │ DELETE
                                    ▼                    ▼
                                  purged              deleted ──restore (≤ 7 days)──► active
                                                        │ 7 days
                                                        ▼
                                                      purged   (bytes + variants removed)
```

| State | Meaning | Served? | Counts toward quota? |
|---|---|---|---|
| `pending` | uploaded, not yet attached to your data | yes (URL works) | yes |
| `active` | confirmed, in use | yes | yes |
| `deleted` | in the 7-day trash | **no (404 immediately)** | no |
| `purged` | gone for good (row kept as a tombstone) | no | no |

## The seven rules

1. **MUST store the file `id`** (and optionally the URL) in your own database — never only the URL.
2. **Upload → save record → confirm.** Upload returns a `pending` file. Only after *your* DB transaction that
   references it has committed, call `confirm` (with `owner_ref`). If the user abandons the form you never
   confirm and the media server removes the file after 24 h. For one-step flows (avatar saved immediately)
   upload with `confirm=true`.
3. **Replace → delete the old.** Confirm the new file, then `DELETE` the old id.
4. **Record deleted → delete its files.** When a post/product is deleted, delete its file ids. When a user is
   deleted, call `delete-by-owner` with `owner_ref_prefix: "user:123:"`.
5. **Deletes MUST be reliable:** use the [transactional outbox](recipes/outbox-pattern.md) — the same DB
   transaction that removes your record inserts a "delete media" row, and a worker retries until `204`.
   `DELETE` is idempotent, so retries are safe.
6. **Permissions are your job.** The media server knows accounts, not end users. You MUST check
   that the logged-in user may see a file *before* requesting a signed URL, and MUST pass the user as `actor`
   for sensitive files.
7. **Active files never expire by time.** A confirmed avatar stays forever, however inactive the user is —
   it is removed only when you delete it.

## `owner_ref` convention

`<entity>:<id>:<field>` — `user:123:avatar`, `product:987:gallery`, `invoice:55:pdf`. Free text to the media
server (≤ 255 chars) but keep it consistent. It enables bulk deletion and answers "which files
belong to user 123?" via `GET /files?owner_ref=user:123:avatar`.

## Endpoints

### `POST /files/{id}/confirm`  (scope `files:write`)

```bash
curl -X POST "$MEDIA/api/v1/files/$ID/confirm" -H "Authorization: Bearer $KEY" \
     -H "Content-Type: application/json" -d '{"owner_ref":"post:77:images"}'
```
`pending → active`; idempotent for `active`; `owner_ref` optional. `409 invalid_state` if the file is
`deleted`/`purged`. Returns the file object.

### `POST /files/confirm`  (batch, ≤ 100)

```json
{ "ids": ["0192…", "0192…"], "owner_ref": "post:77:images" }
```
All-or-nothing: if any id is unknown (`404`) or not confirmable (`409`) nothing changes.

### `GET /files/{id}` and `GET /files`

`GET /files?cursor=&limit=50&purpose=&status=&account=&owner_ref=` → `{ "data": [...], "next_cursor": "…"|null }`,
newest first. `limit` ≤ 200.

## Typical flows

```
Avatar change:   upload(confirm=true, owner_ref=user:123:avatar) → save new id in users table
                 → outbox DELETE old id
Create post:     upload ×N (pending) → user submits → INSERT post + images
                 → confirm(ids, owner_ref=post:77:images)
Abandoned form:  upload (pending) → never confirmed → auto-removed after 24 h
Delete post:     DELETE post row + outbox DELETE each image id
Delete account:  delete user + outbox delete-by-owner("user:123:")
```

See the [recipes](recipes/).
