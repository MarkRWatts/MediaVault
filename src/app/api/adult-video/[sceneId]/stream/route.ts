// GET /api/adult-video/:sceneId/stream — see /api/video/:versionId/stream
// for the full mechanism explanation; this is the scene-flavoured twin,
// gated by requireAdultAccessOrResponse.

import { NextResponse } from "next/server";
import { promises as fsPromises, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolveVideoStream, registerStreamReader } from "@/lib/video-cache";
import { createTailingStream } from "@/lib/tailing-stream";
import { parseRange } from "@/lib/http-range";
import { requireAdultAccessOrResponse } from "@/lib/require-member";

function fileToWebStream(readStream: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(readStream) as ReadableStream<Uint8Array>;
}

export async function GET(req: Request, ctx: { params: Promise<{ sceneId: string }> }) {
  const gate = await requireAdultAccessOrResponse();
  if (gate instanceof NextResponse) return gate;

  const { sceneId: sceneIdParam } = await ctx.params;
  const sceneId = Number(sceneIdParam);
  if (!Number.isInteger(sceneId)) {
    return NextResponse.json({ error: "invalid scene id" }, { status: 400 });
  }

  const resolved = await resolveVideoStream("scene", sceneId);

  if (resolved.kind === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (resolved.kind === "error") {
    return NextResponse.json({ error: resolved.message }, { status: 500 });
  }
  if (resolved.kind === "not-started") {
    return NextResponse.json({ error: "not ready yet" }, { status: 503, headers: { "Retry-After": "2" } });
  }

  if (resolved.kind === "tailing") {
    const nodeStream = createTailingStream(resolved.absPath, {
      isDone: resolved.isDone,
      hasErrored: resolved.hasErrored,
    });
    nodeStream.once("close", registerStreamReader("scene", sceneId));
    return new NextResponse(fileToWebStream(nodeStream), {
      status: 200,
      headers: {
        "Content-Type": resolved.contentType,
        "Cache-Control": "no-store",
      },
    });
  }

  // resolved.kind === "complete" — normal byte-range serving, unchanged.
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
