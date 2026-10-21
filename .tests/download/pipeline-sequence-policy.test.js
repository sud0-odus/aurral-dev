import assert from "node:assert/strict";
import test from "node:test";

// The sequence policy itself uses no storage and cannot erase a different
// attempt; the integration guard verifies this against persisted Honker steps.
function superseded(current, latest) {
  return current.jobId === latest.jobId
    && current.downloadAttemptId === latest.downloadAttemptId
    && Number(current.pipelineSequence || 0) < Number(latest.pipelineSequence || 0);
}
test("a later stage replaces an abandoned claim for the same attempt", () => {
  assert.equal(superseded({ jobId:"job", downloadAttemptId:"a", pipelineSequence:0 },
    { jobId:"job", downloadAttemptId:"a", pipelineSequence:1 }), true);
  assert.equal(superseded({ jobId:"job", downloadAttemptId:"a", pipelineSequence:1 },
    { jobId:"job", downloadAttemptId:"a", pipelineSequence:1 }), false);
  assert.equal(superseded({ jobId:"job", downloadAttemptId:"new", pipelineSequence:0 },
    { jobId:"job", downloadAttemptId:"old", pipelineSequence:9 }), false);
});
