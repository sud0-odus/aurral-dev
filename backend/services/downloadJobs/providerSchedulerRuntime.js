import { db } from "../../config/db-sqlite.js";
import { dbOps } from "../../db/helpers/index.js";
import { getDownloadSourceStatus } from "../downloadSourceService.js";
import { planProviderDispatch, PROVIDER_SOURCES } from "./providerSchedulerPolicy.js";
import { recordDownloadEvent } from "./downloadEventHistory.js";
import { RESERVATION_CLAIM_STATS_SQL } from "./providerSchedulerReservationQuery.js";

// Opt-in until the real provider integrations have been exercised in staging.
export const providerSchedulerEnabled = () => process.env.AURRAL_PROVIDER_SCHEDULER === "1";

db.exec(`
  CREATE TABLE IF NOT EXISTS download_provider_reservations (
    job_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    provider_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_download_provider_reservations_provider
    ON download_provider_reservations(provider_id);
`);

const getReservation = db.prepare("SELECT * FROM download_provider_reservations WHERE job_id = ?");
const getActive = db.prepare("SELECT provider_id, COUNT(*) AS count FROM download_provider_reservations WHERE provider_id IS NOT NULL GROUP BY provider_id");
const insertReservation = db.prepare(`INSERT INTO download_provider_reservations
  (job_id, attempt_id, provider_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)`);
const updateReservation = db.prepare("UPDATE download_provider_reservations SET provider_id = ?, updated_at = ? WHERE job_id = ? AND attempt_id = ?");
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

export function getProviderSchedulerCapacity() {
  const active = new Map(getActive.all().map((entry) => [entry.provider_id, entry.count]));
  return getProviderSchedulerPolicies().map((policy) => ({
    ...policy,
    active: active.get(policy.id) || 0,
  }));
}

// Read-only diagnostics: age is measured from the original reservation, not
// the most recent provider switch. Old reservations are candidates for review,
// NOT permission to release a potentially live download.
const reservationDiagnostics = db.prepare(`
  SELECT provider_id, COUNT(*) AS reservations,
    MIN(created_at) AS oldest_created_at,
    SUM(CASE WHEN created_at <= ? THEN 1 ELSE 0 END) AS older_than_15m,
    SUM(CASE WHEN created_at <= ? THEN 1 ELSE 0 END) AS older_than_60m
  FROM download_provider_reservations
  GROUP BY provider_id
`);

// Source-level outcome counters. These describe job rows, NOT provider-client
// transfer telemetry. In particular, "usenet" cannot distinguish SABnzbd from
// NZBGet, and unassigned jobs must remain visible rather than attributed.
const downloadOutcomeCounts = db.prepare(`
  SELECT COALESCE(download_source, 'unassigned') AS source,
    status, COUNT(*) AS count
  FROM playlist_download_jobs
  GROUP BY download_source, status
`);

// Match the same durable queue claim used by orphan reconciliation, but
// observe only: an absent claim may reflect an in-flight worker transition.
export function getProviderReservationClaimStats() {
  // Honker initializes its live queue table separately. In lightweight test
  // environments it may not exist yet; never fail module initialization.
  const queueExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_honker_live'").get();
  if (!queueExists) return null;
  return db.prepare(RESERVATION_CLAIM_STATS_SQL).all().map((row) => ({
    providerId: row.provider_id,
    jobStatus: row.job_status,
    hasQueueClaim: Boolean(row.has_queue_claim),
    count: row.count,
  }));
}

export function getDownloadSourceOutcomeStats() {
  const bySource = new Map();
  for (const row of downloadOutcomeCounts.all()) {
    if (!bySource.has(row.source)) bySource.set(row.source, {});
    bySource.get(row.source)[row.status] = row.count;
  }
  return [...bySource].map(([source, statuses]) => ({ source, statuses }));
}

// Aggregate the existing operational event history rather than creating a
// parallel lifecycle log. Counts are event occurrences, not unique downloads.
const recentProviderEvents = db.prepare(`
  SELECT COALESCE(provider, 'unassigned') AS provider, event,
    COUNT(*) AS count, COUNT(DISTINCT job_id) AS distinctJobs,
    COUNT(DISTINCT attempt_id) AS distinctAttempts
  FROM download_operation_events
  WHERE occurred_at >= ? AND category IN ('provider', 'scheduler')
    AND event IN ('provider_selected', 'provider_failed', 'fallback')
  GROUP BY COALESCE(provider, 'unassigned'), event
`);

export function getRecentProviderEventStats(now = Date.now()) {
  return recentProviderEvents.all(now - 60 * 60_000).map((row) => ({
    provider: row.provider,
    event: row.event,
    count: row.count,
    distinctJobs: row.distinctJobs,
    distinctAttempts: row.distinctAttempts,
  }));
}

export function getProviderSchedulerStats() {
  const now = Date.now();
  const ages = new Map(reservationDiagnostics.all(now - 15 * 60_000, now - 60 * 60_000)
    .map((row) => [row.provider_id, {
      oldestReservationAgeMs: Math.max(0, now - row.oldest_created_at),
      olderThan15m: row.older_than_15m,
      olderThan60m: row.older_than_60m,
    }]));
  return {
    enabled: providerSchedulerEnabled(),
    sampledAt: now,
    // The worker ceiling is a configured upper bound, not active transfers.
    workerCeiling: providerSchedulerMaxWorkers(),
    sourceOutcomes: getDownloadSourceOutcomeStats(),
    lastHourProviderEvents: getRecentProviderEventStats(now),
    // Null means unavailable; [] means available with no matching claims.
    reservationClaims: getProviderReservationClaimStats(),
    unassignedReservations: ages.get(null) || null,
    providers: getProviderSchedulerCapacity().map((p) => ({
      ...p,
      available: p.enabled ? Math.max(0, p.maxActive - p.active) : 0,
      oldestReservationAgeMs: ages.get(p.id)?.oldestReservationAgeMs ?? null,
      olderThan15m: ages.get(p.id)?.olderThan15m ?? 0,
      olderThan60m: ages.get(p.id)?.olderThan60m ?? 0,
    })),
  };
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
    const policies = getProviderSchedulerCapacity();
    const active = policies.map((p) => ({
      ...p, active: Math.max(0, p.active - (old?.provider_id === p.id ? 1 : 0)),
    }));
    const request = candidateJob(payload);
    if (old?.provider_id && payload.providerId === old.provider_id) {
      // A multi-phase provider attempt holds its slot until completion/fallback.
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
      if (old) updateReservation.run(null, Date.now(), payload.jobId, payload.downloadAttemptId);
      return null;
    }
    const now = Date.now();
    if (old) {
      updateReservation.run(assignment.providerId, now, payload.jobId, payload.downloadAttemptId);
    } else {
      insertReservation.run(payload.jobId, payload.downloadAttemptId, assignment.providerId, now, now);
    }
    if(old?.provider_id!==assignment.providerId) recordDownloadEvent({
      jobId:payload.jobId,attemptId:payload.downloadAttemptId,category:"scheduler",event:"provider_selected",provider:assignment.providerId});
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
