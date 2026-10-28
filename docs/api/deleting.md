# Deleting and restoring

> API v1

## `DELETE /api/v1/files/{id}`  (scope `files:delete`)

Optional `?actor=<user id>` (recorded in the audit log for sensitive files). Returns **`204 No Content`**.

Idempotent: deleting an already-deleted or purged file also returns `204`. An id that does not exist is
`404`.

What happens synchronously:

1. The row becomes `deleted` and the file's bytes are released from your quota.
2. The file is moved out of the served tree → **the origin answers `404` immediately**.
3. Cached image variants are removed.
4. A CDN purge for the original and all variant URLs is queued (public files).

After **7 days** the trash purger permanently removes the bytes (`purged`).

### CDN purge timing and the browser-cache caveat

Cloudflare is purged within seconds. **Browsers cannot be purged**: public files are sent with
`Cache-Control: public, max-age=604800, immutable`, so a user who already viewed the file may still see it for
up to **7 days** from their own cache. Design accordingly: if something must disappear *now* for everyone,
use a `private` or `sensitive` file instead, or ask the platform team for an emergency purge
(`admin file purge`) — that fixes the server and CDN, not other people's browsers.

## `POST /api/v1/files/delete-by-owner`  (scope `files:delete`)

```json
{ "owner_ref_prefix": "user:123:", "actor": "staff_1" }
```
Soft-deletes every `pending`/`active` file whose `owner_ref` starts with the prefix. The prefix MUST be at
least 3 characters and end with `:` (a safety rail against deleting too much). `%` and `_` are literal.
Returns `{ "deleted": 4 }`.

## `POST /api/v1/files/{id}/restore`  (scope `files:delete`)

Brings a `deleted` file back to `active` within the 7-day window. Errors: `409 invalid_state` (not deleted, or
outside the window, or bytes already gone), `507 quota_exceeded` (restoring re-checks the quota).
Files removed by the orphan sweeper (`pending` for 24 h) or already `purged` cannot be restored.

## Reliable deletes

A delete that is lost leaves an unused file counting against your quota forever. Use the
[outbox pattern](recipes/outbox-pattern.md): record the intent in the *same transaction* as your own change,
send it afterwards, retry until `204`.
