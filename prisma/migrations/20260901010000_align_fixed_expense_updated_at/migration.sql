-- The previous migration used this default to backfill existing rows. Prisma
-- owns subsequent updatedAt values, so the database default is no longer needed.
ALTER TABLE "FixedExpense" ALTER COLUMN "updatedAt" DROP DEFAULT;
