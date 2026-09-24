"use client";

// One of Home's rows: a horizontally scrolling line of 2:3 posters in which
// the open one widens into a 16:9 card of its backdrop, its title artwork
// and why it's there — the Apple TV's TVExpandingRow (MediaVaultiOS), drawn
// for a browser. With the row's details (HomeDetails) underneath while the
// row is the active one.
//
// Which card is open:
//   - a mouse resting on a card for HOVER_INTENT_MS (not the instant it
//     passes over — sweeping down the page shouldn't flicker every row
//     open), or keyboard focus, at once;
//   - in the hero row (Top Picks), always one: the last one opened there,
//     else the first — it stays open when the pointer is elsewhere, and its
//     details show while no other row is active;
//   - in any other row, none once the pointer has left it or focus moved
//     on: all posters.
//
// On a touch screen (no `desktop-input`, see globals.css) there is no
// hovering to open anything: the hero row is a snapping carousel of wide
// cards, the others plain posters, and a tap follows the link. That split
// is CSS — every width and visibility below is the touch layout by default
// and `desktop-input:` the mouse one — so the server's HTML is right before
// any script runs. Card sizes all derive from --row-h, the card height.
//
// New Shows and New Music don't open (the TV's Home has neither): posters
// with a caption, and square covers.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import CoverImage from "@/components/CoverImage";
import PosterImage from "@/components/PosterImage";
import HomeDetails from "@/components/home/HomeDetails";
import TitleArt from "@/components/home/TitleArt";
import { homeCard, rowExpands, type HomeCard } from "@/lib/home-cards";
import type { HomeData, HomeItem, HomeRow } from "@/lib/home-rows";

const HOVER_INTENT_MS = 150;
/** Grace after the pointer leaves a row before it closes, so crossing the
 *  gap into the next row doesn't collapse one details panel and open
 *  another in quick succession. */
const LEAVE_GRACE_MS = 250;

// Card height per row, stepped on <main>'s width like card-grid.ts. The
// hero's is taller on a desktop; on a touch screen its wide cards take most
// of the width (85%, minus the page gutter) so the next one peeks in.
const HERO_HEIGHT =
  "[--row-h:min(15rem,calc((100cqw-2rem)*0.85*9/16))] desktop-input:[--row-h:15rem] desktop-input:@4xl:[--row-h:18rem] desktop-input:@6xl:[--row-h:21rem]";
const ROW_HEIGHT = "[--row-h:12rem] @2xl:[--row-h:14rem] @5xl:[--row-h:16rem]";

// Literal class names, so Tailwind finds them.
const POSTER_W = "w-[calc(var(--row-h)*2/3)]";
const WIDE_W = "w-[calc(var(--row-h)*16/9)]";
const DESKTOP_POSTER_W = "desktop-input:w-[calc(var(--row-h)*2/3)]";
const DESKTOP_WIDE_W = "desktop-input:w-[calc(var(--row-h)*16/9)]";

/** The amber ring every card wears on keyboard focus (the global
 *  :focus-visible outline squares its corners off) and, lighter, on hover. */
const CARD_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg desktop-input:hover:ring-2 desktop-input:hover:ring-accent/70";

