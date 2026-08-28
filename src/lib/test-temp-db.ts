// Shared helper for tests that need a REAL, isolated SQLite database rather
// than mocking Prisma away — used by access.test.ts and allowed-email.test.ts,
// both of which exercise queries whose correctness depends on actual SQL
// execution (field-to-field `where` comparisons, OR/AND composition), not
// just on what arguments got passed to a mock.
//
// Applies the real prisma/migrations history (`prisma migrate deploy`, the
// same forward-only command this app runs at boot — see PLAN.md) against a
// throwaway temp file, deliberately NOT `prisma db push --accept-data-loss`:
// the latter is flagged by Prisma's own AI-agent safety guard as a
// destructive action needing human consent, even though the target here is
// guaranteed fresh (mkdtemp'd first) — migrate deploy reaches the same
// schema state without tripping that guard.
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import type { PrismaClient } from "@/generated/prisma/client";

export async function createTempTestDb(): Promise<{
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "mediavault-test-db-"));
  const dbUrl = `file:${path.join(tmpDir, "test.db")}`;

  execSync("npx prisma migrate deploy", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  const { PrismaClient: Client } = await import("@/generated/prisma/client");
  const adapter = new PrismaBetterSqlite3({ url: dbUrl });
  const prisma = new Client({ adapter });

  return {
    prisma,
    cleanup: async () => {
      await prisma.$disconnect();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
