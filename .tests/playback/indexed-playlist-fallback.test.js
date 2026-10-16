import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
test("playlist playback falls back to the shared indexed resolver", async () => {
  const source = await fs.readFile(
    new URL("../../backend/services/playback/playbackPlaylistTracks.js", import.meta.url), "utf8");
  assert.match(source, /resolveIndexedJobFile\(job\)/);
  assert.match(source, /resolveExistingTrackPath\(job\.finalPath/);
  const relinker = await fs.readFile(
    new URL("../../backend/services/libraryFileRelinker.js", import.meta.url), "utf8");
  assert.match(relinker, /byMbid\.all/);
  assert.match(relinker, /byNames\.all/);
  assert.match(relinker, /paths\.length === 1/);
  assert.match(relinker, /Math\.abs\(Number\(job\.durationMs\)/);
});
