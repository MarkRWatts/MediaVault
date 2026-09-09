// The MediaVault wordmark at the top of the card pages (sign in, sign up,
// invite, onboarding, consent) -- the app shell, and with it the logo, is
// not rendered on those routes (see components/shell/app-shell.tsx), so
// the card carries it itself.
export default function AuthLogo() {
  return (
    <img src="/logo.png" alt="MediaVault" className="h-10 w-auto" />
  );
}
