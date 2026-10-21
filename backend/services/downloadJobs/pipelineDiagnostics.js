import { db } from "../../config/db-sqlite.js";
import { logger } from "../logger.js";
import { recordDownloadEvent } from "./downloadEventHistory.js";
import { getProviderSchedulerStats } from "./providerSchedulerRuntime.js";

const enabled = () => process.env.AURRAL_DIAG_PIPELINE_TRACE === "1";
const samples = new Map();
const MAX_SAMPLES = 500;
let timer = null;
let previousCpu = process.cpuUsage();
let previousCounts = null;
const countsStmt = db.prepare("SELECT status, COUNT(*) AS total FROM playlist_download_jobs GROUP BY status");

function observe(kind, stage, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const key = `${kind}:${stage || "unknown"}`;
  const values = samples.get(key) || [];
  values.push(ms);
  if (values.length > MAX_SAMPLES) values.shift();
  samples.set(key, values);
}
function p95(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return Math.round(ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)]);
}
function report() {
  try {
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    const counts = Object.fromEntries(countsStmt.all().map(({ status, total }) => [status, total]));
    const completed = previousCounts ? Math.max(0, (counts.done || 0) - (previousCounts.done || 0)) : 0;
    const failed = previousCounts ? Math.max(0, (counts.failed || 0) - (previousCounts.failed || 0)) : 0;
    previousCounts = counts;
    const timing = {};
    for (const [key, values] of samples) {
      timing[key] = { n: values.length, p95Ms: p95(values), maxMs: Math.round(Math.max(...values)) };
    }
    samples.clear();
    const capacity = getProviderSchedulerStats();
    logger.info("downloads", "Pipeline trace 60s summary", {
      workerCpuSeconds: +((cpu.user + cpu.system) / 1e6).toFixed(2),
      completed, failed,
      activeTransfers: capacity.providers.map(({ id, active, maxActive }) => ({ id, active, maxActive })),
      activeSearches: capacity.searches.map(({ id, active, maxActive }) => ({ id, active, maxActive })),
      activeFinalizers: capacity.finalizers.map(({ id, active, maxActive }) => ({ id, active, maxActive })),
      timing,
    });
  } catch (error) {
    logger.warn("downloads", "Pipeline trace summary failed", { code: error?.code || "error" });
  }
}
export function startPipelineDiagnostics() {
  if (!enabled() || timer) return;
  previousCounts = Object.fromEntries(countsStmt.all().map(({ status, total }) => [status, total]));
  previousCpu = process.cpuUsage();
  timer = setInterval(report, 60000);
  timer.unref?.();
}
export function stopPipelineDiagnostics() {
  if (timer) clearInterval(timer);
  timer = null;
}
export function tracePipelineClaim(payload) {
  if (!enabled()) return;
  const waitMs = Number(payload?.traceEnqueuedAtMs)
    ? Math.max(0, Date.now() - Number(payload.traceEnqueuedAtMs)) : null;
  observe("queue", payload?.phase, waitMs);
  recordDownloadEvent({ jobId: payload?.jobId, attemptId: payload?.downloadAttemptId,
    category: "pipeline", event: "stage_claimed", provider: payload?.providerId || payload?.source,
    detail: JSON.stringify({ stage: payload?.phase, waitMs }) });
}
export function tracePipelineFinish(payload, nextPayload, elapsedMs) {
  if (!enabled()) return;
  observe("execute", payload?.phase, elapsedMs);
  recordDownloadEvent({ jobId: payload?.jobId, attemptId: payload?.downloadAttemptId,
    category: "pipeline", event: "stage_finished", provider: payload?.providerId || payload?.source,
    detail: JSON.stringify({ stage: payload?.phase, elapsedMs, next: nextPayload?.phase || "terminal" }) });
}
export function tracePipelineDeferred(payload) {
  if (!enabled()) return;
  recordDownloadEvent({ jobId: payload?.jobId, attemptId: payload?.downloadAttemptId,
    category: "pipeline", event: "capacity_wait", provider: payload?.providerId || payload?.source,
    detail: String(payload?.phase || "unknown") });
}
