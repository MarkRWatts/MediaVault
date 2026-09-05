import { describe, expect, it } from "vitest";
import { ukCertification, ukTvRating } from "./tmdb";

describe("ukCertification", () => {
  it("takes the first non-empty GB certificate from release_dates", () => {
    const details = {
      release_dates: {
        results: [
          { iso_3166_1: "US", release_dates: [{ certification: "PG-13" }] },
          { iso_3166_1: "GB", release_dates: [{ certification: "" }, { certification: "12A" }, { certification: "12" }] },
        ],
      },
    };
    expect(ukCertification(details)).toBe("12A");
  });

  it("is null without a GB entry or without the append at all", () => {
    expect(ukCertification({ release_dates: { results: [{ iso_3166_1: "US", release_dates: [{ certification: "R" }] }] } })).toBeNull();
    expect(ukCertification({})).toBeNull();
    expect(ukCertification(null)).toBeNull();
  });
});

describe("ukTvRating", () => {
  it("reads the GB content rating", () => {
    expect(ukTvRating({ content_ratings: { results: [{ iso_3166_1: "US", rating: "TV-MA" }, { iso_3166_1: "GB", rating: "15" }] } })).toBe("15");
    expect(ukTvRating({ content_ratings: { results: [{ iso_3166_1: "GB", rating: "" }] } })).toBeNull();
    expect(ukTvRating({})).toBeNull();
  });
});
