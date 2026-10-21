import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const previous = process.env.AURRAL_PROVIDER_SCHEDULER;
const [isolated, { db }, scheduler] = await setupIsolatedBackend(
  "provider-stage-capacity",
  "backend/config/db-sqlite.js",
  "backend/services/downloadJobs/providerSchedulerRuntime.js",
);
process.env.AURRAL_PROVIDER_SCHEDULER = "1";
test.after(async () => {
  if (previous === undefined) delete process.env.AURRAL_PROVIDER_SCHEDULER;
  else process.env.AURRAL_PROVIDER_SCHEDULER = previous;
  await cleanupIsolatedState(isolated);
});

test("five active transfers do not consume search or finalize stage capacity", () => {
  const insert = db.prepare(`INSERT INTO download_provider_reservations
    (job_id, attempt_id, provider_id, created_at, updated_at, stage) VALUES (?, ?, ?, 1, 1, ?)`);
  for (const provider of ["slskd", "ytdlp"]) {
    for (let index = 0; index < 5; index++) {
      insert.run(`${provider}-${index}`, `attempt-${index}`, provider, "transfer");
    }
  }
  const transfers = scheduler.getProviderSchedulerCapacity("transfer");
  const searches = scheduler.getProviderSchedulerCapacity("search");
  const finalizing = scheduler.getProviderSchedulerCapacity("finalize");
  assert.equal(transfers.find((p) => p.id === "slskd").active, 5);
  assert.equal(transfers.find((p) => p.id === "ytdlp").active, 5);
  assert.equal(searches.find((p) => p.id === "slskd").active, 0);
  assert.equal(searches.find((p) => p.id === "ytdlp").active, 0);
  assert.equal(finalizing.find((p) => p.id === "ytdlp").active, 0);
  assert.equal(finalizing.find((p) => p.id === "ytdlp").maxActive, 2);
});

test("durable handoff releases search capacity but retains active remote polling", () => {
  db.prepare(`INSERT INTO download_provider_reservations
    (job_id, attempt_id, provider_id, created_at, updated_at, stage)
    VALUES ('handoff-job', 'attempt', 'slskd', 1, 1, 'search')`).run();
  assert.equal(scheduler.parkPipelineProvider({
    jobId: "handoff-job", downloadAttemptId: "attempt", source: "slskd", phase: "search",
  }, { phase: "download", downloadAttemptId: "attempt" }), 1);
  let row = db.prepare("SELECT stage FROM download_provider_reservations WHERE job_id = 'handoff-job'").get();
  assert.equal(row.stage, "waiting");
  db.prepare("UPDATE download_provider_reservations SET stage = 'transfer' WHERE job_id = 'handoff-job'").run();
  assert.equal(scheduler.parkPipelineProvider({
    jobId: "handoff-job", downloadAttemptId: "attempt", source: "slskd", phase: "download",
  }, { phase: "poll", downloadAttemptId: "attempt" }), 0);
  row = db.prepare("SELECT stage FROM download_provider_reservations WHERE job_id = 'handoff-job'").get();
  assert.equal(row.stage, "transfer");
  assert.equal(scheduler.releasePipelineProvider({
    jobId: "handoff-job", downloadAttemptId: "attempt",
  }), 1);
});
