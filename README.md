# unfaa-media-server
# unfaa-advanced-media-server

## Limits

- Images + documents: `MAX_FILE_BYTES` (default and max 15 MB). Audio: `MAX_AUDIO_BYTES` (default 20 MB, max 25 MB).
- Videos (mp4 / m4v, mov, 3gp, webm): **50 MB**, a code constant (`VIDEO_MAX_BYTES` in `src/config/index.ts`), no env.
  MP4 / MOV / 3GP are validated by walking box headers on disk (only the `moov` box is loaded, max 16 MB); WebM is checked
  on its header only. A proxy in front of the server needs a body limit ≥ 55 MB (nginx `client_max_body_size 55m`).
- Account quota: stored per account (`Account.quotaBytes`, null = unlimited); `DEFAULT_ACCOUNT_QUOTA_BYTES` only applies
  to new accounts. To raise one: `PUT /api/v1/accounts/:ref` (API key scope `accounts:write`) with body `{ "quota_bytes": <bytes> }` (null = unlimited).
