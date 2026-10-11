import test from "node:test";
import assert from "node:assert/strict";
import { boundedSimilarityEvidence, rerankRecommendations } from "../../backend/services/discovery/recommendationPipeline.js";

test("unverified co-listening evidence is capped per independent seed", () => {
  assert.equal(boundedSimilarityEvidence({scoreSimilarity: 590, scoreTagAffinity: 0, seedCount: 5}), 425);
  assert.equal(boundedSimilarityEvidence({scoreSimilarity: 1364, scoreTagAffinity: 0, seedCount: 18}), 1364);
  assert.equal(boundedSimilarityEvidence({scoreSimilarity: 590, scoreTagAffinity: 20, seedCount: 5}), 590);
  assert.equal(boundedSimilarityEvidence({scoreSimilarity: 42}), 42);
});

test("weak co-listening alone does not outrank broader independent support", () => {
  const candidate = (name, scoreSimilarity, seedCount) => ({
    id: name, name, scoreSimilarity, seedCount, scoreTagAffinity: 0,
    scoreSeedCoverage: 0, scoreNovelty: 0, scorePopularityPenalty: 0,
    supportingSeeds: Array.from({length: seedCount}, (_, i) => ({artistName: `Seed ${name} ${i}`})),
  });
  const ranked = rerankRecommendations([
    candidate("Sparse", 590, 5), candidate("Broad", 520, 10),
  ], 2, { discoveryMode: "balanced" });
  assert.deepEqual(ranked.map(x => x.name), ["Broad", "Sparse"]);
});
