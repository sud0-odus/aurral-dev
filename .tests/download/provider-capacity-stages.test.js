import test from "node:test";
import assert from "node:assert/strict";
import { pipelineCapacityStage, retainRemoteTransferReservation } from "../../backend/services/downloadJobs/pipelineCapacityStages.js";

test("search, transfer and finalization have separate capacity", () => {
  for (const phase of ["search", null]) assert.equal(pipelineCapacityStage(phase), "search");
  for (const phase of ["download", "poll"]) assert.equal(pipelineCapacityStage(phase), "transfer");
  assert.equal(pipelineCapacityStage("finalize"), "finalize");
});
test("remote transfers retain their lane through polling, not finalization", () => {
  for (const source of ["slskd", "usenet"]) {
    const job = { source, phase: "download", downloadAttemptId: "a" };
    assert.equal(retainRemoteTransferReservation(job, { phase: "poll", downloadAttemptId: "a" }), true);
    assert.equal(retainRemoteTransferReservation(job, { phase: "finalize", downloadAttemptId: "a" }), false);
    assert.equal(retainRemoteTransferReservation(job, { phase: "poll", downloadAttemptId: "b" }), false);
  }
});
test("search releases capacity before download", () => {
  assert.equal(retainRemoteTransferReservation({ source: "slskd", phase: "search", downloadAttemptId: "a" }, { phase: "download", downloadAttemptId: "a" }), false);
});
