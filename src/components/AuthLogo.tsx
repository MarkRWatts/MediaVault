// The MediaVault wordmark at the top of the pre-auth cards (sign in, sign
// up, invite, consent) -- the nav, and with it the logo, is hidden on those
// routes (see layout.tsx / isPreAuthPath), so the card carries it itself.
export default function AuthLogo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static asset, same as Nav
    <img src="/logo.png" alt="MediaVault" className="h-10 w-auto" />
  );
}
