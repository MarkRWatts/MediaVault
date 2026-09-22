-- AlterTable
ALTER TABLE "user" ADD COLUMN "lastSignInAt" DATETIME;

-- Backfill: BetterAuth mints a Session row on every successful sign-in, so
-- the most recent one's createdAt is the best stand-in for history this
-- column didn't capture live.
UPDATE "user"
SET "lastSignInAt" = (
    SELECT MAX(s."createdAt") FROM "session" s WHERE s."userId" = "user"."id"
);
