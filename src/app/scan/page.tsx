// Every action this page drives (barcode lookup/add, the persistent scan
// queue, title search) hits an owner-gated API route (see
// HOUSEHOLDS_PLAN.md "Auth & gating" and src/lib/require-member.ts's
// requireOwnerOrResponse) — there's nothing left for a non-owner member to
// do here, so bounce them home instead of landing on a page where every
// button just 403s.
import { redirect } from "next/navigation";
import { requireMemberOrRedirect } from "@/lib/require-member";
import ScanPageClient from "./ScanPageClient";

export default async function ScanPage() {
  const { role } = await requireMemberOrRedirect();
  if (role !== "owner") redirect("/");

  return <ScanPageClient />;
}
