// GET /.well-known/apple-app-site-association — public on purpose (see
// src/proxy.ts and src/lib/apple-app-site.ts): Apple's CDN fetches it with
// no session. Served as JSON with no file extension, as Apple requires.

import { NextResponse } from "next/server";
import { appleAppSiteAssociation } from "@/lib/apple-app-site";

export function GET() {
  return NextResponse.json(appleAppSiteAssociation(), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
