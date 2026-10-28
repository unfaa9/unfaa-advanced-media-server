#!/usr/bin/env bash
# Runnable end-to-end example. Usage:  MEDIA=http://localhost:8080 KEY=msk_… ./curl.sh image.jpg
# Exits non-zero on the first failed expectation, so CI can run it against a staging server.
set -euo pipefail
: "${MEDIA:?set MEDIA}" "${KEY:?set KEY}"
IMG="${1:?usage: curl.sh <image.jpg>}"
auth=(-H "Authorization: Bearer $KEY")
json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

echo "1. upload (pending)"
UP=$(curl -fsS "${auth[@]}" -H "Idempotency-Key: example-$$" \
  -F "file=@$IMG" "$MEDIA/api/v1/files?visibility=public&purpose=example")
ID=$(echo "$UP" | json "['id']"); URL=$(echo "$UP" | json "['url']")
echo "   id=$ID size=$(echo "$UP" | json "['size']") original=$(echo "$UP" | json "['original_size']")"

echo "2. confirm"
curl -fsS "${auth[@]}" -H 'Content-Type: application/json' -d '{"owner_ref":"example:1:image"}' \
  -X POST "$MEDIA/api/v1/files/$ID/confirm" | json "['status']" | grep -qx active

echo "3. public original and a 256px variant"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL")" = 200 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' "$MEDIA/i/$ID/256.jpg")" = 200 ]

echo "4. delete (idempotent) -> origin 404"
[ "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X DELETE "$MEDIA/api/v1/files/$ID")" = 204 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X DELETE "$MEDIA/api/v1/files/$ID")" = 204 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL")" = 404 ]

echo "5. restore"
curl -fsS "${auth[@]}" -X POST "$MEDIA/api/v1/files/$ID/restore" | json "['status']" | grep -qx active
[ "$(curl -s -o /dev/null -w '%{http_code}' "$URL")" = 200 ]

echo "6. private file + signed URL"
PID=$(curl -fsS "${auth[@]}" -F "file=@$IMG" "$MEDIA/api/v1/files?visibility=private&confirm=true" | json "['id']")
SIGNED=$(curl -fsS "${auth[@]}" -H 'Content-Type: application/json' -d '{"ttl":60}' \
  -X POST "$MEDIA/api/v1/files/$PID/signed-url" | json "['url']")
[ "$(curl -s -o /dev/null -w '%{http_code}' "$SIGNED")" = 200 ]
[ "$(curl -s -o /dev/null -w '%{http_code}' "$MEDIA/p/$PID.jpg")" != 200 ]

echo "cleanup"
curl -fsS "${auth[@]}" -X DELETE "$MEDIA/api/v1/files/$ID" >/dev/null
curl -fsS "${auth[@]}" -X DELETE "$MEDIA/api/v1/files/$PID" >/dev/null
echo "OK"
