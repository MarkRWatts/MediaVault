// GET /api/video/:versionId/stream — the actual video bytes.
//
// Self-starting: this alone is enough to play any file, regardless of tier.
// A direct-playable file or an already-fully-prepared one is served with
// normal byte-range support (full Content-Length, seeking works). A file
// that needs preparing and hasn't been started yet gets kicked off right
// here, and is streamed live as ffmpeg writes it (see video-cache.ts's
// resolveVideoStream + tailing-stream.ts) rather than making the caller wait
// for the whole thing — that wait was the entire problem with the previous
// version of this route.
//
// Range requests are only honoured against a *complete* file. While a file
// is still being generated, any Range header is ignored and the response
// always starts from byte 0 with no Content-Length (chunked) — there's no
// way to seek into video that doesn't exist yet, and the total length isn't
// known until the write finishes. Once prepared, the normal fast path takes
// over and full seeking works.

import { NextResponse } from "next/server";
import { promises as fsPromises, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolveVideoStream, registerStreamReader } from "@/lib/video-cache";
import { createTailingStream } from "@/lib/tailing-stream";
import { parseRange } from "@/lib/http-range";

// Manual ReadableStream instead of Readable.toWeb(): a Node Readable emits
// 'close' after 'end' as part of its own finalization, and a client
// disconnect (every seek cancels the in-flight range request, and this runs
// on every direct-play file) can race that with a destroy() triggered by the
// runtime canceling the response stream. Readable.toWeb's adapter doesn't
// guard against both landing on the same controller, and throws "Invalid
// state: Controller is already closed" (ERR_INVALID_STATE) as an *uncaught*
// exception when it does -- from inside Node's own internal adapter, outside
// this handler's promise chain, so nothing here ever gets a chance to catch
// it, and it takes the whole process down. Owning the controller directly
// lets every close/error/enqueue call be guarded against running twice.
function fileToWebStream(readStream: Readable): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      readStream.on("data", (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } catch {
          return; // Controller already closed/errored by a concurrent event.
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          readStream.pause();
        }
      });
      readStream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a concurrent event -- ignore.
        }
      });
      readStream.once("error", (err) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(err);
        } catch {
          // Already closed/errored by a concurrent event -- ignore.
        }
      });
    },
    pull() {
      readStream.resume();
    },
    cancel() {
      closed = true;
      readStream.destroy();
    },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId: versionIdParam } = await ctx.params;
  const versionId = Number(versionIdParam);
  if (!Number.isInteger(versionId)) {
    return NextResponse.json({ error: "invalid version id" }, { status: 400 });
  }

  const resolved = await resolveVideoStream("film", versionId);

  if (resolved.kind === "not-found") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (resolved.kind === "error") {
    return NextResponse.json({ error: resolved.message }, { status: 500 });
  }
  if (resolved.kind === "not-started") {
    // ffmpeg hasn't even created its output file yet after a generous wait —
    // essentially never expected in practice. Ask the client to retry.
    return NextResponse.json({ error: "not ready yet" }, { status: 503, headers: { "Retry-After": "2" } });
  }

  if (resolved.kind === "tailing") {
    const nodeStream = createTailingStream(resolved.absPath, {
      isDone: resolved.isDone,
      hasErrored: resolved.hasErrored,
    });
    // Ties the underlying ffmpeg job's lifetime to whether anyone's actually
    // still watching -- pausing doesn't fire this (the connection stays
    // open), only a real disconnect does. See registerStreamReader.
    nodeStream.once("close", registerStreamReader("film", versionId));
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
