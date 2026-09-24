import { describe, expect, it } from "vitest";
import { copyLabel, copyShortLabel, defaultCopyId, sortCopies } from "@/lib/copy-quality";

const copy = (id: number, format: string, edition: string | null = null) => ({ id, format, edition });

describe("copyLabel", () => {
  it("names each kind of copy in plain words", () => {
    expect(copyLabel(copy(1, "UHD"))).toBe("Ultra HD (4K Blu-ray)");
    expect(copyLabel(copy(2, "BLURAY"))).toBe("High Definition (Blu-ray)");
    expect(copyLabel(copy(3, "DVD"))).toBe("Standard (DVD)");
    expect(copyLabel(copy(4, "HD"))).toBe("High Definition");
    expect(copyLabel(copy(5, "SD"))).toBe("Standard");
    expect(copyLabel(copy(6, "UNKNOWN"))).toBe("Other copy");
  });

  it("adds the edition only when two copies are the same kind", () => {
    const theatrical = copy(1, "BLURAY", "Theatrical");
    const extended = copy(2, "BLURAY", "Extended Edition");
    const uhd = copy(3, "UHD", "Extended Edition");
    const all = [theatrical, extended, uhd];
    expect(copyLabel(extended, all)).toBe("High Definition (Blu-ray) · Extended Edition");
    expect(copyLabel(theatrical, all)).toBe("High Definition (Blu-ray) · Theatrical");
    expect(copyLabel(uhd, all)).toBe("Ultra HD (4K Blu-ray)");
  });
});

describe("copyShortLabel", () => {
  it("gives the tier for the Quality caption", () => {
    expect(copyShortLabel(copy(1, "UHD"))).toBe("Ultra HD");
    expect(copyShortLabel(copy(2, "BLURAY"))).toBe("HD");
    expect(copyShortLabel(copy(3, "DVD"))).toBe("SD");
    expect(copyShortLabel({ ...copy(4, "UNKNOWN"), tier: { label: "720p" } })).toBe("720p");
  });
});

describe("sortCopies", () => {
  it("puts the best copy first, ties by id", () => {
    const all = [copy(1, "BLURAY"), copy(2, "BLURAY"), copy(3, "UHD"), copy(4, "DVD"), copy(5, "HD")];
    expect(sortCopies(all).map((c) => c.id)).toEqual([3, 1, 2, 5, 4]);
  });
});

describe("defaultCopyId", () => {
  const all = [copy(1, "BLURAY"), copy(2, "UHD"), copy(3, "DVD")];
  const notUhd = (c: { format: string }) => c.format !== "UHD";

  it("picks the best copy this device can play", () => {
    expect(defaultCopyId(all, notUhd, null)).toBe(1);
    expect(defaultCopyId(all, () => true, null)).toBe(2);
  });

  it("keeps the film on the copy with a saved position", () => {
    expect(defaultCopyId(all, notUhd, 3)).toBe(3);
  });

  it("ignores a saved position on a copy that can't play here", () => {
    expect(defaultCopyId(all, notUhd, 2)).toBe(1);
  });

  it("is null when nothing plays", () => {
    expect(defaultCopyId(all, () => false, null)).toBeNull();
  });
});
