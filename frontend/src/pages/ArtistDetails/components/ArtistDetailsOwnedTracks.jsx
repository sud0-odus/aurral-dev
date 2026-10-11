import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, ListPlus, StepForward } from "lucide-react";
import { TrackList } from "../../../components/TrackList";
import RouteLink from "../../../components/RouteLink";
import { useAudioQueue } from "../../../contexts/audioQueueContext";
import { buildAuthenticatedApiUrl } from "../../../utils/api/core.js";
import { getLibraryPage } from "../../../utils/api/endpoints/library.js";

const limit = 50;
const getAvailableFile = (track) => (track?.files || []).find((file) => file?.available);

const resolveOwnedTracks = async (artistMbid, artistName) => {
  const artistsPage = await getLibraryPage({ kind: "artists", query: artistName, page: 1, pageSize: 100 });
  const artists = artistsPage?.items || [];
  const artist = artists.find((entry) =>
    String(entry.mbid || "").toLowerCase() === String(artistMbid || "").toLowerCase(),
  ) || artists.find((entry) =>
    String(entry.name || "").toLowerCase() === String(artistName || "").toLowerCase(),
  );
  if (!artist?.id) return { artist: null, tracks: [], albums: [] };
  const page = await getLibraryPage({
    kind: "tracks", artistId: artist.id, page: 1, pageSize: limit, availableOnly: true,
  });
  return { artist, tracks: page?.items || [], albums: page?.albums || [] };
};

const formatDuration = (track, file) => {
  const milliseconds = Number(file?.durationMs || track?.durationMs || 0);
  if (!milliseconds) return "";
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export function ArtistDetailsOwnedTracks({ artistMbid, artistName, existsInLibrary }) {
  const { playQueue, queueNext, addToQueue, currentTrack, isPlaying, matchesSource } = useAudioQueue();
  const source = useMemo(() => ({ type: "native-library", id: "library", label: "Library" }), []);
  const { data, isLoading } = useQuery({
    queryKey: ["artist-details-owned-tracks", artistMbid, artistName],
    queryFn: () => resolveOwnedTracks(artistMbid, artistName),
    enabled: Boolean(existsInLibrary && artistMbid && artistName),
    staleTime: 30_000,
  });
  if (!existsInLibrary) return null;
  const tracks = data?.tracks || [];
  if (!isLoading && !tracks.length) return null;
  const albumsById = new Map((data?.albums || []).map((album) => [String(album.id), album]));
  const playable = tracks.map((track) => {
    const file = getAvailableFile(track);
    const relation = (track.albums || []).find((item) => albumsById.has(String(item.albumId)));
    const album = albumsById.get(String(relation?.albumId || file?.albumId || ""));
    if (!file || !album) return null;
    return {
      id: track.id,
      title: track.title,
      artist: artistName,
      album: album.title || track.albumName || "",
      src: file.previewUrl || buildAuthenticatedApiUrl(
        `/library/canonical-stream/${encodeURIComponent(album.id)}/${encodeURIComponent(track.id)}`,
      ),
      streamFormat: file.format || null,
      quality: file.quality || null,
      artistMbid,
      albumMbid: album.releaseGroupMbid || album.mbid || null,
      trackMbid: track.mbid || track.trackMbid || null,
      libraryTrackId: track.id,
      libraryAlbumId: album.id,
      durationMs: Number(file.durationMs || track.durationMs || 0) || null,
      recordHistory: true,
    };
  }).filter(Boolean);
  const play = (trackId) => {
    if (!playable.length) return;
    playQueue(playable, { startTrackId: trackId, source });
  };
  const rows = tracks.map((track, index) => {
    const file = getAvailableFile(track);
    const relation = (track.albums || []).find((item) => albumsById.has(String(item.albumId)));
    const album = albumsById.get(String(relation?.albumId || file?.albumId || ""));
    const ownQueueItem = playable.find((item) => String(item.id) === String(track.id));
    const active = matchesSource(source) && String(currentTrack?.id) === String(track.id);
    return {
      key: track.id,
      number: index + 1,
      title: track.title || "Unknown track",
      album: { label: album?.title || track.albumName || "", to: album?.id ? `/library/album/${encodeURIComponent(album.id)}` : null },
      artist: { label: artistName },
      time: formatDuration(track, file),
      active,
      playing: active && isPlaying,
      playDisabled: !ownQueueItem,
      onPlay: ownQueueItem ? () => play(track.id) : null,
      menu: ownQueueItem ? {
        items: [
          { id: "play", label: "Play", icon: Play, onSelect: () => play(track.id) },
          { id: "next", label: "Play next", icon: StepForward, onSelect: () => queueNext([ownQueueItem], { source }) },
          { id: "queue", label: "Add to queue", icon: ListPlus, onSelect: () => addToQueue([ownQueueItem], { source }) },
        ],
      } : null,
    };
  });
  return (
    <section className="artist-section">
      <div className="artist-heading-row">
        <h2 className="artist-section-title">In Your Library</h2>
        {data?.artist?.id ? (
          <RouteLink to={`/library/artist/${encodeURIComponent(data.artist.id)}`} className="btn btn-ghost btn-sm">
            View in Library
          </RouteLink>
        ) : null}
      </div>
      {isLoading ? <p>Loading your tracks…</p> : <TrackList label="Owned artist tracks" rows={rows} />}
    </section>
  );
}
