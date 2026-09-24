// serveFile's byte ranges: every 206 is exactly the range asked for, since
// AVFoundation rejects a shorter one (see serveFile's doc comment).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileToWebStream, serveFile } from "./serve-file";

let dir: string;
let file: string;
const SIZE = 10_000;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "serve-file-"));
  file = path.join(dir, "clip.mp4");
  writeFileSync(file, Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 256)));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function get(range?: string) {
  return new Request("http://localhost/stream", { headers: range ? { range } : {} });
}

describe("serveFile", () => {
  it("serves an open-ended range to the end of the file", async () => {
    const res = await serveFile(get("bytes=100-"), file, "video/mp4", "no-store");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-${SIZE - 1}/${SIZE}`);
    expect((await res.arrayBuffer()).byteLength).toBe(SIZE - 100);
  });

  it("serves the whole of a whole-file range, as AVFoundation asks for it", async () => {
    const res = await serveFile(get(`bytes=0-${SIZE - 1}`), file, "video/mp4", "no-store");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-${SIZE - 1}/${SIZE}`);
    expect(res.headers.get("content-length")).toBe(String(SIZE));
  });

  it("serves a small range as asked", async () => {
    const res = await serveFile(get("bytes=0-1"), file, "video/mp4", "no-store");
    expect(res.headers.get("content-range")).toBe(`bytes 0-1/${SIZE}`);
  });

  it("closes the file when the client goes away", async () => {
    const abort = new AbortController();
    const readStream = createReadStream(file);
    const reader = fileToWebStream(readStream, abort.signal).getReader();
    await reader.read();
    abort.abort();
    expect(readStream.destroyed).toBe(true);
  });

  it("serves a plain 200 without a Range header", async () => {
    const res = await serveFile(get(), file, "video/mp4", "no-store");
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(SIZE);
  });
});
