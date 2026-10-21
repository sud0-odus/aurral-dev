// Pure classification shared by the durable provider scheduler and worker.
// A remote transfer remains in the transfer stage while slskd/Usenet polls it.
export function capacityStageForPayload(payload) {
  const phase = String(payload?.phase || "search").toLowerCase();
  if (["download", "poll", "transfer", "await", "monitor"].includes(phase)) return "transfer";
  if (["finalize", "validate", "import", "complete"].includes(phase)) return "finalize";
  return "search";
}
export function holdsRemoteTransferAcrossHandoff(current, next) {
  if (!current || !next || current.downloadAttemptId !== next.downloadAttemptId) return false;
  if (current.source !== next.source || !["slskd", "usenet"].includes(current.source)) return false;
  // Hold only while polling the *same* remote acquisition. Poll -> download
  // starts a new candidate and must yield the transfer lane to other jobs.
  return ["download", "poll"].includes(String(current.phase))
    && String(next.phase) === "poll";
}
