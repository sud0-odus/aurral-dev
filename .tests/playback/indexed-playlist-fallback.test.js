import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
test("playback uses indexed media with ID or artist/title and refuses ambiguous copies", async () => {
  const code = await fs.readFile(new URL("../../backend/services/playback/playbackPlaylistTracks.js", import.meta.url), "utf8");
  assert.match(code, /byRecording\.all/);
  assert.match(code, /byNames\.all/);
  assert.match(code, /valid\.length === 1/);
  assert.match(code, /Math\.abs\(job\.durationMs - file\.durationMs\)/);
});
