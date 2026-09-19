-- CreateTable
CREATE TABLE "InterlaceCheck" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "fileId" INTEGER NOT NULL,
    "mtimeMs" REAL NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sampledFrames" INTEGER NOT NULL,
    "interlacedFrames" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "InterlaceCheck_kind_fileId_key" ON "InterlaceCheck"("kind", "fileId");
