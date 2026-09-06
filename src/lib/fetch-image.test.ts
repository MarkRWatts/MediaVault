import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchImage, safeCacheSegment } from "./fetch-image";

function mockFetch(body: BodyInit, init: { status?: number; type?: string; length?: string } = {}) {
  const headers = new Headers();
  if (init.type !== undefined) headers.set("content-type", init.type);
  if (init.length !== undefined) headers.set("content-length", init.length);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: init.status ?? 200, headers })),
  );
}

afterEach(() => vi.unstubAllGlobals());

// A Uint8Array over a plain ArrayBuffer — what BodyInit wants.
function bytes(lenOrValues: number | number[]): Uint8Array<ArrayBuffer> {
  const values = typeof lenOrValues === "number" ? new Array<number>(lenOrValues).fill(0) : lenOrValues;
  const out = new Uint8Array(new ArrayBuffer(values.length));
  out.set(values);
  return out;
}

describe("fetchImage", () => {
  it("returns the bytes of an image response", async () => {
    mockFetch(bytes([0xff, 0xd8, 0xff, 0xe0]), { type: "image/jpeg" });
    const buf = await fetchImage("https://img.example/x.jpg");
    expect(buf?.byteLength).toBe(4);
  });

  it("accepts octet-stream (some CDNs) but refuses text/html and JSON", async () => {
    mockFetch(bytes(8), { type: "application/octet-stream" });
    expect(await fetchImage("https://img.example/x")).not.toBeNull();
    mockFetch("<html>oops</html>", { type: "text/html" });
    expect(await fetchImage("https://img.example/x")).toBeNull();
    mockFetch("{}", { type: "application/json" });
    expect(await fetchImage("https://img.example/x")).toBeNull();
  });

  it("refuses non-OK, oversized (declared or actual) and undersized bodies", async () => {
    mockFetch(bytes(8), { status: 404, type: "image/jpeg" });
    expect(await fetchImage("https://img.example/x")).toBeNull();
    mockFetch(bytes(8), { type: "image/jpeg", length: String(50 * 1024 * 1024) });
    expect(await fetchImage("https://img.example/x")).toBeNull();
    mockFetch(bytes(100), { type: "image/jpeg" });
    expect(await fetchImage("https://img.example/x", { maxBytes: 50 })).toBeNull();
    mockFetch(bytes(10), { type: "image/jpeg" });
    expect(await fetchImage("https://img.example/x", { minBytes: 100 })).toBeNull();
  });

  it("never throws — a network failure is a null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await fetchImage("https://img.example/x")).toBeNull();
  });
});

describe("safeCacheSegment", () => {
  it("accepts TMDB-style filenames and numeric ids", () => {
    expect(safeCacheSegment("1A1BwgWO3Sw379VEhR0vkTuE3XW.jpg")).toBe("1A1BwgWO3Sw379VEhR0vkTuE3XW.jpg");
    expect(safeCacheSegment(42)).toBe("42");
    expect(safeCacheSegment("abc_def-1.png")).toBe("abc_def-1.png");
  });

  it("refuses separators, dot-dirs and anything odd", () => {
    for (const bad of ["../x.jpg", "a/b.jpg", "a\\b.jpg", ".", "..", "", "x y.jpg", "x\0.jpg", "a".repeat(200)]) {
      expect(safeCacheSegment(bad)).toBeNull();
    }
  });
});
