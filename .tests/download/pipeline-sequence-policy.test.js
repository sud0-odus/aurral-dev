import assert from "node:assert/strict";
import test from "node:test";
import { pipelineSequenceFor, pipelineAttemptKey, nextPipelinePayload, isEarlierPipelinePayload } from "../../backend/services/downloadJobs/pipelineSequencePolicy.js";

test("a durable continuation supersedes an abandoned earlier stage", () => {
  const original = { jobId: "track1", downloadAttemptId: "attemptA", phase: "download" };
  const next = nextPipelinePayload(original);
  assert.equal(next.pipelineSequence, 1);
  assert.equal(isEarlierPipelinePayload(original, next.pipelineSequence), true);
  assert.equal(isEarlierPipelinePayload(next, next.pipelineSequence), false);
  assert.equal(nextPipelinePayload(next).pipelineSequence, 2);
});
test("attempt fences isolate retries and never use invalid sequence values", () => {
  assert.notEqual(pipelineAttemptKey({ jobId:"track1", downloadAttemptId:"a" }),
    pipelineAttemptKey({ jobId:"track1", downloadAttemptId:"b" }));
  assert.equal(pipelineSequenceFor({ pipelineSequence:-2 }), 0);
  assert.equal(pipelineSequenceFor({ pipelineSequence:"invalid" }), 0);
  assert.equal(pipelineAttemptKey({ jobId:"track1" }), null);
});
