// Access codes — the growth/trust gate for brand-new households (see
// HOUSEHOLDS_PLAN.md "Access codes & the web of trust"). Ported from
// jinglejotter.com's lib/access.ts, simplified: no `kind`/`accessExpiresAt`
// trial-vs-lifetime split (this app has no monetization). Minted by
// scripts/gen-access-code.ts, redeemed inside Phase 4's createHousehold
// action.

import { randomInt } from "node:crypto";
import { prisma } from "@/lib/db";

// No 0/O/1/I/L — codes get read out loud and typed on phones.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Canonical stored form: uppercase, every non-alphanumeric stripped, so
 *  "mv-abcd 2345" and "MVABCD2345" are the same code. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Pretty form for handing to a person: MV-XXXX-XXXX. */
export function formatCode(normalized: string): string {
  return [normalized.slice(0, 2), normalized.slice(2, 6), normalized.slice(6)].join("-");
}

/** A fresh random code in canonical form (MVXXXXXXXX). randomInt is
 *  crypto-strength — 31^8 ≈ 850 billion combinations behind an unguessable
 *  prefix-free namespace is plenty for a gate that also sits behind
 *  ALLOWED_EMAILS. */
export function generateCode(): string {
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `MV${suffix}`;
}

export type ClaimResult = { ok: true; codeId: string } | { ok: false; error: string };

// One user-facing message for every failure mode (unknown, past cutoff,
// fully redeemed): distinguishing them tells a guesser which codes exist.
const CLAIM_FAILED =
  "That code isn't valid any more — check it for typos, or ask whoever sent it for a fresh one.";

/** Atomically claim one redemption of `raw`. The conditional updateMany is
 *  the whole concurrency story: two households racing the last slot of a
 *  shared code can't both increment past maxRedemptions, because only the
 *  update whose WHERE still matches wins. An email-bound code (the web of
 *  trust — lib/allowed-email.ts) can only be claimed by a session holding
 *  that email, so a forwarded code is useless to anyone else; generic
 *  (email-null) codes stay claimable by anyone signed in. Callers that fail
 *  AFTER a successful claim must compensate with releaseClaim().
 *
 *  SQLite verification (HOUSEHOLDS_PLAN.md flagged this as unverified,
 *  since jinglejotter.com runs Postgres): `redeemedCount: { lt:
 *  prisma.accessCode.fields.maxRedemptions }` is Prisma's field-to-field
 *  filter comparison, comparing one column against another *inside the same
 *  row* rather than against a literal. Checked directly against this
 *  project's generated client + `@prisma/adapter-better-sqlite3` (see the
 *  scratch script run during Phase 3 development, since removed): Prisma
 *  compiles it to plain SQL column-vs-column SQL —
 *  `WHERE ... AND "redeemedCount" < "maxRedemptions"` — which SQLite
 *  supports natively (no Postgres-specific syntax involved), and
 *  better-sqlite3 executes it correctly. Verified all four cases the plan
 *  called out: a not-yet-redeemed code claims successfully (count 1); a
 *  fully-redeemed code (redeemedCount === maxRedemptions) claims nothing
 *  (count 0); an expired code (`redeemableUntil` in the past) claims
 *  nothing; and firing two claims at the same maxRedemptions:1 code left
 *  redeemedCount at exactly 1, never 2 — one succeeded, one got count 0.
 *  No deviation from jinglejotter.com's approach was needed. */
export async function claimAccessCode(
  raw: string,
  redeemerEmail: string | null | undefined,
): Promise<ClaimResult> {
  const code = normalizeCode(raw);
  if (!code) return { ok: false, error: "Enter your access code." };

  const claimed = await prisma.accessCode.updateMany({
    where: {
      code,
      redeemedCount: { lt: prisma.accessCode.fields.maxRedemptions },
      AND: [
        { OR: [{ redeemableUntil: null }, { redeemableUntil: { gt: new Date() } }] },
        { OR: [{ email: null }, { email: redeemerEmail?.trim().toLowerCase() ?? "" }] },
      ],
    },
    data: { redeemedCount: { increment: 1 } },
  });
  if (claimed.count === 0) return { ok: false, error: CLAIM_FAILED };

  const row = await prisma.accessCode.findUniqueOrThrow({
    where: { code },
    select: { id: true },
  });
  return { ok: true, codeId: row.id };
}

/** Best-effort compensation when household creation fails after a claim
 *  succeeded — hands the redemption slot back. */
export async function releaseClaim(codeId: string): Promise<void> {
  await prisma.accessCode.updateMany({
    where: { id: codeId, redeemedCount: { gt: 0 } },
    data: { redeemedCount: { decrement: 1 } },
  });
}
