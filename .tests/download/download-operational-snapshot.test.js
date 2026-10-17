import test from "node:test";
import assert from "node:assert/strict";
test("operational diagnostics are read-only and bounded", async () => {
  const src = await (await import("node:fs/promises")).readFile(
    new URL("../../backend/services/downloadJobs/downloadOperationalSnapshot.js", import.meta.url), "utf8");
  assert.match(src, /getDownloadOperationalSnapshot/);
  assert.match(src, /LIMIT 100/);
  assert.doesNotMatch(src, /(?:UPDATE|DELETE|INSERT)\s+(?:playlist_download_jobs|download_provider_reservations)/i);
});
