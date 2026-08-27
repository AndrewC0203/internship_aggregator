-- CreateEnum
CREATE TYPE "CsField" AS ENUM ('swe', 'ml_ai', 'data', 'quant', 'security', 'hardware_embedded', 'devops_infra', 'it', 'product', 'other');

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "cs_field" "CsField",
ADD COLUMN     "grad_date_max" TEXT,
ADD COLUMN     "grad_date_min" TEXT;
