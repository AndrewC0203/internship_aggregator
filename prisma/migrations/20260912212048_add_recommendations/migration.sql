-- pgvector (Decision 30). The extension ships the `vector` type used below; IF NOT EXISTS so
-- a database that already has it (e.g. a future managed host) replays this migration cleanly.
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "embedding" vector,
ADD COLUMN     "embedding_model" TEXT,
ADD COLUMN     "signature" JSONB,
ADD COLUMN     "signature_fingerprint" TEXT,
ADD COLUMN     "template_version" INTEGER;

-- CreateTable
CREATE TABLE "user_profile" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "resume_text" TEXT,
    "extracted_profile" JSONB,
    "profile" JSONB,
    "questionnaire" JSONB,
    "embedding" vector,
    "embedding_model" TEXT,
    "template_version" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("id")
);
