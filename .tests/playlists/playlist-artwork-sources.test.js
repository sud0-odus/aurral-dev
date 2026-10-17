import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import axios from "../../lib/axiosFetch.js";
import { getPlaylistArtworkSources, isTrustedArtworkUrl } from "../../backend/services/playlistArtworkSources.js";
import { buildGeneratedPlaylistArtworkBuffer } from "../../backend/services/playlistArtworkGenerator.js";

const cover = id => "https://e-cdns-images.dzcdn.net/images/cover/" + id + "/250x250.jpg";
test("selects actual artists and distinct album art; never mixes another playlist", () => {
  const ownerA = getPlaylistArtworkSources({tracks:[
    {artistName:"Ms. Rachel",albumName:"Songs for Littles",artworkUrl:cover("rachel")},
    {artistName:"Ms. Rachel",albumName:"Songs for Littles",artworkUrl:cover("rachel")},
    {artistName:"Daft Punk",albumName:"Discovery",artworkUrl:cover("daft")},
  ]});
  const ownerB = getPlaylistArtworkSources({tracks:[
    {artistName:"Taylor Swift",albumName:"Midnights",artworkUrl:cover("taylor")},
  ]});
  assert.deepEqual(ownerA.imageUrls,[cover("rachel"),cover("daft")]);
  assert.deepEqual(ownerA.artistNames,["Ms. Rachel","Daft Punk"]);
  assert.deepEqual(ownerB.imageUrls,[cover("taylor")]);
  assert.deepEqual(ownerB.artistNames,["Taylor Swift"]);
  assert.deepEqual(getPlaylistArtworkSources({relatedArtists:["Slowdive","Ride"]}).artistNames,["Slowdive","Ride"]);
});
test("rejects private images, unknown domains, HTTP and credentialed links",()=>{
  for (const url of ["http://e-cdns-images.dzcdn.net/images/cover/a",
    "https://localhost/a","https://192.168.1.1/a",
    "https://e-cdns-images.dzcdn.net.evil.org/a",
    "https://user:password@e-cdns-images.dzcdn.net/a"]) assert.equal(isTrustedArtworkUrl(url),false);
  assert.equal(isTrustedArtworkUrl(cover("good")),true);
});
test("photo mode derives artwork from multiple album covers, never stock photos", async t => {
  const px = await sharp({create:{width:32,height:32,channels:3,background:"#386060"}}).jpeg().toBuffer();
  const requests=[];
  t.mock.method(axios,"get",async(url,options)=>{
    requests.push({url,options});return {data:px};
  });
  const image=await buildGeneratedPlaylistArtworkBuffer({title:"Family Mix",kind:"Playlist",
    style:"photo",paletteSeed:"owner:1",imageUrls:[cover("one"),cover("two")]});
  const meta=await sharp(image).metadata();
  assert.equal(meta.format,"jpeg");
  assert.equal(meta.width,1200);
  assert.equal(requests.length,2);
  assert.ok(requests.every(({url,options})=>url.includes("dzcdn.net")&&options.maxRedirects===0));
  await assert.rejects(buildGeneratedPlaylistArtworkBuffer({title:"No Cover",style:"photo",imageUrls:[]}),
    /No usable album artwork/);
});
