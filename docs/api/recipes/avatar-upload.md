# Recipe: avatar upload

> API v1 · One-step flow: upload → save → delete old.

```
browser ──(multipart)──► your backend ──► media server
                              │
                              ├─ save new file id in users.avatar_file_id (your DB)
                              └─ outbox: DELETE old file id
```

TypeScript (Node 20, `fetch`):

```ts
async function changeAvatar(userId: number, file: Blob, filename: string) {
  const form = new FormData();
  form.append("file", file, filename);

  const res = await fetch(
    `${MEDIA}/api/v1/files?visibility=public&confirm=true&purpose=avatar&owner_ref=user:${userId}:avatar`,
    { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Idempotency-Key": `avatar-${userId}-${crypto.randomUUID()}` }, body: form },
  );
  if (!res.ok) throw await MediaError.from(res);        // map 413/415/422 to user messages
  const media = await res.json();

  await db.transaction(async (tx) => {
    const old = await tx.users.getAvatarFileId(userId);
    await tx.users.setAvatar(userId, media.id);          // store the ID
    if (old) await tx.outbox.insert({ kind: "media.delete", fileId: old }); // delete old reliably
  });
  return media.url;                                      // or build /i/{id}/256.jpg
}
```

Render with a variant: `https://media.unfaa.com/i/${id}/256.jpg` (64/128/256 cover typical avatar sizes).

Why `confirm=true`: the file is attached to your record in the same step, so there is no gap to protect.
If the DB transaction fails after upload, the file stays active but unreferenced — either use the two-phase
flow ([post-with-gallery](post-with-gallery.md)) or accept that `owner_ref=user:ID:avatar` lets you find
and clean such leftovers (`GET /files?owner_ref=user:123:avatar`).
