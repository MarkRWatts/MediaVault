// BetterAuth's React client — Phase 2 of HOUSEHOLDS_PLAN.md. Pure plumbing:
// no client plugins yet (organization/emailOTP client extensions land in
// Phase 3 alongside their server-side plugin config in src/lib/auth.ts).
//
// No explicit baseURL: the client's default resolution falls back to this
// app's own "/api/auth" (relative to whatever origin the page is served
// from), which matches where the route handler is mounted in
// src/app/api/auth/[...all]/route.ts. That's correct for both local dev
// (port 3002) and prod without needing a NEXT_PUBLIC_ env var.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signOut, signUp, useSession } = authClient;
