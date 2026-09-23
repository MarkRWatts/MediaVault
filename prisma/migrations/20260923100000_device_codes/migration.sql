-- CreateTable
CREATE TABLE "deviceCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceCode" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "lastPolledAt" DATETIME,
    "pollingInterval" INTEGER,
    "clientId" TEXT,
    "scope" TEXT,
    CONSTRAINT "deviceCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "deviceCode_userId_idx" ON "deviceCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "deviceCode_deviceCode_key" ON "deviceCode"("deviceCode");

-- CreateIndex
CREATE UNIQUE INDEX "deviceCode_userCode_key" ON "deviceCode"("userCode");

