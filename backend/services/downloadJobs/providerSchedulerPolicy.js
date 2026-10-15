// Pure scheduling policy. Persistence, client telemetry and atomic claims belong
// to the dispatcher; this module never starts a download or changes a job.
export const PROVIDER_SOURCES = Object.freeze({
  slskd: 'slskd',
  ytdlp: 'ytdlp',
  sabnzbd: 'usenet',
  nzbget: 'usenet',
  deemix: 'deemix',
  dmm: 'dmm',
});

const ACTIVE_STATES = new Set(['scheduled', 'dispatched', 'searching', 'downloading', 'validating', 'importing']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const ALBUM_CLIENTS = new Set(['slskd', 'sabnzbd', 'nzbget', 'deemix', 'dmm']);

function boundedInt(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

export function normalizeProviderPolicies(providers = []) {
  const seen = new Set();
  return providers.map((provider) => {
    const id = String(provider?.id || '').trim().toLowerCase();
    if (!Object.hasOwn(PROVIDER_SOURCES, id) || seen.has(id)) {
      throw new Error(`Invalid or duplicate download provider: ${id}`);
    }
    seen.add(id);
    return {
      id,
      source: PROVIDER_SOURCES[id],
      enabled: provider.enabled !== false && provider.configured !== false,
      priority: boundedInt(provider.priority, 50, -1000, 1000),
      maxActive: boundedInt(provider.maxActive, 1, 1, 32),
      active: boundedInt(provider.active, 0, 0, 100000),
      cooldownUntil: boundedInt(provider.cooldownUntil, 0, 0, Number.MAX_SAFE_INTEGER),
      supportedJobTypes: Array.isArray(provider.supportedJobTypes)
        ? provider.supportedJobTypes.filter((type) => type === 'track' || type === 'album')
        : (ALBUM_CLIENTS.has(id) ? ['track', 'album'] : ['track']),
    };
  }).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function orderedFairJobs(jobs) {
  const byOwner = new Map();
  for (const job of jobs) {
    const owner = String(job.playlistId || job.playlistType || 'unowned');
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(job);
  }
  const owners = [...byOwner.keys()];
  for (const queue of byOwner.values()) {
    queue.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
      || String(a.id).localeCompare(String(b.id)));
  }
  const result = [];
  while (owners.length) {
    for (let i = 0; i < owners.length;) {
      const queue = byOwner.get(owners[i]);
      result.push(queue.shift());
      if (queue.length === 0) owners.splice(i, 1);
      else i++;
    }
  }
  return result;
}

function canUse(job, provider) {
  if (!provider.enabled || provider.supportedJobTypes.length === 0) return false;
  if (!provider.supportedJobTypes.includes(job.albumGrab === true ? 'album' : 'track')) return false;
  const allowed = Array.isArray(job.allowedSources) ? job.allowedSources : null;
  if (allowed && !allowed.includes(provider.id) && !allowed.includes(provider.source)) return false;
  const tried = Array.isArray(job.triedProviders) ? job.triedProviders : [];
  if (tried.includes(provider.id)) return false;
  const excluded = Array.isArray(job.excludedProviders) ? job.excludedProviders : [];
  return !excluded.includes(provider.id);
}

/**
 * Make deterministic capacity reservations for eligible jobs. Every assignment
 * is advisory: the persistence adapter must atomically claim job+attempt and
 * reserve the provider slot before enqueueing the provider operation.
 * External active work must be included in providers[].active by the caller.
 */
export function planProviderDispatch({ jobs = [], providers = [], activeAttempts = [], now = Date.now(), maxAssignments = 256 } = {}) {
  const ordered = normalizeProviderPolicies(providers);
  const activeByProvider = new Map(ordered.map((provider) => [provider.id, provider.active]));
  const busyJobIds = new Set();
  for (const attempt of activeAttempts) {
    if (!ACTIVE_STATES.has(attempt?.state)) continue;
    if (attempt.jobId != null) busyJobIds.add(String(attempt.jobId));
    // The externally supplied active count might already include the attempts.
    // It is authoritative so it is not incremented again here.
  }
  const uniqueJobs = new Set();
  const readyJobs = [];
  for (const job of jobs) {
    const id = String(job?.id || '');
    if (!id || uniqueJobs.has(id)) continue;
    uniqueJobs.add(id);
    if (busyJobIds.has(id) || TERMINAL_STATES.has(job.state) || ACTIVE_STATES.has(job.state)) continue;
    if (job.state && !['queued', 'retry_waiting', 'pending'].includes(job.state)) continue;
    if (Number(job.readyAt || 0) > now || job.paused === true) continue;
    readyJobs.push(job);
  }
  const assignments = [];
  const deferredJobIds = [];
  for (const job of orderedFairJobs(readyJobs)) {
    if (assignments.length >= Math.max(0, maxAssignments)) {
      deferredJobIds.push(String(job.id));
      continue;
    }
    const available = ordered.find((provider) =>
      canUse(job, provider)
      && provider.cooldownUntil <= now
      && activeByProvider.get(provider.id) < provider.maxActive);
    if (!available) {
      deferredJobIds.push(String(job.id));
      continue;
    }
    activeByProvider.set(available.id, activeByProvider.get(available.id) + 1);
    assignments.push({ jobId: String(job.id), providerId: available.id, source: available.source,
      ...(available.source === 'usenet' ? { downloadClient: available.id } : {}) });
  }
  return {
    assignments,
    deferredJobIds,
    providers: ordered.map((provider) => ({
      id: provider.id, source: provider.source, active: activeByProvider.get(provider.id),
      maxActive: provider.maxActive, available: Math.max(0, provider.maxActive - activeByProvider.get(provider.id)),
      cooldownUntil: provider.cooldownUntil,
    })),
  };
}

export function classifyProviderFailure(error) {
  const code = String(error?.code || error?.type || '').toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (code === 'cancelled' || code === 'abort_err' || code === 'aborterror') return 'cancelled';
  if (status === 401 || status === 403 || code === 'authentication') return 'auth';
  if (status === 429 || code === 'rate_limit') return 'rate_limit';
  if (code === 'no_match' || code === 'not_found') return 'no_match';
  if (code === 'validation' || code === 'invalid_media') return 'validation';
  if (code === 'rejected') return 'rejected';
  if (code === 'timeout' || ['etimedout', 'esockettimedout'].includes(code)) return 'timeout';
  if (status >= 500 || ['econnreset', 'econnrefused', 'enotfound', 'network', 'unavailable'].includes(code)) return 'unavailable';
  return 'unknown';
}

export function decideFailureAction({ error, attemptNumber = 1, maxRetries = 2, hasFallback = false, now = Date.now(), baseBackoffMs = 5000 } = {}) {
  const reason = classifyProviderFailure(error);
  if (reason === 'cancelled') return { action: 'cancel', reason };
  if (reason === 'no_match' || reason === 'validation' || reason === 'rejected') {
    return { action: hasFallback ? 'fallback' : 'fail', reason };
  }
  if (reason === 'auth') return { action: hasFallback ? 'fallback' : 'fail', reason, coolDown: true };
  const retryLimit = boundedInt(maxRetries, 2, 0, 20);
  const current = boundedInt(attemptNumber, 1, 1, 1000);
  if (current <= retryLimit) {
    return { action: 'retry', reason,
      retryAt: now + Math.min(60 * 60 * 1000, Math.max(1000, baseBackoffMs) * 2 ** (current - 1)),
      coolDown: reason === 'rate_limit' || reason === 'unavailable' };
  }
  return { action: hasFallback ? 'fallback' : 'fail', reason,
    coolDown: reason === 'rate_limit' || reason === 'unavailable' };
}
