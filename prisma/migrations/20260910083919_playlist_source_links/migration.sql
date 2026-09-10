-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Playlist" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "sourceAlbumId" INTEGER,
    "sourceArtistId" INTEGER,
    CONSTRAINT "Playlist_sourceAlbumId_fkey" FOREIGN KEY ("sourceAlbumId") REFERENCES "Album" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Playlist_sourceArtistId_fkey" FOREIGN KEY ("sourceArtistId") REFERENCES "Artist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Playlist" ("createdAt", "id", "name", "updatedAt", "userId") SELECT "createdAt", "id", "name", "updatedAt", "userId" FROM "Playlist";
DROP TABLE "Playlist";
ALTER TABLE "new_Playlist" RENAME TO "Playlist";
CREATE INDEX "Playlist_userId_idx" ON "Playlist"("userId");
CREATE UNIQUE INDEX "Playlist_userId_sourceAlbumId_key" ON "Playlist"("userId", "sourceAlbumId");
CREATE UNIQUE INDEX "Playlist_userId_sourceArtistId_key" ON "Playlist"("userId", "sourceArtistId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
