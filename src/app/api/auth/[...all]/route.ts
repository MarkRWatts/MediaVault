// Mounts BetterAuth's own request handler at /api/auth/* — Phase 2 of
// HOUSEHOLDS_PLAN.md. Pure plumbing: no plugins/gating live in src/lib/auth.ts
// yet (that's Phase 3), so today this just exposes whatever the bare
// betterAuth() config from Phase 1 already supports.
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
