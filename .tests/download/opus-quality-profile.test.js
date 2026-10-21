import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAudioQuality, getQualityState, normalizeQualityProfile, QUALITY_TIERS } from "../../backend/services/qualityProfileModel.js";

test("classifies native Opus/WebM without pretending it is AAC or FLAC", () => {
  const opus = classifyAudioQuality({ format: { container: "WebM", codec: "Opus", sampleRate: 48000, bitrate: 160000, lossless: false } }, "/tmp/example.webm");
  assert.equal(opus.tier, "opus-128");
  assert.equal(opus.format, "opus");
  const high = classifyAudioQuality({ format: { container: "Ogg", codec: "Opus", bitrate: 256000, lossless: false } }, "/tmp/example.opus");
  assert.equal(high.tier, "opus-256");
  const flac = classifyAudioQuality({ format: { container: "FLAC", codec: "FLAC", sampleRate: 44100, bitsPerSample: 16, lossless: true } }, "/tmp/example.flac");
  assert.equal(flac.tier, "flac-standard");
});

test("existing profile does not silently accept new Opus tiers", () => {
  const existing = normalizeQualityProfile({ order: ["flac-standard", "m4a-320"], enabled: ["flac-standard", "m4a-320"], cutoff: "m4a-320" });
  assert.equal(existing.enabled.includes("opus-128"), false);
  assert.equal(getQualityState({ tier: "opus-128" }, existing), "below-floor");
  assert.ok(QUALITY_TIERS.some((tier) => tier.id === "opus-128"));
});

test("Opus below the cutoff can be allowed as an upgrade candidate", () => {
  const profile = normalizeQualityProfile({
    order: ["flac-standard", "m4a-320", "opus-256", "opus-192", "opus-128"],
    enabled: ["flac-standard", "m4a-320", "opus-256", "opus-192", "opus-128"],
    cutoff: "m4a-320",
  });
  assert.equal(getQualityState({ tier: "opus-128" }, profile), "upgrade");
});
