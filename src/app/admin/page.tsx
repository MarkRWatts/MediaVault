import { prisma } from "@/lib/db";
import { requireOwnerOrRedirect } from "@/lib/require-member";
import { formatCode } from "@/lib/access";
import { MintCodeForm } from "@/components/admin/MintCodeForm";
import { CodeRowActions } from "@/components/admin/CodeRowActions";
import ScanControls from "@/components/admin/ScanControls";
import { JellyfinClientForm } from "@/components/admin/JellyfinClientForm";

// DB-backed listing: must render per-request, not be frozen at build time
// (the Docker image is built with no database present).
export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function codeStatus(code: {
  redeemedCount: number;
  maxRedemptions: number;
  redeemableUntil: Date | null;
}): { label: string; tone: "used" | "live" | "dead" } {
  if (code.redeemedCount > 0) {
    // Unlike the template app, MediaVault's AccessCode carries no relation
    // back to the household(s) that redeemed it (Household here has no
    // accessCodeId — see prisma/schema.prisma) — just the count.
    const uses =
      code.maxRedemptions > 1 ? ` (${code.redeemedCount}/${code.maxRedemptions} uses)` : "";
    return { label: `Used${uses}`, tone: "used" };
  }
  if (code.redeemableUntil && code.redeemableUntil < new Date()) {
    return { label: `Expired ${dateFmt.format(code.redeemableUntil)}`, tone: "dead" };
  }
  return {
    label: code.redeemableUntil
      ? `Unused — redeemable until ${dateFmt.format(code.redeemableUntil)}`
      : "Unused",
    tone: "live",
  };
}

const TONE_CLASS = {
  used: "border-accent-border bg-accent-dim text-accent",
  live: "border-border-strong bg-bg-hover text-text-muted",
  dead: "border-missing-border bg-missing-bg text-missing",
} as const;

// Owner-only (see HOUSEHOLDS_PLAN.md part 3): access-code minting/revoking
// and the content-free activity log, both product-owner tooling rather
// than anything a household member needs. Ported from the template app's
// app/admin/page.tsx, restyled to MediaVault's dark palette; the template's
// household-attribution column on used codes is dropped (see codeStatus's
// comment above — MediaVault's AccessCode doesn't track which household(s)
// redeemed it).
export default async function AdminPage() {
  await requireOwnerOrRedirect();

  const [codes, audit] = await Promise.all([
    prisma.accessCode.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);

  // AuditLog has no FK relations on purpose (rows outlive their user/
  // household) — resolve display names here and fall back to "(deleted)".
  const userIds = [...new Set(audit.map((a) => a.userId).filter((id): id is string => !!id))];
  const householdIds = [
    ...new Set(audit.map((a) => a.householdId).filter((id): id is string => !!id)),
  ];
  const [users, households] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, email: true },
    }),
    prisma.household.findMany({ where: { id: { in: householdIds } }, select: { id: true, name: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name || u.email || u.id]));
  const householdName = new Map(households.map((h) => [h.id, h.name]));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-10 sm:px-6">
      <header>
        <h1 className="font-display text-3xl tracking-wide text-text">Admin</h1>
        <p className="mt-1 text-sm text-text-muted">
          Only you can see this page. Codes with an email attached let that address sign in while
          the code is live — minting one (or inviting someone into an existing household) is what
          lets a new person in.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl tracking-wide text-text">Library</h2>
        <p className="text-sm text-text-muted">
          Rescan walks the library folders for new/changed/removed files; fetch metadata pulls TMDB (film/TV) or
          Discogs (music) matches for anything unmatched. Each media type runs independently. Set DISCOGS_TOKEN
          before running a full music enrich — it raises Discogs&rsquo; rate limit from 25 to 60 requests/min.
        </p>
        <ScanControls />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl tracking-wide text-text">Integrations</h2>
        <p className="text-sm text-text-muted">
          Registers Jellyfin as a trusted OAuth client so household members sign into Jellyfin with
          their MediaVault account (jellyfin-plugin-sso). One-time setup, run once per Jellyfin
          instance — see HOUSEHOLDS_PLAN.md &quot;Jellyfin SSO&quot;.
        </p>
        <JellyfinClientForm />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl tracking-wide text-text">Access codes</h2>
        <MintCodeForm />
        <div className="overflow-x-auto rounded-lg border border-border bg-bg-elevated">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-widest text-text-faint">
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">For</th>
                <th className="px-4 py-3 font-medium">Minted</th>
                <th className="px-4 py-3 font-medium">Emailed</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {codes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-text-faint">
                    No codes minted yet.
                  </td>
                </tr>
              )}
              {codes.map((code) => {
                const status = codeStatus(code);
                return (
                  <tr key={code.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3 font-mono font-medium tracking-wide text-text">
                      {formatCode(code.code)}
                    </td>
                    <td className="px-4 py-3 text-text">
                      {code.email ?? <span className="text-text-faint">generic</span>}
                      {code.note && <div className="text-xs text-text-faint">{code.note}</div>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-text-faint">
                      {dateFmt.format(code.createdAt)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-text-faint">
                      {code.sentAt ? dateTimeFmt.format(code.sentAt) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[status.tone]}`}
                      >
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <CodeRowActions
                        codeId={code.id}
                        hasEmail={!!code.email}
                        everSent={!!code.sentAt}
                        used={code.redeemedCount > 0}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl tracking-wide text-text">Activity</h2>
        <p className="text-sm text-text-muted">
          What kinds of things people are doing — never the content. The most recent 100 actions.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border bg-bg-elevated">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-widest text-text-faint">
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Who</th>
                <th className="px-4 py-3 font-medium">Household</th>
                <th className="px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {audit.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-text-faint">
                    Nothing logged yet.
                  </td>
                </tr>
              )}
              {audit.map((entry) => (
                <tr key={entry.id} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-3 whitespace-nowrap text-text-faint">
                    {dateTimeFmt.format(entry.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-text">
                    {entry.userId ? (userName.get(entry.userId) ?? "(deleted)") : "—"}
                  </td>
                  <td className="px-4 py-3 text-text">
                    {entry.householdId ? (householdName.get(entry.householdId) ?? "(deleted)") : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full border border-accent-border bg-accent-dim px-2.5 py-0.5 text-xs font-medium text-accent">
                      {entry.action}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
