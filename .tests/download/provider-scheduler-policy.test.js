import test from 'node:test';
import assert from 'node:assert/strict';
import { planProviderDispatch, normalizeProviderPolicies, decideFailureAction, classifyProviderFailure } from '../../backend/services/downloadJobs/providerSchedulerPolicy.js';
const job = (id, options = {}) => ({ id: String(id), playlistId: 'one', state: 'queued', createdAt: Number(id), ...options });
const provider = (id, maxActive = 3, priority = 10, options = {}) => ({ id, maxActive, priority, ...options });
test('fills independent 3+3+3 capacity limits', () => {
  const result = planProviderDispatch({ jobs: Array.from({ length: 12 }, (_, i) => job(i + 1)), providers: [provider('slskd'), provider('ytdlp', 3, 20), provider('sabnzbd', 3, 30)] });
  assert.equal(result.assignments.length, 9);
  for (const id of ['slskd', 'ytdlp', 'sabnzbd']) assert.equal(result.assignments.filter((a) => a.providerId === id).length, 3);
  assert.equal(result.deferredJobIds.length, 3);
});
test('spillover and prompt refill', () => {
  const providers = [provider('slskd', 2, 1, { active: 2 }), provider('ytdlp', 2, 2)];
  assert.equal(planProviderDispatch({ jobs: [job(1)], providers }).assignments[0].providerId, 'ytdlp');
  providers[0].active = 1;
  assert.equal(planProviderDispatch({ jobs: [job(1)], providers }).assignments[0].providerId, 'slskd');
});
test('SABnzbd and NZBGet use independent capacities', () => {
  const result = planProviderDispatch({ jobs: [job(1), job(2), job(3), job(4)], providers: [provider('sabnzbd', 2), provider('nzbget', 2, 11)] });
  assert.deepEqual(result.assignments.map((a) => a.downloadClient), ['sabnzbd', 'sabnzbd', 'nzbget', 'nzbget']);
  assert.ok(result.assignments.every((a) => a.source === 'usenet'));
});
test('cooldown, disabled providers, type and allowed-source filtering', () => {
  const result = planProviderDispatch({ jobs: [job(1, { albumGrab: true, allowedSources: ['dmm', 'usenet'] })], now: 100, providers: [provider('ytdlp', 3, 1), provider('sabnzbd', 3, 2, { cooldownUntil: 200 }), provider('dmm', 1, 3)] });
  assert.equal(result.assignments[0].providerId, 'dmm');
});
test('fallback to another usenet client, without duplicate simultaneous attempt', () => {
  const result = planProviderDispatch({ jobs: [job(1, { triedProviders: ['sabnzbd'] }), job(2)], providers: [provider('sabnzbd', 1), provider('nzbget', 1, 20)], activeAttempts: [{ jobId: '2', state: 'downloading' }] });
  assert.deepEqual(result.assignments.map((a) => [a.jobId, a.providerId]), [['1', 'nzbget']]);
});
test('fair scheduling across playlists', () => {
  const jobs = [...Array.from({ length: 5 }, (_, i) => job(i + 1, { playlistId: 'large' })), job(6, { playlistId: 'small' })];
  assert.deepEqual(planProviderDispatch({ jobs, providers: [provider('slskd', 3)] }).assignments.map((a) => a.jobId), ['1', '6', '2']);
});
test('paused, cancelled, and not-yet-ready work excluded', () => {
  const result = planProviderDispatch({ jobs: [job(1, { paused: true }), job(2, { state: 'cancelled' }), job(3, { readyAt: 200 }), job(4)], now: 100, providers: [provider('slskd')] });
  assert.deepEqual(result.assignments.map((a) => a.jobId), ['4']);
});
test('retries bounded with correct fallback classification', () => {
  assert.equal(decideFailureAction({ error: { code: 'timeout' }, attemptNumber: 1, maxRetries: 2, now: 100, baseBackoffMs: 1000 }).retryAt, 1100);
  assert.equal(decideFailureAction({ error: { code: 'timeout' }, attemptNumber: 3, maxRetries: 2, hasFallback: true }).action, 'fallback');
  assert.equal(decideFailureAction({ error: { code: 'no_match' }, hasFallback: true }).action, 'fallback');
  assert.equal(decideFailureAction({ error: { code: 'cancelled' } }).action, 'cancel');
  assert.equal(classifyProviderFailure({ status: 401 }), 'auth');
  assert.equal(classifyProviderFailure({ status: 429 }), 'rate_limit');
});
test('duplicate or unknown provider rejects configuration', () => {
  assert.throws(() => normalizeProviderPolicies([provider('bogus')]));
  assert.throws(() => normalizeProviderPolicies([provider('slskd'), provider('slskd')]));
});
