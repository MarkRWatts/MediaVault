// GET /api/films/:id — film detail for native clients (see /api/films for
// why this exists). Reuses getFilmDetail verbatim; the web page's own
// collection-strip data is harmless extra payload for a native client to
// ignore rather than worth a second, trimmed DTO.

import { NextResponse } from "next/server";
import { getFilmDetail } from "@/lib/queries";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: idParam } = await ctx.params;
  const id = Number(idParam);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "invalid film id" }, { status: 400 });
  }

  const film = await getFilmDetail(id);
  if (!film) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(film);
}
