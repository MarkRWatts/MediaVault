import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// One client per process; Next dev hot-reload re-evaluates modules, so park it
// on globalThis like the Prisma docs recommend.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function makeClient() {
  const url = process.env.DATABASE_URL ?? "file:./data/filmdb.db";
  const adapter = new PrismaBetterSqlite3({ url });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
