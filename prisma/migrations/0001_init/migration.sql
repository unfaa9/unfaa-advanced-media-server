-- CreateEnum
CREATE TYPE "file_status" AS ENUM ('pending', 'active', 'deleted', 'purged');

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "scopes" TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "quota_bytes" BIGINT,
    "used_bytes" BIGINT NOT NULL DEFAULT 0,
    "file_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "account_id" UUID,
    "status" "file_status" NOT NULL DEFAULT 'pending',
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "original_size_bytes" BIGINT NOT NULL,
    "sha256" BYTEA NOT NULL,
    "upload_sha256" BYTEA NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "original_name" TEXT,
    "purpose" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,
    "purged_at" TIMESTAMPTZ,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_refs" (
    "file_id" UUID NOT NULL,
    "owner_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_refs_pkey" PRIMARY KEY ("file_id","owner_ref")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "run_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 10,
    "last_error" TEXT,
    "locked_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "name" TEXT NOT NULL,
    "next_run_at" TIMESTAMPTZ NOT NULL,
    "last_run_at" TIMESTAMPTZ,
    "last_error" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_ref_key" ON "accounts"("ref");

-- CreateIndex
CREATE INDEX "files_account_id_created_at_idx" ON "files"("account_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_refs" ADD CONSTRAINT "file_refs_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written (not expressible in schema.prisma) ---------------------------

ALTER TABLE "accounts" ADD CONSTRAINT "accounts_used_bytes_check" CHECK ("used_bytes" >= 0);

CREATE INDEX "files_pending_idx" ON "files" ("created_at") WHERE "status" = 'pending';
CREATE INDEX "files_deleted_idx" ON "files" ("deleted_at") WHERE "status" = 'deleted';

-- Dedup: one live file per (account, uploaded bytes). Files without an account share the nil uuid.
CREATE UNIQUE INDEX "files_dedup_idx" ON "files"
    (COALESCE("account_id", '00000000-0000-0000-0000-000000000000'::uuid), "upload_sha256")
    WHERE "status" IN ('pending', 'active');

CREATE INDEX "file_refs_owner_ref_idx" ON "file_refs" ("owner_ref" text_pattern_ops);

CREATE INDEX "jobs_ready_idx" ON "jobs" ("run_at") WHERE "attempts" < "max_attempts";
