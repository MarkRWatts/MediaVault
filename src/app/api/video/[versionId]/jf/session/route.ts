// POST /api/video/:versionId/jf/session?variant=original|remote[&audio=<streamIdx>]
// — start a Jellyfin playback session for a film Version (src/lib/jf-routes.ts).

import { jfSession } from "@/lib/jf-routes";
import { jellyfinItemForVersion } from "@/lib/jf-viewer";

export async function POST(req: Request, ctx: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await ctx.params;
  return jfSession(req, versionId, jellyfinItemForVersion, "/api/video");
}
