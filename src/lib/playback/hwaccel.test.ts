// The pure halves of the hardware switch: reading PLAYBACK_HWACCEL, and the
// argument line the self-test runs. The self-test itself spawns ffmpeg and
// is covered by engine.integration.test.ts, which asserts the documented
// behaviour on a machine with no render node -- a clean fallback to
// software, never a failed play.
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredHwAccel, selfTestArgs } from "./hwaccel";

afterEach(() => {
  delete process.env.PLAYBACK_HWACCEL;
  vi.restoreAllMocks();
});

describe("configuredHwAccel", () => {
  it("defaults to software when unset or empty", () => {
    delete process.env.PLAYBACK_HWACCEL;
    expect(configuredHwAccel()).toBe("none");
    process.env.PLAYBACK_HWACCEL = "";
    expect(configuredHwAccel()).toBe("none");
  });

  it("accepts the three documented values, case and whitespace insensitively", () => {
    process.env.PLAYBACK_HWACCEL = "vaapi";
    expect(configuredHwAccel()).toBe("vaapi");
    process.env.PLAYBACK_HWACCEL = " QSV ";
    expect(configuredHwAccel()).toBe("qsv");
  });

  it("falls back to software with a warning rather than crashing on a typo", () => {
    // An env-file mistake must degrade playback, not take it down.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.PLAYBACK_HWACCEL = "vappi";
    expect(configuredHwAccel()).toBe("none");
    expect(warn).toHaveBeenCalled();
  });
});

describe("selfTestArgs", () => {
  it("passes the same device flag a head would, and encodes with the real encoder", () => {
    const args = selfTestArgs("vaapi", "/dev/dri/renderD129");
    expect(args).toContain("-vaapi_device");
    expect(args[args.indexOf("-vaapi_device") + 1]).toBe("/dev/dri/renderD129");
    expect(args).toContain("h264_vaapi");
    // Uploading software frames is what proves the device, the driver and
    // the encoder entry point are all actually reachable.
    expect(args[args.indexOf("-vf") + 1]).toBe("format=nv12,hwupload");
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("uses the qsv device flag and encoder for qsv", () => {
    const args = selfTestArgs("qsv");
    expect(args).toContain("-qsv_device");
    expect(args).toContain("h264_qsv");
    expect(args).not.toContain("-vaapi_device");
  });

  it("encodes a fraction of a second -- this runs on the first play of the evening", () => {
    const input = selfTestArgs("vaapi")[selfTestArgs("vaapi").indexOf("-i") + 1];
    expect(input).toMatch(/^testsrc=duration=0\.\d+:/);
  });
});
