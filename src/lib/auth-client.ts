// BetterAuth's React client — Phase 2 of HOUSEHOLDS_PLAN.md. The only
// client plugin is passkeys (PASSKEYS_PLAN.md): the WebAuthn ceremony is a
// browser API, so sign-in-with-passkey and add-a-passkey have to be driven
// from client components via this client, unlike the OTP flow's server
// actions. organization/emailOTP need no client extension — every call to
// them goes through server actions.
//
// No explicit baseURL: the client's default resolution falls back to this
// app's own "/api/auth" (relative to whatever origin the page is served
// from), which matches where the route handler is mounted in
// src/app/api/auth/[...all]/route.ts. That's correct for both local dev
// (port 3002) and prod without needing a NEXT_PUBLIC_ env var.
import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({ plugins: [passkeyClient()] });

export const { signIn, signOut, signUp, useSession } = authClient;
