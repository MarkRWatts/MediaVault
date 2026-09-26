import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpcBusyError, lookupMovieByBarcode, parseUpcItemDbResponse, resetUpcLookupState } from "./barcode-lookup";

describe("parseUpcItemDbResponse", () => {
  it("returns null with no items", () => {
    expect(parseUpcItemDbResponse({ items: [] })).toBeNull();
    expect(parseUpcItemDbResponse({})).toBeNull();
  });

  it("returns null when the item has no title", () => {
    expect(parseUpcItemDbResponse({ items: [{}] })).toBeNull();
  });

  it("extracts a bracketed year and strips it from the title", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "The Matrix [1999]" }] })).toEqual({
      title: "The Matrix",
      year: 1999,
    });
  });

  it("extracts a parenthesised year", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "The Matrix (1999)" }] })).toEqual({
      title: "The Matrix",
      year: 1999,
    });
  });

  it("strips format tags like (Blu-ray) even with no year present", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "The Matrix (Blu-ray)" }] })).toEqual({
      title: "The Matrix",
      year: null,
    });
  });

  it("strips bracketed studio/UPC noise", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "The Matrix [Warner Bros]" }] })).toEqual({
      title: "The Matrix",
      year: null,
    });
  });

  it("returns null if stripping leaves nothing", () => {
    expect(parseUpcItemDbResponse({ items: [{ title: "(DVD)" }] })).toBeNull();
  });

  // Real UPCitemdb responses captured while diagnosing a batch of scanned
  // Blu-rays that all came back "unknown" — the barcode database itself was
  // fine, but every one of these titles defeated the original cleanup.
  describe("real-world retailer listing shapes", () => {
    it("strips the barcode echoed back inside the title", () => {
      expect(
        parseUpcItemDbResponse({ items: [{ title: "Ant Man & The Wasp, 8717418538514" }] }, "8717418538514"),
      ).toEqual({ title: "Ant Man & The Wasp", year: null });
    });

    it("cuts at the first comma (barcode + cast names trailing)", () => {
      expect(
        parseUpcItemDbResponse(
          { items: [{ title: "Kingsman: The Secret Service [blu-ray], 5039036072847, Colin Firth, Samuel L. J." }] },
          "5039036072847",
        ),
      ).toEqual({ title: "Kingsman: The Secret Service", year: null });
    });

    it("cuts at a bare (unpunctuated) format keyword with no comma present", () => {
      expect(
        parseUpcItemDbResponse({
          items: [{ title: "Thor Ragnarok Blu-ray 2017 Marvel Film Movie Comic Pre Order For 26th February" }],
        }),
      ).toEqual({ title: "Thor Ragnarok", year: null });
    });

    it("strips a non-year parenthetical format tag with trailing junk after it", () => {
      expect(
        parseUpcItemDbResponse({
          items: [{ title: "Murder On The Orient Express Blu-ray + With Kenneth Branagh (blu-ray 2017)" }],
        }),
      ).toEqual({ title: "Murder On The Orient Express", year: null });
    });

    it("strips a generic (non-format) parenthetical aside", () => {
      expect(parseUpcItemDbResponse({ items: [{ title: "Guardians Of The Galaxy V (uk Import) Dvd" }] })).toEqual({
        title: "Guardians Of The Galaxy V",
        year: null,
      });
    });

    it("combines barcode-strip, bracket-strip and comma-cut together", () => {
      expect(
        parseUpcItemDbResponse(
          { items: [{ title: "The Bourne Supremacy [blu-ray][region Free], 5050582597318, Matt Damon, Franka ." }] },
          "5050582597318",
        ),
      ).toEqual({ title: "The Bourne Supremacy", year: null });
    });
  });
});

describe("lookupMovieByBarcode", () => {
  const ok = { code: "OK", items: [{ title: "The Mechanic [blu-ray], 5060116726428, Jason Statham" }] };
  const tooFast = { code: "TOO_FAST" };
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

  beforeEach(() => {
    resetUpcLookupState();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits out a 429 TOO_FAST and retries, instead of reporting not found", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() => reply(429, tooFast)).mockImplementationOnce(() => reply(200, ok));
    vi.stubGlobal("fetch", fetchMock);
    const pending = lookupMovieByBarcode("5060116726428");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ title: "The Mechanic", year: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws UpcBusyError when still throttled after the wait", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => reply(429, tooFast)));
    const pending = lookupMovieByBarcode("5060116726428");
    const assertion = expect(pending).rejects.toBeInstanceOf(UpcBusyError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("answers a re-scan from the cache without calling UPCitemdb", async () => {
    const fetchMock = vi.fn().mockImplementation(() => reply(200, ok));
    vi.stubGlobal("fetch", fetchMock);
    const first = lookupMovieByBarcode("5060116726428");
    await vi.runAllTimersAsync();
    await first;
    await expect(lookupMovieByBarcode("5060116726428")).resolves.toEqual({ title: "The Mechanic", year: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
