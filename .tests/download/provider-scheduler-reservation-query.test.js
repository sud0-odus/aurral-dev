import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { RESERVATION_CLAIM_STATS_SQL } from "../../backend/services/downloadJobs/providerSchedulerReservationQuery.js";

test("reservation diagnostic query is read-only and correlates exact attempt claims", () => {
  assert.match(RESERVATION_CLAIM_STATS_SQL, /SELECT r\.provider_id/);
  assert.match(RESERVATION_CLAIM_STATS_SQL, /json_extract\(h\.payload, '\$\.jobId'\) = r\.job_id/);
  assert.match(RESERVATION_CLAIM_STATS_SQL, /json_extract\(h\.payload, '\$\.downloadAttemptId'\) = r\.attempt_id/);
  assert.match(RESERVATION_CLAIM_STATS_SQL, /h\.queue = 'slskd-pipeline'/);
  assert.match(RESERVATION_CLAIM_STATS_SQL, /json_valid\(h\.payload\)/);
  assert.doesNotMatch(RESERVATION_CLAIM_STATS_SQL, /\b(UPDATE|DELETE|INSERT|DROP|ALTER)\b/i);
});

test("reservation diagnostics distinguish claim presence, attempt mismatch and missing jobs", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE download_provider_reservations (
        job_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, provider_id TEXT
      );
      CREATE TABLE playlist_download_jobs (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE _honker_live (queue TEXT, payload TEXT);
      INSERT INTO playlist_download_jobs VALUES ('a', 'pending'), ('b', 'downloading'), ('c', 'pending');
      INSERT INTO download_provider_reservations VALUES
        ('a', 'attempt-a', 'dmm'),
        ('b', 'attempt-b', 'slskd'),
        ('c', 'attempt-c', 'dmm'),
        ('missing', 'attempt-missing', 'sabnzbd');
      INSERT INTO _honker_live VALUES
        ('slskd-pipeline', '{"jobId":"a","downloadAttemptId":"attempt-a"}'),
        ('slskd-pipeline', '{"jobId":"b","downloadAttemptId":"other-attempt"}'),
        ('other-queue', '{"jobId":"c","downloadAttemptId":"attempt-c"}'),
        ('slskd-pipeline', 'not-json');
    `);
    const rows = db.prepare(RESERVATION_CLAIM_STATS_SQL).all();
    const key = (p, status, claim) => rows.find((row) =>
      row.provider_id === p && row.job_status === status && row.has_queue_claim === claim);
    assert.equal(key("dmm", "pending", 1)?.count, 1);
    assert.equal(key("dmm", "pending", 0)?.count, 1);
    assert.equal(key("slskd", "downloading", 0)?.count, 1);
    assert.equal(key("sabnzbd", "missing_job", 0)?.count, 1);
    assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 4);
  } finally {
    db.close();
  }
});
