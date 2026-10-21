import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundEncodeSlots } from "../../backend/services/downloadJobs/backgroundEncodeSlots.js";

test("limits concurrent conversions and releases capacity in FIFO order", async () => {
  const slots = new BackgroundEncodeSlots(2);
  const first = await slots.acquire();
  const second = await slots.acquire();
  const seen = [];
  const third = slots.acquire().then((release) => { seen.push("third"); return release; });
  const fourth = slots.acquire().then((release) => { seen.push("fourth"); return release; });
  assert.deepEqual(slots.stats, { limit: 2, active: 2, waiting: 2 });
  first();
  const releaseThird = await third;
  assert.deepEqual(seen, ["third"]);
  second();
  const releaseFourth = await fourth;
  assert.deepEqual(seen, ["third", "fourth"]);
  releaseThird();
  releaseFourth();
  releaseFourth();
  assert.equal(slots.stats.active, 0);
});

test("cancelled waiter is removed without taking capacity", async () => {
  const slots = new BackgroundEncodeSlots(1);
  const release = await slots.acquire();
  const controller = new AbortController();
  const pending = slots.acquire({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(slots.stats.waiting, 0);
  release();
  assert.equal(slots.stats.active, 0);
});

test("already-aborted requests do not enter the queue", async () => {
  const slots = new BackgroundEncodeSlots(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(slots.acquire({ signal: controller.signal }), /cancelled/);
  assert.deepEqual(slots.stats, { limit: 1, active: 0, waiting: 0 });
});

test("run releases a slot on failure, and cancellation after grant", async () => {
  const slots = new BackgroundEncodeSlots(1);
  await assert.rejects(slots.run(async () => { throw Error("encode failed"); }), /encode failed/);
  assert.equal(slots.stats.active, 0);
  const release = await slots.acquire();
  const controller = new AbortController();
  const run = slots.run(async () => assert.fail("must not start aborted conversion"), { signal: controller.signal });
  release();
  controller.abort();
  await assert.rejects(run, (error) => error.name === "AbortError");
  assert.equal(slots.stats.active, 0);
});

test("rejects invalid limits", () => {
  for (const limit of [0, -1, NaN, 1.5, Infinity]) {
    assert.throws(() => new BackgroundEncodeSlots(limit), RangeError);
  }
});
