// What an action or route may echo back to the browser when something
// throws. BetterAuth's APIError messages are written for people ("You are
// not allowed to invite users to this organization") and are safe to show;
// anything else — Prisma constraint text, filesystem paths, upstream
// response bodies — is logged here and replaced with the caller's fallback.

import { APIError } from "better-auth/api";

/** Route-handler flavour: log the real error, return only the fallback.
 *  (Route handlers never throw BetterAuth APIErrors, so there is nothing
 *  worth passing through.) */
export function hideError(err: unknown, context: string, fallback = "Something went wrong — the app owner can find the details in the server logs."): string {
  console.error(`[${context}]`, err);
  return fallback;
}

export function userFacingError(err: unknown, fallback: string, context?: string): string {
  if (err instanceof APIError && typeof err.message === "string" && err.message.trim()) {
    return err.message;
  }
  console.error(`[${context ?? "action"}] ${fallback}:`, err);
  return fallback;
}
