import path from 'node:path';
import fs from 'node:fs/promises';
import { dmmToken, dmmStagingRoot } from './dmmSettings.js';
import { logger } from './logger.js';
import { searchDmmAlbums, getDmmAlbum } from './dmmClient.js';
import { downloadTracker } from './downloadJobs/downloadTracker.js';
import { buildResolvedJobTrack as buildResolvedTrack, commitDownloadedFile, joinUnderRoot, buildTrackFileName, writeAudioMetadata } from './downloadUtils.js';
import { resolveDownloadRoot } from './downloadPaths.js';
import { validateDownloadedTrackFile } from './trackMatching/index.js';
import { finalizePipelineJobSuccess } from './pipelineHelpers.js';
import { isPipelinePayloadActive, withPipelineCommitLock } from './downloadJobs/downloadCancellation.js';

const RD = 'https://api.real-debrid.com/rest/1.0';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const norm = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\([^)]*\)/g,' ').replace(/\[[^\]]*\]/g,' ').replace(/^[0-9]{1,3}\s*[-._)]\s*/, '').replace(/\.(flac|mp3|m4a|aac|ogg|opus|wav|wma)$/i,'').replace(/[^a-z0-9]+/g,' ').trim();
const token = () => dmmToken();
async function rd(pathname, { method = 'GET', data } = {}) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (data) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(`${RD}${pathname}`, { method, headers, body: data ? new URLSearchParams(data) : undefined, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Real-Debrid HTTP ${response.status} at ${pathname.split('/').slice(0,3).join('/')}`);
  if (response.status === 204 && pathname.startsWith("/torrents?")) return [];
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}
// Real-Debrid can briefly return 404 while a newly added magnet becomes visible.
// Retry only that transient case; do not retry authentication or other failures.
async function getTorrentInfoWithRetry(id, payload) {
  const pathname = `/torrents/info/${encodeURIComponent(id)}`;
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt++) {
    if (!isPipelinePayloadActive(payload)) throw new Error('Job cancelled');
    try {
      return await rd(pathname);
    } catch (error) {
      lastError = error;
      if (!String(error.message || '').includes('Real-Debrid HTTP 404 at /torrents/info') || attempt === 8) break;
      await sleep(2000);
    }
  }
  if (String(lastError?.message || '').includes('Real-Debrid HTTP 404 at /torrents/info')) {
    throw new Error('Real-Debrid torrent info remained 404 after 8 checks (magnet added, but unavailable to account)');
  }
  throw lastError;
}

// RD_EXISTING_TORRENT_REUSE_V1
// Reuse completed torrents belonging to the configured RD account, with exact
// info-hash and selected file ID matching. No cross-account or public-link guessing.
async function findExistingRealDebridLink({hash, fileId, jobId, payload}) {
  const wanted = String(hash).toLowerCase();
  for (let offset = 0; offset < 1000; offset += 100) {
    if (!isPipelinePayloadActive(payload)) throw new Error('Job cancelled');
    const torrents = await rd(`/torrents?limit=100&offset=${offset}`);
    if (!Array.isArray(torrents)) throw new Error('Unexpected Real-Debrid torrent list response');
    for (const torrent of torrents) {
      if (String(torrent.hash || '').toLowerCase() !== wanted || torrent.status !== 'downloaded') continue;
      const info = await getTorrentInfoWithRetry(torrent.id, payload);
      if (String(info.hash || '').toLowerCase() !== wanted || info.status !== 'downloaded') continue;
      const selected = (info.files || []).filter(f => f.selected);
      const linkIndex = selected.findIndex(f => Number(f.id) === Number(fileId));
      if (linkIndex < 0 || !info.links?.[linkIndex]) continue;
      logger.info('dmm','Reusing completed Real-Debrid torrent',{jobId,torrentId:torrent.id});
      return {link:info.links[linkIndex],name:selected[linkIndex].path || ''};
    }
    if (torrents.length < 100) break;
  }
  return null;
}

async function acquire({ hash, fileId, jobId, payload }) {
  let id;
  let preserveFailedTorrent = false; // RD_DIAGNOSTIC_PATCH_V1
  try {
    let existing = null;
    try {
      existing = await findExistingRealDebridLink({hash,fileId,jobId,payload});
    } catch (error) {
      if (String(error.message).includes('Job cancelled')) throw error;
      logger.warn('dmm','Existing RD lookup unavailable; using magnet flow',{jobId,error:error.message});
    }
    if (existing) {
      const un = await rd('/unrestrict/link', { method:'POST', data:{link:existing.link} });
      if (!un.download) throw new Error('Existing Real-Debrid torrent returned no download URL');
      const dir = path.join(dmmStagingRoot(), String(jobId));
      await fs.mkdir(dir,{recursive:true});
      const output = path.join(dir,'track' + (path.extname(un.filename || existing.name || '') || '.flac'));
      const resp = await fetch(un.download,{signal:AbortSignal.timeout(180000)});
      if (!resp.ok || !resp.body) throw new Error(`Real-Debrid download HTTP ${resp.status}`);
      const {pipeline} = await import('node:stream/promises');
      const {Readable} = await import('node:stream');
      const {createWriteStream} = await import('node:fs');
      await pipeline(Readable.fromWeb(resp.body),createWriteStream(output));
      return output;
    }
    id = (await rd('/torrents/addMagnet', { method:'POST', data:{ magnet:`magnet:?xt=urn:btih:${hash}` }})).id;
    if (!id) throw new Error('Real-Debrid returned no torrent ID');
    const deadline = Date.now() + 8 * 60 * 1000;
    let info;
    do {
      if (!isPipelinePayloadActive(payload)) throw new Error('Job cancelled');
      info = await getTorrentInfoWithRetry(id, payload);
      if (info.files?.length) break;
      await sleep(1500);
    } while (Date.now() < deadline);
    const match = info?.files?.find(f => Number(f.id) === Number(fileId));
    if (!match) throw new Error('Real-Debrid file ID did not match DMM');
    await rd(`/torrents/selectFiles/${encodeURIComponent(id)}`, { method:'POST', data:{ files:String(fileId) }});
    let lastLoggedStatus = '';
    let lastProgressLog = 0;
    do {
      if (!isPipelinePayloadActive(payload)) throw new Error('Job cancelled');
      info = await getTorrentInfoWithRetry(id, payload);
      if (info.status !== lastLoggedStatus || Date.now() - lastProgressLog >= 30000) {
        logger.info('dmm','Real-Debrid torrent progress',{jobId,status:info.status,progress:info.progress ?? null,secondsRemaining:Math.max(0,Math.ceil((deadline-Date.now())/1000))});
        lastLoggedStatus = info.status;
        lastProgressLog = Date.now();
      }
      if (info.status === 'downloaded' && info.links?.length) break;
      if (['dead','error','virus','magnet_error'].includes(info.status)) {
        // Only log safe status fields: never URLs, magnets, filenames, links, or credentials.
        const diagnostic = {
          jobId,
          status: info.status,
          progress: typeof info.progress === 'number' ? info.progress : null,
          errorCode: typeof info.error_code === 'number' || typeof info.error_code === 'string'
            ? String(info.error_code).slice(0, 32) : null,
          error: typeof info.error === 'string' ? info.error.slice(0, 160) : null,
          torrentId: id,
        };
        logger.warn('dmm', 'Real-Debrid terminal torrent failure (retained for inspection)', diagnostic);
        preserveFailedTorrent = true;
        throw new Error(`Real-Debrid status: ${info.status}; torrent retained for inspection`);
      }
      await sleep(2000);
    } while (Date.now() < deadline);
    if (info.status !== 'downloaded') throw new Error(`Real-Debrid timeout after 8 minutes: ${info.status}`);
    const selected = info.files.filter(f => f.selected);
    const index = selected.findIndex(f => Number(f.id) === Number(fileId));
    if (index < 0 || !info.links[index]) throw new Error('No Real-Debrid link for matching audio file');
    const un = await rd('/unrestrict/link', { method:'POST', data:{ link:info.links[index] }});
    if (!un.download) throw new Error('Real-Debrid provided no download URL');
    const dir = path.join(dmmStagingRoot(), String(jobId));
    await fs.mkdir(dir, { recursive:true });
    const output = path.join(dir, 'track' + (path.extname(un.filename || match.path || '') || '.flac'));
    const resp = await fetch(un.download, { signal: AbortSignal.timeout(180000) });
    if (!resp.ok || !resp.body) throw new Error(`Real-Debrid download HTTP ${resp.status}`);
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    const { createWriteStream } = await import('node:fs');
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(output));
    return output;
  } finally {
    if (id && !preserveFailedTorrent) await rd(`/torrents/delete/${encodeURIComponent(id)}`, { method:'DELETE' }).catch(() => {});
  }
}
function matchTrack(album, requested) {
  const target = norm(requested.title || requested.trackName || requested.name);
  return (album.tracks || []).find(t => norm(t.filename) === target) || null;
}
async function search(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  const request = buildResolvedTrack(job, payload.track);
  const artist = request.artistName || job.artistName;
  const albumName = request.albumName || job.albumName;
  const albums = payload.dmmHash
    ? [await getDmmAlbum(payload.dmmHash)]
    : (await searchDmmAlbums(`${artist} ${albumName || ''}`.trim(), 48)).albums
      .filter(a => norm(a.artist) === norm(artist) && (!albumName || norm(a.album) === norm(albumName)));
  const matches = [];
  for (const item of albums.slice(0,5)) {
    const album = await getDmmAlbum(item.hash);
    const track = matchTrack(album, { title: request.title || request.trackName || job.trackName });
    if (track) matches.push({hash:album.hash, fileId:track.fileId, filename:track.filename, albumName:album.album});
  }
  if (!matches.length) return helpers.failOrTryNextSource(payload, job, 'No exact DMM album/track match');
  logger.info('dmm','Matched music catalog candidate',{jobId:job.id,candidateCount:matches.length});
  return {...payload, source:'dmm', phase:'download', dmmCandidates:matches, dmmCandidateIndex:0};
}
async function download(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  const c = payload.dmmCandidates?.[payload.dmmCandidateIndex || 0];
  if (!c) return helpers.failOrTryNextSource(payload, job, 'No DMM candidate');
  let file;
  downloadTracker.updateDownloadMetadata(job.id, {downloadSource:'dmm', downloadClient:'realdebrid', remoteFilename:c.filename, releaseGuid:c.hash});
  try { file = await acquire({ ...c, jobId:job.id, payload }); }
  catch (err) { logger.warn('dmm','Real-Debrid acquisition failed',{jobId:job.id,error:err.message}); return helpers.failOrTryNextSource(payload, job, `DMM download failed: ${err.message}`); }
  if (!isPipelinePayloadActive(payload)) { await fs.rm(path.dirname(file), {recursive:true,force:true}); return null; }
  logger.info('dmm','Acquired audio; entering validation',{jobId:job.id,filename:c.filename});
  downloadTracker.updateDownloadMetadata(job.id, {downloadSource:'dmm', downloadClient:'realdebrid', remoteFilename:c.filename, releaseGuid:c.hash});
  return {...payload, source:'dmm', phase:'finalize', downloadedPath:file};
}
async function finalize(payload, helpers) {
  const job = downloadTracker.getJob(payload.jobId);
  if (!job) return null;
  const c = payload.dmmCandidates?.[payload.dmmCandidateIndex || 0];
  const request = buildResolvedTrack(job,payload.track);
  const file = payload.downloadedPath;
  if (!file || !isPipelinePayloadActive(payload)) {
    if (file) await fs.rm(path.dirname(file), {recursive:true,force:true});
    return null;
  }
  const validation = await validateDownloadedTrackFile({request, filePath:file, source:'dmm', options:{strict:true}});
  if (!validation.valid) { logger.warn('dmm','Audio validation failed',{jobId:job.id,reason:validation.reason}); await fs.rm(path.dirname(file), {recursive:true,force:true}); return helpers.failOrTryNextSource(payload,job,`DMM validation failed: ${validation.reason}`); }
  const finalDir = joinUnderRoot(resolveDownloadRoot(),String(payload.destination || '').trim());
  const dest = path.join(finalDir,buildTrackFileName(job,path.extname(file)));
  const committed = await withPipelineCommitLock(payload, async () => {
    await writeAudioMetadata(file, request);
    const finalPath = await commitDownloadedFile(file,dest);
    await fs.rm(path.dirname(file),{recursive:true,force:true});
    return finalizePipelineJobSuccess({downloadTracker,job,committedFinalPath:finalPath,album:c.albumName,quality:validation.quality});
  });
  if (!committed.cancelled) logger.info('dmm','Track imported',{jobId:job.id,finalPath:dest});
  if (committed.cancelled) {
    await fs.rm(path.dirname(file), {recursive:true,force:true});
    return null;
  }
  return committed.result;
}
export async function processDmmPipelinePayload(payload,helpers={}) {
  if (!token()) return helpers.failOrTryNextSource(payload,downloadTracker.getJob(payload.jobId),'DMM Real-Debrid token missing');
  if (!isPipelinePayloadActive(payload)) return null;
  try {
    if (payload.phase === 'search') return await search(payload,helpers);
    if (payload.phase === 'download') return await download(payload,helpers);
    if (payload.phase === 'finalize') return await finalize(payload,helpers);
    throw new Error(`Unknown DMM phase: ${payload.phase}`);
  } catch(err) {
    const job=downloadTracker.getJob(payload.jobId);
    if (!job) return null;
    return helpers.failOrTryNextSource(payload,job,`DMM error: ${err.message}`);
  }
}
