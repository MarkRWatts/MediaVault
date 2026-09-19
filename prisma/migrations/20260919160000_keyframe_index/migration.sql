-- CreateTable
CREATE TABLE "KeyframeIndex" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "fileId" INTEGER NOT NULL,
    "mtimeMs" REAL NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "data" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "KeyframeIndex_kind_fileId_key" ON "KeyframeIndex"("kind", "fileId");
