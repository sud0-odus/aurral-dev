import { db } from "../../config/db-sqlite.js";
import { dbOps } from "../../db/helpers/index.js";
import { getDownloadSourceStatus } from "../downloadSourceService.js";
import { planProviderDispatch, PROVIDER_SOURCES } from "./providerSchedulerPolicy.js";
import { recordDownloadEvent } from "./downloadEventHistory.js";

// Opt-in until the real provider integrations have been exercised in staging.
export const providerSchedulerEnabled = () => process.env.AURRAL_PROVIDER_SCHEDULER === "1";

db.exec(`
  CREATE TABLE IF NOT EXISTS download_provider_reservations (
    job_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    provider_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    stage TEXT NOT NULL DEFAULT 'search'
  );
  CREATE INDEX IF NOT EXISTS idx_download_provider_reservations_provider
    ON download_provider_reservations(provider_id);
`);

if (!db.prepare("PRAGMA table_info(download_provider_reservations)").all().some((column) => column.name === "stage")) {
  db.exec("ALTER TABLE download_provider_reservations ADD COLUMN stage TEXT NOT NULL DEFAULT 'search'");
}
export const pipelineCapacityStage = (phase) => phase === "download" || phase === "poll"
  ? "transfer" : phase === "finalize" ? "finalize" : "search";
const getReservation = db.prepare("SELECT * FROM download_provider_reservations WHERE job_id = ?");
const getActive = db.prepare("SELECT provider_id, COUNT(*) AS count FROM download_provider_reservations WHERE provider_id IS NOT NULL AND stage = ? GROUP BY provider_id");
const insertReservation = db.prepare(`INSERT INTO download_provider_reservations
  (job_id, attempt_id, provider_id, created_at, updated_at, stage)
  VALUES (?, ?, ?, ?, ?, ?)`);
const updateReservation = db.prepare("UPDATE download_provider_reservations SET provider_id = ?, stage = ?, updated_at = ? WHERE job_id = ? AND attempt_id = ?");
const parkReservation = db.prepare("UPDATE download_provider_reservations SET stage = 'waiting', updated_at = ? WHERE job_id = ? AND attempt_id = ?");
const deleteReservation = db.prepare("DELETE FROM download_provider_reservations WHERE job_id = ? AND attempt_id = ?");
const deleteByJob = db.prepare("DELETE FROM download_provider_reservations WHERE job_id = ?");

function limit(value, fallback) {
  const number = Number(value);
  return value == null || value === "" || !Number.isFinite(number)
    ? fallback : Math.max(1, Math.min(8, Math.trunc(number)));
}

export function getProviderSchedulerPolicies() {
  const source = getDownloadSourceStatus();
  const settings = dbOps.getSettings()?.integrations || {};
  const create = (id, enabled, priority, defaultSlots) => ({
    id,
    enabled,
    configured: enabled,
    priority: Number.isFinite(Number(settings[id]?.priority))
      ? Number(settings[id].priority) : priority,
    maxActive: limit(settings[id]?.maxActive, defaultSlots),
  });
  return [
    create("slskd", source.slskd.configured, source.slskd.priority, 3),
    create("ytdlp", source.ytdlp.configured, source.ytdlp.priority, 3),
    create("sabnzbd", source.usenet.prowlarrConfigured && source.usenet.sabnzbdConfigured, 20, 2),
    create("nzbget", source.usenet.prowlarrConfigured && source.usenet.nzbgetConfigured, 20, 2),
    create("deemix", source.deemix.configured, source.deemix.priority, 2),
    create("dmm", source.dmm.configured, source.dmm.priority, 1),
  ];
}

export function getProviderSchedulerCapacity(stage = "transfer") {
  const active = new Map(getActive.all(stage).map((entry) => [entry.provider_id, entry.count]));
  return getProviderSchedulerPolicies().map((policy) => ({
    ...policy,
    active: active.get(policy.id) || 0,
  }));
}

export function getProviderSchedulerStats() {
  return { enabled: providerSchedulerEnabled(), providers: getProviderSchedulerCapacity().map((p) => ({
    ...p, available: p.enabled ? Math.max(0, p.maxActive - p.active) : 0,
  })) };
}

export function providerSchedulerMaxWorkers() {
  return Math.min(24, Math.max(1, getProviderSchedulerCapacity()
    .filter((p) => p.enabled).reduce((sum, p) => sum + p.maxActive, 0)));
}

function candidateJob(payload) {
  return {
    id: payload.jobId, state: "queued", albumGrab: payload.albumGrab === true,
    allowedSources: payload.allowedSources,
    triedProviders: payload.triedProviders,
    // Once a manual choice was made it cannot silently change provider.
    excludedProviders: payload.manualSelection === true
      ? Object.keys(PROVIDER_SOURCES).filter((id) => id !== (payload.providerId
        || payload.manualDownloadClient || payload.source))
      : [],
  };
}

