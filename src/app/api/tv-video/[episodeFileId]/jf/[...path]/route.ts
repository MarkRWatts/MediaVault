// GET /api/tv-video/:episodeFileId/jf/<playlist or segment>?…

import { jfProxy } from "@/lib/jf-routes";
import { jellyfinItemForEpisodeFile } from "@/lib/jf-viewer";

export async function GET(req: Request, ctx: { params: Promise<{ episodeFileId: string; path: string[] }> }) {
  const { episodeFileId, path } = await ctx.params;
  return jfProxy(req, episodeFileId, path, jellyfinItemForEpisodeFile);
}
