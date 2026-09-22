-- CreateTable
CREATE TABLE "PlayEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "itemId" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "positionSecs" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "PlayEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PlayEvent_userId_lastSeenAt_idx" ON "PlayEvent"("userId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "PlayEvent_userId_kind_itemId_idx" ON "PlayEvent"("userId", "kind", "itemId");

-- Backfill one event per existing WatchProgress row so the History page has
-- a past on the day it ships. WatchProgress keeps only the latest state per
-- item, so this recovers exactly one sitting per film/episode — the most
-- recent one — and nothing earlier; that is all the data there has ever
-- been. Music has no equivalent record at all, so there is nothing to
-- backfill for tracks.
--
-- WatchProgress.userId carries no foreign key, so a row left behind by a
-- deleted account would fail PlayEvent's; the membership test drops those.
INSERT INTO "PlayEvent" ("userId", "kind", "itemId", "startedAt", "lastSeenAt", "positionSecs", "completed")
SELECT
    "userId",
    CASE WHEN "versionId" IS NOT NULL THEN 'film' ELSE 'episode' END,
    COALESCE("versionId", "episodeFileId"),
    "updatedAt",
    "updatedAt",
    CAST("positionSecs" AS INTEGER),
    "completed"
FROM "WatchProgress"
WHERE COALESCE("versionId", "episodeFileId") IS NOT NULL
  AND "userId" IN (SELECT "id" FROM "user");
