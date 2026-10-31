# Videos and documents

> API v1

## Video (minor use case, best-practice handling)

- Accepted: **MP4** (also `.m4v`) and **WebM**. QuickTime `.mov`, AVI, MKV etc. are rejected with `415` — ask
  users to export **MP4 (H.264 video + AAC audio)**, the format every browser plays.
- The server checks the container structure in pure Go (`ftyp`, `moov`, `mdat` boxes). Corrupt/truncated files
  → `422`.
- **Faststart**: the response contains `meta.faststart`. `true` = the `moov` index is at the start, so playback
  begins immediately. `false` files are accepted but must download further before playing — fix at the source
  with `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` (lossless, seconds).
- Served byte-for-byte with `Range` support (`206 Partial Content`, `Accept-Ranges: bytes`), so seeking works.
- **No transcoding, no thumbnails, no HLS.** Keep clips short (the limit is 15 MB). For heavy video use a
  dedicated video service.

```html
<video controls preload="metadata" src="https://media.unfaa.com/f/0192f3c4-….mp4"></video>
```

## PDF

- Validated by magic bytes and a trailing `%%EOF` marker; stored as-is.
- Served `Content-Disposition: inline` with `Content-Security-Policy: default-src 'none'`.
  (The `sandbox` directive used for other types is omitted for PDFs because it blocks Chromium's built-in
  PDF viewer.) Embed with `<iframe>`/`<embed>` or link to it.

## DOCX

- Must be a real Word package (`[Content_Types].xml`, `word/document.xml`). Plain zips renamed to `.docx`,
  **macro-enabled documents** (`vbaProject.bin`), path-traversal entries and zip bombs are rejected.
- Served with `Content-Disposition: attachment` (it downloads; browsers can't display it) and the sandbox CSP.
  The download is named `<id>.docx`; set the user-facing filename in your own UI/`download` attribute.
- Old `.doc`, `.xlsx`, `.pptx`, `.odt`, text, archives etc. are **not** supported in v1.

## Antivirus

There is **no virus scanning in v1**. Images are re-encoded (neutralizing most payloads); PDF and DOCX are
only structurally checked. Treat user-supplied documents as untrusted when *you* open them.
