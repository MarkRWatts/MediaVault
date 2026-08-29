import type { NextRequest } from "next/server";

// force=true/1 (query string ?force=1 or JSON body {"force":true}) ignores
// the size+mtime probe cache and re-probes every file — e.g. after adding a
// new ffprobe-derived field so existing rows pick it up. Plain POST with no
// body keeps working exactly as before (force defaults to false).
export async function readForceFlag(req: NextRequest): Promise<boolean> {
  const queryForce = req.nextUrl.searchParams.get("force");
  if (queryForce === "1" || queryForce === "true") return true;

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = await req.json();
      if (body && typeof body === "object" && "force" in body) {
        return Boolean((body as { force?: unknown }).force);
      }
    } catch {
      // no/invalid JSON body — treat as force=false
    }
  }
  return false;
}
