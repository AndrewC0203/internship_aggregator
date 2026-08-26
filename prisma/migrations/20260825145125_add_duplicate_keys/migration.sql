-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "duplicate_keys" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "listings_company_title_location_idx" ON "listings"("company", "title", "location");
