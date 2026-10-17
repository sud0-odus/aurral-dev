import { getListenHistoryProfile, hasListenHistoryProfile } from "../listeningHistory.js";

const artistNameKey = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en");
const providerKey = (profile) =>
  [profile.listenHistoryProvider, String(profile.listenHistoryUsername || profile.listenHistoryUrl || "").trim().toLowerCase()].join(":");

/** One user's linked providers coexist with their legacy preferences. An
 * unconnected provider is not silently borrowed from another account. */
export function getPersonalHistoryProfiles(user, linked = {}) {
  const profiles = [getListenHistoryProfile(user)];
  for (const provider of ["lastfm", "listenbrainz"]) {
    const name = String(linked?.[provider]?.displayName || "").trim();
    if (name) profiles.push(getListenHistoryProfile({
      listenHistoryProvider: provider, listenHistoryUsername: name,
    }));
  }
  const unique = new Map();
  for (const profile of profiles) {
    if (!hasListenHistoryProfile(profile) || profile.listenHistoryProvider === "local") continue;
    const key = providerKey(profile);
    if (!unique.has(key)) unique.set(key, profile);
  }
  return [...unique.values()];
}

const SOURCE_RANK = Object.freeze({
  local: 5, listenbrainz: 4, lastfm: 3, koito: 3, apple_music: 2,
});
/** Round-robin across independent sources so Apple imports, local plays and
 * scrobbles contribute even when another service has hundreds of artists.
 * The same performer is counted once, and scrobbled totals are never added
 * together (the services may contain identical listens). */
export function mergePersonalArtistSources(groups, { limit = 250 } = {}) {
  const lists = (Array.isArray(groups) ? groups : []).map(group =>
    Array.isArray(group) ? group : []).filter(group => group.length);
  const cap = Math.max(0, Math.min(500, Math.trunc(Number(limit) || 0)));
  const keys = new Map();
  const byName = new Map();
  const result = [];
  const positions = lists.map(() => 0);
  let advanced = true;
  while (advanced && result.length < cap) {
    advanced = false;
    for (let i = 0; i < lists.length; i++) {
      if (positions[i] >= lists[i].length) continue;
      advanced = true;
      const artist = lists[i][positions[i]++];
      const name = String(artist?.artistName || artist?.name || "").trim();
      const normalized = artistNameKey(name);
      if (!normalized) continue;
      const mbid = String(artist?.mbid || "").trim().toLowerCase();
      const old = (mbid ? keys.get(mbid) : null) || byName.get(normalized);
      const source = String(artist.source || "").trim().toLowerCase() || "local";
      if (old) {
        old.playcount = Math.max(Number(old.playcount || 0), Number(artist.playcount || 0));
        if (!old.sources.includes(source)) old.sources.push(source);
        if ((SOURCE_RANK[source] || 0) > (SOURCE_RANK[old.source] || 0)) old.source = source;
        if (!old.mbid && mbid) old.mbid = mbid;
        if (mbid) keys.set(mbid, old);
        continue;
      }
      const merged = { ...artist, artistName: name, mbid: artist.mbid || null,
        source, sources: [...new Set([...(Array.isArray(artist.sources) ? artist.sources : []), source])],
        playcount: Math.max(0, Number(artist.playcount || 0)) };
      result.push(merged);
      byName.set(normalized, merged);
      if (mbid) keys.set(mbid, merged);
      if (result.length >= cap) break;
    }
  }
  return result;
}
