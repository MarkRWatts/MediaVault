-- CreateTable
CREATE TABLE "ShowFavourite" (
    "userId" TEXT NOT NULL,
    "showId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "showId"),
    CONSTRAINT "ShowFavourite_showId_fkey" FOREIGN KEY ("showId") REFERENCES "Show" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShowFavourite_userId_idx" ON "ShowFavourite"("userId");
