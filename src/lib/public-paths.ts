// Pre-auth entry pages — reachable while signed out, and where the full app
// nav shouldn't render (there's nothing signed-in to navigate to yet).
// Shared between proxy.ts (which paths skip the session redirect) and
// layout.tsx (which paths skip rendering <Nav />), so the two never drift.
export const PUBLIC_PATHS = ["/signin", "/signup"];
export const PUBLIC_PATH_PREFIXES = ["/invite/"];

export function isPreAuthPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.includes(pathname) || PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}
