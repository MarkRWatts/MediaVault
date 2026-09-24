// The one list of app destinations, shared by the desktop sidebar
// (sidebar.tsx), the mobile tab bar (bottom-tabs.tsx) and the mobile
// account menu behind the avatar (top-nav.tsx). Same shape as
// template-app / TrainTracker's nav-items.ts, plus the gated groups
// MediaVault needs (see navItemsFor).
//
// The five tabs are the iPhone app's, same order and same words
// (FILM_PAGE_PLAN.md "Everywhere"): Home · Movies · Shows · Music · Search.
// Everything else — Collections, History, Adult, the owner's tools — is an
// extra: under the five in the sidebar, in the avatar's menu on a phone.

import {
  ClipboardList,
  Disc3,
  EyeOff,
  Film,
  History,
  House,
  Library,
  ScanBarcode,
  Search,
  Shield,
  Tv,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

/** The five tabs, on every signed-in member's phone and at the top of the
 *  desktop sidebar. */
export const PRIMARY_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: House },
  { href: "/films", label: "Movies", icon: Film },
  { href: "/shows", label: "Shows", icon: Tv },
  { href: "/music", label: "Music", icon: Disc3 },
  { href: "/search", label: "Search", icon: Search },
];

/** Every member's other destinations, in menu order. */
export const EXTRA_ITEMS: NavItem[] = [
  { href: "/collections", label: "Collections", icon: Library },
  { href: "/history", label: "History", icon: History },
];

/** Gated on the self-service opt-in (User.adultLibraryAccess, see
 *  /account). Slots in after Collections, before History. */
export const ADULT_ITEM: NavItem = { href: "/adult", label: "Adult", icon: EyeOff };

/** App-owner tools (User.isAppOwner — NOT Member.role, see
 *  src/lib/require-member.ts). Rendered as a separate, tinted group so they
 *  read as admin-only at a glance. */
export const OWNER_ITEMS: NavItem[] = [
  { href: "/scan", label: "Scan", icon: ScanBarcode },
  { href: "/report", label: "Report", icon: ClipboardList },
  { href: "/admin", label: "Admin", icon: Shield },
];

export type NavFlags = { isOwner: boolean; hasAdultAccess: boolean };

export type NavGroups = {
  /** The five: the mobile tab bar, and the sidebar's first group. */
  primary: NavItem[];
  /** Collections, (Adult,) History: the sidebar's second group and the top
   *  of the mobile account menu. */
  extras: NavItem[];
  /** The tinted owner group, in both; empty for non-owners. */
  owner: NavItem[];
};

/** Which rows this person sees. A UX nicety only — the security boundary
 *  is requireOwnerOrRedirect / requireAdultAccessOrRedirect on the pages
 *  and routes themselves. */
export function navItemsFor({ isOwner, hasAdultAccess }: NavFlags): NavGroups {
  const extras = hasAdultAccess
    ? EXTRA_ITEMS.flatMap((item) => (item.href === "/history" ? [ADULT_ITEM, item] : [item]))
    : EXTRA_ITEMS;
  return { primary: PRIMARY_ITEMS, extras, owner: isOwner ? OWNER_ITEMS : [] };
}

/** A nav item is "active" for its own route and any nested route beneath it. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
