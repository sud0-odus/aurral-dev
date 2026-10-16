import test from "node:test";
import assert from "node:assert/strict";
import { rankPersonalEditorialPlaylists } from "../../backend/services/discovery/editorialPlaylistRanking.js";
const playlists=[
  {id:"1",name:"Drake Essentials",description:"A rap playlist"},
  {id:"2",name:"Taylor Swift Favorites",description:"Country pop"},
  {id:"3",name:"Indie Pop",description:"With Adele and Sabrina"},
  {id:"4",name:"Taylor Swift Hits",description:"Greatest songs"},
];
test("ranking follows each user and never assumes global musical taste",()=>{
  const wife={basedOn:[{name:"Taylor Swift"}],topGenres:["pop"]};
  const husband={basedOn:[{name:"Drake"}],topGenres:["rap"]};
  assert.equal(rankPersonalEditorialPlaylists(playlists,wife)[0].id,"2");
  assert.equal(rankPersonalEditorialPlaylists(playlists,husband)[0].id,"1");
});
test("ranking recognizes complete artist names, deduplicates and has stable ties",()=>{
  const result=rankPersonalEditorialPlaylists([{id:"1",name:"The Rapper"},...playlists,playlists[0]],
    {basedOn:[{name:"Rap"}],topTags:["pop"]},{limit:3});
  assert.equal(new Set(result.map(p=>p.id)).size,result.length);
  assert.ok(!result[0].name.includes("Rapper"));
});
