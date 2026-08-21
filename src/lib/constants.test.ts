import { describe, expect, it } from "vitest";
import { classifyFormat, resolutionTier } from "./constants";

describe("classifyFormat", () => {
  it("classifies by width, including 4K", () => {
    expect(classifyFormat(3840)).toBe("UHD");
    expect(classifyFormat(4096)).toBe("UHD");
    expect(classifyFormat(1920)).toBe("BLURAY");
    expect(classifyFormat(1280)).toBe("BLURAY");
    expect(classifyFormat(720)).toBe("DVD");
    expect(classifyFormat(704)).toBe("DVD");
    expect(classifyFormat(null)).toBe("UNKNOWN");
  });
});

describe("resolutionTier", () => {
  it("labels tiers from width, tolerating letterbox-cropped heights", () => {
    expect(resolutionTier(3840, 1600)).toMatchObject({ label: "4K", rank: 0 });
    expect(resolutionTier(1920, 800)).toMatchObject({ label: "1080p" });
    expect(resolutionTier(1280, 720)).toMatchObject({ label: "720p" });
  });

  it("uses height for SD line-count labels", () => {
    expect(resolutionTier(720, 576).label).toBe("576p");
    expect(resolutionTier(720, 480).label).toBe("480p");
    expect(resolutionTier(720, 304).label).toBe("SD"); // cropped widescreen DVD
    expect(resolutionTier(null, null).label).toBe("?");
  });

  it("ranks best-first for comparisons", () => {
    expect(resolutionTier(3840, 2160).rank).toBeLessThan(resolutionTier(1920, 1080).rank);
    expect(resolutionTier(1920, 1080).rank).toBeLessThan(resolutionTier(720, 576).rank);
  });
});
