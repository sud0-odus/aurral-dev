import test from "node:test";
import assert from "node:assert/strict";
import { RESERVATION_CLAIM_STATS_SQL } from "../../backend/services/downloadJobs/providerSchedulerReservationQuery.js";

test("reservation diagnostic query is read-only and correlates exact attempt claims", () => {
  assert.match(RESERVATION_CLAIM_STATS_SQL, /SELECT r\.provider_id/);
  assert.match(RESERVATION_CLAIM_STATS_SQL, /json_extract\(h\.payload, '\$\.jobId'\) = r\.job_id/);
  assert.match(RESERVATION_CLAIM_STATS_SQL, /json_extract\(h\.payload, '\$\.downloadAttemptId'\) = r\.attempt_id/);
  assert.match(RESERVATION_CLAIM_STATS_SQL, /h\.queue = 'slskd-pipeline'/);
  assert.match(RESERVATION_CLAIM_STATS_SQL, /json_valid\(h\.payload\)/);
  assert.doesNotMatch(RESERVATION_CLAIM_STATS_SQL, /\b(UPDATE|DELETE|INSERT|DROP|ALTER)\b/i);
});
