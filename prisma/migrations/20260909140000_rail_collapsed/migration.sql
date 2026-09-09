-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "isAppOwner" BOOLEAN NOT NULL DEFAULT false,
    "adultLibraryAccess" BOOLEAN NOT NULL DEFAULT false,
    "jellyfinUserId" TEXT,
    "sidebarCollapsed" BOOLEAN NOT NULL DEFAULT false,
    "railCollapsed" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_user" ("adultLibraryAccess", "createdAt", "email", "emailVerified", "id", "image", "isAppOwner", "jellyfinUserId", "name", "sidebarCollapsed", "updatedAt") SELECT "adultLibraryAccess", "createdAt", "email", "emailVerified", "id", "image", "isAppOwner", "jellyfinUserId", "name", "sidebarCollapsed", "updatedAt" FROM "user";
DROP TABLE "user";
ALTER TABLE "new_user" RENAME TO "user";
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
