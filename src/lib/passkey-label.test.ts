import { describe, expect, it } from "vitest";
import { suggestPasskeyName } from "@/lib/passkey-label";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
};

describe("suggestPasskeyName", () => {
  it("names Apple devices", () => {
    expect(suggestPasskeyName(UA.iphone)).toBe("iPhone");
    expect(suggestPasskeyName(UA.ipad)).toBe("iPad");
    expect(suggestPasskeyName(UA.mac)).toBe("Mac");
  });

  it("names Windows, Android, ChromeOS and Linux", () => {
    expect(suggestPasskeyName(UA.windows)).toBe("Windows PC");
    expect(suggestPasskeyName(UA.chromeos)).toBe("Chromebook");
    expect(suggestPasskeyName(UA.linux)).toBe("Linux");
  });

  it("prefers Android over the Linux its user-agent also mentions", () => {
    expect(suggestPasskeyName(UA.android)).toBe("Android");
  });

  it("falls back for unknown or missing user-agents", () => {
    expect(suggestPasskeyName("curl/8.0")).toBe("This device");
    expect(suggestPasskeyName("")).toBe("This device");
    expect(suggestPasskeyName(null)).toBe("This device");
    expect(suggestPasskeyName(undefined)).toBe("This device");
  });
});
