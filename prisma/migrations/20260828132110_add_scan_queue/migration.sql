-- CreateTable
CREATE TABLE "ScanQueueItem" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "barcode" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resultJson" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ScanQueueItem_barcode_key" ON "ScanQueueItem"("barcode");

-- CreateIndex
CREATE INDEX "ScanQueueItem_status_idx" ON "ScanQueueItem"("status");
