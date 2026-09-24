"use server";

// The one writer of FilmShowLink (prisma/schema.prisma): the app owner
// curating which films belong with which show — Serenity with Firefly, the
// 1994 Stargate with all three SG series. No scan or enrich pass touches
// this table, because TMDB has no movie-to-show relation to read it from.
//
// Both entry points start with requireOwner(); the show page only renders
// the control for the owner, but that is cosmetic and this is the
// enforcement (same posture as admin.ts).

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/require-member";
import { userFacingError } from "@/lib/user-facing-error";

export type FilmShowLinkState = { error?: string } | null;

function idFrom(formData: FormData, field: string): number | null {
  const value = Number(formData.get(field));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export async function linkFilmToShow(
  _prevState: FilmShowLinkState,
  formData: FormData,
): Promise<FilmShowLinkState> {
  await requireOwner();

  const filmId = idFrom(formData, "filmId");
  const showId = idFrom(formData, "showId");
  if (filmId === null) return { error: "Missing film." };
  if (showId === null) return { error: "Choose a show." };

  // A concert is a Film row browsed from Music and is never part of a
  // series; refusing here rather than in the picker keeps the rule with the
  // write. The show lookup is what turns a made-up id into an error instead
  // of a foreign-key crash.
  const film = await prisma.film.findUnique({ where: { id: filmId }, select: { kind: true } });
  if (!film) return { error: "No such film." };
  if (film.kind !== "FILM") return { error: "Concerts can't be linked to a show." };
  const show = await prisma.show.findUnique({ where: { id: showId }, select: { id: true } });
  if (!show) return { error: "No such show." };

  try {
    // Already linked is the harmless case — the picker can race a second
    // tab — so the unique constraint settles it quietly rather than erroring.
    await prisma.filmShowLink.upsert({
      where: { filmId_showId: { filmId, showId } },
      create: { filmId, showId },
      update: {},
    });
  } catch (err) {
    return { error: userFacingError(err, "Couldn't link that show.", "linkFilmToShow") };
  }

  revalidatePath(`/film/${filmId}`);
  revalidatePath(`/shows/${showId}`);
  return null;
}

export async function unlinkFilmFromShow(
  _prevState: FilmShowLinkState,
  formData: FormData,
): Promise<FilmShowLinkState> {
  await requireOwner();

  const filmId = idFrom(formData, "filmId");
  const showId = idFrom(formData, "showId");
  if (filmId === null || showId === null) return { error: "Missing film or show." };

  // deleteMany, not delete: removing a link that has already gone is the
  // outcome the person asked for, not an error.
  await prisma.filmShowLink.deleteMany({ where: { filmId, showId } });

  revalidatePath(`/film/${filmId}`);
  revalidatePath(`/shows/${showId}`);
  return null;
}
