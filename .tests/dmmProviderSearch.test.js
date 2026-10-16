import test from "node:test";
import assert from "node:assert/strict";
import {
  dmmFilenameTitle, buildDmmSearchQueries, discoverDmmTrack,
} from "../backend/services/dmmSearch.js";

const hash = (n) => n.toString(16).padStart(40, "0");
const entry = (album, n) => ({ artist: "Charlotte Day Wilson", album, hash: hash(n) });
const request = {
  artistName: "Charlotte Day Wilson",
  albumName: "ALPHA",
  trackName: "I Can Only Whisper",
};
const track = (filename) => ({ fileId: 1, filename, bytes: 123456 });

test("DMM filename parser handles track numbers and artist prefixes", () => {
  assert.equal(dmmFilenameTitle("01 - I Can Only Whisper.flac"), "I Can Only Whisper");
  assert.equal(dmmFilenameTitle("Charlotte Day Wilson - I Can Only Whisper.mp3", ["Charlotte Day Wilson"]), "I Can Only Whisper");
  assert.equal(dmmFilenameTitle("02 - Song (Single Edit).flac"), "Song (Single Edit)");
});

test("DMM makes album, track, and artist search tiers", () => {
  assert.deepEqual(buildDmmSearchQueries(request).map(x => x.kind), ["album", "track", "artist"]);
});

test("DMM finds a track on a different edition without claiming the wrong album", async () => {
  const cyan = entry("Cyan Blue", 1);
  const calls = [];
  const result = await discoverDmmTrack({
    request,
    searchAlbums: async (query) => {
      calls.push(query);
      if (query.endsWith("ALPHA")) return { albums: [] };
      return { albums: [cyan] };
    },
    readAlbum: async () => ({
      ...cyan, tracks: [track("01 - I Can Only Whisper.flac")],
    }),
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].albumName, "Cyan Blue");
  assert.equal(result.stats.reason, "matched");
  assert.ok(calls.some(x => x.includes("I Can Only Whisper")));
});

test("DMM skips a different recording and keeps explicit rejection diagnostics", async () => {
  const cyan = entry("Cyan Blue", 1);
  const result = await discoverDmmTrack({
    request,
    searchAlbums: async () => ({ albums: [cyan] }),
    readAlbum: async () => ({
      ...cyan, tracks: [track("01 - A Completely Different Song.flac")],
    }),
  });
  assert.equal(result.matches.length, 0);
  assert.equal(result.stats.reason, "no_matching_recording");
});

test("DMM does not accept an unrelated artist even if the title matches", async () => {
  const wrong = { artist: "Other Artist", album: "ALPHA", hash: hash(2) };
  let inspected = 0;
  const result = await discoverDmmTrack({
    request,
    searchAlbums: async () => ({ albums: [wrong] }),
    readAlbum: async () => { inspected++; return {...wrong, tracks: [track("I Can Only Whisper.flac")]}; },
  });
  assert.equal(result.matches.length, 0);
  assert.equal(inspected, 0);
  assert.equal(result.stats.reason, "artist_not_in_results");
});
