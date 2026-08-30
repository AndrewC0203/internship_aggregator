-- CreateEnum
CREATE TYPE "DegreeStatus" AS ENUM ('pursuing', 'completed_required', 'unknown');

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "degree_status" "DegreeStatus";
