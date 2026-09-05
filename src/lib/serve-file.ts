// Serve a local file over HTTP with byte-range support, as a Web
// ReadableStream built by hand rather than Readable.toWeb() — the latter can
// throw an uncaught ERR_INVALID_STATE when a client disconnect races the
// stream's own end/close (see the stream routes for the history). Used by the
// HLS segment routes; the film/scene stream routes carry their own copy of
// the same wrapper.

import { NextResponse } from "next/server";
import { promises as fsPromises, createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { parseRange } from "@/lib/http-range";

export function fileToWebStream(readStream: Readable): ReadableStream<Uint8Array> {
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      readStream.on("data", (chunk: Buffer) => {
        try {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } catch {
          return; // Controller already closed/errored by a concurrent event.
        }
        if (controller.desiredSize !== null && controller.desiredSize <= 0) readStream.pause();
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

/** 200 or 206 for `absPath`, honouring a single-range Range header. */
export async function serveFile(
  req: Request,
  absPath: string,
  contentType: string,
  cacheControl: string,
): Promise<NextResponse> {
  const stat = await fsPromises.stat(absPath);
  const range = parseRange(req.headers.get("range"), stat.size);
  const common = { "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": cacheControl };

  if (range === "unsatisfiable") {
    return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
  }
  if (range === null) {
    return new NextResponse(fileToWebStream(createReadStream(absPath)), {
      status: 200,
      headers: { ...common, "Content-Length": String(stat.size) },
    });
  }
  return new NextResponse(fileToWebStream(createReadStream(absPath, { start: range.start, end: range.end })), {
    status: 206,
    headers: {
      ...common,
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Content-Length": String(range.end - range.start + 1),
    },
  });
}
