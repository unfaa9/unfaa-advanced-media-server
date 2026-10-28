# Recipe: post with a gallery (two-phase, batch confirm)

> API v1

1. As the user adds images, upload each one **unconfirmed** (default). Keep the returned `id`s in the form state.
2. When the user presses *Publish*, create your records and, **after your DB transaction commits**, confirm all ids
   in one call.
3. If the user abandons the form, do nothing — the media server deletes unconfirmed files after 24 h.

```ts
// 1. per image (your backend proxies the browser upload)
const { id, url } = await uploadPending(file);          // POST /files?visibility=public&purpose=post-image

// 2. on publish
const post = await db.transaction(async (tx) => {
  const p = await tx.posts.insert({ title });
  await tx.postImages.insertMany(p.id, imageIds);       // store the IDs
  return p;
});
await media.confirmBatch(imageIds, `post:${post.id}:images`);   // POST /files/confirm {ids, owner_ref}
```

If confirm fails (network/5xx) retry it — it is idempotent. If you cannot confirm within 24 h of the upload the
file is gone, so a confirm retry loop must be shorter than that; `404`/`409` from confirm means re-upload.

Deleting the post later: outbox `DELETE` for each image id, or one `delete-by-owner` with prefix `post:77:`
(note the trailing colon).
