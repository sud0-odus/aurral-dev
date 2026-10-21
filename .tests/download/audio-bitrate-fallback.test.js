import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAudioWithBitrate } from "../../backend/services/trackMatching/audioBitrateFallback.js";
import { classifyAudioQuality, getQualityState, normalizeQualityProfile } from "../../backend/services/qualityProfileModel.js";

test("ffprobe fallback preserves measured Opus bitrate and classifies 106 kbps as Opus 96", async () => {
  const parsed = await parseAudioWithBitrate("/tmp/example.webm", {
    parse: async () => ({ format: { codec: "OPUS", container: "EBML/webm", sampleRate: 48000 } }),
    probe: async (_binary, args) => {
      assert.ok(args.includes("-of"));
      return { stdout: JSON.stringify({ streams: [{ codec_name: "opus" }], format: { bit_rate: "106064" } }) };
    },
  });
  const quality = classifyAudioQuality(parsed, "/tmp/example.webm");
  assert.equal(quality.bitrateKbps, 106);
  assert.equal(quality.tier, "opus-96");
  const profile = normalizeQualityProfile({ cutoff: "m4a-320", enabled: ["m4a-320"] });
  assert.equal(getQualityState(quality, profile), "below-floor");
});

test("unknown bitrate stays unknown when ffprobe fails", async () => {
  const parsed = await parseAudioWithBitrate("/tmp/example.webm", {
    parse: async () => ({ format: { codec: "Opus", container: "WebM" } }),
    probe: async () => { throw Error("ffprobe unavailable"); },
  });
  assert.equal(classifyAudioQuality(parsed, "/tmp/example.webm").tier, null);
});

test("known bitrate does not invoke ffprobe", async () => {
  const parsed = await parseAudioWithBitrate("/tmp/example.m4a", {
    parse: async () => ({ format: { codec: "AAC", bitrate: 256000 } }),
    probe: async () => { assert.fail("should not probe"); },
  });
  assert.equal(parsed.format.bitrate, 256000);
});
