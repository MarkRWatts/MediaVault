-- CreateTable
CREATE TABLE "TrackFavourite" (
    "userId" TEXT NOT NULL,
    "trackId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "trackId"),
    CONSTRAINT "TrackFavourite_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AlbumFavourite" (
    "userId" TEXT NOT NULL,
    "albumId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "albumId"),
    CONSTRAINT "AlbumFavourite_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "Album" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArtistFavourite" (
    "userId" TEXT NOT NULL,
    "artistId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("userId", "artistId"),
    CONSTRAINT "ArtistFavourite_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TrackFavourite_userId_idx" ON "TrackFavourite"("userId");

-- CreateIndex
CREATE INDEX "AlbumFavourite_userId_idx" ON "AlbumFavourite"("userId");

-- CreateIndex
CREATE INDEX "ArtistFavourite_userId_idx" ON "ArtistFavourite"("userId");
