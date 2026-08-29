-- AlterTable
ALTER TABLE "Artist" ADD COLUMN "backdropPath" TEXT;
ALTER TABLE "Artist" ADD COLUMN "backdropSource" TEXT;
ALTER TABLE "Artist" ADD COLUMN "bio" TEXT;
ALTER TABLE "Artist" ADD COLUMN "bioSource" TEXT;
ALTER TABLE "Artist" ADD COLUMN "photoPath" TEXT;
ALTER TABLE "Artist" ADD COLUMN "photoSource" TEXT;

-- AlterTable
ALTER TABLE "PhysicalCopy" ADD COLUMN "discogsReleaseId" INTEGER;
