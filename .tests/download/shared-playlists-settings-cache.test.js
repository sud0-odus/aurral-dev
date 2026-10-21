import assert from "node:assert/strict";
import test from "node:test";
import { setupIsolatedBackend, cleanupIsolatedState, resetDatabase } from "../helpers/backendTestHarness.js";

const [state, { db }, { dbOps }] = await setupIsolatedBackend(
  "shared-playlists-settings-cache",
  "backend/config/db-sqlite.js",
  "backend/db/helpers/index.js",
);

test.after(async () => { await cleanupIsolatedState(state); });

test("unchanged shared playlist document retains parsed identity across cache refreshes", () => {
  resetDatabase(db);
  const original = [{ id: "p1", ownerUserId: 1, tracks: [{ id: "t1" }] }];
  db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('sharedPlaylists', ?)").run(JSON.stringify(original));
  dbOps.invalidateSettingsCache();
  const first = dbOps.getSettings().sharedPlaylists;
  dbOps.invalidateSettingsCache();
  const second = dbOps.getSettings().sharedPlaylists;
  assert.strictEqual(second, first);
  assert.deepEqual(second, original);
});

test("cross-process playlist replacement becomes visible on next settings refresh", () => {
  const changed = [{ id: "p2", ownerUserId: 2, tracks: [{ id: "t2" }] }];
  db.prepare("UPDATE settings SET value=? WHERE key='sharedPlaylists'").run(JSON.stringify(changed));
  dbOps.invalidateSettingsCache();
  const refreshed = dbOps.getSettings().sharedPlaylists;
  assert.deepEqual(refreshed, changed);
  assert.equal(refreshed[0].ownerUserId, 2);
});

test("invalid JSON remains null instead of returning an obsolete playlist snapshot", () => {
  db.prepare("UPDATE settings SET value=? WHERE key='sharedPlaylists'").run("{broken");
  dbOps.invalidateSettingsCache();
  assert.equal(dbOps.getSettings().sharedPlaylists, null);
});
