// Sign-in for devices with no keyboard worth typing on — the Apple TV app
// (TVOS_PLAN.md "Sign-in: scan a QR code with your phone"). BetterAuth's
// deviceAuthorization plugin (RFC 8628) does the work: the TV asks
// /api/auth/device/code for a code and shows it as a QR code, a signed-in
// member opens the /device link on their phone and approves it, and the TV
// collects its own session from /api/auth/device/token.
//
// This file is the closed list of clients allowed to start that flow, and
// the plain names /device shows for them. Anything not listed gets
// `invalid_client` from the plugin before a code is ever minted.

export const DEVICE_CLIENTS: Readonly<Record<string, string>> = {
  "mediavault-tvos": "MediaVault on Apple TV",
};

export function isDeviceClient(clientId: string): boolean {
  return Object.hasOwn(DEVICE_CLIENTS, clientId);
}

/** What /device calls the thing asking to be signed in. */
export function deviceClientName(clientId: string | null | undefined): string {
  return (clientId && DEVICE_CLIENTS[clientId]) || "A device";
}

/** How long a code on the TV stays usable. Short: it only has to last
 *  from the QR code appearing to someone picking up their phone, and a
 *  code photographed off the screen stops being worth anything soon. */
export const DEVICE_CODE_LIFETIME = "10m";

/** The user code as the TV shows it, `ABCD-EFGH`, so the phone's prompt
 *  reads the same as the screen it's being compared against. Stored and
 *  matched without the dash (the plugin normalises either form). */
export function formatUserCode(code: string): string {
  const bare = code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare;
}
