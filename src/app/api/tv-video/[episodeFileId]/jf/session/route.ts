// POST /api/tv-video/:episodeFileId/jf/session — the episode twin of the film
// route (src/lib/jf-routes.ts).

import { jfSession } from "@/lib/jf-routes";
import { jellyfinItemForEpisodeFile } from "@/lib/jf-viewer";

export async function POST(req: Request, ctx: { params: Promise<{ episodeFileId: string }> }) {
  const { episodeFileId } = await ctx.params;
  return jfSession(req, episodeFileId, jellyfinItemForEpisodeFile, "/api/tv-video");
}
