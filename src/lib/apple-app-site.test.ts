import { describe, expect, it } from "vitest";
import { appleAppSiteAssociation, IOS_APP_ID } from "./apple-app-site";

describe("apple-app-site-association", () => {
  it("lets only the iOS app open /device links and share web credentials", () => {
    const aasa = appleAppSiteAssociation();
    expect(aasa.applinks.details).toEqual([
      { appIDs: [IOS_APP_ID], components: [expect.objectContaining({ "/": "/device" })] },
    ]);
    expect(aasa.webcredentials.apps).toEqual([IOS_APP_ID]);
    // Team ID, a dot, then the bundle id — Apple silently ignores anything else.
    expect(IOS_APP_ID).toMatch(/^[A-Z0-9]{10}\.[a-z0-9.]+$/);
  });
});
