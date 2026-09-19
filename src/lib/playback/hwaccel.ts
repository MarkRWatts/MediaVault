// The hardware switch (V4_PLAN.md, "Hardware switch"): PLAYBACK_HWACCEL
// selects the argument-builder pipeline, and one tiny real encode decides
// whether that selection is honoured.
//
// The self-test exists because every way hardware encoding fails in
// production is a *deployment* fault, not a content fault: a missing
// /dev/dri/renderD128 in the container, the render group id not added to the
// app user, a driver that loads but can't reach VAEntrypointEncSlice. All of
// them look identical from the engine -- ffmpeg exits non-zero on the first
// head of the evening, for every title, until someone reads a log. So the
// first thing that asks for hardware runs a ~1s testsrc encode through the
// exact device flags a head would use; if that fails the engine logs why,
// permanently falls back to "none" (software libx264 still plays everything,
// just slower) and says so on the admin page. A misconfigured GPU degrades
// playback; it must not break it.

import { spawn } from "node:child_process";
import { ffmpegPath } from "@/lib/ffmpeg-bin";
import { DEFAULT_RENDER_DEVICE } from "./head-args";
import type { HwAccel } from "./types";

const HWACCELS: readonly HwAccel[] = ["none", "vaapi", "qsv"];

/** PLAYBACK_HWACCEL, default "none". An unrecognised value is "none" with a
 *  log line rather than a crash -- a typo in an env file must not take
 *  playback down. */
export function configuredHwAccel(): HwAccel {
  const raw = (process.env.PLAYBACK_HWACCEL ?? "").trim().toLowerCase();
  if (raw === "") return "none";
  if ((HWACCELS as readonly string[]).includes(raw)) return raw as HwAccel;
  console.warn(`[playback] PLAYBACK_HWACCEL="${raw}" is not one of ${HWACCELS.join("|")}; using none`);
  return "none";
}

export interface HwAccelStatus {
  /** What PLAYBACK_HWACCEL asks for. */
  configured: HwAccel;
  /** What the engine will actually use; null until the self-test has run. */
  effective: HwAccel | null;
  /** Why `effective` differs from `configured`, for the admin page. */
  reason: string | null;
  testedAt: number | null;
}

// The self-test result is process-wide and permanent: a render node that
// isn't there at boot isn't going to appear, and re-testing per head would
// add a second of latency to the failure case it is meant to remove.
let selfTest: Promise<HwAccel> | null = null;
let status: HwAccelStatus = { configured: "none", effective: null, reason: null, testedAt: null };

/** How long the probe encode is given. It encodes five 320x240 frames; a
 *  second is generous, and a device that hangs rather than failing must not
 *  hold the first play of the evening open indefinitely. */
const SELF_TEST_TIMEOUT_MS = 15_000;

/** The probe encode, with the same device flag a head would pass. The
 *  `format=nv12,hwupload` filter is the 10-bit fallback path from
 *  head-args.ts, which is also the simplest way to hand software-generated
 *  frames to a hardware encoder -- it exercises the device, the driver and
 *  the encoder entry point in one go without needing a real file. */
export function selfTestArgs(hwaccel: "vaapi" | "qsv", renderDevice = DEFAULT_RENDER_DEVICE): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    hwaccel === "vaapi" ? "-vaapi_device" : "-qsv_device",
    renderDevice,
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=0.2:size=320x240:rate=25",
    "-vf",
    "format=nv12,hwupload",
    "-c:v",
    hwaccel === "vaapi" ? "h264_vaapi" : "h264_qsv",
    "-f",
    "null",
    "-",
  ];
}

function runSelfTest(hwaccel: "vaapi" | "qsv"): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), selfTestArgs(hwaccel), { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, `the ${hwaccel} self-test did not finish within ${SELF_TEST_TIMEOUT_MS / 1000}s`);
    }, SELF_TEST_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => finish(false, `could not run ffmpeg: ${err.message}`));
    child.on("close", (code) => {
      const detail = stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ");
      finish(code === 0, detail || `ffmpeg exited ${code}`);
    });
  });
}

/**
 * The hardware pipeline this process will use. Runs the self-test once, on
 * first call, and caches the answer (including the fallback) for the life of
 * the process. Never throws: the worst case is "none".
 */
export function resolveHwAccel(): Promise<HwAccel> {
  if (selfTest) return selfTest;
  const configured = configuredHwAccel();
  status = { configured, effective: null, reason: null, testedAt: null };

  if (configured === "none") {
    status = { configured, effective: "none", reason: null, testedAt: Date.now() };
    selfTest = Promise.resolve<HwAccel>("none");
    return selfTest;
  }

  selfTest = runSelfTest(configured).then(({ ok, detail }) => {
    if (ok) {
      status = { configured, effective: configured, reason: null, testedAt: Date.now() };
      console.log(`[playback] hardware ${configured} self-test passed`);
      return configured;
    }
    const reason = `${configured} is configured but its self-test failed: ${detail}`;
    status = { configured, effective: "none", reason, testedAt: Date.now() };
    console.warn(`[playback] ${reason} -- falling back to software encoding`);
    return "none" as HwAccel;
  });
  return selfTest;
}

/** Synchronous snapshot for the admin page. `effective` is null until the
 *  first play has forced the self-test. */
export function hwAccelStatus(): HwAccelStatus {
  return { ...status };
}

/** Tests only: forget the cached self-test so a different PLAYBACK_HWACCEL
 *  can be exercised in the same process. */
export function resetHwAccelForTest(): void {
  selfTest = null;
  status = { configured: "none", effective: null, reason: null, testedAt: null };
}
