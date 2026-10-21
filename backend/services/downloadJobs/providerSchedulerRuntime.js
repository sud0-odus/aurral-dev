import { db } from "../../config/db-sqlite.js";
import { dbOps } from "../../db/helpers/index.js";
import { getDownloadSourceStatus } from "../downloadSourceService.js";
import { planProviderDispatch, PROVIDER_SOURCES } from "./providerSchedulerPolicy.js";
import { recordDownloadEvent } from "./downloadEventHistory.js";
import { capacityStageForPayload } from "./pipelineCapacityStages.js";

// Opt-in until the real provider integrations have been exercised in staging.
export const providerSchedulerEnabled = () => process.env.AURRAL_PROVIDER_SCHEDULER === "1";

db.exec(`
  CREATE TABLE IF NOT EXISTS download_provider_reservations (
    job_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    provider_id TEXT,
    stage TEXT NOT NULL DEFAULT 'search',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_download_provider_reservations_provider
    ON download_provider_reservations(provider_id);
`);

// Upgrade existing reservations without deleting or resetting in-flight attempts.
if (!db.prepare("PRAGMA table_info(download_provider_reservations)").all().some((row) => row.name === "stage")) {
  db.exec("ALTER TABLE download_provider_reservations ADD COLUMN stage TEXT NOT NULL DEFAULT 'search'");
  // Adopt the actual current phase of PR41 reservations. Assigning every
  // migrated lease to 'search' would strand active poll/finalize attempts.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_honker_live'").get()) {
    db.exec(`UPDATE download_provider_reservations SET stage = COALESCE((
    SELECT CASE
      WHEN json_extract(h.payload, '$.phase') IN ('download','poll','transfer','await','monitor') THEN 'transfer'
      WHEN json_extract(h.payload, '$.phase') IN ('finalize','validate','import','complete') THEN 'finalize'
      ELSE 'search'
    END FROM _honker_live h
    WHERE h.queue = 'slskd-pipeline'
      AND json_valid(h.payload)
      AND json_extract(h.payload, '$.jobId') = download_provider_reservations.job_id
      AND json_extract(h.payload, '$.downloadAttemptId') = download_provider_reservations.attempt_id
    ORDER BY h.id DESC LIMIT 1
  ), 'search')`);
  }
}
const getReservation = db.prepare("SELECT * FROM download_provider_reservations WHERE job_id = ?");
// Honker creates _honker_live lazily. Never prepare queries against it at
// module import: tests and first-run startup may not have initialized Honker.
function hasOldAttemptMessage(jobId, attemptId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_honker_live'").get()) return false;
  return Boolean(db.prepare(`SELECT 1 FROM _honker_live
    WHERE queue = 'slskd-pipeline' AND json_valid(payload)
      AND json_extract(payload, '$.jobId') = ?
      AND json_extract(payload, '$.downloadAttemptId') = ?
    LIMIT 1`).get(jobId, attemptId));
}
const hasExternalProviderWork = db.prepare("SELECT 1 FROM weekly_flow_download_provider_work WHERE job_id = ? LIMIT 1");
const getActive = db.prepare("SELECT provider_id, stage, COUNT(*) AS count FROM download_provider_reservations WHERE provider_id IS NOT NULL GROUP BY provider_id, stage");
const insertReservation = db.prepare(`INSERT INTO download_provider_reservations
  (job_id, attempt_id, provider_id, stage, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)`);
const updateReservation = db.prepare("UPDATE download_provider_reservations SET provider_id = ?, stage = ?, updated_at = ? WHERE job_id = ? AND attempt_id = ?");
const deleteReservation = db.prepare("DELETE FROM download_provider_reservations WHERE job_id = ? AND attempt_id = ?");
const releaseStageReservation = db.prepare("DELETE FROM download_provider_reservations WHERE job_id = ? AND attempt_id = ? AND stage = ?");
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
    searchMaxActive: limit(settings[id]?.searchMaxActive, 2),
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
  const active = new Map(getActive.all().map((entry) => [`${entry.provider_id}:${entry.stage}`, entry.count]));
  return getProviderSchedulerPolicies().map((policy) => ({
    ...policy,
    // Search, acquisition and import no longer compete for the same quota.
    maxActive: stage === "search" ? policy.searchMaxActive : stage === "finalize" ? 2 : policy.maxActive,
    active: active.get(`${policy.id}:${stage}`) || 0,
  }));
}

export function getProviderSchedulerStats() {
  const build = (stage) => getProviderSchedulerCapacity(stage).map((p) => ({
    ...p, available: p.enabled ? Math.max(0, p.maxActive - p.active) : 0,
  }));
  return { enabled: providerSchedulerEnabled(), providers: build("transfer"), searches: build("search"), finalizers: build("finalize") };
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
    let old = getReservation.get(payload.jobId);
    if (old && old.attempt_id !== payload.downloadAttemptId) {
      // An old attempt must not permanently block the replacement. Do not
      // reclaim while its queue message or remote provider work still exists.
      if (hasOldAttemptMessage(payload.jobId, old.attempt_id)
        || hasExternalProviderWork.get(payload.jobId)) return null;
      deleteByJob.run(payload.jobId);
      old = null;
      recordDownloadEvent({ jobId: payload.jobId, attemptId: payload.downloadAttemptId,
        category: "scheduler", event: "orphan_reservation_recovered" });
    }
    const stage = capacityStageForPayload(payload);
    // Finalization has its own small pool; it never counts against active
    // transfers or searches but is still bounded to protect playback latency.
    const policies = getProviderSchedulerCapacity(stage);
    const active = policies.map((p) => ({
      ...p, active: Math.max(0, p.active - (old?.provider_id === p.id && old?.stage === stage ? 1 : 0)),
    }));
    const request = candidateJob(payload);
    if (old?.provider_id && payload.providerId === old.provider_id && old.stage === stage) {
      // A multi-phase provider attempt holds its slot until completion/fallback.
      return { ...payload, delaySeconds: null };
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
      if (old) updateReservation.run(null, stage, Date.now(), payload.jobId, payload.downloadAttemptId);
      return null;
    }
    const now = Date.now();
    if (old) {
      updateReservation.run(assignment.providerId, stage, now, payload.jobId, payload.downloadAttemptId);
    } else {
      insertReservation.run(payload.jobId, payload.downloadAttemptId, assignment.providerId, stage, now, now);
    }
    if(old?.provider_id!==assignment.providerId || old?.stage !== stage) recordDownloadEvent({
      jobId:payload.jobId,category:"scheduler",event:"capacity_reserved",provider:assignment.providerId, attemptId:payload.downloadAttemptId, detail:stage});
    return {
      ...payload,
      ...assignment,
      delaySeconds: null,
      providerId: assignment.providerId,
      source: assignment.source,
      ...(assignment.downloadClient ? { downloadClient: assignment.downloadClient } : { downloadClient: null }),
      waitingForProvider: false,
    };
  })();
}

export function releasePipelineProvider(payload) {
  if (!providerSchedulerEnabled() || !payload?.jobId || !payload?.downloadAttemptId) return 0;
  // A continuation may have claimed the next stage already. Never delete its
  // reservation when releasing the previous stage after durable enqueue.
  return releaseStageReservation.run(payload.jobId, payload.downloadAttemptId, capacityStageForPayload(payload)).changes;
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
