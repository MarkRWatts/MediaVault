import { describe, expect, it } from "vitest";
import { packKeyframeSecs, unpackKeyframeSecs } from "./keyframe-store";

describe("packKeyframeSecs / unpackKeyframeSecs", () => {
  it("round-trips an empty list", () => {
    const packed = packKeyframeSecs([]);
    expect(packed.length).toBe(0);
    expect(unpackKeyframeSecs(packed)).toEqual([]);
  });

  it("round-trips fractional seconds exactly (Float64 has plenty of precision for this)", () => {
    const secs = [0, 6.5, 12.240001, 3600.999999, 7203.14159265];
    const packed = packKeyframeSecs(secs);
    expect(packed.length).toBe(secs.length * 8);
    expect(unpackKeyframeSecs(packed)).toEqual(secs);
  });

  it("round-trips a large keyframe list", () => {
    const secs = Array.from({ length: 5000 }, (_, i) => i * 2.002);
    expect(unpackKeyframeSecs(packKeyframeSecs(secs))).toEqual(secs);
  });

  it("throws on a buffer whose length isn't a multiple of 8", () => {
    expect(() => unpackKeyframeSecs(Buffer.alloc(7))).toThrow();
  });

  it("unpacks from a plain Uint8Array (as Prisma's Bytes field returns)", () => {
    const packed = packKeyframeSecs([1, 2, 3]);
    const view = new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
    expect(unpackKeyframeSecs(view)).toEqual([1, 2, 3]);
  });
});
