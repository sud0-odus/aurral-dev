import assert from "node:assert/strict";
import test from "node:test";
import { planProviderDispatch } from "../../backend/services/downloadJobs/providerSchedulerPolicy.js";

for (const id of ["ytdlp", "slskd"]) {
  test(`dispatch up to five eligible ${id} transfers without overbooking`, () => {
    const jobs = Array.from({ length: 7 }, (_, index) => ({
      id: `${id}-job-${index}`, state: "queued", playlistId: "test",
      allowedSources: [id],
    }));
    const providers = [{ id, enabled: true, configured: true, priority: 1,
      maxActive: 5, active: 0 }];
    const result = planProviderDispatch({ jobs, providers });
    assert.equal(result.assignments.length, 5);
    assert.equal(result.deferredJobIds.length, 2);
    assert.equal(result.providers[0].active, 5);
    assert.equal(result.providers[0].available, 0);
    assert.equal(new Set(result.assignments.map((x) => x.jobId)).size, 5);
  });
}
test("occupied provider capacity does not exceed the limit", () => {
  const result = planProviderDispatch({
    jobs: Array.from({ length: 5 }, (_, i) => ({
      id: `job-${i}`, state: "queued", allowedSources: ["ytdlp"],
    })),
    providers: [{ id: "ytdlp", enabled: true, maxActive: 5, active: 3 }],
  });
  assert.equal(result.assignments.length, 2);
  assert.equal(result.deferredJobIds.length, 3);
});
