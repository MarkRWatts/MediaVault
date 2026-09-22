-- Hand-curated film-to-show links (Serenity with Firefly, Stargate with all
-- three SG shows). Nothing in the scan or enrich pipeline writes this table —
-- TMDB has no movie-to-show relation — so there is no backfill to do here;
-- it starts empty and the owner fills it from the film page.

-- CreateTable
CREATE TABLE "FilmShowLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "filmId" INTEGER NOT NULL,
    "showId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FilmShowLink_filmId_fkey" FOREIGN KEY ("filmId") REFERENCES "Film" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FilmShowLink_showId_fkey" FOREIGN KEY ("showId") REFERENCES "Show" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FilmShowLink_filmId_idx" ON "FilmShowLink"("filmId");

-- CreateIndex
CREATE INDEX "FilmShowLink_showId_idx" ON "FilmShowLink"("showId");

-- CreateIndex
CREATE UNIQUE INDEX "FilmShowLink_filmId_showId_key" ON "FilmShowLink"("filmId", "showId");
