import assert from "node:assert/strict";
import test from "node:test";
import { withYtdlpSearchSlot, ytdlpSearchSlotStats } from "../../backend/services/downloadJobs/ytdlpSearchSlots.js";

test("limits simultaneous metadata searches and advances queued work", async () => {
  const previous = process.env.AURRAL_YTDLP_SEARCH_LIMIT;
  process.env.AURRAL_YTDLP_SEARCH_LIMIT = "1";
  try {
    let concurrent = 0;
    let peak = 0;
    const completed = [];
    const jobs = Array.from({ length: 4 }, (_, index) => withYtdlpSearchSlot(async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 8));
      completed.push(index);
      concurrent--;
    }));
    await Promise.all(jobs);
    assert.equal(peak, 1);
    assert.deepEqual(completed, [0, 1, 2, 3]);
    assert.equal(ytdlpSearchSlotStats().active, 0);
    assert.equal(ytdlpSearchSlotStats().waiting, 0);
  } finally {
    if (previous === undefined) delete process.env.AURRAL_YTDLP_SEARCH_LIMIT;
    else process.env.AURRAL_YTDLP_SEARCH_LIMIT = previous;
  }
});

test("releases a slot on failure", async () => {
  await assert.rejects(withYtdlpSearchSlot(async () => { throw new Error("test"); }), /test/);
  assert.equal(ytdlpSearchSlotStats().active, 0);
});
