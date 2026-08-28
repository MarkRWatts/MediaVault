// One-off admin tooling: grant User.isAppOwner to an existing user by
// email. Simpler than the template app's scripts/bootstrap-owner.ts —
// MediaVault already has its one household and its one owner Member row
// (set by hand during Phase 3), so this script's only job is flipping the
// isAppOwner flag, not also creating a household. See
// src/lib/require-member.ts for what isAppOwner gates.
//
// Usage: npx tsx scripts/grant-app-owner.ts <email>
//
// The user must already have signed in at least once (a User row must
// exist for that email — sign in via /signin first, which creates it via
// BetterAuth). Errors clearly if no such User exists yet. No-op (prints
// and exits) if that email is already an app owner.
import "dotenv/config";
import { prisma } from "@/lib/db";

const email = process.argv[2];
if (!email) {
  throw new Error("Usage: npx tsx scripts/grant-app-owner.ts <email>");
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(
      `No User found for ${email} — they must sign in at /signin at least once first (it needs ALLOWED_EMAILS to include this address), then re-run this script.`,
    );
  }

  if (user.isAppOwner) {
    console.log(`${email} is already an app owner — nothing to do.`);
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { isAppOwner: true } });
  console.log(`Granted isAppOwner to ${email} (user ${user.id}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
