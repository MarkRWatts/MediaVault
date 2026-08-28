// Advance the persistent scan queue by one item: claim the oldest pending
// barcode and resolve it. Meant to be called repeatedly (a "tick") by
// whichever client has the batch scan view open — see the scan page's
// polling effect. The claim is a conditional UPDATE (status must still be
// "pending" when it runs) so two clients ticking at once can't double-
// process the same row; SQLite's single-writer semantics make this safe
// without any additional locking.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveBarcode, shapeScanQueueItem } from "@/lib/scan-resolve";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function POST() {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const pending = await prisma.scanQueueItem.findFirst({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
  });
  if (!pending) {
    return NextResponse.json({ done: true });
  }

  const claim = await prisma.scanQueueItem.updateMany({
    where: { id: pending.id, status: "pending" },
    data: { status: "looking_up" },
  });
  if (claim.count === 0) {
    // Another client's tick claimed it first — nothing to do this round.
    return NextResponse.json({ done: false });
  }

  try {
    const result = await resolveBarcode(pending.barcode, pending.mediaType === "auto" ? null : pending.mediaType);
    const updated = await prisma.scanQueueItem.update({
      where: { id: pending.id },
      data: { status: "resolved", resultJson: JSON.stringify(result) },
    });
    return NextResponse.json({ done: false, item: shapeScanQueueItem(updated) });
  } catch (err) {
    const updated = await prisma.scanQueueItem.update({
      where: { id: pending.id },
      data: { status: "error", errorMessage: err instanceof Error ? err.message : "Lookup failed" },
    });
    return NextResponse.json({ done: false, item: shapeScanQueueItem(updated) });
  }
}
