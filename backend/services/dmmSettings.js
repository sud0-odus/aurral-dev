import { dbOps } from '../db/helpers/index.js';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { resolveDownloadRoot } from './downloadPaths.js';

const config = () => dbOps.getSettings()?.integrations?.dmm || {};
export function dmmConfig() { return config(); }
export function dmmToken(cfg = config()) { return String(cfg.apiToken || process.env.AURRAL_RD_TOKEN || '').trim(); }
export function dmmEnabled(cfg = config()) { return cfg.enabled === false ? false : cfg.enabled === true || process.env.AURRAL_DMM_ENABLED === 'true'; }
export function dmmConfigured(cfg = config()) { return dmmEnabled(cfg) && Boolean(dmmToken(cfg)); }
export function dmmPriority(cfg = config()) { const n = Number(cfg.priority); return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 30; }
export function dmmStagingRoot(cfg = config()) {
  const root = String(cfg.stagingPath || process.env.AURRAL_DMM_STAGING_DIR || '').trim() || path.join(resolveDownloadRoot(), '.dmm-staging');
  if (!path.isAbsolute(root)) throw new Error('DMM staging path must be absolute');
  const dest = path.resolve(root);
  if (dest === '/' || dest === '/tmp') throw new Error('DMM staging path must be a dedicated directory');
  return dest;
}
export const dmmSettings = Object.freeze({
  key: 'dmm', label: 'DMM + Real-Debrid', subtitle: 'Shared music catalog / cached audio',
  enabledDefault: false, testRequiresEnabled: false,
  fields: Object.freeze([
    {key:'enabled',label:'Enable DMM',type:'toggle'},
    {key:'apiToken',label:'Real-Debrid API token',type:'password',secret:true,section:'Connection',hint:'Leave empty to use the existing server environment token.'},
    {key:'priority',label:'Source priority',type:'number',min:1,max:1000,section:'Behavior'},
    {key:'stagingPath',label:'Staging path',type:'path',section:'Downloads',hint:'Temporary Real-Debrid files. NAS path supported, e.g. /downloads/aurral/.dmm-staging.'}
  ]),
  defaults: Object.freeze({enabled:false,priority:30,apiToken:'',stagingPath:''}),
  validation: Object.freeze({required:[],url:[]}),testConnection:true
});
export class DmmClient {
  constructor(cfg = null) {this.key='dmm';this.name='DMM + Real-Debrid';this.config=cfg;}
  updateConfig(cfg={}) {this.config=cfg;}
  isEnabled() {return dmmEnabled(this.config || config());}
  isConfigured(){return dmmConfigured(this.config || config());}
  getStatus(){return {enabled:this.isEnabled(),configured:this.isConfigured()};}
  async testConnection(){
    const cfg=this.config || config();const token=dmmToken(cfg);
    if (!token) return {configured:false,ok:false,message:'Real-Debrid API token is missing'};
    try {
      const [rd,dmm]=await Promise.all([
        fetch('https://api.real-debrid.com/rest/1.0/user',{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)}),
        fetch('https://debridmediamanager.com/api/music/library?summary=1&limit=1',{signal:AbortSignal.timeout(15000)})
      ]);
      if (!rd.ok || !dmm.ok) return {configured:true,ok:false,message:`Real-Debrid HTTP ${rd.status}; DMM HTTP ${dmm.status}`};
      try{accessSync(path.dirname(dmmStagingRoot(cfg)),constants.W_OK);}catch{return {configured:true,ok:false,message:'DMM staging parent is not writable'};}
      return {configured:true,ok:true,message:'DMM catalog and Real-Debrid authenticated; staging parent writable'};
    }catch(err){return {configured:true,ok:false,message:err.message};}
  }
}
export const dmmClient=new DmmClient();
