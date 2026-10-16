import { db } from "../../config/db-sqlite.js";
import { logger, safeLogDiagnostic } from "../logger.js";

// Append-only audit history survives deletion of download job rows.
db.exec("CREATE TABLE IF NOT EXISTS download_operation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL, job_id TEXT, category TEXT NOT NULL, event TEXT NOT NULL, provider TEXT, detail TEXT)");
db.exec("CREATE INDEX IF NOT EXISTS idx_download_events_job ON download_operation_events(job_id, occurred_at DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_download_events_date ON download_operation_events(occurred_at DESC)");
const existingColumns = new Set(db.prepare("PRAGMA table_info(download_operation_events)").all().map(row => row.name));
for (const [column, definition] of [["attempt_id", "TEXT"], ["reason_code", "TEXT"]]) {
  if (!existingColumns.has(column)) db.exec("ALTER TABLE download_operation_events ADD COLUMN " + column + " " + definition);
}
db.exec("CREATE INDEX IF NOT EXISTS idx_download_events_provider ON download_operation_events(provider, id DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_download_events_category ON download_operation_events(category, id DESC)");
db.exec("CREATE INDEX IF NOT EXISTS idx_download_events_attempt ON download_operation_events(attempt_id, id DESC)");

const write = db.prepare("INSERT INTO download_operation_events (occurred_at,job_id,category,event,provider,detail,attempt_id,reason_code) VALUES (?,?,?,?,?,?,?,?)");
const shorten = (value,max) => value == null ? null : String(value).trim().slice(0,max) || null;

export function classifyDownloadFailure(reason) {
  const status = Number(reason?.status ?? reason?.statusCode ?? reason?.response?.status);
  const message = String(reason?.message || reason || "").toLowerCase();
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|logged out|log(?:ged)?[ -]?in|invalid credentials|authentication/.test(message)) return "auth";
  if (status === 429 || /rate.limit|too many requests|quota exceeded/.test(message)) return "rate_limit";
  if (/cancel|abort/.test(message)) return "cancelled";
  if (/timeout|timed out|deadline|etimedout/.test(message)) return "timeout";
  if (/not found|no match|no candidate|no results|unavailable release/.test(message)) return "no_match";
  if (/validat|corrupt|identity mismatch|quality mismatch|wrong duration/.test(message)) return "validation";
  if (/econn|enotfound|network|connection refused|dns|socket hang up/.test(message)) return "network";
  return "provider_error";
}

// Event recording is best-effort: logging must not break an active download.
export function recordDownloadEvent({
  jobId = null, category = "download", event, provider = null,
  detail = null, attemptId = null, reasonCode = null,
} = {}) {
  if (!event) return false;
  try {
    write.run(Date.now(),shorten(jobId,128),shorten(category,48) || "download",
      shorten(event,80),shorten(provider,64),
      detail == null ? null : safeLogDiagnostic(detail),
      shorten(attemptId,128),shorten(reasonCode,48));
    return true;
  } catch (error) {
    logger.warn("downloads","Unable to persist operational event",{reason:safeLogDiagnostic(error)});
    return false;
  }
}

// Bound-parameter cursor pagination makes history searchable at any scale.
export function queryDownloadEvents({
  jobId = null, provider = null, category = null, event = null,
  reasonCode = null, attemptId = null, search = null, before = null, limit = 75,
} = {}) {
  const take = Math.max(1,Math.min(200,Math.floor(Number(limit) || 75)));
  const where = [];
  const params = [];
  for (const [column,value] of [
    ["job_id",jobId],["provider",provider],["category",category],
    ["event",event],["reason_code",reasonCode],["attempt_id",attemptId],
  ]) {
    if (value == null || !String(value).trim()) continue;
    where.push(column + " = ?");
    params.push(String(value).trim().slice(0,128));
  }
  const term = String(search || "").trim().slice(0,120);
  if (term) {
    where.push("instr(lower(coalesce(job_id,'') || ' ' || coalesce(event,'') || ' ' || coalesce(provider,'') || ' ' || coalesce(detail,'') || ' ' || coalesce(reason_code,'')), lower(?)) > 0");
    params.push(term);
  }
  const cursor = Number(before);
  if (before != null && before !== "" && Number.isSafeInteger(cursor) && cursor > 0) {
    where.push("id < ?");
    params.push(cursor);
  }
  const sql = "SELECT id,occurred_at AS occurredAt,job_id AS jobId,category,event,provider,detail,attempt_id AS attemptId,reason_code AS reasonCode FROM download_operation_events" +
    (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY id DESC LIMIT ?";
  const rows = db.prepare(sql).all(...params,take + 1);
  const events = rows.slice(0,take);
  return {events,hasMore:rows.length > take,nextBefore:rows.length > take ? events[events.length - 1].id : null};
}
export function getDownloadEvents(options = {}) {
  return queryDownloadEvents({...options,limit:options.limit ?? 100}).events;
}
export function pruneDownloadEventHistory(days = 90) {
  return db.prepare("DELETE FROM download_operation_events WHERE occurred_at < ?")
    .run(Date.now()-Math.max(1,Math.min(365,Number(days)||90))*86400000).changes;
}
