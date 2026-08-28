// Mutate one scan-queue row. DELETE removes it (used once a barcode's been
// successfully added, or the user gives up on it). PATCH { action: "retry" }
// resets a stuck/errored item back to pending.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { shapeScanQueueItem } from "@/lib/scan-resolve";
import { requireOwnerOrResponse } from "@/lib/require-member";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const { id } = await ctx.params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    await prisma.scanQueueItem.delete({ where: { id: idNum } });
  } catch (error) {
    // P2025: already gone — idempotent, not an error.
    if (error instanceof Error && "code" in error && error.code === "P2025") {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const member = await requireOwnerOrResponse();
  if (member instanceof NextResponse) return member;

  const { id } = await ctx.params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.action !== "retry") {
    return NextResponse.json({ error: "expected { action: 'retry' }" }, { status: 400 });
  }

  try {
    const updated = await prisma.scanQueueItem.update({
      where: { id: idNum },
      data: { status: "pending", resultJson: null, errorMessage: null },
    });
    return NextResponse.json(shapeScanQueueItem(updated));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "P2025") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown error" }, { status: 500 });
  }
}
