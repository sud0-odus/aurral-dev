// Provider-specific DMM discovery. The DMM API indexes album releases, not
// individual YouTube-style videos; match the requested recording inside those
// releases without requiring Deezer's exact album/edition name.
import path from "node:path";
import { searchDmmAlbums, getDmmAlbum } from "./dmmClient.js";
import { buildSourceCandidates, usableEvaluationEntries } from "./trackMatching/index.js";
import { bestArtistSimilarity, normalizeMatchText } from "./trackMatching/nativeMatcher.js";

const AUDIO_FILE = /\.(?:flac|mp3|m4a|aac|ogg|opus|wav|wma)$/i;
const HASH = /^[0-9a-f]{40}$/i;
const DECISION_RANK = { accept: 0, verify: 1, review: 2 };
const DEFAULT_MAX_EDITION_DETAILS = 12;
const DEFAULT_MAX_CANDIDATES = 6;

function comparableArtist(credit, names) {
  return Boolean(credit && bestArtistSimilarity(names, [credit]) >= 0.9);
}

function albumEquals(left, right) {
  return Boolean(left && right && normalizeMatchText(left) === normalizeMatchText(right));
}

// Catalog filenames may contain disk/track positions and an artist prefix.
// Never strip version qualifiers such as "(Live)" or "(Single Edit)" here;
// the shared recording matcher must be able to reject incompatible versions.
export function dmmFilenameTitle(filename, artistNames = []) {
  const basename = path.posix.basename(String(filename || "").replaceAll("\\", "/"))
    .replace(AUDIO_FILE, "").trim();
  let title = basename.replace(/^\s*(?:\d{1,2}-)?\d{1,3}\s*[-._)\]]\s*/, "").trim();
  const segments = title.split(/\s+[-–—]\s+/u);
  if (segments.length > 1 && artistNames.some((artist) =>
    normalizeMatchText(segments[0]) === normalizeMatchText(artist))) {
    title = segments.slice(1).join(" - ");
  }
  return title;
}

export function buildDmmSearchQueries(request) {
  const artist = String(request?.artistName || "").trim();
  const title = String(request?.trackName || "").trim();
  const album = String(request?.albumName || "").trim();
  const queries = [
    ...(artist && album ? [{ kind: "album", query: artist + " " + album }] : []),
    ...(artist && title ? [{ kind: "track", query: artist + " " + title }] : []),
    ...(artist ? [{ kind: "artist", query: artist }] : []),
  ];
  return queries.filter((entry, index) =>
    queries.findIndex((other) => normalizeMatchText(other.query) === normalizeMatchText(entry.query)) === index);
}

function candidateFromTrack(item, album, track, artistNames) {
  const filename = String(track?.filename || track?.path || "").trim();
  if (!AUDIO_FILE.test(filename) || !Number.isFinite(Number(track.fileId))) return null;
  const artist = String(album.artist || item.artist || "").trim();
  const title = dmmFilenameTitle(filename, artistNames);
  if (!title) return null;
  return {
    title, artist, album: album.album || item.album || "",
    format: path.extname(filename).slice(1), 
    durationMs: track.durationMs ?? null,
    id: String(album.hash || item.hash) + ":" + String(track.fileId),
    dmmHash: album.hash || item.hash,
    dmmFileId: track.fileId,
    dmmFilename: filename,
    dmmExpectedBytes: track.bytes || null,
    dmmLink: track.link || null,
  };
}

function rankEntries(evaluation, requestedAlbum) {
  return usableEvaluationEntries(evaluation)
    .sort((a, b) => (DECISION_RANK[a.decision] ?? 9) - (DECISION_RANK[b.decision] ?? 9)
      || Number(albumEquals(b.candidate?.album, requestedAlbum))
        - Number(albumEquals(a.candidate?.album, requestedAlbum))
      || (a.distance ?? 1) - (b.distance ?? 1));
}

/**
 * Return DMM release/file candidates using provider-aware discovery, followed
 * by Aurral's shared recording matcher. Search and read functions are injected
 * to permit catalog fixtures without a Real-Debrid account.
 */
