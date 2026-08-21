-- CreateTable
CREATE TABLE "Artist" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "sortName" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "mbid" TEXT,
    "disambiguation" TEXT,
    "various" BOOLEAN NOT NULL DEFAULT false,
    "matchConfidence" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Album" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "artistId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "sortTitle" TEXT NOT NULL,
    "year" INTEGER,
    "releaseDate" DATETIME,
    "mbid" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'STUDIO',
    "coverPath" TEXT,
    "owned" BOOLEAN NOT NULL DEFAULT true,
    "folder" TEXT,
    "trackTotal" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Album_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Track" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "albumId" INTEGER NOT NULL,
    "disc" INTEGER NOT NULL DEFAULT 1,
    "trackNumber" INTEGER,
    "title" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "codec" TEXT,
    "lossless" BOOLEAN NOT NULL DEFAULT false,
    "sampleRate" INTEGER,
    "bitDepth" INTEGER,
    "durationSecs" REAL,
    "sizeBytes" BIGINT,
    "mtimeMs" REAL,
    "probedAt" DATETIME,
    CONSTRAINT "Track_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Artist_folder_key" ON "Artist"("folder");

-- CreateIndex
CREATE UNIQUE INDEX "Artist_mbid_key" ON "Artist"("mbid");

-- CreateIndex
CREATE INDEX "Artist_sortName_idx" ON "Artist"("sortName");

-- CreateIndex
CREATE UNIQUE INDEX "Album_mbid_key" ON "Album"("mbid");

-- CreateIndex
CREATE INDEX "Album_artistId_idx" ON "Album"("artistId");

-- CreateIndex
CREATE UNIQUE INDEX "Album_artistId_folder_key" ON "Album"("artistId", "folder");

-- CreateIndex
CREATE UNIQUE INDEX "Track_filePath_key" ON "Track"("filePath");

-- CreateIndex
CREATE INDEX "Track_albumId_idx" ON "Track"("albumId");
