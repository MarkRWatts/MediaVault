-- CreateTable
CREATE TABLE "WatchProgress" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "versionId" INTEGER,
    "episodeFileId" INTEGER,
    "positionSecs" REAL NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WatchProgress_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "Version" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WatchProgress_episodeFileId_fkey" FOREIGN KEY ("episodeFileId") REFERENCES "EpisodeFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WatchProgress_userId_idx" ON "WatchProgress"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchProgress_userId_versionId_key" ON "WatchProgress"("userId", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchProgress_userId_episodeFileId_key" ON "WatchProgress"("userId", "episodeFileId");
