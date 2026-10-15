import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadTracker } from '../services/downloadJobs/downloadTracker.js';
import { cancelDownloadWorkForJobs } from '../services/downloadJobs/downloadCancellationService.js';
import { resolveDownloadRoot } from '../services/downloadPaths.js';
import { dmmStagingRoot } from '../services/dmmSettings.js';
import { listHonkerJobs } from '../services/honkerDb.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i=args.indexOf(name); return i>=0?args[i+1]:null; };
const kind=value('--scope');
const id=value('--job');
const confirmed=flag('--confirm');
const removeFiles=flag('--remove-imported');
const fail=(reason)=>{console.error(`RESET=BLOCKED ${reason}`); process.exitCode=1;};
const pause=(ms)=>new Promise(r=>setTimeout(r,ms));

if (!['track','album'].includes(kind) || !/^[a-f\d-]{36}$/i.test(id||'')) {
  fail('Usage: --scope track|album --job UUID [--confirm] [--remove-imported]');
} else {
  const selected=downloadTracker.getJob(id);
  if (!selected || selected.playlistType!=='library' || selected.managedBy!=='aurral') {
    fail('Job not found or not a managed Aurral library job');
  } else {
    const jobs=(kind==='album'
      ? downloadTracker.getAll().filter(j=>j.playlistType==='library' && j.managedBy==='aurral'
        && j.requestGroupId && selected.requestGroupId && j.requestGroupId===selected.requestGroupId
        && j.albumMbid===selected.albumMbid)
      : [selected]);
    if (!jobs.length || (kind==='album' && !selected.requestGroupId)) {
      fail('No request-group jobs found for album');
    } else {
      console.log('SCOPE='+kind);
      console.log('ALBUM='+selected.artistName+' / '+selected.albumName);
      console.log('JOBS='+jobs.length);
      for(const j of jobs) console.log(`TRACK=${j.id} | ${j.trackName} | ${j.status} | imported=${Boolean(j.finalPath)}`);
      console.log('REMOVE_IMPORTED='+removeFiles);
      if (!confirmed) {
        console.log('RESET=DRY_RUN');
      } else {
        // Persistent cancellation invalidates in-flight pipeline payloads before cleanup.
        try { await cancelDownloadWorkForJobs(jobs); }
        catch(error) { fail('Provider cleanup failed; jobs retained: '+error.message); }
        if (!process.exitCode) {
          for(let attempt=0;attempt<15;attempt++){
            const active=listHonkerJobs('slskd-pipeline').filter(r=>jobs.some(j=>j.id===r.payload?.jobId
              || r.payload?.albumGroupJobIds?.includes(j.id)));
            if(!active.length) break;
            await pause(1000);
          }
          const active=listHonkerJobs('slskd-pipeline').filter(r=>jobs.some(j=>j.id===r.payload?.jobId
            || r.payload?.albumGroupJobIds?.includes(j.id)));
          if(active.length) fail('Queue still contains '+active.length+' selected entries; jobs retained');
        }
        if(!process.exitCode) {
          const root=await fs.realpath(resolveDownloadRoot());
          const stagingRoot=path.resolve(dmmStagingRoot());
          const staged=[];
          const imported=[];
          for(const j of jobs) {
            if(j.finalPath && removeFiles){
              const candidate=path.resolve(j.finalPath);
              if(!candidate.startsWith(root+path.sep)) { fail('Imported file outside music root: '+j.id); break; }
              const stat=await fs.lstat(candidate).catch(()=>null);
              if(stat?.isSymbolicLink() || (stat && !stat.isFile())) { fail('Unsafe file target: '+j.id); break; }
              if(stat) imported.push(candidate);
            }
            const stage=path.resolve(stagingRoot,j.id);
            if(!stage.startsWith(stagingRoot+path.sep)){fail('Unsafe staging path');break;}
            staged.push(stage);
          }
          if(!process.exitCode){
            for(const f of imported) await fs.unlink(f);
            for(const dir of staged) await fs.rm(dir,{recursive:true,force:true});
            for(const j of jobs) downloadTracker.removeJob(j.id);
            console.log('IMPORTED_FILES_REMOVED='+imported.length);
            console.log('JOBS_REMOVED='+jobs.length);
            console.log('RESET=PASS');
            console.log('NEXT=Refresh library scan if imported files were removed, then use Download album/track again');
          }
        }
      }
    }
  }
}
