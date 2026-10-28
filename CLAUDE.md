# CLAUDE.md

This file guides Claude Code (claude.ai/code) when working in this repository.

## What this is

`unfaa-media-server` is a small Express + TypeScript media server. It accepts image and video uploads, stores them on the local disk, and serves them back as static files. There is no database in active use. It was scaffolded from a larger boilerplate (Programming Hero's "university-management-core-service"), so you will find leftover code that nothing uses.

## Commands

```bash
yarn dev            # ts-node-dev with respawn, runs src/server.ts
yarn build          # tsc: src -> dist
yarn start          # node dist/server.js
yarn lint:check     # eslint over .js/.ts
yarn lint:fix
yarn prettier:fix
yarn lint-prettier  # lint + prettier (what the husky pre-commit runs via lint-staged)
```

There are no tests (`yarn test` exits with an error on purpose).

`postinstall` runs `prisma generate`, but the repo has **no `prisma/schema.prisma`**. If an install fails at that step, that is the reason.

## Configuration

- Env vars are loaded from `.env` in the CWD (`src/config/index.ts`); see `.env.example`. Only `PORT` and `NODE_ENV` matter to the live code paths. The JWT, DB, Cloudinary and email settings are boilerplate.
- `NODE_ENV=production` changes the storage paths (see below).

## Architecture

```
src/server.ts            HTTP bootstrap + process signal/error handlers
src/app.ts               express app: cors, cookie-parser, json/urlencoded,
                         static mounts, /api/v1 router, global error handler, 404
src/app/routes/index.ts  moduleRoutes array -> router.use(path, route)
src/app/modules/<name>/  <name>.route.ts / .controller.ts / .validation.ts
src/app/middlewares/     upload (multer + sharp), validateRequest (zod), auth, globalErrorHandler
src/shared/              catchAsync, sendResponse, etc.
src/errors/              ApiError, handleZodError
```

To add a feature, create a module folder that follows the route/controller/validation pattern and register it in `src/app/routes/index.ts`. Wrap controllers in `catchAsync`, reply with `sendResponse` (`{ statusCode, success, message, meta, data }`), and throw `ApiError(status, msg)` for expected failures. Errors go through `globalErrorHandler`, which returns `{ success: false, message, errorMessages, stack }` (`stack` is omitted in production).

### Endpoints (all under `/api/v1`)

| Method | Path | Notes |
|---|---|---|
| POST | `/uploadImg` | multipart field `image`. Query options: `w`, `h`, `q` (1–100), `format` (`png`/`jpeg`/`webp`), `fit`, `updateFileName`. Returns `{ url }` |
| GET | `/uploadImg` | lists image URLs |
| DELETE | `/uploadImg` | body `{ urls: string[] }` (zod-validated) |
| POST | `/uploadVideo` | multipart field `video`, max 40MB, any `video/*` mimetype. Returns `{ url }` |
| DELETE | `/uploadVideo/delete-videos` | body `{ videoUrls: string[] }` |

Static files are served at `/uploads/img/*` and `/uploads/videos/*`.

### Upload pipeline

- **Images** (`middlewares/uploadImage.ts`): multer disk storage writes to `uploadDir`. Allowed types are jpeg/png only, max 4MB. Then the `uploadImage` middleware runs sharp (resize, format and quality), writes `temp-<file>`, renames it over the original, and sets `req.body.uploadedImageUrl`. The controller only echoes that URL back. Filenames are `<timestamp>-<random><ext>`. When `updateFileName` names an existing file, that file is overwritten.
- **Videos** (`middlewares/uploadVideo.ts`): multer writes to `videoUploadDir` with no processing. The route has an inline error handler that turns `LIMIT_FILE_SIZE` into a 400.

### Storage paths

| | dev | production |
|---|---|---|
| images (`uploadDir`) | `<repo>/uploads` | `/mnt/data/uploads` |
| videos (`videoUploadDir`) | `<repo>/uploads/videos` | `/mnt/data/uploads/videos` |

Production expects a persistent volume mounted at `/mnt/data`.

## Known quirks and inconsistencies

Keep these in mind before you "fix" anything. Change them only on purpose.

- Images are written to the `uploads/` root, but `getAllFiles` reads `uploads/img` (a relative path), so it doesn't list what was uploaded. The `existsSync('./uploads/img/...')` check in the multer filename function points at the old location too. Image delete uses `uploads/<name>` relative to the CWD, which ignores the production path.
- The image URL is hard-coded to `https://`. The video URL uses `req.protocol`.
- Image delete responds with the message "User Created successfully!" (copy-paste leftover). Video delete skips `sendResponse` and its response shape differs.
- `validExtensions` in the image filename check includes `.webp`, but the mimetype filter rejects webp uploads.
- None of the routes use auth. `middlewares/auth.ts` references `prisma.user`, which doesn't exist.
- Unused boilerplate: Prisma client, Cloudinary, nodemailer, NOWPayments/Paystack, `catchAsyncSemaphore`, the logger (fully commented out), pagination helpers, and `tsconfig.json` includes stale paths.

## Deployment

- `dist/` is committed and is what runs in production: `vercel.json` routes everything to `dist/server.js`, and `main` is `dist/server.js`. **Run `yarn build` and commit `dist/` together with `src/` changes.**
- `dist/` also holds stale compiled files from the boilerplate (payment and email helpers, etc.) that have no source in `src/`. They aren't imported by the live app.
- Vercel's filesystem is ephemeral, so disk uploads don't persist there. The `/mnt/data` paths suggest the real deployment is a VM or container with a mounted volume.

## Code style

Prettier: single quotes, semicolons, `arrowParens: avoid`. ESLint prefers `type` over `interface` (`@typescript-eslint/consistent-type-definitions`). `strict` TypeScript, commonjs, target es2016.
