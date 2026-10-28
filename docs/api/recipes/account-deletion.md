# Recipe: deleting a user or an agency

> API v1

**A user** (files tagged `owner_ref = user:123:<field>`):

```bash
curl -X POST "$MEDIA/api/v1/files/delete-by-owner" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"owner_ref_prefix":"user:123:"}'
# {"deleted": 4}
```
The prefix must end with `:` and be ≥ 3 characters, so `user:12:` never matches `user:123:`. Send it from an
outbox worker so it is retried until it succeeds (it is idempotent: a second run returns `{"deleted":0}`).

**An agency / customer** (files uploaded with `account=agency_42`):

```bash
curl -X DELETE "$MEDIA/api/v1/accounts/agency_42?actor=admin_1" -H "Authorization: Bearer $KEY"
# {"deleted_files": 812}
```
All files go to the 7-day trash (restorable with `POST /files/{id}/restore`), then are purged. Sensitive
files record `deleted` audit events with the `actor`. Audit logs themselves are retained for 365 days.

For legal erasure that must not wait 7 days, ask the platform team to run `admin file purge --id …`.
