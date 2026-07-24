-- CreateTable
CREATE TABLE "crawl_targets" (
    "id" SERIAL NOT NULL,
    "source" "Source" NOT NULL,
    "token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_in_discovery_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_crawled_at" TIMESTAMPTZ(6),
    "last_error" TEXT,

    CONSTRAINT "crawl_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crawl_targets_source_token_key" ON "crawl_targets"("source", "token");
