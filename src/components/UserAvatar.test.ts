import { describe, expect, it } from "vitest";
import { initialsFor } from "./UserAvatar";

describe("initialsFor", () => {
  it("uses first and last initials of a full name", () => {
    expect(initialsFor("Mark Watts")).toBe("MW");
    expect(initialsFor("  mark   robert   watts ")).toBe("MW");
  });

  it("uses a single initial for a one-word name", () => {
    expect(initialsFor("Rosie")).toBe("R");
  });

  it("falls back to the email's first letter, then ?", () => {
    expect(initialsFor("", "someone@example.com")).toBe("S");
    expect(initialsFor(null, null)).toBe("?");
    expect(initialsFor("   ", "")).toBe("?");
  });
});
