import { describe, expect, it } from "vitest";
import { CHROMELESS_PATHS, isChromelessPath, isPreAuthPath, PUBLIC_PATHS } from "./public-paths";

describe("isPreAuthPath", () => {
  it("matches the sign-in/sign-up pages and invite links only", () => {
    expect(isPreAuthPath("/signin")).toBe(true);
    expect(isPreAuthPath("/signup")).toBe(true);
    expect(isPreAuthPath("/invite/abc123")).toBe(true);
    expect(isPreAuthPath("/")).toBe(false);
    expect(isPreAuthPath("/consent")).toBe(false);
    expect(isPreAuthPath("/signinx")).toBe(false);
  });
});

describe("isChromelessPath", () => {
  it("hides the app shell on the OIDC consent card", () => {
    expect(isChromelessPath("/consent")).toBe(true);
    expect(isChromelessPath("/")).toBe(false);
    expect(isChromelessPath("/account")).toBe(false);
  });

  // Hiding chrome and skipping the auth redirect are different decisions:
  // a chromeless page must never accidentally become publicly reachable.
  it("keeps the chromeless list separate from the public list", () => {
    for (const path of CHROMELESS_PATHS) expect(PUBLIC_PATHS).not.toContain(path);
  });
});
