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
import { albumGrabJobs, finishAlbumGrab } from './albumGrab.js';

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

// DMM_CATALOG_FASTPATH_V1: use the existing file link supplied by DMM before creating a magnet.
// Never print the link, token or unrestricted download URL in logs.
async function tryCatalogLink({link, hash, fileId, expectedBytes, jobId, payload}) {
  if (!link) return null;
  const catalogUrl = new URL(link);
  if (catalogUrl.protocol !== 'https:' || !['real-debrid.com', 'www.real-debrid.com'].includes(catalogUrl.hostname) ||
      !/^\/d\/[A-Za-z0-9]+$/.test(catalogUrl.pathname)) throw new Error('Invalid DMM catalog file link');
  let un;
  try {
    un = await rd('/unrestrict/link', {method:'POST',data:{link}});
    if (!un.download) throw new Error('No direct Real-Debrid download URL');
    logger.info('dmm','DMM catalog link unrestricted directly',{jobId});
  } catch (directError) {
    if (!isPipelinePayloadActive(payload)) throw new Error('Job cancelled');
    logger.info('dmm','Direct catalog unrestrict unavailable; trying DMM music endpoint',{
      jobId,reason:String(directError.message || '').slice(0,120)
    });
    const response = await fetch('https://debridmediamanager.com/api/music/unrestrict',{
      method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify({link,hash,fileId,accessToken:token()}),signal:AbortSignal.timeout(120000)
    });
    if (!response.ok) throw new Error(`DMM music unrestrict HTTP ${response.status}`);
    const data = await response.json();
    if (!data.streamUrl) throw new Error('DMM music unrestrict returned no stream URL');
    un = {download:data.streamUrl,filename:data.filename,filesize:data.filesize};
    logger.info('dmm','DMM catalog link resolved by music endpoint',{jobId});
  }
  if (!isPipelinePayloadActive(payload)) throw new Error('Job cancelled');
  const dl = new URL(un.download);
  if (dl.protocol !== 'https:' || !(/(^|\.)download\.real-debrid\.com$/.test(dl.hostname)))
    throw new Error('Unexpected Real-Debrid stream host');
  if (Number(expectedBytes)>0 && Number(un.filesize)>0 && Number(un.filesize)!==Number(expectedBytes))
    throw new Error('DMM catalog file size mismatch');
  const dir=path.join(dmmStagingRoot(),String(jobId));
  await fs.mkdir(dir,{recursive:true});
  const output=path.join(dir,'track'+(path.extname(un.filename||'')||'.flac'));
  try {
    const resp=await fetch(un.download,{signal:AbortSignal.timeout(180000)});
    if (!resp.ok || !resp.body) throw new Error(`Real-Debrid audio HTTP ${resp.status}`);
    const {pipeline}=await import('node:stream/promises');
    const {Readable}=await import('node:stream');
    const {createWriteStream}=await import('node:fs');
    await pipeline(Readable.fromWeb(resp.body),createWriteStream(output));
    if (Number(expectedBytes)>0 && (await fs.stat(output)).size!==Number(expectedBytes))
      throw new Error('Downloaded audio size did not match DMM catalog');
    logger.info('dmm','DMM catalog audio staged',{jobId,bytes:(await fs.stat(output)).size});
    return output;
  } catch(error) {
    await fs.rm(dir,{recursive:true,force:true});
    throw error;
  }
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
    if (track) matches.push({hash:album.hash, fileId:track.fileId, filename:track.filename, albumName:album.album, link:track.link || null, expectedBytes:track.bytes || null});
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
  try {
    if (c.link) {
      try {
        file = await tryCatalogLink({...c,jobId:job.id,payload});
      } catch(error) {
        if (String(error.message).includes('Job cancelled')) throw error;
        logger.warn('dmm','DMM catalog fast path unavailable; falling back to Real-Debrid torrent workflow',{
          jobId:job.id,reason:String(error.message || '').slice(0,150)
        });
      }
    }
    if (!file) file = await acquire({...c,jobId:job.id,payload});
  }
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
// DMM_ALBUM_MATCH_V2: compare track titles, not catalog file paths or artist prefixes.
// Matching is only a candidate prefilter: finishAlbumGrab still verifies each audio
// file strictly against Aurral's requested release before importing anything.
function dmmAlbumTrackMatches(job, track) {
  const wanted = norm(job.trackName);
  if (!wanted) return false;
  const filename = path.posix.basename(String(track.filename || track.path || '').replaceAll('\\', '/'));
  const title = norm(filename);
  if (title === wanted) return true;
  // DMM filenames sometimes omit punctuation AND the separator itself:
  // "Black Magic WomanGypsy Queen" vs "Black Magic Woman / Gypsy Queen".
  // Compare full, compact titles only; never use substring/fuzzy matching.
  const compact = value => value.replace(/\s+/g, '');
  if (compact(title) === compact(wanted)) return true;
  const artist = norm(job.artistName);
  return Boolean(artist && (title === `${artist} ${wanted}` ||
    compact(title) === compact(`${artist} ${wanted}`)));
}

// DMM_ALBUM_GRAB_V1: a single shared-queue operation for the whole release.
// Never mark missing/invalid tracks done: finishAlbumGrab enforces strict validation.
async function processDmmAlbumGrab(payload, helpers) {
  const leader = downloadTracker.getJob(payload.jobId);
  if (!leader) return null;
  if (payload.phase === 'search') {
    const jobs = albumGrabJobs(payload);
    if (jobs.length < 2) return helpers.failOrTryNextSource(payload, leader, 'Album grab no longer has pending members');
    const results = (await searchDmmAlbums(`${leader.artistName} ${leader.albumName}`, 48)).albums || [];
    const editions = results.filter(item => norm(item.artist) === norm(leader.artistName) && norm(item.album) === norm(leader.albumName));
    let best = null;
    for (const item of editions.slice(0, 6)) {
      const album = await getDmmAlbum(item.hash);
      const tracks = (album.tracks || []).filter(t => /\.(flac|mp3|m4a|aac|ogg|opus|wav|wma)$/i.test(t.filename || ''));
      const matching = jobs.filter(j => tracks.some(t => dmmAlbumTrackMatches(j, t))).length;
      if (!best || matching > best.matching) best = {album, tracks, matching};
    }
    if (!best || best.matching < 2) {
      logger.info('dmm', 'DMM album candidate match summary', {
        jobId:leader.id, catalogEditions:editions.length,
        bestMatchedTracks:best?.matching || 0, requestedTracks:jobs.length,
      });
      return helpers.failOrTryNextSource(payload, leader, 'No DMM album edition matching multiple requested tracks');
    }
    logger.info('dmm', 'DMM album release matched', {jobId: leader.id, trackCount: best.tracks.length, requestedTracks: jobs.length, matchingTracks: best.matching});
    return {...payload, source:'dmm', phase:'download', dmmAlbumHash:best.album.hash};
  }
  if (payload.phase !== 'download') throw new Error('Unexpected DMM album phase');
  const album = await getDmmAlbum(payload.dmmAlbumHash);
  const jobs = albumGrabJobs(payload);
  if (!jobs.length) return null;
  const staged = [];
  const folders = new Set();
  const albumTracks = (album.tracks || []).filter(t => /\.(flac|mp3|m4a|aac|ogg|opus|wav|wma)$/i.test(t.filename || ''));
  try {
    for (const track of albumTracks) {
      if (!isPipelinePayloadActive(payload)) throw new Error('Job cancelled');
      const job = jobs.find(j => dmmAlbumTrackMatches(j, track) && !staged.some(f => f.jobId === j.id));
      if (!job || !track.link) continue;
      try {
        const file = await tryCatalogLink({link:track.link, hash:album.hash, fileId:track.fileId, expectedBytes:track.bytes, jobId:job.id, payload});
        const safeName = path.basename(String(track.filename));
        if (!safeName || !/\.(flac|mp3|m4a|aac|ogg|opus|wav|wma)$/i.test(safeName)) throw new Error('Invalid DMM filename');
        const named = path.join(path.dirname(file), safeName);
        await fs.rename(file, named);
        folders.add(path.dirname(named));
        staged.push({jobId:job.id, path:named});
        logger.info('dmm', 'DMM album track staged', {jobId:job.id, stagedCount:staged.length, totalRequested:jobs.length});
      } catch (error) {
        if (String(error.message).includes('Job cancelled')) throw error;
        logger.warn('dmm', 'DMM album track unavailable', {jobId:job.id, reason:String(error.message).slice(0,130)});
      }
    }
    if (!staged.length) return helpers.failOrTryNextSource(payload, leader, 'DMM album had no downloadable matching tracks');
    if (!isPipelinePayloadActive(payload)) return null;
    const next = await finishAlbumGrab(payload, {filePaths:staged.map(f => f.path), source:'dmm', album:album.album, settleEdition:false});
    logger.info('dmm', 'DMM album grab processed', {jobId:leader.id, stagedTracks:staged.length, requestedTracks:jobs.length});
    return next;
  } finally {
    for (const folder of folders) await fs.rm(folder, {recursive:true, force:true}).catch(()=>{});
  }
}

export async function processDmmPipelinePayload(payload,helpers={}) {
  if (!token()) return helpers.failOrTryNextSource(payload,downloadTracker.getJob(payload.jobId),'DMM Real-Debrid token missing');
  if (!isPipelinePayloadActive(payload)) return null;
  try {
    if (payload.albumGrab === true) return await processDmmAlbumGrab(payload,helpers);
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