/** Atomic advisory-policy + SQLite reservation. Same job cannot reserve twice. */
export function reservePipelineProvider(payload) {
  if (!providerSchedulerEnabled() || !payload?.jobId || !payload?.downloadAttemptId) return payload;
  return db.transaction(() => {
    const old = getReservation.get(payload.jobId);
    if (old && old.attempt_id !== payload.downloadAttemptId) return null;
    const stage = pipelineCapacityStage(payload.phase);
    const policies = getProviderSchedulerCapacity(stage);
    const active = policies.map((p) => ({
      ...p, active: Math.max(0, p.active - (old?.provider_id === p.id && old?.stage === stage ? 1 : 0)),
    }));
    const request = candidateJob(payload);
    if (old?.provider_id && payload.providerId === old.provider_id
      && (old.stage === stage || stage === "finalize")) {
      if (old.stage !== stage) updateReservation.run(old.provider_id, stage, Date.now(), payload.jobId, payload.downloadAttemptId);
      return payload;
    }
    const desired = String(payload.providerId || "").trim();
    // A continuation or a source fallback must stay with its selected source.
    // Initial unassigned searches may overflow across providers by priority.
    // Usenet is one source with two independently scheduled clients.
    if (desired) {
      request.allowedSources = [desired];
    } else if (payload.source) {
      request.allowedSources = [payload.source];
    }
    const assignment = planProviderDispatch({ jobs: [request], providers: active }).assignments[0];
    if (!assignment) {
      // Release the old provider slot while waiting for fallback capacity,
      // but preserve the attempt's exclusivity across the delayed Honker step.
      if (old) updateReservation.run(null, "waiting", Date.now(), payload.jobId, payload.downloadAttemptId);
      return null;
    }
    const now = Date.now();
    if (old) {
      updateReservation.run(assignment.providerId, stage, now, payload.jobId, payload.downloadAttemptId);
    } else {
      insertReservation.run(payload.jobId, payload.downloadAttemptId, assignment.providerId, now, now, stage);
    }
    if(old?.provider_id!==assignment.providerId) recordDownloadEvent({
      jobId:payload.jobId,category:"scheduler",event:"provider_selected",provider:assignment.providerId});
    return {
      ...payload,
      ...assignment,
      providerId: assignment.providerId,
      source: assignment.source,
      ...(assignment.downloadClient ? { downloadClient: assignment.downloadClient } : { downloadClient: null }),
      waitingForProvider: false,
    };
  })();
}

export function parkPipelineProvider(payload, nextPayload) {
  if (!providerSchedulerEnabled() || !payload?.jobId || !payload?.downloadAttemptId || !nextPayload) return 0;
  // Remote transfer remains active across durable poll messages. No other phase
  // holds a provider lane while its continuation waits in the queue.
  const from = pipelineCapacityStage(payload.phase);
  const to = pipelineCapacityStage(nextPayload.phase);
  if (from === "transfer" && to === "transfer" &&
    ["slskd", "usenet"].includes(payload.source)) return 0;
  return parkReservation.run(Date.now(), payload.jobId, payload.downloadAttemptId).changes;
}

export function releasePipelineProvider(payload) {
  if (!providerSchedulerEnabled() || !payload?.jobId || !payload?.downloadAttemptId) return 0;
  return deleteReservation.run(payload.jobId, payload.downloadAttemptId).changes;
}

export function revokePipelineProviderJob(jobId) {
  if (!providerSchedulerEnabled()) return 0;
  return deleteByJob.run(String(jobId || "")).changes;
}

export function isPipelineReservationCurrent(payload) {
  if (!providerSchedulerEnabled() || !payload?.downloadAttemptId) return true;
  const row = getReservation.get(payload.jobId);
  return row?.attempt_id === payload.downloadAttemptId
    && (!payload.providerId || row.provider_id === payload.providerId);
}

/** Only remove orphan reservations, never discard an in-flight queue claim. */
export function reconcilePipelineReservations() {
  if (!providerSchedulerEnabled()) return 0;
  return db.transaction(() => {
    const rows = db.prepare("SELECT job_id, attempt_id FROM download_provider_reservations").all();
    let removed = 0;
    for (const row of rows) {
      const job = db.prepare("SELECT status FROM playlist_download_jobs WHERE id = ?").get(row.job_id);
      const queued = db.prepare(`SELECT 1 FROM _honker_live
        WHERE queue = 'slskd-pipeline' AND json_valid(payload)
          AND json_extract(payload, '$.jobId') = ?
          AND json_extract(payload, '$.downloadAttemptId') = ? LIMIT 1`)
        .get(row.job_id, row.attempt_id);
      if (!job || ["done", "failed", "cancelled", "blocked"].includes(job.status) || !queued) {
        removed += deleteReservation.run(row.job_id, row.attempt_id).changes;
      }
    }
    return removed;
  })();
}

export async function reconcilePipelineReservationsCooperatively({ yieldEvery = 16 } = {}) {
  if (!providerSchedulerEnabled()) return 0;
  const rows = db.prepare("SELECT job_id, attempt_id FROM download_provider_reservations").all();
  const jobStatus = db.prepare("SELECT status FROM playlist_download_jobs WHERE id = ?");
  const queuedAttempt = db.prepare(`SELECT 1 FROM _honker_live
    WHERE queue = 'slskd-pipeline' AND json_valid(payload)
      AND json_extract(payload, '$.jobId') = ?
      AND json_extract(payload, '$.downloadAttemptId') = ? LIMIT 1`);
  const batchSize = Math.max(1, Math.floor(Number(yieldEvery) || 16));
  let removed = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (index > 0 && index % batchSize === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const row = rows[index];
    const job = jobStatus.get(row.job_id);
    const queued = queuedAttempt.get(row.job_id, row.attempt_id);
    if (!job || ["done", "failed", "cancelled", "blocked"].includes(job.status) || !queued) {
      removed += deleteReservation.run(row.job_id, row.attempt_id).changes;
    }
  }
  return removed;
}
