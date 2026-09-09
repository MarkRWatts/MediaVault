// The one list of app destinations, shared by the desktop sidebar
// (sidebar.tsx) and the mobile tab bar + "More" sheet (bottom-tabs.tsx).
// Same shape as template-app / TrainTracker's nav-items.ts, plus the two
// gated groups MediaVault needs (see navItemsFor).

import {
  ChartColumn,
  ClipboardList,
  Disc3,
  EyeOff,
  Film,
  Library,
  ScanBarcode,
  Shield,
  Tv,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  /** Shorter label for the cramped mobile tab bar. */
  tabLabel: string;
  icon: LucideIcon;
};

/** Every signed-in member's destinations, in desktop sidebar order. */
export const PRIMARY_ITEMS: NavItem[] = [
  { href: "/", label: "Movies", tabLabel: "Movies", icon: Film },
  { href: "/shows", label: "Shows", tabLabel: "Shows", icon: Tv },
  { href: "/music", label: "Music", tabLabel: "Music", icon: Disc3 },
  { href: "/collections", label: "Collections", tabLabel: "Collections", icon: Library },
  { href: "/stats", label: "Stats", tabLabel: "Stats", icon: ChartColumn },
];

/** Gated on the self-service opt-in (User.adultLibraryAccess, see
 *  /account). Slots in after Collections, before Stats. */
export const ADULT_ITEM: NavItem = { href: "/adult", label: "Adult", tabLabel: "Adult", icon: EyeOff };

/** App-owner tools (User.isAppOwner — NOT Member.role, see
 *  src/lib/require-member.ts). Rendered as a second, tinted group so they
 *  read as admin-only at a glance. */
export const OWNER_ITEMS: NavItem[] = [
  { href: "/scan", label: "Scan", tabLabel: "Scan", icon: ScanBarcode },
  { href: "/report", label: "Report", tabLabel: "Report", icon: ClipboardList },
  { href: "/admin", label: "Admin", tabLabel: "Admin", icon: Shield },
];

// Four everyday tabs before "More" earns its keep on a phone.
const MOBILE_TAB_HREFS = ["/", "/shows", "/music", "/collections"];

export type NavFlags = { isOwner: boolean; hasAdultAccess: boolean };

export type NavGroups = {
  /** Sidebar's main group: primary items (+ Adult when opted in). */
  primary: NavItem[];
  /** Sidebar's tinted owner group; empty for non-owners. */
  owner: NavItem[];
  /** Mobile tab bar slots. */
  mobileTabs: NavItem[];
  /** Everything else, for the mobile "More" sheet (owner rows last). */
  more: NavItem[];
  /** Owner rows within `more`, so the sheet can tint them. */
  moreOwner: NavItem[];
};

/** Which rows this person sees. A UX nicety only — the security boundary
 *  is requireOwnerOrRedirect / requireAdultAccessOrRedirect on the pages
 *  and routes themselves. */
export function navItemsFor({ isOwner, hasAdultAccess }: NavFlags): NavGroups {
  const primary = hasAdultAccess
    ? PRIMARY_ITEMS.flatMap((item) => (item.href === "/stats" ? [ADULT_ITEM, item] : [item]))
    : PRIMARY_ITEMS;
  const owner = isOwner ? OWNER_ITEMS : [];
  const mobileTabs = MOBILE_TAB_HREFS.map((href) => primary.find((i) => i.href === href)!);
  const morePrimary = primary.filter((i) => !MOBILE_TAB_HREFS.includes(i.href));
  return { primary, owner, mobileTabs, more: [...morePrimary, ...owner], moreOwner: owner };
}

/** A nav item is "active" for its own route and any nested route beneath it. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
