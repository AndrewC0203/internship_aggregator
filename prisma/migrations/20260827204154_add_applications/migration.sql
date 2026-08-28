-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('saved', 'applied', 'interviewing', 'offer', 'rejected');

-- CreateTable
CREATE TABLE "applications" (
    "listing_id" INTEGER NOT NULL,
    "status" "ApplicationStatus" NOT NULL,
    "note" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("listing_id")
);

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
