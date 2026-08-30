-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Album" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "artistId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "sortTitle" TEXT NOT NULL,
    "year" INTEGER,
    "releaseDate" DATETIME,
    "discogsMasterId" INTEGER,
    "discogsReleaseId" INTEGER,
    "discogsUrl" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'STUDIO',
    "coverPath" TEXT,
    "coverSource" TEXT,
    "owned" BOOLEAN NOT NULL DEFAULT true,
    "folder" TEXT,
    "digitalSource" TEXT,
    "trackTotal" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Album_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Album" ("artistId", "coverPath", "coverSource", "createdAt", "digitalSource", "folder", "id", "kind", "owned", "releaseDate", "sortTitle", "title", "trackTotal", "updatedAt", "year") SELECT "artistId", "coverPath", "coverSource", "createdAt", "digitalSource", "folder", "id", "kind", "owned", "releaseDate", "sortTitle", "title", "trackTotal", "updatedAt", "year" FROM "Album";
DROP TABLE "Album";
ALTER TABLE "new_Album" RENAME TO "Album";
CREATE UNIQUE INDEX "Album_discogsMasterId_key" ON "Album"("discogsMasterId");
CREATE UNIQUE INDEX "Album_discogsReleaseId_key" ON "Album"("discogsReleaseId");
CREATE INDEX "Album_artistId_idx" ON "Album"("artistId");
CREATE UNIQUE INDEX "Album_artistId_folder_key" ON "Album"("artistId", "folder");
CREATE TABLE "new_Artist" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "sortName" TEXT NOT NULL,
    "folder" TEXT,
    "discogsId" INTEGER,
    "disambiguation" TEXT,
    "various" BOOLEAN NOT NULL DEFAULT false,
    "matchConfidence" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "studioTotal" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "bio" TEXT,
    "bioSource" TEXT,
    "photoPath" TEXT,
    "photoSource" TEXT,
    "backdropPath" TEXT,
    "backdropSource" TEXT
);
INSERT INTO "new_Artist" ("backdropPath", "backdropSource", "bio", "bioSource", "createdAt", "disambiguation", "folder", "id", "matchConfidence", "name", "photoPath", "photoSource", "sortName", "studioTotal", "updatedAt", "various") SELECT "backdropPath", "backdropSource", "bio", "bioSource", "createdAt", "disambiguation", "folder", "id", "matchConfidence", "name", "photoPath", "photoSource", "sortName", "studioTotal", "updatedAt", "various" FROM "Artist";
DROP TABLE "Artist";
ALTER TABLE "new_Artist" RENAME TO "Artist";
CREATE UNIQUE INDEX "Artist_folder_key" ON "Artist"("folder");
CREATE UNIQUE INDEX "Artist_discogsId_key" ON "Artist"("discogsId");
CREATE INDEX "Artist_sortName_idx" ON "Artist"("sortName");
CREATE TABLE "new_PhysicalCopy" (
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
    "barcode" TEXT,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discogsReleaseId" INTEGER,
    "discogsUrl" TEXT,
    "coverPath" TEXT,
    "coverSource" TEXT,
    CONSTRAINT "PhysicalCopy_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PhysicalCopy" ("addedAt", "albumId", "barcode", "catalogNo", "condition", "coverPath", "coverSource", "discogsReleaseId", "discs", "format", "id", "inferred", "label", "medium", "notes", "pressYear") SELECT "addedAt", "albumId", "barcode", "catalogNo", "condition", "coverPath", "coverSource", "discogsReleaseId", "discs", "format", "id", "inferred", "label", "medium", "notes", "pressYear" FROM "PhysicalCopy";
DROP TABLE "PhysicalCopy";
ALTER TABLE "new_PhysicalCopy" RENAME TO "PhysicalCopy";
CREATE INDEX "PhysicalCopy_albumId_medium_idx" ON "PhysicalCopy"("albumId", "medium");
CREATE INDEX "PhysicalCopy_barcode_idx" ON "PhysicalCopy"("barcode");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

