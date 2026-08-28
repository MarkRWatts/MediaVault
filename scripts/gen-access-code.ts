// Mint access codes — the admin tooling for the web of trust (see
// HOUSEHOLDS_PLAN.md "Access codes & the web of trust"). Owner-run, not a
// UI: minting a brand-new household's way in is deliberately not a
// self-serve growth surface. Run against whichever database DATABASE_URL
// points at, so on the deployed VM run it inside the app container.
//
// Usage: npx tsx scripts/gen-access-code.ts [--email sarah@example.com]
//          [--max 1] [--until 2026-12-31] [--count 1]
//
// --email binds the code into the web of trust (src/lib/allowed-email.ts):
// that address can then sign in while the code is live, and only a session
// holding that address can redeem it. Omit it for a generic code
// (redeemable by anyone already signed in, vouches for nobody). --until is
// the redemption cutoff (end of that day, server time); omit it for a code
// that stays redeemable forever. Prints the pretty MV-XXXX-XXXX form —
// that's what you hand out; entry is forgiving (case/separators are
// normalized away, see src/lib/access.ts's normalizeCode).
import "dotenv/config";
import { parseArgs } from "node:util";
import { prisma } from "@/lib/db";
import { formatCode, generateCode } from "@/lib/access";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    max: { type: "string", default: "1" },
    until: { type: "string" },
    count: { type: "string", default: "1" },
  },
});

const maxRedemptions = Number(values.max);
const count = Number(values.count);
if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) {
  throw new Error("--max must be a whole number >= 1");
}
if (!Number.isInteger(count) || count < 1 || count > 100) {
  throw new Error("--count must be a whole number between 1 and 100");
}

let redeemableUntil: Date | null = null;
if (values.until) {
  redeemableUntil = new Date(`${values.until}T23:59:59`);
  if (Number.isNaN(redeemableUntil.getTime())) {
    throw new Error("--until must be a date like 2026-12-31");
  }
}

async function main() {
  for (let i = 0; i < count; i++) {
    const row = await prisma.accessCode.create({
      data: {
        code: generateCode(),
        email: values.email?.trim().toLowerCase() || null,
        maxRedemptions,
        redeemableUntil,
      },
    });
    const cutoff = redeemableUntil
      ? `redeemable until ${redeemableUntil.toDateString()}`
      : "no redemption cutoff";
    console.log(
      `${formatCode(row.code)}  (${row.maxRedemptions} use${row.maxRedemptions === 1 ? "" : "s"}, ${cutoff}${
        row.email ? `, signs in ${row.email}` : ", generic — grants no sign-in"
      })`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
