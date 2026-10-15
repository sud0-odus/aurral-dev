import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../config/db-sqlite.js';
import { downloadTracker } from './downloadJobs/downloadTracker.js';
import { cancelDownloadWorkForJobs } from './downloadJobs/downloadCancellationService.js';
import { cancelDownloadJobs } from './downloadJobs/downloadCancellation.js';
import { resolveDownloadRoot } from './downloadPaths.js';
import { dmmStagingRoot } from './dmmSettings.js';
import { listHonkerJobs } from './honkerDb.js';
import { withPlaylistMutationLock } from './downloadJobs/mutationGuards.js';

const isLibrary = j => j?.playlistType === 'library' && j?.managedBy === 'aurral';
const active = new Set(['pending','downloading','cancel_requested']);
const history = db.prepare('SELECT id, kind, metadata FROM aurral_history WHERE id = ?');
const removeHistory = db.prepare('DELETE FROM aurral_history WHERE id = ?');
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

function selection(id) {
  if (String(id).startsWith('aurral-album_grab-')) {
    const record=history.get(id);
    if (!record || record.kind !== 'album_grab') throw Object.assign(new Error('Album attempt no longer exists'),{statusCode:404});
    const meta=JSON.parse(record.metadata || '{}');
    const ids=meta.memberJobIds;
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 200 || new Set(ids).size !== ids.length) throw new Error('Invalid album job membership');
    const jobs=ids.map(jobId => downloadTracker.getJob(jobId));
    if (jobs.some(j=>!isLibrary(j)) || jobs.some(j=>j.requestGroupId!==jobs[0].requestGroupId || !j.requestGroupId || j.albumMbid!==jobs[0].albumMbid)) {
      throw Object.assign(new Error('Album jobs changed; refresh History'),{statusCode:409});
    }
    return { jobs, albumId:id };
  }
  if (String(id).startsWith('aurral-album_requested-')) {
    const record=history.get(id);
    if (!record || record.kind !== 'album_requested') throw Object.assign(new Error('Album request not found'),{statusCode:404});
    const meta=JSON.parse(record.metadata || '{}');
    // Requests can outlive their download jobs. Only allow clearing a request
    // without deleting files or touching unrelated work.
    const related=downloadTracker.getAll().filter(j=>isLibrary(j) &&
      ((meta.requestGroupId && j.requestGroupId===meta.requestGroupId) ||
       (meta.albumId && (String(j.albumMbid)===String(meta.albumId) || String(j.albumMbid)===String(meta.canonicalAlbumId)))));
    if (related.length) throw Object.assign(new Error('Album still has download jobs. Use its album download History entry.'),{statusCode:409});
    return { jobs:[],albumId:null,requestId:id };
  }
  const job=downloadTracker.getJob(id);
  if (!isLibrary(job)) throw Object.assign(new Error('Aurral library job not found'),{statusCode:404});
  return {jobs:[job],albumId:null};
}

async function importedPaths(jobs, removeImported) {
  if (!removeImported) return [];
  const root=await fs.realpath(resolveDownloadRoot());
  const candidates=[];
  for(const job of jobs) {
    if (!job.finalPath) continue;
    const target=path.resolve(job.finalPath);
    if (!target.startsWith(root+path.sep)) throw new Error('Imported path outside download root');
    const stat=await fs.lstat(target).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe imported file');
    // No arbitrary external library files; only files assigned to the selected jobs.
    candidates.push(target);
  }
  if (new Set(candidates).size !== candidates.length) throw new Error('Overlapping imported files');
  return candidates;
}

export async function performHistoryTestAction(id, action, {removeImported=false}={}) {
  if (!['cancel','reset-retry','force-clear'].includes(action)) throw Object.assign(new Error('Unknown action'),{statusCode:400});
  if (typeof removeImported !== 'boolean') throw Object.assign(new Error('removeImported must be boolean'),{statusCode:400});
  const chosen=selection(id);
  const result = await withPlaylistMutationLock('library', async () => {
    const {jobs,albumId,requestId}=selection(id);
    if (requestId) {
      if (action !== 'force-clear') throw Object.assign(new Error('This request has no download jobs. Use Force Clear, then Download album from the album page.'),{statusCode:409});
      if (removeImported) throw Object.assign(new Error('No imported files belong to the request record'),{statusCode:400});
      const removed=removeHistory.run(requestId).changes;
      return {success:true,action,jobsRemoved:0,historyRemoved:removed};
    }
    const ids=new Set(jobs.map(j=>j.id));
    if (action==='cancel' && !jobs.some(j=>active.has(j.status))) {
      throw Object.assign(new Error('No active jobs to cancel'),{statusCode:409});
    }
    // Check all file targets before we stop anything or delete rows.
    const files=await importedPaths(jobs,removeImported && action!=='cancel');
    const running=jobs.filter(j=>active.has(j.status));
    if (running.length) {
      cancelDownloadJobs(running.map(j=>j.id));
      await cancelDownloadWorkForJobs(running,{lock:false});
      for (const j of running) downloadTracker.setCancelled(j.id);
    }
    if (action==='cancel') return {success:true,action,cancelled:running.length};
    // A queued payload can reference any member of the album. Never reset until all
    // such work is gone, including a claimed queue entry.
    for(let n=0;n<20;n++) {
      const rows=listHonkerJobs('slskd-pipeline').filter(r=>ids.has(r.payload?.jobId) || r.payload?.albumGroupJobIds?.some(x=>ids.has(x)));
      if (!rows.length) break;
      if (n===19) throw Object.assign(new Error('Selected queue work has not drained; retry in a few seconds'),{statusCode:409});
      await sleep(1000);
    }
    for(const file of files) await fs.unlink(file);
    const stageRoot=path.resolve(dmmStagingRoot());
    for(const job of jobs){
      const dir=path.resolve(stageRoot,job.id);
      if (!dir.startsWith(stageRoot+path.sep)) throw new Error('Invalid staging directory');
      await fs.rm(dir,{recursive:true,force:true});
    }
    for(const job of jobs) downloadTracker.removeJob(job.id);
    db.transaction(()=>{
      for(const job of jobs){
        const key=`aurral-track_download-${job.id}`;
        const record=history.get(key);
        if(!record) continue;
        const meta=JSON.parse(record.metadata||'{}');
        if(!albumId || meta.albumGrabId===albumId) removeHistory.run(key);
      }
      if(albumId) removeHistory.run(albumId);
    })();
    let queued=0;
    if (action==='reset-retry') {
      const group=albumId ? randomUUID() : null;
      for(const job of jobs) {
        // Preserve imported tracks unless explicit removal was chosen.
        if (job.finalPath && !files.includes(path.resolve(job.finalPath))) continue;
        const track={...job,requestGroupId:group,reason:'Manual Reset & Retry'};
        const fresh=downloadTracker.addJob(track,'library',{playlistId:'library'});
        if (fresh) queued++;
      }
    }
    return {success:true,action,jobsRemoved:jobs.length,importedFilesRemoved:files.length,queued};
  });
  // A retired download owner is not running, so wake() is a no-op.
  // Release the playlist mutation lock before starting or waking its worker.
  if (action === 'reset-retry' && result.queued > 0) {
    const { wakeDownloadWorker } = await import('./downloadJobs/mutationGuards.js');
    await wakeDownloadWorker();
  }
  return result;
}
