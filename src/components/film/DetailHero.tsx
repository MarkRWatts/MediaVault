// The top of a film's or a show's page — one layout for both, so the two read
// as one app (FILM_PAGE_PLAN.md and SHOW_PAGE_PLAN.md "Top" and "Hero"): the
// backdrop full bleed, fading into the page, with the floating Back and the
// owner's ⋯ over it and the TMDB title logo centred in its fade; the
// details — chips, quiet line, actions, synopsis — come in as children.
//
// A phone: a short hero, everything centred below it. A wide screen (xl):
// the backdrop at its own 16:9 shape — a 45%-tall strip across a 1440p
// window cropped it into a close-up — with the title and the details over
// its lower left, as on the Apple TV.

import type { ReactNode } from "react";
import BackButton from "@/components/film/BackButton";
import TitleArt from "@/components/home/TitleArt";

export default function DetailHero({
  title,
  logoPath,
  backdropPath,
  posterPath,
  back,
  menu,
  children,
}: {
  title: string;
  logoPath: string | null;
  backdropPath: string | null;
  posterPath: string | null;
  /** Where Back goes when there's no earlier page in this tab to go back to. */
  back: { fallbackHref: string; label: string };
  /** The owner's ⋯, or nothing. */
  menu?: ReactNode;
  children: ReactNode;
}) {
  // With no backdrop, the poster stands in, blurred and darkened.
  const heroImage = backdropPath
    ? {
        src: `/api/poster/w1280${backdropPath}`,
        className: "object-cover xl:object-top",
      }
    : posterPath
      ? {
          src: `/api/poster/w780${posterPath}`,
          className: "scale-110 object-cover blur-2xl brightness-50",
        }
      : null;

  return (
    <div className="relative">
      <div className="relative">
        <div className="relative h-[45svh] max-h-[34rem] min-h-72 w-full overflow-hidden bg-bg-elevated xl:aspect-video xl:h-auto xl:max-h-[85svh] xl:min-h-[38rem]">
          {heroImage && (
            <img
              src={heroImage.src}
              alt=""
              fetchPriority="high"
              decoding="async"
              className={`absolute inset-0 h-full w-full ${heroImage.className}`}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent via-40% to-bg" />
          <div className="absolute inset-0 hidden bg-gradient-to-r from-bg via-bg/70 via-30% to-transparent to-65% xl:block" />
        </div>

        <div className="absolute inset-x-0 top-0 flex items-center justify-between px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-5">
          <BackButton fallbackHref={back.fallbackHref} label={back.label} />
          {menu}
        </div>

        <div className="absolute inset-x-0 bottom-2 flex justify-center px-4 xl:hidden">
          <TitleArt title={title} logoPath={logoPath} variant="hero" />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-5 px-4 pt-4 sm:px-6 xl:absolute xl:bottom-0 xl:left-0 xl:mx-0 xl:w-[min(38rem,48%)] xl:max-w-none xl:items-start xl:px-12 xl:pb-12 xl:pt-0">
        <div className="hidden w-full xl:block">
          <TitleArt title={title} logoPath={logoPath} variant="hero" />
        </div>
        {children}
      </div>
    </div>
  );
}
