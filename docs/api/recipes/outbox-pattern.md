# Recipe: reliable deletes with a transactional outbox

> API v1

Problem: you delete a post row and then call the media server. If the process dies in between, or the media
server is briefly down, the file leaks. Calling the media server *inside* your DB transaction doesn't help
either (two systems, no shared transaction).

Solution: in the **same DB transaction** that changes your data, insert a row into an `outbox` table. A worker
sends the requests and retries until `204`. Because `DELETE` is idempotent, at-least-once delivery is safe.

```sql
CREATE TABLE media_outbox (
  id          bigserial PRIMARY KEY,
  file_id     uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  attempts    int         NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  last_error  text
);
```

```ts
// in your business transaction
await tx.posts.delete(postId);
for (const id of fileIds) await tx.query("INSERT INTO media_outbox (file_id) VALUES ($1)", [id]);
```

```ts
// worker: runs every few seconds (cron / setInterval / queue consumer)
async function drainOutbox() {
  const rows = await db.query(
    `SELECT id, file_id FROM media_outbox WHERE next_at <= now()
     ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED`);            // safe with several workers
  for (const r of rows) {
    const res = await fetch(`${MEDIA}/api/v1/files/${r.file_id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${KEY}` },
    });
    if (res.status === 204 || res.status === 404) {            // 404 = already gone / never existed
      await db.query("DELETE FROM media_outbox WHERE id = $1", [r.id]);
    } else {                                                   // 429/5xx/network: back off
      await db.query(
        `UPDATE media_outbox SET attempts = attempts + 1, last_error = $2,
         next_at = now() + LEAST(interval '1 hour', interval '10 seconds' * power(2, attempts))
         WHERE id = $1`, [r.id, `HTTP ${res.status}`]);
    }
  }
}
```

Run the SELECT and the status updates in one transaction per batch (or claim rows with a lease column) so
`FOR UPDATE SKIP LOCKED` actually protects concurrent workers.

Monitor: alert when the oldest outbox row is older than an hour or `attempts > 10`.
