-- CreateEnum
CREATE TYPE "OpportunityType" AS ENUM ('internship', 'co_op', 'fellowship', 'new_grad', 'research', 'part_time');

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "opportunity_type" "OpportunityType";
