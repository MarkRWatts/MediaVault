import { describe, expect, it } from "vitest";
import { hidesTopNav } from "./top-nav";

describe("hidesTopNav", () => {
  it("drops the logo bar on a film's and a show's own page", () => {
    expect(hidesTopNav("/film/12")).toBe(true);
    expect(hidesTopNav("/shows/7")).toBe(true);
  });

  it("keeps it on the top-level pages", () => {
    expect(hidesTopNav("/")).toBe(false);
    expect(hidesTopNav("/films")).toBe(false);
    expect(hidesTopNav("/shows")).toBe(false);
    expect(hidesTopNav("/shows/")).toBe(false);
    expect(hidesTopNav("/music")).toBe(false);
  });
});
