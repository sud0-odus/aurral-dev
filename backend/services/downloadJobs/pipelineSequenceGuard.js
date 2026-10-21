import { listHonkerJobs } from "../honkerDb.js";

// Honker retries abandoned claims after a worker crash. A newer stage for the
// same attempt is authoritative if both old and new messages still exist.
const latest = new Map();
let loaded = false;
function sequence(value) {
  const n = Number(value?.pipelineSequence ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
function key(value) {
  const jobId = String(value?.jobId || "");
  const attempt = String(value?.downloadAttemptId || "");
  return jobId && attempt ? `${jobId}\0${attempt}` : null;
}
function remember(value) {
  const id = key(value);
  if (!id) return;
  const seq = sequence(value);
  latest.set(id, Math.max(seq, latest.get(id) ?? 0));
}
function load() {
  if (loaded) return;
  // One bounded startup scan; no SQL JSON scans on every pipeline claim.
  for (const item of listHonkerJobs("slskd-pipeline")) remember(item.payload);
  loaded = true;
}
export function nextPipelinePayload(value) {
  return { ...value, pipelineSequence: sequence(value) + 1 };
}
export function rememberEnqueuedPipelinePayload(value) {
  load();
  remember(value);
}
export function isSupersededPipelinePayload(value) {
  load();
  const id = key(value);
  return id ? sequence(value) < (latest.get(id) ?? 0) : false;
}
