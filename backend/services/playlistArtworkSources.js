// Artwork is derived only from the playlist owner/track metadata. Unknown
// hosts and private-network URLs are never fetched by the image renderer.
const ALLOWED_COVER_HOSTS = new Set([
  "e-cdns-images.dzcdn.net", "cdn-images.dzcdn.net",
  "i.scdn.co", "coverartarchive.org", "lastfm.freetls.fastly.net",
]);
export function isTrustedArtworkUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_COVER_HOSTS.has(host) ||
      /^is[0-9]+-ssl\.mzstatic\.com$/.test(host);
  } catch {
    return false;
  }
}
export const normalizeArtworkUrl = value =>
  isTrustedArtworkUrl(value) ? String(value).trim() : null;
const trimmed = value => String(value || "").trim();
const nameKey = value => trimmed(value).normalize("NFKC").toLowerCase();

export function getPlaylistArtworkSources(entity = {}) {
  const tracks = Array.isArray(entity.tracks) ? entity.tracks : [];
  const artistCounts = new Map();
  const artworkChoices = new Map();
  for (const track of tracks) {
    const artist = trimmed(track?.artistName);
    if (!artist) continue;
    const key = nameKey(artist);
    const count = artistCounts.get(key);
    if (count) count.count += 1;
    else artistCounts.set(key, { artist, count: 1 });
    const url = normalizeArtworkUrl(track.artworkUrl || track.coverUrl);
    if (!url) continue;
    const albumKey = nameKey(track.albumName) || key;
    if (!artworkChoices.has(albumKey)) artworkChoices.set(albumKey, { url, artistKey: key });
  }
  const artists = [...artistCounts.values()].sort((a,b)=>b.count-a.count || a.artist.localeCompare(b.artist));
  const labels = artists.slice(0, 3).map(x=>x.artist);
  if (!labels.length) {
    const related = Array.isArray(entity.relatedArtists) ? entity.relatedArtists :
      (entity.relatedArtists && typeof entity.relatedArtists === "object"
        ? Object.keys(entity.relatedArtists) : []);
    for (const item of related) {
      const name = trimmed(typeof item === "string" ? item : item?.name || item?.artistName);
      if (name && !labels.some(label=>nameKey(label)===nameKey(name))) labels.push(name);
      if (labels.length >= 3) break;
    }
  }
  // One cover per artist first, then fill remaining positions with albums.
  const selected = [], seen = new Set();
  for (const value of artworkChoices.values()) {
    if (seen.has(value.artistKey)) continue;
    selected.push(value.url);
    seen.add(value.artistKey);
    if (selected.length >= 4) break;
  }
  if (selected.length < 4) {
    for (const value of artworkChoices.values()) {
      if (selected.includes(value.url)) continue;
      selected.push(value.url);
      if (selected.length >= 4) break;
    }
  }
  return { imageUrls: selected, artistNames: labels };
}
