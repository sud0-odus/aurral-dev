import fs from "node:fs/promises";
import { db } from "../../config/db-sqlite.js";
import path from "node:path";
import {
  flowPlaylistConfig,
  orderJobsByPlaylistTracks,
} from "../playlists/flowPlaylistConfig.js";
import { downloadTracker } from "../downloadJobs/downloadTracker.js";
import {
  resolveExistingTrackPath,
  resolveDownloadRoot,
} from "../downloadPaths.js";

// Use indexed files only when the original is unavailable; reject ambiguous matches.
const byRecording = db.prepare(`SELECT DISTINCT media.path, track.artist_name AS artistName,
 track.title AS title, track.mbid AS mbid, media.duration_ms AS durationMs
 FROM library_tracks track JOIN library_media_files media ON media.track_id = track.id
 WHERE media.available = 1 AND track.mbid = ? LIMIT 24`);
const byNames = db.prepare(`SELECT DISTINCT media.path, track.artist_name AS artistName,
 track.title AS title, track.mbid AS mbid, media.duration_ms AS durationMs
 FROM library_tracks track JOIN library_media_files media ON media.track_id = track.id
 WHERE media.available = 1 AND lower(track.artist_name) = lower(?)
 AND lower(track.title) = lower(?) LIMIT 24`);

async function resolveIndexedJobFile(job) {
  let matches = job.trackMbid ? byRecording.all(job.trackMbid) : [];
  if (!matches.length && job.artistName && job.trackName) {
    matches = byNames.all(job.artistName, job.trackName);
  }
  const valid = [];
  for (const file of matches) {
    if (job.durationMs && file.durationMs &&
      Math.abs(job.durationMs - file.durationMs) > 5000) continue;
    if (await isFile(file.path)) valid.push(file.path);
  }
  // Multiple distinct files may represent differing releases; don't guess.
  return valid.length === 1 ? valid[0] : null;
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function collectPlaybackPlaylistTracks(entityId, options = {}) {
  const downloadRoot = path.resolve(options.downloadRoot || resolveDownloadRoot());
  const playlist = flowPlaylistConfig.getStaticPlaylist(entityId);
  const referencedJobs = (playlist?.tracks || [])
    .map((track) => (track?.canonicalJobId ? downloadTracker.getJob(track.canonicalJobId) : null))
    .filter(Boolean);
  const jobs = [
    ...referencedJobs,
    ...downloadTracker.getByPlaylistType(entityId),
  ]
    .filter((job, index, values) =>
      values.findIndex((candidate) => candidate.id === job.id) === index,
    )
    .filter((job) => job?.status === "done" && typeof job?.finalPath === "string");
  const orderedJobs = orderJobsByPlaylistTracks(
    jobs,
    playlist?.tracks,
  );
  const tracks = [];
  for (const job of orderedJobs) {
    const resolved = await resolveExistingTrackPath(job.finalPath, downloadRoot);
    const mediaPath = resolved && await isFile(resolved.path)
      ? resolved.path : await resolveIndexedJobFile(job);
    if (!mediaPath) continue;
    tracks.push({
      path: mediaPath,
      title: String(job.trackName || "").trim() || "Unknown Track",
      artist: String(job.artistName || "").trim() || "Unknown Artist",
      ...(job.albumName ? { album: job.albumName } : {}),
      ...(job.durationMs != null ? { durationMs: job.durationMs } : {}),
      ...(job.trackMbid ? { mbid: job.trackMbid } : {}),
    });
  }
  return tracks;
}
