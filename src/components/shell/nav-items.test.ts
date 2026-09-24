import { describe, expect, it } from "vitest";
import { isNavItemActive, navItemsFor, OWNER_ITEMS } from "./nav-items";

describe("isNavItemActive", () => {
  it("matches Home only on the exact root", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/film/abc", "/")).toBe(false);
    expect(isNavItemActive("/films", "/")).toBe(false);
  });

  it("does not light Movies for a film page (/film is not under /films)", () => {
    expect(isNavItemActive("/films", "/films")).toBe(true);
    expect(isNavItemActive("/film/1", "/films")).toBe(false);
  });

  it("matches a section and anything nested under it", () => {
    expect(isNavItemActive("/music", "/music")).toBe(true);
    expect(isNavItemActive("/music/album/xyz", "/music")).toBe(true);
    expect(isNavItemActive("/shows/1", "/music")).toBe(false);
  });

  it("does not treat a shared prefix as nested", () => {
    expect(isNavItemActive("/showsfoo", "/shows")).toBe(false);
  });
});

describe("navItemsFor", () => {
  const hrefs = (items: { href: string }[]) => items.map((i) => i.href);
  const labels = (items: { label: string }[]) => items.map((i) => i.label);

  it("gives everyone the iPhone app's five tabs, in its order and words", () => {
    const groups = navItemsFor({ isOwner: false, hasAdultAccess: false });
    expect(labels(groups.primary)).toEqual(["Home", "Movies", "Shows", "Music", "Search"]);
    expect(hrefs(groups.primary)).toEqual(["/", "/films", "/shows", "/music", "/search"]);
  });

  it("puts Collections and History in the extras, with no owner rows for a member", () => {
    const groups = navItemsFor({ isOwner: false, hasAdultAccess: false });
    expect(hrefs(groups.extras)).toEqual(["/collections", "/history"]);
    expect(groups.owner).toEqual([]);
  });

  it("adds Adult between Collections and History only with the opt-in", () => {
    const groups = navItemsFor({ isOwner: false, hasAdultAccess: true });
    expect(hrefs(groups.extras)).toEqual(["/collections", "/adult", "/history"]);
    expect(hrefs(groups.primary)).not.toContain("/adult");
  });

  it("adds the owner group only for the app owner", () => {
    const groups = navItemsFor({ isOwner: true, hasAdultAccess: false });
    expect(groups.owner).toEqual(OWNER_ITEMS);
  });

  it("never lists a destination twice", () => {
    const groups = navItemsFor({ isOwner: true, hasAdultAccess: true });
    const all = [...hrefs(groups.primary), ...hrefs(groups.extras), ...hrefs(groups.owner)];
    expect(new Set(all).size).toBe(all.length);
  });
});
