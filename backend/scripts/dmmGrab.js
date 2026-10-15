#!/usr/bin/env node
// Submit exactly one track from a DMM release to Aurral's shared Honker pipeline.
import { getDmmAlbum } from '../services/dmmClient.js';
import { downloadTracker } from '../services/downloadJobs/downloadTracker.js';
import { getEnabledDownloadSources } from '../services/downloadSourceService.js';

const url = process.argv[2] || '';
const trackArg = process.argv.indexOf('--track');
const trackNumber = trackArg >= 0 ? Number(process.argv[trackArg + 1]) : NaN;
const hash = /^https:\/\/debridmediamanager\.com\/(?:music|albums)\/([a-f0-9]{40})\/?(?:[?#].*)?$/i.exec(url)?.[1];
if (!hash || !Number.isInteger(trackNumber) || trackNumber < 1) {
  console.error('USAGE=node backend/scripts/dmmGrab.js https://debridmediamanager.com/music/<40-char-hash> --track 1');
  process.exit(2);
}
if (!getEnabledDownloadSources().some(x => x.id === 'dmm')) {
  console.error('DMM_PROVIDER=NOT_CONFIGURED');
  process.exit(3);
}
const album = await getDmmAlbum(hash);
const tracks = (album.tracks || []).filter(x => /\.(flac|mp3|m4a|aac|ogg|opus|wav|wma)$/i.test(x.filename || ''));
const chosen = tracks.find(x => Number(x.trackNumber) === trackNumber) || tracks[trackNumber - 1];
if (!chosen) throw new Error('DMM release does not contain that track number');
const trackName = String(chosen.filename).replace(/^\d{1,3}\s*[-._)]\s*/, '').replace(/\.[a-z0-9]+$/i, '').trim();
if (!trackName || !album.artist || !album.album) throw new Error('Incomplete DMM album metadata');
// Resolve an independent duration reference before asking the shared validator to
// compare a downloaded file. Never use the downloaded file's own duration as truth.
const clean = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function mbJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers: {
        Accept: 'application/json', 'User-Agent': 'Aurral/1.0 (DMM metadata validation; self-hosted)'
      }, signal: AbortSignal.timeout(18000) });
      if (response.ok) return response.json();
      const error = new Error(`MusicBrainz HTTP ${response.status}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw error;
      lastError = error;
      if (attempt === 3) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(10000, retryAfter * 1000) : 1500 * (attempt + 1);
      await sleep(wait);
    } catch (error) {
      lastError = error;
      if (/HTTP (400|401|403|404|422)/.test(error.message) || attempt === 3) break;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}
async function deezerDuration(album, chosen, trackName) {
  const query = `${album.artist} ${trackName}`;
  const endpoint = `https://api.deezer.com/search/track?q=${encodeURIComponent(query)}&limit=100`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(18000) });
  if (!response.ok) throw new Error(`Deezer HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`Deezer catalog unavailable (${body.error.code || 'API'})`);
  const candidates = (body.data || []).filter(r =>
    clean(r.title_short || r.title) === clean(trackName) &&
    clean(r.artist?.name) === clean(album.artist) &&
    clean(r.album?.title) === clean(album.album) &&
    Number(r.duration) >= 30
  );
  const durations = [...new Set(candidates.map(r => Number(r.duration) * 1000))];
  if (durations.length === 1) return {ms:durations[0], method:'deezer_catalog'};
  return null;
}
async function findReferenceDuration(album, chosen, trackName) {
  const mbid = String(album.mbid || '');
  if (/^[0-9a-f-]{36}$/i.test(mbid)) {
    try {
      // DMM's MBID may be a release-group ID, not a release ID.
      let releases = [];
      try {
        const release = await mbJson(`https://musicbrainz.org/ws/2/release/${mbid}?inc=recordings&fmt=json`);
        releases = [release];
      } catch (err) {
        if (!/HTTP 404/.test(err.message)) throw err;
        const group = await mbJson(`https://musicbrainz.org/ws/2/release-group/${mbid}?inc=releases&fmt=json`);
        releases = await Promise.all((group.releases || []).slice(0, 8).map(async r => {
          try { return await mbJson(`https://musicbrainz.org/ws/2/release/${r.id}?inc=recordings&fmt=json`); }
          catch { return null; }
        }));
      }
      const found = [];
      for (const release of releases.filter(Boolean)) for (const medium of release.media || []) {
        for (const entry of medium.tracks || []) {
          if (clean(entry.title || entry.recording?.title) !== clean(trackName)) continue;
          const ms = Number(entry.length || entry.recording?.length);
          if (Number.isFinite(ms) && ms >= 30000) found.push(ms);
        }
      }
      const values = [...new Set(found)];
      if (values.length === 1) return {ms:values[0],method:'release'};
    } catch (error) { console.error('DURATION_RELEASE_LOOKUP=' + error.message); }
  }

  try {
    // Search recordings by artist and title. Some legitimate releases have no
    // MusicBrainz release link, despite the recording itself being indexed.
    const term = `recording:"${trackName.replaceAll('"','')}" AND artist:"${album.artist.replaceAll('"','')}"`;
    const params = new URLSearchParams({query:term,fmt:'json',limit:'100'});
    const result = await mbJson(`https://musicbrainz.org/ws/2/recording/?${params}`);
    const matches = (result.recordings || []).filter(r =>
      clean(r.title) === clean(trackName) && Number(r.length) >= 30000);
    const albumMatches = matches.filter(r =>
      (r.releases || []).some(x => clean(x.title) === clean(album.album)));
    for (const group of [albumMatches, matches]) {
      // A single duration is unambiguous. Conflicting editions are not.
      const durations = [...new Set(group.map(r => Number(r.length)))];
      if (durations.length === 1) return {ms:durations[0],method:'recording'};
    }
  } catch (error) { console.error('DURATION_RECORDING_LOOKUP=' + error.message); }

  // Independently identify the recording across Apple/Deezer. Compilation album
  // names vary by territory; album-exact evidence takes precedence, otherwise
  // require agreement from *both* catalogs on the same length (within 2s).
  const catalogCandidates = [];
  const usable = ms => Number.isFinite(ms) && ms >= 30000 && ms <= 3600000;
  const albumMatches = title => clean(title) === clean(album.album);
  const appleQuery = new URLSearchParams({term:`${album.artist} ${trackName}`,entity:'song',limit:'200'});
  try {
    const response = await fetch(`https://itunes.apple.com/search?${appleQuery}`, {
      headers: {'Accept':'application/json'}, signal:AbortSignal.timeout(18000),
    });
    if (!response.ok) throw new Error(`Apple catalog HTTP ${response.status}`);
    const data = await response.json();
    for (const r of data.results || []) {
      const ms = Number(r.trackTimeMillis);
      if (r.wrapperType !== 'track' || !usable(ms) ||
          clean(r.artistName) !== clean(album.artist) ||
          clean(r.trackName) !== clean(trackName)) continue;
      catalogCandidates.push({source:'apple', ms, exactAlbum:albumMatches(r.collectionName)});
    }
  } catch (error) { console.error('DURATION_CATALOG_LOOKUP=' + error.message); }
  try {
    const query = new URLSearchParams({q:`${album.artist} ${trackName}`, limit:'100'});
    const response = await fetch(`https://api.deezer.com/search/track?${query}`, {signal:AbortSignal.timeout(18000)});
    if (!response.ok) throw new Error(`Deezer HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`Deezer catalog unavailable (${body.error.code || 'API'})`);
    for (const r of body.data || []) {
      const ms = Number(r.duration) * 1000;
      if (!usable(ms) || clean(r.title_short || r.title) !== clean(trackName) ||
          clean(r.artist?.name) !== clean(album.artist)) continue;
      catalogCandidates.push({source:'deezer', ms, exactAlbum:albumMatches(r.album?.title)});
    }
  } catch (error) { console.error('DURATION_DEEZER_LOOKUP=' + error.message); }
  // Prefer compilation-exact references only when they form one tight group.
  const exact = catalogCandidates.filter(r => r.exactAlbum);
  if (exact.length) {
    const values = exact.map(r => r.ms);
    if (Math.max(...values) - Math.min(...values) <= 2000)
      return {ms:Math.round(values.reduce((a,b)=>a+b,0)/values.length),method:'exact_compilation_catalog'};
  }
  // When the compilation is absent from catalogs, require two *independent*
  // sources to agree and reject ambiguous competing cross-catalog versions.
  const apple = catalogCandidates.filter(r => r.source === 'apple');
  const deezer = catalogCandidates.filter(r => r.source === 'deezer');
  const consensus = [];
  for (const a of apple) for (const d of deezer) {
    if (Math.abs(a.ms - d.ms) <= 2000)
      consensus.push(Math.round((a.ms + d.ms)/2));
  }
  if (consensus.length && Math.max(...consensus) - Math.min(...consensus) <= 2000)
    return {ms:Math.round(consensus.reduce((a,b)=>a+b,0)/consensus.length),method:'apple_deezer_consensus'};
  console.error('DURATION_CATALOG_CANDIDATES=apple:' + apple.length + ',deezer:' + deezer.length + ',exact_album:' + exact.length);
  throw new Error('No unambiguous independent reference duration; job not submitted (MusicBrainz, Apple and Deezer checked)');
}
const reference = await findReferenceDuration(album, chosen, trackName);
console.log('DMM_REFERENCE_DURATION_MS=' + reference.ms);
console.log('DMM_DURATION_SOURCE=' + reference.method);
const jobId = downloadTracker.addJob({
  artistName: album.artist,
  albumName: album.album,
  albumMbid: album.mbid || null,
  trackName,
  trackNumber,
  durationMs: reference.ms,
  albumTrackCount: album.trackCount,
  reason: 'DMM CLI one-track test',
}, 'library', {playlistId:'library'});
if (!jobId) throw new Error('Failed to create track job');
try {
  if (!downloadTracker.enqueueDmmOnly(jobId, hash)) throw new Error('Shared pipeline refused the job');
} catch (error) {
  downloadTracker.setFailed(jobId, `DMM CLI enqueue failed: ${error.message}`);
  throw error;
}
console.log('===COPY FROM HERE===');
console.log('DMM_CLI=QUEUED');
console.log('JOB_ID=' + jobId);
console.log('ARTIST=' + album.artist);
console.log('ALBUM=' + album.album);
console.log('TRACK=' + trackName);
console.log('DMM_HASH=' + hash);
console.log('ALLOWED_SOURCES=dmm');
console.log('QUEUE=slskd-pipeline (shared)');
console.log('===TO HERE===');
