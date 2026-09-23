// serveFile's byte ranges, and the cap the direct-play /stream routes use
// (see serveFile's doc comment for why an uncapped open-ended range starves
// AVFoundation's audio reads).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveFile } from "./serve-file";

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
  it("serves a requested range whole when there's no cap", async () => {
    const res = await serveFile(get("bytes=100-"), file, "video/mp4", "no-store");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-${SIZE - 1}/${SIZE}`);
    expect((await res.arrayBuffer()).byteLength).toBe(SIZE - 100);
  });

  it("caps an open-ended range and says so in Content-Range", async () => {
    const res = await serveFile(get("bytes=100-"), file, "video/mp4", "no-store", { maxRangeBytes: 1000 });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 100-1099/${SIZE}`);
    expect(res.headers.get("content-length")).toBe("1000");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(1000);
    expect(body[0]).toBe(100 % 256);
  });

  it("leaves a range smaller than the cap alone", async () => {
    const res = await serveFile(get("bytes=0-1"), file, "video/mp4", "no-store", { maxRangeBytes: 1000 });
    expect(res.headers.get("content-range")).toBe(`bytes 0-1/${SIZE}`);
  });

  it("never caps a plain 200", async () => {
    const res = await serveFile(get(), file, "video/mp4", "no-store", { maxRangeBytes: 1000 });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(SIZE);
  });
});
