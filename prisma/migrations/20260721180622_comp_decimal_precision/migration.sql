/*
  Warnings:

  - You are about to alter the column `comp_min` on the `listings` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.
  - You are about to alter the column `comp_max` on the `listings` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.

*/
-- AlterTable
ALTER TABLE "listings" ALTER COLUMN "comp_min" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "comp_max" SET DATA TYPE DECIMAL(12,2);
