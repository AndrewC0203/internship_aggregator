-- CreateEnum
CREATE TYPE "Source" AS ENUM ('greenhouse', 'lever', 'ashby', 'other');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('full_time', 'part_time', 'intern', 'contract', 'temporary');

-- CreateEnum
CREATE TYPE "WorkplaceType" AS ENUM ('onsite', 'remote', 'hybrid');

-- CreateEnum
CREATE TYPE "CompInterval" AS ENUM ('hourly', 'monthly', 'yearly', 'one_time');

-- CreateEnum
CREATE TYPE "CitizenshipStatus" AS ENUM ('us_citizen_required', 'no_sponsorship', 'sponsorship_available', 'unknown');

-- CreateTable
CREATE TABLE "listings" (
    "id" SERIAL NOT NULL,
    "source" "Source" NOT NULL,
    "source_external_id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description_html" TEXT NOT NULL,
    "description_plain" TEXT NOT NULL,
    "location" TEXT,
    "department" TEXT,
    "employment_type" "EmploymentType",
    "workplace_type" "WorkplaceType",
    "comp_min" DECIMAL(65,30),
    "comp_max" DECIMAL(65,30),
    "comp_currency" TEXT,
    "comp_interval" "CompInterval",
    "grad_year_min" INTEGER,
    "grad_year_max" INTEGER,
    "citizenship_status" "CitizenshipStatus",
    "published_at" TIMESTAMPTZ(6),
    "application_deadline" TIMESTAMPTZ(6),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_listed" BOOLEAN NOT NULL DEFAULT true,
    "url" TEXT NOT NULL,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "listings_source_source_external_id_key" ON "listings"("source", "source_external_id");
