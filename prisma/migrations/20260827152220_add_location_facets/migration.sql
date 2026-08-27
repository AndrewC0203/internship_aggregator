-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "loc_countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "loc_us_states" TEXT[] DEFAULT ARRAY[]::TEXT[];
