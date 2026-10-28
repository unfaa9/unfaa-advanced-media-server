# Integration checklist

> API v1 — a client team MUST tick every box before going live.

**Setup**
- [ ] Key stored in a secret manager / Coolify env var; not in Git, logs or any frontend.
- [ ] Key has only the scopes this service needs.
- [ ] Backend uses the internal URL (`http://media-server:8080`) when on the same Coolify server.
- [ ] HTTP client timeouts: connect 3 s, total ≥ 60 s for uploads; retries with backoff + jitter on 429/5xx.

**Uploads**
- [ ] Every upload sends an `Idempotency-Key`.
- [ ] UI shows friendly messages for `413`, `415`, `422`, `507`.
- [ ] Browser → your backend → media server (no browser holds an API key).
- [ ] `visibility` chosen deliberately: nothing personal is `public`.
- [ ] Uploads pass `account` (agency id) if quotas per customer apply, and `owner_ref` per the convention.

**Lifecycle** ([rules](file-lifecycle.md))
- [ ] The file **id** is stored in my DB (not only the URL).
- [ ] Multi-step forms upload with `confirm=false` and call confirm **after** my DB commit.
- [ ] Replacing a file deletes the old id.
- [ ] Deleting a record deletes its files — via a **transactional outbox**, with retries until `204`.
- [ ] Account/user deletion uses `delete-by-owner` / `DELETE /accounts/{ref}`.
- [ ] I understand deleted public files can stay in users' browser caches for up to 7 days.

**Reading**
- [ ] Images are rendered through `/i/{id}/{w}.{fmt}` with `srcset`, not the original.
- [ ] Private files: I check the user's permission *before* requesting a signed URL; URLs are never stored or logged.
- [ ] Sensitive files: `actor` is the real logged-in user; a reason is passed when known.

**Operations**
- [ ] I log `X-Request-Id` and `code` of failed media calls.
- [ ] I alert on repeated `401/403` (key problem) and on outbox rows older than 1 h.
- [ ] Someone knows how to ask the platform team for a key rotation or emergency purge.
