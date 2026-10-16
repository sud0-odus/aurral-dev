import { db } from "../../config/db-sqlite.js";
import { getProviderSchedulerStats } from "./providerSchedulerRuntime.js";
import { downloadTracker } from "./downloadTracker.js";
import { getDownloadEvents } from "./downloadEventHistory.js";
const MAX_AGE_MS = 30 * 60 * 1000;
export function getDownloadOperationalSnapshot(now = Date.now()) {
  const stats = downloadTracker.getStats();
  const pipeline = db.prepare(`SELECT state, COUNT(*) AS total
    FROM _honker_live WHERE queue = 'slskd-pipeline'
    GROUP BY state`).all();
  const reservations = db.prepare(`SELECT job_id, provider_id, updated_at
    FROM download_provider_reservations ORDER BY updated_at ASC LIMIT 150`).all();
  const activeAttempts = db.prepare(`SELECT DISTINCT json_extract(payload,'$.jobId') AS jobId
    FROM _honker_live WHERE queue = 'slskd-pipeline' AND json_valid(payload)
    AND json_extract(payload,'$.jobId') IS NOT NULL`).all();
  const activeIds = new Set(activeAttempts.map(row => row.jobId));
  const staleReservations = reservations.filter(row =>
    Number(row.updated_at) < now - MAX_AGE_MS && !activeIds.has(row.job_id));
  const recent = db.prepare(`SELECT id, artist_name, track_name, status, download_source,
    error, started_at, completed_at, created_at FROM playlist_download_jobs
    ORDER BY created_at DESC LIMIT 60`).all();
  const stalledCandidates = db.prepare(`SELECT id, artist_name, track_name,
    playlist_type, started_at, status
    FROM playlist_download_jobs
    WHERE status='downloading' AND started_at IS NOT NULL AND started_at < ?
    ORDER BY started_at ASC LIMIT 100`).all(now - MAX_AGE_MS);
  return {
    observedAt: new Date(now).toISOString(),
    stats,
    pipeline: Object.fromEntries(pipeline.map(row => [row.state, row.total])),
    providers: getProviderSchedulerStats(),
    staleReservations: staleReservations.length,
    recentEvents: getDownloadEvents({limit:120}),
    recentJobs: recent.map(row => ({ id: row.id, artist: row.artist_name, track: row.track_name,
      status: row.status, provider: row.download_source, error: row.error,
      startedAt: row.started_at, completedAt: row.completed_at, createdAt: row.created_at })),
    stalledCandidates: stalledCandidates.filter(job => !activeIds.has(job.id)).map(job => ({
      id:job.id, artistName:job.artist_name, trackName:job.track_name,
      playlistId:job.playlist_type, status:job.status,
      activeForMs:now-Number(job.started_at),
    })),
    note:"Only unclaimed old jobs are flagged. No active downloads are interrupted or requeued.",
  };
}
