import { db } from "../../config/db-sqlite.js";
import { safeLogDiagnostic } from "../logger.js";
db.exec(`
 CREATE TABLE IF NOT EXISTS download_operation_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL,
 job_id TEXT, category TEXT NOT NULL, event TEXT NOT NULL, provider TEXT, detail TEXT);
 CREATE INDEX IF NOT EXISTS idx_download_events_job ON download_operation_events(job_id, occurred_at DESC);
 CREATE INDEX IF NOT EXISTS idx_download_events_date ON download_operation_events(occurred_at DESC);`);
const write=db.prepare("INSERT INTO download_operation_events (occurred_at,job_id,category,event,provider,detail) VALUES (?,?,?,?,?,?)");
export function recordDownloadEvent({jobId=null,category="download",event,provider=null,detail=null}={}){
 if (!event) return false;
 write.run(Date.now(),jobId?String(jobId):null,String(category).slice(0,48),
 String(event).slice(0,80),provider?String(provider).slice(0,64):null,
 detail==null?null:safeLogDiagnostic(detail));return true;
}
export function getDownloadEvents({jobId=null,limit=100}={}){
 const take=Math.max(1,Math.min(500,Number(limit)||100));
 const sql=`SELECT id, occurred_at AS occurredAt, job_id AS jobId,category,event,provider,detail
 FROM download_operation_events${jobId?" WHERE job_id = ?":""} ORDER BY id DESC LIMIT ?`;
 return db.prepare(sql).all(...(jobId?[String(jobId)]:[]),take);
}
export function pruneDownloadEventHistory(days=30){
 return db.prepare("DELETE FROM download_operation_events WHERE occurred_at < ?")
 .run(Date.now()-Math.max(1,Math.min(365,Number(days)||30))*86400000).changes;
}
