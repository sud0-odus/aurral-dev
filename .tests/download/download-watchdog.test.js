import test from "node:test";
import assert from "node:assert/strict";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";
const [state, { db }, { downloadTracker }, { inspectOrphanedDownloadJobs }] = await setupIsolatedBackend(
  "download-watchdog", "backend/config/db-sqlite.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/downloadJobs/downloadWatchdog.js",
);
test.after(() => cleanupIsolatedState(state));

test("never calls a queued or active pipeline an orphan", () => {
  const id = downloadTracker.addJob({artistName:"Band",trackName:"Song"}, "library");
  downloadTracker.setDownloading(id);
  const old = Date.now()-3600000;
  db.prepare("UPDATE playlist_download_jobs SET started_at=? WHERE id=?").run(old,id);
  assert.equal(inspectOrphanedDownloadJobs({activeJobIds:new Set([id])}).length,0);
  assert.equal(inspectOrphanedDownloadJobs().map(job=>job.id).includes(id),true);
  const now = Date.now();
  db.prepare("INSERT INTO weekly_flow_download_provider_work (job_id,playlist_id,provider,work_id,created_at) VALUES (?, 'library', 'slskd-search', 'active-search', ?)").run(id,now);
  assert.equal(inspectOrphanedDownloadJobs().some(job=>job.id===id),false);
});
