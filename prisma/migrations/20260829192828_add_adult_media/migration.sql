-- CreateTable
CREATE TABLE "Scene" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "title" TEXT NOT NULL,
    "sortTitle" TEXT NOT NULL,
    "studioId" INTEGER,
    "date" DATETIME,
    "overview" TEXT,
    "posterPath" TEXT,
    "backgroundPath" TEXT,
    "tpdbId" TEXT,
    "matchConfidence" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "folder" TEXT,
    "format" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "width" INTEGER,
    "height" INTEGER,
    "videoCodec" TEXT,
    "videoRange" TEXT,
    "container" TEXT,
    "sizeBytes" BIGINT,
    "durationSecs" REAL,
    "mtimeMs" REAL,
    "probedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Scene_studioId_fkey" FOREIGN KEY ("studioId") REFERENCES "Studio" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Performer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "tpdbId" TEXT,
    "imagePath" TEXT
);

-- CreateTable
CREATE TABLE "Studio" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "tpdbId" INTEGER
);

-- CreateTable
CREATE TABLE "ScenePerformer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sceneId" INTEGER NOT NULL,
    "performerId" INTEGER NOT NULL,
    CONSTRAINT "ScenePerformer_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScenePerformer_performerId_fkey" FOREIGN KEY ("performerId") REFERENCES "Performer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "isAppOwner" BOOLEAN NOT NULL DEFAULT false,
    "adultLibraryAccess" BOOLEAN NOT NULL DEFAULT false,
    "jellyfinUserId" TEXT
);
INSERT INTO "new_user" ("createdAt", "email", "emailVerified", "id", "image", "isAppOwner", "name", "updatedAt") SELECT "createdAt", "email", "emailVerified", "id", "image", "isAppOwner", "name", "updatedAt" FROM "user";
DROP TABLE "user";
ALTER TABLE "new_user" RENAME TO "user";
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Scene_tpdbId_key" ON "Scene"("tpdbId");

-- CreateIndex
CREATE UNIQUE INDEX "Scene_filePath_key" ON "Scene"("filePath");

-- CreateIndex
CREATE INDEX "Scene_studioId_idx" ON "Scene"("studioId");

-- CreateIndex
CREATE INDEX "Scene_sortTitle_idx" ON "Scene"("sortTitle");

-- CreateIndex
CREATE UNIQUE INDEX "Performer_tpdbId_key" ON "Performer"("tpdbId");

-- CreateIndex
CREATE INDEX "Performer_name_idx" ON "Performer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Studio_tpdbId_key" ON "Studio"("tpdbId");

-- CreateIndex
CREATE INDEX "Studio_name_idx" ON "Studio"("name");

-- CreateIndex
CREATE INDEX "ScenePerformer_sceneId_idx" ON "ScenePerformer"("sceneId");

-- CreateIndex
CREATE INDEX "ScenePerformer_performerId_idx" ON "ScenePerformer"("performerId");

-- CreateIndex
CREATE UNIQUE INDEX "ScenePerformer_sceneId_performerId_key" ON "ScenePerformer"("sceneId", "performerId");
