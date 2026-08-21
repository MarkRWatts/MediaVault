-- CreateTable
CREATE TABLE "Collection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "overview" TEXT,
    "posterPath" TEXT,
    "backdropPath" TEXT
);

-- CreateTable
CREATE TABLE "Film" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "sortTitle" TEXT NOT NULL,
    "year" INTEGER,
    "imdbId" TEXT,
    "tmdbId" INTEGER,
    "overview" TEXT,
    "posterPath" TEXT,
    "backdropPath" TEXT,
    "releaseDate" DATETIME,
    "runtimeMins" INTEGER,
    "rating" REAL,
    "genres" TEXT,
    "owned" BOOLEAN NOT NULL DEFAULT true,
    "matchConfidence" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "collectionId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Film_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Version" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "filmId" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "edition" TEXT,
    "format" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "width" INTEGER,
    "height" INTEGER,
    "videoCodec" TEXT,
    "container" TEXT,
    "sizeBytes" BIGINT,
    "durationSecs" REAL,
    "mtimeMs" REAL,
    "probedAt" DATETIME,
    CONSTRAINT "Version_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AudioTrack" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "versionId" INTEGER NOT NULL,
    "streamIdx" INTEGER NOT NULL,
    "codec" TEXT,
    "language" TEXT,
    "channels" INTEGER,
    "layout" TEXT,
    "title" TEXT,
    CONSTRAINT "AudioTrack_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "Version" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "filesSeen" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "log" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Film_imdbId_key" ON "Film"("imdbId");

-- CreateIndex
CREATE UNIQUE INDEX "Film_tmdbId_key" ON "Film"("tmdbId");

-- CreateIndex
CREATE INDEX "Film_collectionId_idx" ON "Film"("collectionId");

-- CreateIndex
CREATE INDEX "Film_sortTitle_idx" ON "Film"("sortTitle");

-- CreateIndex
CREATE UNIQUE INDEX "Version_filePath_key" ON "Version"("filePath");

-- CreateIndex
CREATE INDEX "Version_filmId_idx" ON "Version"("filmId");

-- CreateIndex
CREATE INDEX "AudioTrack_versionId_idx" ON "AudioTrack"("versionId");
