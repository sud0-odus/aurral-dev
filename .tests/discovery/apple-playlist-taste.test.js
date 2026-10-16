import test from "node:test";
import assert from "node:assert/strict";
import { getAppleMusicPlaylistSeeds } from "../../backend/services/discovery/applePlaylistTaste.js";
const apple=(owner,artists)=>({ownerUserId:owner,sourceName:"Apple Music",tracks:artists.map(artistName=>({artistName}))});
test("Apple import seeds never cross profile ownership",()=>{
  const p=[apple(2,["Taylor Swift","Luke Bryan"]),apple(3,["Drake"])];
  assert.deepEqual(getAppleMusicPlaylistSeeds(p,2).map(x=>x.artistName),["Luke Bryan","Taylor Swift"]);
  assert.deepEqual(getAppleMusicPlaylistSeeds(p,3).map(x=>x.artistName),["Drake"]);
  assert.deepEqual(getAppleMusicPlaylistSeeds(p,null),[]);
});
test("long playlists do not crowd out small playlists",()=>{
  const p=[apple(2,["Russ","Russ","Bad Bunny"]),apple(2,["Luke Bryan"]),apple(2,["Sabrina Carpenter"])];
  assert.deepEqual(getAppleMusicPlaylistSeeds(p,2,{limit:3}).map(x=>x.artistName),["Russ","Luke Bryan","Sabrina Carpenter"]);
});
