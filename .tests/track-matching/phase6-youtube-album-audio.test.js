import test from "node:test";
import assert from "node:assert/strict";
import { parseYoutubeTitle } from "../../backend/services/trackMatching/youtubeEvidence.js";
import { buildSourceCandidates } from "../../backend/services/trackMatching/index.js";

test("phase6: official soundtrack audio attribution is not part of song title", async () => {
  const raw = { id: "L3NgbB0fqeg", title: "Ari Lennox, J. Cole - Shea Butter Baby (From Creed II: The Album/Audio)", channel: "Ari Lennox" };
  const p = parseYoutubeTitle(raw.title, ["Ari Lennox & J. Cole"], "Shea Butter Baby");
  assert.equal(p.title, "Shea Butter Baby");
  const result = await buildSourceCandidates({source: "ytdlp", request: {artistName: "Ari Lennox & J. Cole", trackName:"Shea Butter Baby"}, results:[raw]});
  assert.notEqual(result.evaluations[0].decision, "reject");
});

test("phase6: genuine recording-version descriptors stay visible", () => {
  const p = parseYoutubeTitle("Ari Lennox - Shea Butter Baby (Live)", ["Ari Lennox"], "Shea Butter Baby");
  assert.match(p.versionTitle, /Live/i);
});

test("phase6: same title from an unrelated channel is not made acceptable", async () => {
  const raw = {title:"Another Artist - Shea Butter Baby (From Another Album/Audio)", channel:"Another Artist"};
  const result = await buildSourceCandidates({source:"ytdlp", request:{artistName:"Ari Lennox & J. Cole",trackName:"Shea Butter Baby"},results:[raw]});
  assert.equal(result.evaluations[0].decision, "reject");
});
