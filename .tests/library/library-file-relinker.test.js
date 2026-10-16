import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const [state, { db }, { downloadTracker }, relinker] = await setupIsolatedBackend(
  "library-file-relinker",
  "backend/config/db-sqlite.js",
  "backend/services/downloadJobs/downloadTracker.js",
  "backend/services/libraryFileRelinker.js",
);
test.after(() => cleanupIsolatedState(state));

const stamp = () => Date.now();
let id = 0;
async function fileTrack(t, name, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aurral-relocate-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const newPath = path.join(dir, name + ".flac");
  await fs.writeFile(newPath, "test media");
  const oldPath = path.join(dir, "gone-" + name + ".flac");
  const trackId = ++id;
  const now = stamp();
  db.prepare(`INSERT INTO library_tracks (id, identity_key, mbid, artist_name, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`).run(trackId, "relink:" + trackId, opts.mbid ?? null, "Test Artist", name, now, now);
  db.prepare(`INSERT INTO library_media_files (track_id, source, path, duration_ms, size, available, created_at, updated_at)
    VALUES (?, 'aurral', ?, ?, 10, 1, ?, ?)`).run(trackId, newPath, opts.durationMs ?? 200000, now, now);
  return { oldPath, newPath };
}

test("completed job retains state and new path after scan reconciliation", async t => {
  const {oldPath, newPath} = await fileTrack(t, "Relocated", { mbid: "recording:one" });
  const id = downloadTracker.addJob({artistName: "Test Artist", trackName: "Relocated", trackMbid: "recording:one"}, "library");
  assert.equal(downloadTracker.setDone(id, oldPath, null, oldPath), true);
  const result = await relinker.reconcileCompletedJobFileLocations();
  assert.equal(result.moved, 1);
  const job = db.prepare("SELECT status, final_path, external_path FROM playlist_download_jobs WHERE id=?").get(id);
  assert.equal(job.status, "done");
  assert.equal(job.final_path, newPath);
  assert.equal(job.external_path, newPath);
});

test("ambiguous identical tracks are not silently linked", async t => {
  const first = await fileTrack(t, "Ambiguous");
  await fileTrack(t, "Ambiguous");
  const job = {artistName:"Test Artist",trackName:"Ambiguous"};
  assert.equal(await relinker.resolveIndexedJobFile(job), null);
  assert.equal(await relinker.resolveIndexedJobFile({...job,durationMs:240000}),null);
});
