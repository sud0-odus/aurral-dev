import { db } from "../../config/db-sqlite.js";

const DEFAULT_ORPHAN_AGE_MS = 30 * 60 * 1000;
const hasReservations = Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='download_provider_reservations'",
).get());
const SELECT_ORPHANS = db.prepare(`
  SELECT j.id, j.download_source AS downloadSource, j.started_at AS startedAt
  FROM playlist_download_jobs j
  WHERE j.status = 'downloading' AND j.started_at IS NOT NULL AND j.started_at < ?
    AND NOT EXISTS (
      SELECT 1 FROM _honker_live q
      WHERE q.queue = 'slskd-pipeline' AND json_valid(q.payload)
        AND json_extract(q.payload, '$.jobId') = j.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM weekly_flow_download_provider_work w WHERE w.job_id = j.id
    )
    ${hasReservations ? `AND NOT EXISTS (
      SELECT 1 FROM download_provider_reservations r WHERE r.job_id = j.id
    )` : ""}
  ORDER BY j.started_at ASC LIMIT 100`);

export function inspectOrphanedDownloadJobs({
  now = Date.now(),
  minimumAgeMs = DEFAULT_ORPHAN_AGE_MS,
  activeJobIds = new Set(),
} = {}) {
  const ids = activeJobIds instanceof Set ? activeJobIds : new Set(activeJobIds);
  return SELECT_ORPHANS.all(now - Math.max(60000, minimumAgeMs))
    .filter(job => !ids.has(job.id));
}
