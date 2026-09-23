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

/** 200 or 206 for `absPath`, honouring a single-range Range header.
 *
 *  `maxRangeBytes` caps how much one 206 carries: a request for more (an
 *  open-ended `bytes=N-` is the usual one) gets the first `maxRangeBytes`
 *  of it, with a Content-Range that says so, and the client asks again for
 *  the rest — RFC 9110 lets a server send less than was asked for. The
 *  /stream routes need it: AVFoundation (the Apple TV and iOS apps) opens
 *  several ranges of the same MP4 over one HTTP/2-or-3 connection, stops
 *  reading the open-ended ones once it has buffered enough, and those
 *  stalled responses then hold the connection's flow-control window — so
 *  the audio track's reads behind them get nothing, and the sound stops
 *  while the picture plays on from its buffer. Bounded responses finish
 *  and free the window. A plain 200 (no Range header) is never capped. */
export async function serveFile(
  req: Request,
  absPath: string,
  contentType: string,
  cacheControl: string,
  options: { maxRangeBytes?: number } = {},
): Promise<NextResponse> {
  const stat = await fsPromises.stat(absPath);
  const range = capRange(parseRange(req.headers.get("range"), stat.size), options.maxRangeBytes);
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

function capRange(range: ReturnType<typeof parseRange>, maxRangeBytes: number | undefined): ReturnType<typeof parseRange> {
  if (!maxRangeBytes || range === null || range === "unsatisfiable") return range;
  if (range.end - range.start + 1 <= maxRangeBytes) return range;
  return { start: range.start, end: range.start + maxRangeBytes - 1 };
}
