// Shared error mapping for /api/v1's mutation routes. The lib functions in
// music-user-state.ts / film-user-state.ts throw plain Errors for every
// validation failure (bad id, bad name, wrong owner, unplayable track) —
// exactly the messages the web's server actions already surface as form
// errors. A route handler can't let those fall through to Next's generic
// 500, so every mutation route wraps its lib call in try/catch and hands
// the caught error to this one place.

import { NextResponse } from "next/server";

// The lib layer deliberately uses one message for "doesn't exist" and
// "isn't yours" (see e.g. music-user-state.ts's ownedPlaylist) — telling
// them apart would confirm another person's id to an attacker. Matching on
// message text here, rather than a typed error, keeps the lib functions
// free of any API-specific error class while still letting the route pick
// the right status code.
const NOT_FOUND_PATTERNS = [/not found/i, /is not in this playlist/i];

/** Turn a thrown Error into the { error } JSON shape every /api/v1 route
 *  uses: 404 for a message that reads as "doesn't exist or isn't yours",
 *  400 for every other validation failure. */
export function apiV1Error(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "Unexpected error";
  const status = NOT_FOUND_PATTERNS.some((pattern) => pattern.test(message)) ? 404 : 400;
  return NextResponse.json({ error: message }, { status });
}
