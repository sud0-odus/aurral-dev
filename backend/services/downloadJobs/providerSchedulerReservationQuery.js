// Shared read-only reservation/claim aggregation. No mutations or job metadata.
export const RESERVATION_CLAIM_STATS_SQL = `
  SELECT r.provider_id AS provider_id,
    COALESCE(j.status, 'missing_job') AS job_status,
    CASE WHEN EXISTS (
      SELECT 1 FROM _honker_live h
      WHERE h.queue = 'slskd-pipeline'
        AND json_valid(h.payload)
        AND json_extract(h.payload, '$.jobId') = r.job_id
        AND json_extract(h.payload, '$.downloadAttemptId') = r.attempt_id
    ) THEN 1 ELSE 0 END AS has_queue_claim,
    COUNT(*) AS count
  FROM download_provider_reservations r
  LEFT JOIN playlist_download_jobs j ON j.id = r.job_id
  GROUP BY r.provider_id, COALESCE(j.status, 'missing_job'), has_queue_claim
`;
