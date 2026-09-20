-- CreateTable
CREATE TABLE "EpisodeAudioTrack" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "episodeFileId" INTEGER NOT NULL,
    "streamIdx" INTEGER NOT NULL,
    "codec" TEXT,
    "profile" TEXT,
    "language" TEXT,
    "channels" INTEGER,
    "layout" TEXT,
    "title" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isDescriptive" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "EpisodeAudioTrack_episodeFileId_fkey" FOREIGN KEY ("episodeFileId") REFERENCES "EpisodeFile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "EpisodeAudioTrack_episodeFileId_idx" ON "EpisodeAudioTrack"("episodeFileId");
