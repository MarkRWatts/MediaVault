-- AlterTable
ALTER TABLE "PhysicalCopy" ADD COLUMN "coverPath" TEXT;
ALTER TABLE "PhysicalCopy" ADD COLUMN "coverSource" TEXT;
ALTER TABLE "PhysicalCopy" ADD COLUMN "releaseMbid" TEXT;

-- CreateTable
CREATE TABLE "PhysicalTrack" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "physicalCopyId" INTEGER NOT NULL,
    "disc" INTEGER NOT NULL DEFAULT 1,
    "trackNumber" INTEGER,
    "title" TEXT NOT NULL,
    "durationSecs" REAL,
    CONSTRAINT "PhysicalTrack_physicalCopyId_fkey" FOREIGN KEY ("physicalCopyId") REFERENCES "PhysicalCopy" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PhysicalTrack_physicalCopyId_idx" ON "PhysicalTrack"("physicalCopyId");
