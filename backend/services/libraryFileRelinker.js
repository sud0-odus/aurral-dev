import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../config/db-sqlite.js";
import { resolveDownloadRoot } from "./downloadPaths.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { logger } from "./logger.js";

const MAX_CANDIDATES = 40;
const byMbid = db.prepare(`
  SELECT DISTINCT media.path, media.duration_ms AS durationMs,
    album.title AS albumName
  FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  LEFT JOIN library_albums AS album ON album.id = media.album_id
  WHERE media.available = 1 AND lower(track.mbid) = lower(?)
  LIMIT ${MAX_CANDIDATES + 1}`);
const byNames = db.prepare(`
  SELECT DISTINCT media.path, media.duration_ms AS durationMs,
    album.title AS albumName
  FROM library_media_files AS media
  JOIN library_tracks AS track ON track.id = media.track_id
  LEFT JOIN library_albums AS album ON album.id = media.album_id
  WHERE media.available = 1 AND lower(track.artist_name) = lower(?)
    AND lower(track.title) = lower(?)
  LIMIT ${MAX_CANDIDATES + 1}`);
const completed = db.prepare(`
  SELECT id, artist_name AS artistName, track_name AS trackName,
    album_name AS albumName, track_mbid AS trackMbid,
    duration_ms AS durationMs, final_path AS finalPath,
    external_path AS externalPath
  FROM playlist_download_jobs
  WHERE status = 'done' AND final_path IS NOT NULL
  ORDER BY created_at, id LIMIT ?`);
const changeLocation = db.prepare(`
  UPDATE playlist_download_jobs
  SET final_path = ?, external_path = ?
  WHERE id = ? AND status = 'done' AND final_path = ?`);

const text = (value) => String(value || "").trim().normalize("NFKC").toLowerCase();
const within = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
async function isFile(filePath) {
  if (!filePath || !path.isAbsolute(String(filePath))) return false;
  try { return (await fs.stat(filePath)).isFile(); } catch { return false; }
}

/**
 * Exact recording MBID first, otherwise artist/title. Never guess among
 * multiple versions or use a file whose duration conflicts with the job.
 * Unlike a download job, this lookup does not change music on disk.
 */
export async function resolveIndexedJobFile(job, { exists = isFile } = {}) {
  const mbid = String(job?.trackMbid || "").trim();
  let options = mbid ? byMbid.all(mbid) : [];
  if (options.length > MAX_CANDIDATES) return null;
  if (options.length === 0 && job?.artistName && job?.trackName) {
    options = byNames.all(job.artistName, job.trackName);
  }
  if (options.length > MAX_CANDIDATES) return null;
  const paths = [];
  for (const option of options) {
    if (job.durationMs && option.durationMs &&
        Math.abs(Number(job.durationMs) - Number(option.durationMs)) > 5000) continue;
    if (await exists(option.path)) paths.push(option);
  }
  if (!paths.length) return null;
  const album = text(job?.albumName);
  if (album) {
    const exactAlbum = paths.filter(entry => text(entry.albumName) === album);
    if (exactAlbum.length) return exactAlbum.length === 1 ? exactAlbum[0].path : null;
  }
  return paths.length === 1 ? paths[0].path : null;
}

/** Persist relocated files only once both the old path is missing and the
 * destination is an unambiguous, indexed, accessible recording. No requeues. */
export async function reconcileCompletedJobFileLocations({ limit = 5000 } = {}) {
  const rows = completed.all(Math.max(1, Math.min(10000, Number(limit) || 5000)));
  const downloadRoot = resolveDownloadRoot();
  let checked = 0, moved = 0, unresolved = 0;
  for (const row of rows) {
    if (await isFile(row.finalPath)) continue;
    checked++;
    const resolved = await resolveIndexedJobFile(row);
    if (!resolved || !await isFile(resolved)) { unresolved++; continue; }
    const externalPath = row.externalPath || !within(downloadRoot, resolved)
      ? resolved : null;
    const changed = changeLocation.run(resolved, externalPath, row.id, row.finalPath).changes;
    if (changed) moved++;
  }
  if (moved) {
    // Scanner, server and downloader may be different processes. Revision
    // triggers make persisted changes visible to all on their next refresh.
    downloadTracker.reconcileCommittedJobs();
    logger.info("library", "Repaired completed download file locations", { checked, moved, unresolved });
  }
  return { checked, moved, unresolved };
}

/** Optional read-only mounts can be indexed without using them as download
 * destinations. /sources/<mount> is recognized from already-restored external
 * job references; explicit additional roots use AURRAL_LIBRARY_REFERENCE_ROOTS. */
export function getReferenceLibraryRoots(jobs = completed.all(10000)) {
  const roots = new Set();
  for (const raw of String(process.env.AURRAL_LIBRARY_REFERENCE_ROOTS || "").split(path.delimiter)) {
    const root = raw.trim();
    if (path.isAbsolute(root) && root !== path.parse(root).root) roots.add(path.resolve(root));
  }
  for (const job of jobs) {
    const filePath = String(job.externalPath || "").trim();
    if (!filePath || !within("/sources", filePath) || filePath === "/sources") continue;
    const relative = path.relative("/sources", filePath).split(path.sep);
    if (relative.length >= 2 && relative[0] && relative[0] !== "..") {
      roots.add(path.join("/sources", relative[0]));
    }
  }
  return [...roots];
}

export async function scanReferenceLibraryRoots({ metadataByPath = new Map(), force = false } = {}) {
  const { scanMusicRoot } = await import("./libraryFileScanner.js");
  const results = [];
  for (const root of getReferenceLibraryRoots()) {
    try {
      if (!(await fs.stat(root)).isDirectory()) continue;
      // Targeted directory scan: changing /sources must not mark the main
      // Aurral download tree unavailable or make the archive writable.
      const result = await scanMusicRoot({
        rootPath: root, source: "aurral", changedPaths: [root], force,
        syncSearch: false,
        metadataEnricher: (_metadata, filePath) => metadataByPath.get(path.resolve(filePath)),
      });
      results.push({ root, ...result });
    } catch (error) {
      logger.warn("library", "Reference music root scan failed", {
        root, reason: error?.message || String(error),
      });
    }
  }
  return results;
}
