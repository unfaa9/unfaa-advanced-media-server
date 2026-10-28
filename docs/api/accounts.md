# Accounts (agencies) and per-account quotas

> API v1

Your backend often serves many customers (e.g. travel **agencies**). Pass `account=<your customer id>` on upload
and the media server tracks usage per customer, so quotas, usage meters and bulk deletion work per agency.

- The account is **auto-created on first upload** with the default quota (5 GB unless configured otherwise).
- Plans and prices live in *your* app; the media server stores only a byte limit.

## `PUT /api/v1/accounts/{ref}`  (scope `accounts:write`)

Create or update an account's quota (e.g. when an agency changes plan).

```bash
curl -X PUT "$MEDIA/api/v1/accounts/agency_42" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"quota_bytes": 21474836480}'
```
`quota_bytes` is **required**; `null` means unlimited (the server disk guard still applies). Lowering it below the
current usage is allowed: existing files stay, new uploads fail with `507`.

## `GET /api/v1/accounts/{ref}`  (scope `accounts:read`)

```json
{ "ref": "agency_42", "quota_bytes": 5368709120, "used_bytes": 4509715660, "file_count": 812, "usage_percent": 84.06 }
```
Call it before showing an upload form ("4.2 GB of 5 GB used").

## `DELETE /api/v1/accounts/{ref}`  (scope `accounts:write`)

Soft-deletes **all** of the account's files (normal 7-day trash window) and marks the account deleted.
Returns `{ "deleted_files": 812 }`. Uploading again with the same `account` revives it, and so does
restoring one of its files within the trash window (the restored file is counted in its usage again).
Uploads that race with the deletion are deleted too: the account is only marked deleted once it has no
pending/active files left.

## What counts toward the quota

The **stored** size (after compression — customers benefit) of `pending` + `active` files.

- Deleting releases the bytes immediately; restoring re-checks the quota (`507` if there is no room).
- Enforcement is atomic: concurrent uploads can never push an account past its quota.
- Counters are recomputed from the database weekly; drift is corrected and reported.