export async function discoverDmmTrack({
  request,
  hash = null,
  searchAlbums = searchDmmAlbums,
  readAlbum = getDmmAlbum,
  maxEditionDetails = DEFAULT_MAX_EDITION_DETAILS,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
} = {}) {
  if (!request?.artistName || !request?.trackName) {
    throw new Error("DMM search requires an artist and track");
  }
  const artistNames = [request.artistName, ...(request.artistAliases || [])].filter(Boolean);
  const stats = {
    queries: [], searchErrors: 0, editionsReturned: 0,
    artistEditions: 0, inspectedEditions: 0, audioTracks: 0,
    usableCandidates: 0, reason: "no_matching_track",
  };
  const inspected = new Set();
  const raw = [];
  const tiers = hash ? [{ kind: "hash", query: String(hash) }] : buildDmmSearchQueries(request);

  for (const tier of tiers) {
    let summaries = [];
    stats.queries.push(tier.kind);
    if (tier.kind === "hash") {
      if (!HASH.test(tier.query)) throw new Error("Invalid DMM release hash");
      summaries = [{ hash: tier.query, artist: request.artistName, album: request.albumName }];
    } else {
      try {
        const result = await searchAlbums(tier.query, 96);
        summaries = Array.isArray(result?.albums) ? result.albums : [];
      } catch (error) {
        stats.searchErrors++;
        continue;
      }
    }
    stats.editionsReturned += summaries.length;
    const artistEditions = summaries.filter((item) =>
      HASH.test(String(item?.hash || "")) && comparableArtist(item.artist, artistNames));
    stats.artistEditions += artistEditions.length;
    // An album-specific query may return unrelated releases. Only inspect
    // the requested edition at this stage; broaden to other editions later.
    const eligible = tier.kind === "album"
      ? artistEditions.filter((item) => albumEquals(item.album, request.albumName))
      : artistEditions;
    eligible.sort((a, b) =>
      Number(albumEquals(b.album, request.albumName))
        - Number(albumEquals(a.album, request.albumName)));
    for (const item of eligible) {
      if (stats.inspectedEditions >= maxEditionDetails) break;
      const key = item.hash.toLowerCase();
      if (inspected.has(key)) continue;
      inspected.add(key);
      let album;
      try {
        album = await readAlbum(item.hash);
      } catch (error) {
        stats.searchErrors++;
        continue;
      }
      if (!album || !comparableArtist(album.artist || item.artist, artistNames)) continue;
      stats.inspectedEditions++;
      for (const track of Array.isArray(album.tracks) ? album.tracks : []) {
        const candidate = candidateFromTrack(item, album, track, artistNames);
        if (!candidate) continue;
        stats.audioTracks++;
        raw.push(candidate);
      }
    }
    if (raw.length) {
      const evaluation = await buildSourceCandidates({
        source: "dmm", results: raw, request,
      });
      const ranked = rankEntries(evaluation, request.albumName).slice(0, maxCandidates);
      if (ranked.length) {
        stats.usableCandidates = ranked.length;
        stats.reason = "matched";
        return {
          matches: ranked.map(({ candidate, decision }) => ({
            hash: candidate.raw.dmmHash,
            fileId: candidate.raw.dmmFileId,
            filename: candidate.raw.dmmFilename,
            albumName: candidate.raw.album,
            link: candidate.raw.dmmLink,
            expectedBytes: candidate.raw.dmmExpectedBytes,
            matchDecision: decision,
          })),
          stats,
        };
      }
    }
    if (stats.inspectedEditions >= maxEditionDetails) break;
  }
  stats.reason = stats.editionsReturned === 0
    ? stats.searchErrors ? "catalog_unavailable_or_empty" : "catalog_empty"
    : stats.artistEditions === 0 ? "artist_not_in_results"
      : stats.audioTracks === 0 ? "no_audio_files"
        : "no_matching_recording";
  return { matches: [], stats };
}
