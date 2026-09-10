-- AlterTable
ALTER TABLE "Artist" ADD COLUMN "spotifyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Artist_spotifyId_key" ON "Artist"("spotifyId");
