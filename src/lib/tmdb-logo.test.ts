import { describe, expect, it } from "vitest";
import { pickLogo } from "./tmdb";

describe("pickLogo", () => {
  it("takes the best-voted English PNG", () => {
    const images = {
      logos: [
        { file_path: "/fr.png", iso_639_1: "fr", vote_average: 9 },
        { file_path: "/en-low.png", iso_639_1: "en", vote_average: 3 },
        { file_path: "/en-high.png", iso_639_1: "en", vote_average: 5.4 },
        { file_path: "/neutral.png", iso_639_1: null, vote_average: 8 },
      ],
    };
    expect(pickLogo(images)).toBe("/en-high.png");
  });

  it("falls back to a language-neutral logo when there's no English one", () => {
    expect(pickLogo({ logos: [{ file_path: "/neutral.png", iso_639_1: null, vote_average: 1 }] })).toBe("/neutral.png");
  });

  it("skips SVGs, which the poster route can't serve", () => {
    expect(pickLogo({ logos: [{ file_path: "/vector.svg", iso_639_1: "en", vote_average: 10 }] })).toBeNull();
  });

  it("is null without logos or without the append at all", () => {
    expect(pickLogo({ logos: [] })).toBeNull();
    expect(pickLogo(undefined)).toBeNull();
  });
});
