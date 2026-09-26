// What `/.well-known/apple-app-site-association` says (TVOS_PLAN.md,
// PASSKEYS_PLAN.md): which Apple apps may claim links to this site and
// share its web credentials. Apple fetches it itself — through its own CDN,
// with no session — when the app is installed, so it has to be public and
// plain JSON.
//
// `applinks`: the Apple TV's QR code is a `/device?user_code=…` link, and
// with this the phone's camera opens it in the MediaVault app (which can
// approve with the session it already has) rather than Safari.
// `webcredentials`: lets the app use passkeys registered on the web.

/** Team ID + bundle id of the iPhone/iPad app (MediaVault-Player project.yml). */
export const IOS_APP_ID = "2Y2TMF4L4P.com.markrwatts.mediavault";

export function appleAppSiteAssociation() {
  return {
    applinks: {
      details: [
        {
          appIDs: [IOS_APP_ID],
          components: [{ "/": "/device", comment: "Approve an Apple TV's sign-in" }],
        },
      ],
    },
    webcredentials: { apps: [IOS_APP_ID] },
  };
}
