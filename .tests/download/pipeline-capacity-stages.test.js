import assert from "node:assert/strict";
import test from "node:test";
import { capacityStageForPayload, holdsRemoteTransferAcrossHandoff } from "../../backend/services/downloadJobs/pipelineCapacityStages.js";

test("search, real transfers, remote polling and import are distinct capacity stages", () => {
  assert.equal(capacityStageForPayload({ phase: "search" }), "search");
  assert.equal(capacityStageForPayload({ phase: "download" }), "transfer");
  assert.equal(capacityStageForPayload({ phase: "poll" }), "transfer");
  assert.equal(capacityStageForPayload({ phase: "finalize" }), "finalize");
});
test("hold remote transfer lease through polling only for same attempt and provider", () => {
  const base = { phase: "download", source: "slskd", downloadAttemptId: "a" };
  assert.equal(holdsRemoteTransferAcrossHandoff(base, { ...base, phase: "poll" }), true);
  assert.equal(holdsRemoteTransferAcrossHandoff(base, { ...base, phase: "finalize" }), false);
  assert.equal(holdsRemoteTransferAcrossHandoff(base, { ...base, phase: "poll", downloadAttemptId: "b" }), false);
  assert.equal(holdsRemoteTransferAcrossHandoff(base, { ...base, phase: "poll", source: "ytdlp" }), false);
});
