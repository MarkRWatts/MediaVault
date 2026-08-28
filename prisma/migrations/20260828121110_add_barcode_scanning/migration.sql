-- AlterTable
ALTER TABLE "PhysicalCopy" ADD COLUMN "barcode" TEXT;

-- CreateTable
CREATE TABLE "FilmPhysicalCopy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "filmId" INTEGER NOT NULL,
    "medium" TEXT NOT NULL,
    "barcode" TEXT,
    "notes" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FilmPhysicalCopy_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FilmPhysicalCopy_filmId_idx" ON "FilmPhysicalCopy"("filmId");

-- CreateIndex
CREATE INDEX "FilmPhysicalCopy_barcode_idx" ON "FilmPhysicalCopy"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "FilmPhysicalCopy_filmId_medium_key" ON "FilmPhysicalCopy"("filmId", "medium");

-- CreateIndex
CREATE INDEX "PhysicalCopy_barcode_idx" ON "PhysicalCopy"("barcode");
