import { describe, expect, it } from "vitest";
import {
  ageInYears,
  ageLimitFor,
  ageLimitLabel,
  allowedCertificates,
  allowsCertificate,
  minimumAgeFor,
} from "./age-rating";

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("minimumAgeFor", () => {
  it("maps the BBFC certificates", () => {
    expect(minimumAgeFor("U")).toBe(0);
    expect(minimumAgeFor("PG")).toBe(0);
    expect(minimumAgeFor("12")).toBe(12);
    expect(minimumAgeFor("12A")).toBe(12);
    expect(minimumAgeFor("15")).toBe(15);
    expect(minimumAgeFor("18")).toBe(18);
    expect(minimumAgeFor("R18")).toBe(18);
  });

  it("ignores case and surrounding space", () => {
    expect(minimumAgeFor(" 12a ")).toBe(12);
    expect(minimumAgeFor("r18")).toBe(18);
  });

  it("is null for anything it doesn't recognise", () => {
    expect(minimumAgeFor(null)).toBeNull();
    expect(minimumAgeFor(undefined)).toBeNull();
    expect(minimumAgeFor("")).toBeNull();
    expect(minimumAgeFor("TV-MA")).toBeNull();
    expect(minimumAgeFor("NR")).toBeNull();
  });
});

describe("ageInYears", () => {
  it("counts whole years", () => {
    expect(ageInYears(utc("2014-03-02"), utc("2026-03-01"))).toBe(11);
  });

  it("counts the birthday itself", () => {
    expect(ageInYears(utc("2014-03-02"), utc("2026-03-02"))).toBe(12);
  });

  it("handles a later month and a later day in the same month", () => {
    expect(ageInYears(utc("2014-11-30"), utc("2026-09-20"))).toBe(11);
    expect(ageInYears(utc("2014-09-30"), utc("2026-09-20"))).toBe(11);
    expect(ageInYears(utc("2014-09-01"), utc("2026-09-20"))).toBe(12);
  });

  it("clamps a future date of birth to 0 rather than going negative", () => {
    expect(ageInYears(utc("2030-01-01"), utc("2026-09-20"))).toBe(0);
  });
});

describe("ageLimitFor", () => {
  it("is unrestricted with no date of birth", () => {
    expect(ageLimitFor(null)).toBe("unrestricted");
    expect(ageLimitFor(undefined)).toBe("unrestricted");
  });

  it("is the age in years with one", () => {
    expect(ageLimitFor(utc("2014-03-02"), utc("2026-09-20"))).toBe(12);
  });
});

describe("allowsCertificate", () => {
  it("lets an unrestricted viewer see everything, rating or not", () => {
    for (const cert of ["U", "18", "R18", null, "TV-MA"]) {
      expect(allowsCertificate("unrestricted", cert)).toBe(true);
    }
  });

  it("allows certificates at or below the viewer's age", () => {
    expect(allowsCertificate(12, "U")).toBe(true);
    expect(allowsCertificate(12, "PG")).toBe(true);
    expect(allowsCertificate(12, "12A")).toBe(true);
    expect(allowsCertificate(12, "12")).toBe(true);
  });

  it("blocks certificates above the viewer's age", () => {
    expect(allowsCertificate(12, "15")).toBe(false);
    expect(allowsCertificate(12, "18")).toBe(false);
    expect(allowsCertificate(12, "R18")).toBe(false);
    expect(allowsCertificate(17, "18")).toBe(false);
  });

  it("opens up as the viewer ages", () => {
    expect(allowsCertificate(15, "15")).toBe(true);
    expect(allowsCertificate(18, "18")).toBe(true);
    expect(allowsCertificate(18, "R18")).toBe(true);
  });

  it("fails safe on a missing or unknown certificate, at every age", () => {
    for (const age of [0, 7, 12, 15, 17, 99]) {
      expect(allowsCertificate(age, null)).toBe(false);
      expect(allowsCertificate(age, undefined)).toBe(false);
      expect(allowsCertificate(age, "")).toBe(false);
      expect(allowsCertificate(age, "TV-MA")).toBe(false);
      expect(allowsCertificate(age, "Unrated")).toBe(false);
    }
  });

  it("lets a newborn see U and PG and nothing else", () => {
    expect(allowedCertificates(0)).toEqual(["U", "PG"]);
  });
});

describe("ageLimitLabel", () => {
  it("describes an unrestricted member", () => {
    expect(ageLimitLabel("unrestricted")).toBe("No age restriction");
  });

  it("lists what a restricted member may see", () => {
    expect(ageLimitLabel(12)).toBe("12 years old — U, PG, 12A and 12");
    expect(ageLimitLabel(1)).toBe("1 year old — U and PG");
    expect(ageLimitLabel(18)).toBe("18 years old — U, PG, 12A, 12, 15, 18 and R18");
  });
});
