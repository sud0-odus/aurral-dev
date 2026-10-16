import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [state, { db }, history] = await setupIsolatedBackend(
  "download-event-history", "backend/config/db-sqlite.js",
  "backend/services/downloadJobs/downloadEventHistory.js",
);
test.after(() => cleanupIsolatedState(state));

test("persistent provider events include attempt and redact credentials", () => {
  assert.equal(history.recordDownloadEvent({jobId:"history-1",category:"provider",
    event:"provider_failed",provider:"slskd",attemptId:"attempt-1",
    reasonCode:"auth",detail:"HTTP 401 authorization=supersecret"}),true);
  const event = history.queryDownloadEvents({jobId:"history-1"}).events[0];
  assert.equal(event.attemptId,"attempt-1");
  assert.equal(event.reasonCode,"auth");
  assert.equal(event.provider,"slskd");
  assert.ok(event.detail.includes("[redacted]"));
  assert.ok(!event.detail.includes("supersecret"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM download_operation_events").get().n,1);
});
test("search, filter and descending cursor pagination work", () => {
  for (const [jobId,provider,reasonCode] of [
    ["download-1","dmm","timeout"],["download-2","slskd","auth"],
    ["download-1","slskd","timeout"],["download-3","ytdlp","no_match"],
  ]) history.recordDownloadEvent({jobId,category:"provider",
    provider,event:"provider_failed",detail:"failure "+reasonCode,reasonCode});
  const first=history.queryDownloadEvents({category:"provider",limit:2});
  assert.equal(first.events.length,2);
  assert.equal(first.hasMore,true);
  const second=history.queryDownloadEvents({category:"provider",limit:2,before:first.nextBefore});
  assert.equal(second.events.length,2);
  assert.ok(second.events.every(row=>row.id<first.events[1].id));
  const filtered=history.queryDownloadEvents({provider:"slskd",reasonCode:"timeout",search:"download-1"});
  assert.equal(filtered.events.length,1);
  assert.equal(filtered.events[0].jobId,"download-1");
  assert.equal(history.queryDownloadEvents({search:"no match anywhere"}).events.length,0);
});
test("failure classification exposes auth, timeout, rate limits and validation", () => {
  assert.equal(history.classifyDownloadFailure({status:401}),"auth");
  assert.equal(history.classifyDownloadFailure("Soulseek logged out"),"auth");
  assert.equal(history.classifyDownloadFailure("Timed out"),"timeout");
  assert.equal(history.classifyDownloadFailure("Corrupt file validation failed"),"validation");
  assert.equal(history.classifyDownloadFailure({status:429}),"rate_limit");
});
test("explicit age pruning retains recent events", () => {
  const id=history.queryDownloadEvents({jobId:"history-1"}).events[0].id;
  db.prepare("UPDATE download_operation_events SET occurred_at=? WHERE id=?")
    .run(Date.now()-120*86400000,id);
  assert.equal(history.pruneDownloadEventHistory(90),1);
  assert.equal(history.queryDownloadEvents({jobId:"history-1"}).events.length,0);
});