export default function ExpandingRow({
  row,
  films,
  hero,
  active,
  idle,
  onActivate,
  onDeactivate,
}: {
  row: HomeRow;
  films: HomeData["films"];
  /** Top Picks: taller, a card always open, a carousel on touch. */
  hero: boolean;
  /** This row is the one showing details. */
  active: boolean;
  /** No row is active — the hero shows its details. */
  idle: boolean;
  /** Called with this row's element, which Home keeps still on screen
   *  while details elsewhere appear and disappear. */
  onActivate: (rowId: string, el: HTMLElement) => void;
  onDeactivate: (rowId: string, el: HTMLElement) => void;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The card the pointer or focus opened. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** The last card opened here, which the hero keeps open. */
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [canScroll, setCanScroll] = useState({ left: false, right: false });

  const expands = rowExpands(row.items);
  const cards = row.items
    .map((item) => ({ item, card: homeCard(item, films) }))
    .filter((c): c is { item: HomeItem; card: HomeCard } => c.card !== null);

  const openCardKey =
    active && openKey
      ? openKey
      : hero
        ? (cards.find((c) => c.card.key === lastKey) ?? cards[0])?.card.key ?? null
        : null;
  const showsDetails = expands && (active || (hero && idle));
  const detailsItem = cards.find((c) => c.card.key === openCardKey)?.item;

  useEffect(
    () => () => {
      clearTimeout(hoverTimer.current);
      clearTimeout(leaveTimer.current);
    },
    [],
  );

  const open = useCallback(
    (key: string) => {
      setOpenKey(key);
      setLastKey(key);
      if (sectionRef.current) onActivate(row.id, sectionRef.current);
    },
    [onActivate, row.id],
  );

  const close = useCallback(() => {
    clearTimeout(hoverTimer.current);
    setOpenKey(null);
    if (sectionRef.current) onDeactivate(row.id, sectionRef.current);
  }, [onDeactivate, row.id]);

  // Arrow buttons show only when there's more to scroll to that way.
  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setCanScroll((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  function scrollByPage(direction: 1 | -1) {
    const el = scrollerRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: reduce ? "auto" : "smooth" });
  }

  const pointerHandlers = expands
    ? {
        onPointerEnter: (e: React.PointerEvent) => {
          if (e.pointerType === "mouse") clearTimeout(leaveTimer.current);
        },
        onPointerLeave: (e: React.PointerEvent) => {
          if (e.pointerType !== "mouse") return;
          clearTimeout(hoverTimer.current);
          leaveTimer.current = setTimeout(close, LEAVE_GRACE_MS);
        },
        onBlur: (e: React.FocusEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
        },
      }
    : {};

  return (
    <section
      ref={sectionRef}
      aria-labelledby={`home-row-${row.id}`}
      className={`group/row flex flex-col gap-1 py-2 ${hero ? HERO_HEIGHT : ROW_HEIGHT}`}
      {...pointerHandlers}
    >
      <h2 id={`home-row-${row.id}`} className="px-4 font-display text-xl tracking-wide sm:px-6">
        {row.title}
      </h2>
      <div className="relative">
        <div
          ref={scrollerRef}
          onScroll={measure}
          onTransitionEnd={measure}
          className={`flex items-start gap-3 overflow-x-auto scroll-px-4 px-4 py-3 [scrollbar-width:none] sm:scroll-px-6 sm:px-6 [&::-webkit-scrollbar]:hidden ${
            hero ? "snap-x snap-mandatory desktop-input:snap-none" : ""
          }`}
        >
          {cards.map(({ item, card }) =>
            expands ? (
              <ExpandingCard
                key={card.key}
                card={card}
                hero={hero}
                open={card.key === openCardKey}
                onPointerEnter={(e) => {
                  if (e.pointerType !== "mouse") return;
                  clearTimeout(hoverTimer.current);
                  hoverTimer.current = setTimeout(() => open(card.key), HOVER_INTENT_MS);
                }}
                onPointerLeave={() => clearTimeout(hoverTimer.current)}
                onFocus={() => {
                  clearTimeout(hoverTimer.current);
                  open(card.key);
                }}
              />
            ) : item.kind === "album" ? (
              <AlbumCard key={card.key} item={item} card={card} />
            ) : (
              <PosterCard key={card.key} item={item} card={card} />
            ),
          )}
        </div>
        <ScrollArrow side="left" visible={canScroll.left} label={row.title} onClick={() => scrollByPage(-1)} />
        <ScrollArrow side="right" visible={canScroll.right} label={row.title} onClick={() => scrollByPage(1)} />
      </div>
      {/* Details are for a mouse or keyboard: a touch screen's Top Picks
          is a carousel with no one card chosen. The hero keeps their room
          while another row has them, so the page below doesn't jump up
          under the pointer the moment it moves down to the next row (Home
          steadies the rest, see HomeRows). */}
      {(hero || showsDetails) && expands && (
        <div className="hidden min-h-[7rem] px-4 sm:px-6 desktop-input:block">
          {showsDetails && detailsItem && (
            <div key={openCardKey} className="home-fade">
              <HomeDetails item={detailsItem} films={films} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ExpandingCard({
  card,
  hero,
  open,
  onPointerEnter,
  onPointerLeave,
  onFocus,
}: {
  card: HomeCard;
  hero: boolean;
  open: boolean;
  onPointerEnter: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  onFocus: () => void;
}) {
  // Touch: the hero is all wide cards, the rest all posters. Mouse: wide
  // only when open.
  const width = hero ? `${WIDE_W} ${open ? "" : DESKTOP_POSTER_W}` : `${POSTER_W} ${open ? DESKTOP_WIDE_W : ""}`;
  // The wide layer is always there in the hero (it's what a touch screen
  // sees), hidden on a desktop while that card is a poster; elsewhere it's
  // only rendered once the card opens, so a row of forty posters doesn't
  // fetch forty backdrops.
  const wideLayer = hero || open;
  const wideVisibility = hero ? (open ? "" : "desktop-input:hidden") : "hidden desktop-input:block";
  const backdrop = card.backdropPath ?? card.posterPath;
  const backdropSize = card.backdropPath ? "w1280" : "w780";

  return (
    <Link
      href={card.href}
      aria-label={[card.title, ...card.badges].join(", ")}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onTransitionEnd={(e) => {
        if (e.propertyName === "width" && e.currentTarget === document.activeElement) revealFocused(e.currentTarget);
      }}
      className={`relative block h-[var(--row-h)] shrink-0 snap-start overflow-hidden rounded-xl bg-bg-elevated transition-[width,box-shadow] duration-300 ease-out motion-reduce:transition-none ${width} ${CARD_RING} ${
        open ? "shadow-xl shadow-black/60" : "shadow-md shadow-black/30"
      }`}
    >
      <div className={`absolute inset-0 ${hero ? "desktop-input:block hidden" : ""}`}>
        <PosterImage
          posterPath={card.posterPath}
          title={card.title}
          size={hero ? "w500" : "w342"}
          priority={hero}
          className="h-full w-full"
        />
      </div>
      {wideLayer && (
        <div className={`home-fade absolute inset-0 ${wideVisibility}`}>
          {backdrop && (
            <img
              src={`/api/poster/${backdropSize}${backdrop}`}
              alt=""
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-full w-full bg-bg-elevated object-cover"
            />
          )}
          <div className="absolute inset-0 bg-[linear-gradient(to_top_right,rgba(0,0,0,0.78),rgba(0,0,0,0.15)_55%,transparent)]" />
          <div className="absolute bottom-0 left-0 flex max-w-full flex-col items-start gap-[calc(var(--row-h)*0.04)] p-[calc(var(--row-h)*0.07)]">
            <TitleArt title={card.title} logoPath={card.logoPath} />
            {card.badges.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {card.badges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded-md bg-black/55 px-2 py-0.5 text-xs font-semibold text-white"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {card.progress !== null && (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
          <div className="h-full bg-accent" style={{ width: `${card.progress * 100}%` }} />
        </div>
      )}
    </Link>
  );
}

/** A card opened by the keyboard grows off the row's right edge, and its
 *  details can land below the fold: once it has finished growing, scroll
 *  the row along to the whole card and the page to the whole row. (The
 *  browser's own scroll-into-view on focus ran while it was a poster.) */
function revealFocused(card: HTMLElement) {
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  const scroller = card.parentElement;
  if (scroller) {
    const pad = parseFloat(getComputedStyle(scroller).scrollPaddingLeft) || 0;
    const c = card.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const overRight = c.right - (s.right - pad);
    const overLeft = c.left - (s.left + pad);
    if (overRight > 0) scroller.scrollBy({ left: Math.min(overRight, overLeft), behavior });
    else if (overLeft < 0) scroller.scrollBy({ left: overLeft, behavior });
  }
  card.closest("section")?.scrollIntoView({ block: "nearest", behavior });
}

/** New Shows: a poster with how many episodes you have under it. */
function PosterCard({ item, card }: { item: HomeItem; card: HomeCard }) {
  const episodes = item.kind === "show" ? item.show.ownedEpisodeCount : null;
  return (
    <Link href={card.href} className={`group/card flex shrink-0 flex-col gap-1.5 rounded-xl ${POSTER_W} focus-visible:outline-none`}>
      <PosterImage
        posterPath={card.posterPath}
        title={card.title}
        className={`h-[var(--row-h)] w-full rounded-xl shadow-md shadow-black/30 transition-shadow group-focus-visible/card:ring-2 group-focus-visible/card:ring-accent group-focus-visible/card:ring-offset-2 group-focus-visible/card:ring-offset-bg desktop-input:group-hover/card:ring-2 desktop-input:group-hover/card:ring-accent/70`}
      />
      <span className="line-clamp-1 text-sm font-semibold text-text">{card.title}</span>
      {episodes !== null && (
        <span className="-mt-1 font-mono text-xs text-text-faint">
          {episodes} episode{episodes === 1 ? "" : "s"}
        </span>
      )}
    </Link>
  );
}

/** New Music: a square cover, the album and its artist under it. */
function AlbumCard({ item, card }: { item: HomeItem; card: HomeCard }) {
  if (item.kind !== "album") return null;
  const { album } = item;
  return (
    <Link href={card.href} className={`group/card flex shrink-0 flex-col gap-1.5 rounded-xl ${POSTER_W} focus-visible:outline-none`}>
      <CoverImage
        albumId={album.hasCover ? album.id : null}
        version={album.coverVersion}
        title={album.title}
        className="w-full rounded-xl shadow-md shadow-black/30 group-focus-visible/card:ring-2 group-focus-visible/card:ring-accent group-focus-visible/card:ring-offset-2 group-focus-visible/card:ring-offset-bg desktop-input:group-hover/card:ring-2 desktop-input:group-hover/card:ring-accent/70"
      />
      <span className="line-clamp-1 text-sm font-semibold text-text">{album.title}</span>
      <span className="-mt-1 line-clamp-1 text-xs text-text-faint">
        {album.artistName}
        {album.year != null ? ` · ${album.year}` : ""}
      </span>
    </Link>
  );
}

function ScrollArrow({
  side,
  visible,
  label,
  onClick,
}: {
  side: "left" | "right";
  visible: boolean;
  label: string;
  onClick: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      // The cards are the keyboard's way along a row (each scrolls itself
      // into view as it takes focus); these are for the mouse.
      tabIndex={-1}
      aria-label={`Scroll ${label} ${side}`}
      onClick={onClick}
      className={`absolute inset-y-3 z-10 hidden w-12 items-center justify-center text-text opacity-0 transition-opacity desktop-input:flex ${
        visible ? "desktop-input:group-hover/row:opacity-100" : "pointer-events-none"
      } ${
        side === "left"
          ? "left-0 bg-gradient-to-r from-bg/90 to-transparent"
          : "right-0 bg-gradient-to-l from-bg/90 to-transparent"
      }`}
    >
      <Icon aria-hidden className="h-7 w-7 drop-shadow" />
    </button>
  );
}
