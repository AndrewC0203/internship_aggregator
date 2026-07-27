-- CreateTable
CREATE TABLE "seen_listings" (
    "source" "Source" NOT NULL,
    "source_external_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seen_listings_pkey" PRIMARY KEY ("source","source_external_id")
);
