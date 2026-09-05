import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTailingStream } from "./tailing-stream";

async function collect(stream: ReturnType<typeof createTailingStream>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createTailingStream", () => {
  it("reads a file that's already complete, same as a plain read", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tailing-"));
    const file = path.join(dir, "out.bin");
    await writeFile(file, "hello world");

    const stream = createTailingStream(file, { isDone: () => true, hasErrored: () => null });
    const result = await collect(stream);

    expect(result.toString()).toBe("hello world");
    await rm(dir, { recursive: true, force: true });
  });

  it("waits for more bytes instead of ending when the writer isn't done yet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tailing-"));
    const file = path.join(dir, "out.bin");
    await writeFile(file, "first-");

    let done = false;
    const stream = createTailingStream(file, {
      isDone: () => done,
      hasErrored: () => null,
      pollIntervalMs: 20,
    });
    const collected = collect(stream);

    // Append more after the reader has already hit the initial EOF once.
    await sleep(60);
    await appendFile(file, "second-");
    await sleep(60);
    await appendFile(file, "third");
    done = true;

    const result = await collected;
    expect(result.toString()).toBe("first-second-third");
    await rm(dir, { recursive: true, force: true });
  });

  it("ends the stream with an error once hasErrored reports one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tailing-"));
    const file = path.join(dir, "out.bin");
    await writeFile(file, "partial");

    const stream = createTailingStream(file, {
      isDone: () => false,
      hasErrored: () => "ffmpeg exploded",
      pollIntervalMs: 20,
    });

    await expect(collect(stream)).rejects.toThrow("ffmpeg exploded");
    await rm(dir, { recursive: true, force: true });
  });

  // A job that finishes normally is removed from the caller's job table,
  // which its hasErrored callback reports as "stopped" -- so done must win
  // whenever both are true, or every successful prepare would end its
  // live viewer's stream with an error at the last byte.
  it("ends cleanly when the file is done, even if hasErrored would also report something", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tailing-"));
    const file = path.join(dir, "out.bin");
    await writeFile(file, "complete");

    const stream = createTailingStream(file, {
      isDone: () => true,
      hasErrored: () => "job no longer running",
    });
    const result = await collect(stream);

    expect(result.toString()).toBe("complete");
    await rm(dir, { recursive: true, force: true });
  });

  it("honours a non-zero start offset", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tailing-"));
    const file = path.join(dir, "out.bin");
    await writeFile(file, "0123456789");

    const stream = createTailingStream(file, { start: 5, isDone: () => true, hasErrored: () => null });
    const result = await collect(stream);

    expect(result.toString()).toBe("56789");
    await rm(dir, { recursive: true, force: true });
  });
});
