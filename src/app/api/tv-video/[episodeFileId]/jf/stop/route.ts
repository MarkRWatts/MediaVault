// POST /api/tv-video/:episodeFileId/jf/stop?playSessionId=…

import { jfStop } from "@/lib/jf-routes";

export async function POST(req: Request) {
  return jfStop(req);
}
