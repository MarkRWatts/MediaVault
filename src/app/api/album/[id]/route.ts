// Delete a physical-only Album row outright — for a placeholder created by
// mistake (e.g. a "paste Discogs links" add that matched the wrong record,
// see the Scan page's Discogs paste tool). Unlike
// DELETE /api/physical, which only removes one PhysicalCopy, this removes
// the Album row itself (cascading its PhysicalCopy/PhysicalTrack/Track rows
// — see onDelete: Cascade in prisma/schema.prisma).
//
// Scoped to owned=false albums only: an owned album is a live folder-scan
// result, and there's no code path that needs to delete one outright (a
// rescan would just recreate it from disk, silently dropping any
// hand-curated fields in between) — so this refuses rather than serving
// a footgun outside the case it exists for.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const { id } = await params;
  const albumId = Number(id);
  if (!Number.isInteger(albumId)) {
    return NextResponse.json({ error: "invalid album id" }, { status: 400 });
  }

  const album = await prisma.album.findUnique({ where: { id: albumId }, select: { owned: true } });
  if (!album) {
    return NextResponse.json({ error: "unknown album id" }, { status: 404 });
  }
  if (album.owned) {
    return NextResponse.json(
      { error: "can't delete an owned album — it's tied to a scanned folder, not just a placeholder" },
      { status: 400 },
    );
  }

  await prisma.album.delete({ where: { id: albumId } });
  return NextResponse.json({ ok: true });
}
