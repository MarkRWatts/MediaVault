// GET /api/video/:versionId/jf/<playlist or segment>?… — one playlist or
// segment for a film Version, from Jellyfin or the local engine depending
// on PLAYBACK_ENGINE (src/lib/jf-routes.ts).

import { jfProxy } from "@/lib/jf-routes";
import { jellyfinItemForVersion } from "@/lib/jf-viewer";

export async function GET(req: Request, ctx: { params: Promise<{ versionId: string; path: string[] }> }) {
  const { versionId, path } = await ctx.params;
  return jfProxy(req, versionId, path, jellyfinItemForVersion, "film");
}
