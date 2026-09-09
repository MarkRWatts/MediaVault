import { describe, expect, it } from "vitest";
import { isNavItemActive, navItemsFor, OWNER_ITEMS } from "./nav-items";

describe("isNavItemActive", () => {
  it("matches Movies only on the exact root", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/film/abc", "/")).toBe(false);
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

  it("shows a plain member the five everyday sections and no owner rows", () => {
    const groups = navItemsFor({ isOwner: false, hasAdultAccess: false });
    expect(hrefs(groups.primary)).toEqual(["/", "/shows", "/music", "/collections", "/stats"]);
    expect(groups.owner).toEqual([]);
    expect(hrefs(groups.mobileTabs)).toEqual(["/", "/shows", "/music", "/collections"]);
    expect(hrefs(groups.more)).toEqual(["/stats"]);
  });

  it("adds Adult between Collections and Stats only with the opt-in", () => {
    const groups = navItemsFor({ isOwner: false, hasAdultAccess: true });
    expect(hrefs(groups.primary)).toEqual(["/", "/shows", "/music", "/collections", "/adult", "/stats"]);
    expect(hrefs(groups.more)).toEqual(["/adult", "/stats"]);
  });

  it("adds the owner group, and puts it last in More, only for the app owner", () => {
    const groups = navItemsFor({ isOwner: true, hasAdultAccess: false });
    expect(groups.owner).toEqual(OWNER_ITEMS);
    expect(hrefs(groups.more)).toEqual(["/stats", "/scan", "/report", "/admin"]);
    expect(groups.moreOwner).toEqual(OWNER_ITEMS);
  });

  it("never lists a destination twice across tabs and More", () => {
    const groups = navItemsFor({ isOwner: true, hasAdultAccess: true });
    const all = [...hrefs(groups.mobileTabs), ...hrefs(groups.more)];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...hrefs(groups.primary), ...hrefs(groups.owner)].sort());
  });
});
