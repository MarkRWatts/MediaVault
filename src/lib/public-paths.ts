// Pre-auth entry pages — reachable while signed out. Used by proxy.ts to
// decide which paths skip the session redirect. (Chrome — the sidebar /
// tab bar — is decided separately: components/shell/app-shell.tsx hides it
// whenever there's no session or no household, which already covers these
// paths, plus CHROMELESS_PATHS below for signed-in card pages.)
export const PUBLIC_PATHS = ["/signin", "/signup"];
export const PUBLIC_PATH_PREFIXES = ["/invite/"];

export function isPreAuthPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.includes(pathname) || PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

// Signed-in pages that still render as a bare card with no app chrome.
// /consent is the OIDC consent screen for Jellyfin SSO: the person is
// signed in and has a household, so AppShell's own no-session/no-household
// checks wouldn't catch it. Deliberately a SEPARATE list from PUBLIC_PATHS
// — adding a path here hides the nav, it does NOT make it reachable
// signed out.
export const CHROMELESS_PATHS = ["/consent"];

export function isChromelessPath(pathname: string): boolean {
  return CHROMELESS_PATHS.includes(pathname);
}
