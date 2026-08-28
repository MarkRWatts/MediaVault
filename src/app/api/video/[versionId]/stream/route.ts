// GET /api/video/:versionId/stream — the actual video bytes: the original
// file when direct-playable, or the cached remux/transcode once ready (see
// video-cache.ts). Range-enabled so <video> seeking works — this is what
// makes the "prepare once into a complete file" approach viable without HLS:
// a finished MP4 gets normal byte-range support for free.

import { NextResponse } from "next/server";
import { promises as fsPromises, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolveVideoFile } from "@/lib/video-cache";
import { parseRange } from "@/lib/http-range";

function fileToWebStream(readStream: ReturnType<typeof createReadStream>): ReadableStream<Uint8Array> {
  return Readable.toWeb(readStream) as ReadableStream<Uint8Array>;
}

export async function GET(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }

  const resolved = await resolveVideoFile(versionId);
  if (!resolved) {
    return NextResponse.json({ error: "not ready" }, { status: 404 });
  }

  const stat = await fsPromises.stat(resolved.absPath);
  const range = parseRange(req.headers.get("range"), stat.size);

  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${stat.size}` },
    });
  }

  if (range === null) {
    return new NextResponse(fileToWebStream(createReadStream(resolved.absPath)), {
      status: 200,
      headers: {
        "Content-Type": resolved.contentType,
        "Content-Length": String(stat.size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }

  const chunkSize = range.end - range.start + 1;
  return new NextResponse(fileToWebStream(createReadStream(resolved.absPath, { start: range.start, end: range.end })), {
    status: 206,
    headers: {
      "Content-Type": resolved.contentType,
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Content-Length": String(chunkSize),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
