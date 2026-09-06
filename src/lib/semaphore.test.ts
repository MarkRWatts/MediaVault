import { describe, expect, it } from "vitest";
import { Semaphore, SemaphoreFullError } from "./semaphore";

describe("Semaphore", () => {
  it("hands out up to `limit` slots and refuses the rest with tryAcquire", () => {
    const s = new Semaphore(2);
    const a = s.tryAcquire();
    const b = s.tryAcquire();
    expect(a && b).toBeTruthy();
    expect(s.tryAcquire()).toBeNull();
    a!();
    expect(s.tryAcquire()).not.toBeNull();
  });

  it("acquire() waits for a slot and wakes waiters in order", async () => {
    const s = new Semaphore(1);
    const first = await s.acquire();
    const order: string[] = [];
    const p2 = s.acquire().then((r) => { order.push("second"); return r; });
    const p3 = s.acquire().then((r) => { order.push("third"); return r; });
    expect(s.queued).toBe(2);
    first();
    const r2 = await p2;
    expect(order).toEqual(["second"]);
    r2();
    await p3;
    expect(order).toEqual(["second", "third"]);
    expect(s.inUse).toBe(1);
  });

  it("refuses immediately once the queue is full", async () => {
    const s = new Semaphore(1, 1);
    const held = await s.acquire();
    const waiting = s.acquire(); // fills the one queue slot
    await expect(s.acquire()).rejects.toBeInstanceOf(SemaphoreFullError);
    held();
    (await waiting)();
  });

  it("release is idempotent", () => {
    const s = new Semaphore(1);
    const r = s.tryAcquire()!;
    r();
    r();
    expect(s.inUse).toBe(0);
    expect(s.tryAcquire()).not.toBeNull();
    expect(s.tryAcquire()).toBeNull();
  });
});
