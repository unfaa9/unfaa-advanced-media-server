# CLAUDE.md

This file guides Claude Code (claude.ai/code) when working in this repository.

## What this is

`unfaa-media-server` is an Express + TypeScript media server (Prisma/Postgres metadata, files on local disk). Clients
(the Unfaa backend) upload through the API-key protected `/api/v1/files` API; files are served publicly from `/f/<id>.<ext>`
(originals) and `/i/<id>/<w>.<fmt>` (image variants). The old `/uploadImg`, `/uploadVideo` routes and the `/uploads/*`
static mounts were removed on 2026-10-31. API docs: `unfadoc/new-media-server-apis-doc.md`, feature list: `unfadoc/features_implemented.md`.

## Commands

```bash
pnpm dev            # ts-node-dev with respawn, runs src/server.ts
pnpm build          # tsc: src -> dist
pnpm start          # node dist/server.js
pnpm lint:check     # eslint over .js/.ts
pnpm lint:fix
pnpm prettier:fix
pnpm lint-prettier  # lint + prettier
```

Package manager: pnpm 11 (pinned in `package.json` `packageManager`; `pnpm-workspace.yaml` `allowBuilds` lets prisma/sharp/esbuild run install scripts). Install with `pnpm install --frozen-lockfile`. Tests: `pnpm test` (vitest, `test/unit`).

`postinstall` runs `prisma generate` (`prisma/schema.prisma`); migrations: `pnpm db:migrate`.

## Configuration

Env vars are validated by zod at startup (`src/config/index.ts`); see `.env.example`. In production:

- `STORAGE_PATH` MUST be on the persistent volume (e.g. `/mnt/data/media` with the Coolify volume mounted at `/mnt/data`).
  A relative path resolves inside the container and is lost on every redeploy.
- `PUBLIC_BASE_URL` builds every returned URL; the backend's `MEDIA_PUBLIC_URL` must equal it.
- `MAX_FILE_BYTES` must allow the backend's PDF previews (15 MB).
- API keys: `node dist/cli.js admin key create --name backend-prod` (scopes default to all).

## Architecture

```
src/server.ts             HTTP bootstrap, signals, background jobs
src/app.ts                health + delivery (public), then /api/v1 (API key, problem+json errors)
src/app/modules/files     upload / confirm / refs / delete / restore
src/app/modules/accounts  per-account quota buckets
src/app/modules/delivery  public /f and /i routes
src/lib/                  storage layout, upload (busboy), media sniffing + sharp, variants, auth, cdn purge
src/jobs/                 maintenance (orphan/trash/tmp sweeps, variant LRU), reconcile
```

Deletes: `DELETE /files/:id` refuses while references exist unless `force=true`; `DELETE /files/:id/refs` drops one
owner's reference and deletes the file when it was the last one (that is what the backend uses).

## Code style

Prettier: single quotes, semicolons, `arrowParens: avoid`. ESLint prefers `type` over `interface` (`@typescript-eslint/consistent-type-definitions`). `strict` TypeScript, commonjs, target es2016.
