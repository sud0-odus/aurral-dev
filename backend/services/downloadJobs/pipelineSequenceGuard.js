import { listHonkerJobs } from "../honkerDb.js";
import { pipelineAttemptKey, pipelineSequenceFor, nextPipelinePayload,
  isEarlierPipelinePayload } from "./pipelineSequencePolicy.js";

export { nextPipelinePayload };

// Honker can reclaim a processing claim after a crash. A newer durable queue
// message for the *same* attempt fences out the abandoned older phase.
const latest = new Map();
let loaded = false;
function remember(payload) {
  const key = pipelineAttemptKey(payload);
  if (!key) return;
  latest.set(key, Math.max(pipelineSequenceFor(payload), latest.get(key) ?? 0));
}
function load() {
  if (loaded) return;
  for (const item of listHonkerJobs("slskd-pipeline")) remember(item.payload);
  loaded = true;
}
export function rememberEnqueuedPipelinePayload(payload) {
  load();
  remember(payload);
}
export function isSupersededPipelinePayload(payload) {
  load();
  const key = pipelineAttemptKey(payload);
  return key ? isEarlierPipelinePayload(payload, latest.get(key) ?? 0) : false;
}
