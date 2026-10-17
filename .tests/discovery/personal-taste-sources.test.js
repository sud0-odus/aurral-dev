import test from "node:test";
import assert from "node:assert/strict";
import { getPersonalHistoryProfiles, mergePersonalArtistSources } from "../../backend/services/discovery/personalTasteSources.js";

test("independent Last.fm and ListenBrainz profiles and legacy profile are deduplicated", () => {
  const user={listenHistoryProvider:"lastfm",listenHistoryUsername:"Me"};
  const profiles=getPersonalHistoryProfiles(user,{
    lastfm:{displayName:"me"},listenbrainz:{displayName:"my-listens"},
  });
  assert.deepEqual(profiles.map(x=>[x.listenHistoryProvider,x.listenHistoryUsername]),
    [["lastfm","Me"],["listenbrainz","my-listens"]]);
  assert.deepEqual(getPersonalHistoryProfiles({},{}),[]);
  assert.deepEqual(getPersonalHistoryProfiles({listenHistoryProvider:"local"},{}),[]);
});
test("round-robin sources without double counting cross-service listening history", () => {
  const mk=(artistName,source,playcount)=>({artistName,source,playcount});
  const merged=mergePersonalArtistSources([
    [mk("Taylor Swift","lastfm",120),mk("Adele","lastfm",40),mk("Beyonce","lastfm",9)],
    [mk("taylor swift","listenbrainz",90),mk("Bad Bunny","listenbrainz",15)],
    [mk("Luke Bryan","apple_music",5)],
  ]);
  assert.deepEqual(merged.map(x=>x.artistName),
    ["Taylor Swift","Luke Bryan","Adele","Bad Bunny","Beyonce"]);
  assert.equal(merged[0].playcount,120);
  assert.deepEqual(merged[0].sources,["lastfm","listenbrainz"]);
  assert.equal(merged[0].source,"listenbrainz");
});
test("independent profiles and history never borrow another user's artists", () => {
  const a=mergePersonalArtistSources([[{artistName:"Adele",source:"apple_music"}]]);
  const b=mergePersonalArtistSources([[{artistName:"Drake",source:"lastfm"}]]);
  assert.deepEqual(a.map(x=>x.artistName),["Adele"]);
  assert.deepEqual(b.map(x=>x.artistName),["Drake"]);
});
