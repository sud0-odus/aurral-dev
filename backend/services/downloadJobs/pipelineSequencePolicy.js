// Pure, testable stage-fence policy; persistence is handled by the guard.
export function pipelineSequenceFor(value) {
  const n = Number(value?.pipelineSequence ?? 0);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
export function pipelineAttemptKey(value) {
  const job = String(value?.jobId || "");
  const attempt = String(value?.downloadAttemptId || "");
  return job && attempt ? job + "\0" + attempt : null;
}
export function nextPipelinePayload(value) {
  return { ...value, pipelineSequence: pipelineSequenceFor(value) + 1 };
}
export function isEarlierPipelinePayload(value, latestSequence) {
  return pipelineSequenceFor(value) < Number(latestSequence ?? 0);
}
