// BetterAuth config — Phase 1 of HOUSEHOLDS_PLAN.md. Just enough for the CLI
// to introspect the schema and for `npx @better-auth/cli generate` to add the
// User/Session/Account/Verification models to prisma/schema.prisma. No
// plugins yet (organization plugin is Phase 3) and nothing mounts this yet
// (the `/api/auth/[...all]` route handler + lib/auth-client.ts are Phase 2).
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { prisma } from "@/lib/db";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
});
