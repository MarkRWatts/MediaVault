-- Generalize VinylCopy -> PhysicalCopy (medium: CD | VINYL | ...), preserving
-- existing vinyl rows as medium='VINYL'.

-- CreateTable
CREATE TABLE "PhysicalCopy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "albumId" INTEGER NOT NULL,
    "medium" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "inferred" BOOLEAN NOT NULL DEFAULT false,
    "discs" INTEGER,
    "catalogNo" TEXT,
    "label" TEXT,
    "pressYear" INTEGER,
    "condition" TEXT,
    "notes" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PhysicalCopy_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Preserve existing vinyl copies
INSERT INTO "PhysicalCopy" ("albumId", "medium", "format", "catalogNo", "label", "pressYear", "condition", "notes", "addedAt")
SELECT "albumId", 'VINYL', "format", "catalogNo", "label", "pressYear", "condition", "notes", "addedAt" FROM "VinylCopy";

-- DropTable
DROP TABLE "VinylCopy";

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalCopy_albumId_medium_key" ON "PhysicalCopy"("albumId", "medium");
