// Pure capacity rules: durable messages advance independently of provider ownership.
export function pipelineCapacityStage(phase) {
  return phase === "download" || phase === "poll" ? "transfer"
    : phase === "finalize" ? "finalize" : "search";
}
export function retainRemoteTransferReservation(current, next) {
  return current?.downloadAttemptId && current.downloadAttemptId === next?.downloadAttemptId
    && pipelineCapacityStage(current.phase) === "transfer"
    && pipelineCapacityStage(next.phase) === "transfer"
    && ["slskd", "usenet"].includes(current?.source);
}
