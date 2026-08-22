-- CreateTable
CREATE TABLE "VinylCopy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "albumId" INTEGER NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'LP',
    "catalogNo" TEXT,
    "label" TEXT,
    "pressYear" INTEGER,
    "condition" TEXT,
    "notes" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VinylCopy_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Artist" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "sortName" TEXT NOT NULL,
    "folder" TEXT,
    "mbid" TEXT,
    "disambiguation" TEXT,
    "various" BOOLEAN NOT NULL DEFAULT false,
    "matchConfidence" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "studioTotal" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Artist" ("createdAt", "disambiguation", "folder", "id", "matchConfidence", "mbid", "name", "sortName", "studioTotal", "updatedAt", "various") SELECT "createdAt", "disambiguation", "folder", "id", "matchConfidence", "mbid", "name", "sortName", "studioTotal", "updatedAt", "various" FROM "Artist";
DROP TABLE "Artist";
ALTER TABLE "new_Artist" RENAME TO "Artist";
CREATE UNIQUE INDEX "Artist_folder_key" ON "Artist"("folder");
CREATE UNIQUE INDEX "Artist_mbid_key" ON "Artist"("mbid");
CREATE INDEX "Artist_sortName_idx" ON "Artist"("sortName");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "VinylCopy_albumId_key" ON "VinylCopy"("albumId");
