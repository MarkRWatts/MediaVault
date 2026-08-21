-- CreateTable
CREATE TABLE "Show" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "sortTitle" TEXT NOT NULL,
    "year" INTEGER,
    "folder" TEXT NOT NULL,
    "tmdbId" INTEGER,
    "imdbId" TEXT,
    "overview" TEXT,
    "posterPath" TEXT,
    "backdropPath" TEXT,
    "firstAirDate" DATETIME,
    "status" TEXT,
    "rating" REAL,
    "genres" TEXT,
    "matchConfidence" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShowSeason" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "showId" INTEGER NOT NULL,
    "seasonNumber" INTEGER NOT NULL,
    "name" TEXT,
    "overview" TEXT,
    "posterPath" TEXT,
    "airDate" DATETIME,
    CONSTRAINT "ShowSeason_showId_fkey" FOREIGN KEY ("showId") REFERENCES "Show" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "seasonId" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL,
    "name" TEXT,
    "overview" TEXT,
    "stillPath" TEXT,
    "airDate" DATETIME,
    "runtimeMins" INTEGER,
    "owned" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Episode_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "ShowSeason" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EpisodeFile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "episodeId" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "width" INTEGER,
    "height" INTEGER,
    "videoCodec" TEXT,
    "videoRange" TEXT,
    "container" TEXT,
    "sizeBytes" BIGINT,
    "durationSecs" REAL,
    "audioSummary" TEXT,
    "mtimeMs" REAL,
    "probedAt" DATETIME,
    "jellyfinId" TEXT,
    CONSTRAINT "EpisodeFile_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Show_folder_key" ON "Show"("folder");

-- CreateIndex
CREATE UNIQUE INDEX "Show_tmdbId_key" ON "Show"("tmdbId");

-- CreateIndex
CREATE UNIQUE INDEX "Show_imdbId_key" ON "Show"("imdbId");

-- CreateIndex
CREATE INDEX "Show_sortTitle_idx" ON "Show"("sortTitle");

-- CreateIndex
CREATE UNIQUE INDEX "ShowSeason_showId_seasonNumber_key" ON "ShowSeason"("showId", "seasonNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_seasonId_episodeNumber_key" ON "Episode"("seasonId", "episodeNumber");

-- CreateIndex
CREATE INDEX "EpisodeFile_episodeId_idx" ON "EpisodeFile"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeFile_filePath_episodeId_key" ON "EpisodeFile"("filePath", "episodeId");
