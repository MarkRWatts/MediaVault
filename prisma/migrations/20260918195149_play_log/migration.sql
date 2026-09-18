-- CreateTable
CREATE TABLE "PlayLog" (
    "day" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "itemId" INTEGER NOT NULL,
    "plays" INTEGER NOT NULL DEFAULT 1,

    PRIMARY KEY ("day", "kind", "itemId")
);
