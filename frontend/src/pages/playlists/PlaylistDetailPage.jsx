import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Clock, Download, Pencil, RefreshCw, Share2, Trash2 } from "lucide-react";
import { DotLoader } from "../../components/DotLoader";
import { SkeletonCollectionHeader, SkeletonRows, SkeletonStatus } from "../../components/Skeletons";
import { CollectionHeader, CollectionPage, CollectionPlayButtons } from "../../components/CollectionHeader";
import { LibraryItemMenu } from "../../components/LibraryItemMenu";
import TooltipButton from "../../components/TooltipButton";
import { useAuth } from "../../contexts/AuthContext";
import { useToast } from "../../contexts/ToastContext";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";
import { queryClient, queryKeys } from "../../queryClient.js";
import {
  deleteStaticPlaylist,
  setPlaylistRecordHistory,
  setPlaylistTrackAvailability,
  syncStaticPlaylistImport,
  updateStaticPlaylist,
} from "../../utils/api/endpoints/playlists.js";
import { getApiErrorMessage } from "../onboardingUtils.jsx";
import { getData, putData } from "../../utils/api/core.js";
import { ConfirmModal } from "../../components/ConfirmModal.jsx";
import { PlaylistArtworkThumb } from "./components/PlaylistArtworkThumb.jsx";
import { getStaticPlaylistTrackCount } from "./playlistStats";
import { PlaylistEditModal } from "./PlaylistEditModal.jsx";
import { PlaylistTracks } from "./PlaylistTracks.jsx";
import { usePlaylistTrackPlayback } from "./components/playlistTrackComponents.jsx";
import {
  SYNC_INTERVAL_OPTIONS,
  SYNCABLE_IMPORT_PROVIDERS,
  exportPlaylistTracklist,
  formatTrackTotal,
  getImportedProviderLabel,
  choiceMenuItem,
  optionMenuItem,
  usePlaylistArtwork,
  usePlaylistTracks,
} from "./playlistPageUtils";
import { countAvailableTracks } from "./trackAvailability.js";
import { usePlaylistStatus } from "./usePlaylistStatus";
import { useHiddenPlaylistTracks } from "./usePlaylistBulkActions.js";

function updateCachedPlaylist(playlistId, changes) {
  queryClient.setQueryData(queryKeys.playlistStatus, (current) =>
    current
      ? {
          ...current,
          sharedPlaylists: current.sharedPlaylists.map((playlist) =>
            playlist.id === playlistId ? { ...playlist, ...changes } : playlist,
          ),
        }
      : current,
  );
}

export default function PlaylistDetailPage() {
  const { playlistId } = useParams();
  const location = useLocation();
  const { status, loading, error, fetchStatus, getPlaylistStats, staticPlaylists } =
    usePlaylistStatus();
  const playlist = staticPlaylists.find((entry) => entry.id === playlistId) || null;
  useDocumentTitle(playlist?.name || "Playlist");

  if (!playlist) {
    const waiting = (loading && !status) || location.state?.created;
    return (
      <div className="library-page native-library-page playlist-page">
        <div className="native-library-content">
          {waiting ? (
            <SkeletonStatus label="Loading playlist" className="native-library-detail">
              <SkeletonCollectionHeader />
              <SkeletonRows count={10} />
            </SkeletonStatus>
          ) : error && !status ? (
            <div className="native-library-state" role="alert">
              <strong>Playlist unavailable</strong>
              <span>Aurral could not load this playlist.</span>
              <button type="button" className="native-library-state__action" onClick={fetchStatus}>
                Retry
              </button>
            </div>
          ) : (
            <div className="native-library-state">
              <strong>Playlist not found</strong>
              <span>It may have been deleted.</span>
              <Link to="/library/playlists" className="native-library-state__action">
                Back to playlists
              </Link>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <PlaylistDetail
      key={playlist.id}
      playlist={playlist}
      stats={getPlaylistStats(playlist.id)}
      staticPlaylists={staticPlaylists}
      fetchStatus={fetchStatus}
    />
  );
}

function PlaylistDetail({ playlist, stats, staticPlaylists, fetchStatus }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { showSuccess, showError } = useToast();
  const { artworkUrlFor } = usePlaylistArtwork();
  // PHASE8E9_SHARE_SUMMARY: show recipients only to owner/admin.
  const [sharedWith, setSharedWith] = useState([]);
  const canManageSharingSummary = user?.role === "admin" ||
    (playlist.ownerUserId != null && Number(playlist.ownerUserId) === Number(user?.id));
  const viewerUsersKey = (playlist.viewerUserIds || []).join(",");
  useEffect(() => {
    let cancelled = false;
    setSharedWith([]);
    if (!canManageSharingSummary) return undefined;
    getData(`/playlists/shared-playlists/${encodeURIComponent(playlist.id)}/share-summary`)
      .then(data => { if (!cancelled) setSharedWith(Array.isArray(data?.recipients) ? data.recipients : []); })
      .catch(() => { if (!cancelled) setSharedWith([]); });
    return () => { cancelled = true; };
  }, [canManageSharingSummary, playlist.id, viewerUsersKey]);
  const showTrackAvailability = playlist.showTrackAvailability === true;
  const { tracks: savedTracks, loading, error, refresh } = usePlaylistTracks(playlist.id, {
    pollAvailability: showTrackAvailability,
  });
  const hiddenTrackIds = useHiddenPlaylistTracks().get(playlist.id);
  const tracks = useMemo(
    () => (hiddenTrackIds ? savedTracks.filter((track) => !hiddenTrackIds.has(track.id)) : savedTracks),
    [hiddenTrackIds, savedTracks],
  );
  const playbackSource = {
    type: "playlist",
    id: playlist.id,
    label: playlist.name || "Playlist",
    recordHistory: playlist.recordHistory !== false,
  };
  const playback = usePlaylistTrackPlayback({ tracks, playbackSource });
  const [editOpen, setEditOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false); // PHASE8E5_SHARE_UI

  const importSource = playlist.importSource || null;
  const isSyncable = SYNCABLE_IMPORT_PROVIDERS.has(importSource?.provider);
  const providerLabel = isSyncable ? getImportedProviderLabel(importSource.provider) : "";
  const totalTracks = Math.max(
    0,
    getStaticPlaylistTrackCount(playlist, stats, savedTracks.length) - (savedTracks.length - tracks.length),
  );
  const trackLabel =
    showTrackAvailability && !loading && !error
      ? `${countAvailableTracks(tracks)}/${totalTracks} available`
      : formatTrackTotal(totalTracks);
  const owner = playlist.ownerUsername || user?.username || null;
  const mayManageSharing = user?.role === "admin" || (playlist.ownerUserId != null && Number(playlist.ownerUserId) === Number(user?.id));
  const syncInterval = importSource?.syncIntervalHours ?? 0;
  const metaParts = [owner, trackLabel];
  if (canManageSharingSummary && sharedWith.length) {
    metaParts.push(`Shared with ${sharedWith.map(u => u.username).join(", ")}`);
  }
  if (isSyncable) {
    metaParts.push(
      importSource?.syncEnabled === true
        ? `Synced from ${providerLabel}`
        : `Imported from ${providerLabel}`,
    );
  }

  const handleRename = async (name) => {
    setRenaming(true);
    setRenameError("");
    try {
      await updateStaticPlaylist(playlist.id, { name: String(name ?? "").trim() });
      showSuccess("Playlist renamed");
      await fetchStatus();
      setEditOpen(false);
    } catch (err) {
      const message = err.response?.data?.message || err.message || "Failed to rename playlist";
      setRenameError(message);
      showError(message);
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await deleteStaticPlaylist(playlist.id);
      showSuccess(result?.queued ? `Removal of ${playlist.name} queued` : `Deleted ${playlist.name}`);
      await fetchStatus();
      navigate("/library/playlists", { replace: true });
    } catch (err) {
      showError(err.response?.data?.message || err.message || "Failed to delete playlist");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await syncStaticPlaylistImport(playlist.id);
      if (result?.skipped) {
        showSuccess("Playlist is already up to date");
      } else {
        const queued = Number(result?.tracksQueued || 0);
        showSuccess(
          queued > 0
            ? `Synced ${queued} new track${queued === 1 ? "" : "s"} from ${providerLabel}`
            : `${providerLabel} playlist synced`,
        );
      }
      await fetchStatus();
      await refresh();
    } catch (err) {
      showError(getApiErrorMessage(err, "Failed to sync playlist"));
    } finally {
      setSyncing(false);
    }
  };

  const handleExport = async () => {
    try {
      exportPlaylistTracklist(playlist, tracks);
      showSuccess(`Exported ${playlist.name} tracklist`);
    } catch (err) {
      showError(err?.message || "Failed to export tracklist");
    }
  };

  const saveSetting = async (action, successMessage, fallbackMessage) => {
    try {
      await action();
      showSuccess(successMessage);
    } catch (err) {
      showError(getApiErrorMessage(err, fallbackMessage));
    }
  };

  const updateSyncInterval = (hours) =>
    saveSetting(
      async () => {
        await updateStaticPlaylist(playlist.id, {
          importSource: { syncIntervalHours: hours, syncEnabled: hours > 0 },
        });
        await fetchStatus();
      },
      hours > 0 ? "Sync schedule updated" : "Auto-sync turned off",
      "Failed to update sync schedule",
    );

  const updateKeepRemoved = (keepRemovedTracks) =>
    saveSetting(
      async () => {
        await updateStaticPlaylist(playlist.id, { importSource: { keepRemovedTracks } });
        await fetchStatus();
      },
      keepRemovedTracks
        ? "Removed tracks will stay in the library"
        : "Removed tracks will be deleted when unshared",
      "Failed to update removed-track setting",
    );

  const updateRecordHistory = (enabled) =>
    saveSetting(
      async () => {
        const result = await setPlaylistRecordHistory(playlist.id, enabled);
        updateCachedPlaylist(playlist.id, { recordHistory: result.recordHistory });
        await fetchStatus();
      },
      enabled ? "Scrobbling turned on" : "Scrobbling turned off",
      "Failed to update scrobbling setting",
    );

  const updateTrackAvailability = (enabled) =>
    saveSetting(
      async () => {
        const result = await setPlaylistTrackAvailability(playlist.id, enabled);
        await queryClient.cancelQueries({ queryKey: queryKeys.playlistStatus });
        updateCachedPlaylist(playlist.id, { showTrackAvailability: result.showTrackAvailability });
        if (enabled) await refresh();
      },
      enabled ? "Showing track availability" : "Hiding track availability",
      "Failed to update track availability",
    );

  return (
    <CollectionPage tintSrc={artworkUrlFor(playlist.id)} className="playlist-page">
      <CollectionHeader
        cover={
          <button
            type="button"
            className="playlist-detail__cover"
            onClick={() => setEditOpen(true)}
            aria-label={`Edit ${playlist.name} details`}
          >
            <PlaylistArtworkThumb artworkUrl={artworkUrlFor(playlist.id)} name={playlist.name} />
          </button>
        }
        corner={
          isSyncable ? (
            <TooltipButton
              className="native-library-icon-button"
              label={syncing ? "Syncing…" : "Sync now"}
              onClick={() => !syncing && handleSync()}
              aria-disabled={syncing}
            >
              {syncing ? <DotLoader size="sm" label={null} /> : <RefreshCw aria-hidden="true" />}
            </TooltipButton>
          ) : null
        }
        kicker="Playlist"
        title={playlist.name}
        meta={metaParts.filter(Boolean).join(" · ")}
        actions={
          <>
            <CollectionPlayButtons
              label={playlist.name}
              disabled={playback.disabled}
              isPlaying={playback.isListPlaying}
              isShuffleEnabled={playback.isShuffleEnabled}
              onPlay={playback.handlePlayAll}
              onShuffle={playback.handleShufflePlay}
            />
            <LibraryItemMenu
              label={playlist.name}
              contextMenu={false}
              items={[
                {
                  id: "edit",
                  label: "Edit details",
                  icon: Pencil,
                  onSelect: () => setEditOpen(true),
                },
                ...(mayManageSharing ? [{
                  id: "share", label: "Share playlist", icon: Share2,
                  onSelect: () => setSharingOpen(true),
                }] : []),
                {
                  id: "export",
                  label: "Export tracklist",
                  icon: Download,
                  disabled: tracks.length === 0,
                  onSelect: handleExport,
                },
                ...(isSyncable
                  ? [
                      {
                        id: "auto-sync",
                        label: "Auto-sync",
                        icon: Clock,
                        separatorBefore: true,
                        submenuItems: SYNC_INTERVAL_OPTIONS.map((option) =>
                          choiceMenuItem({
                            id: `sync-${option.value}`,
                            label: option.label,
                            checked: syncInterval === option.value,
                            onSelect: () => updateSyncInterval(option.value),
                          }),
                        ),
                      },
                      optionMenuItem({
                        id: "keep-removed",
                        label: "Keep removed tracks in library",
                        checked: importSource?.keepRemovedTracks !== false,
                        onSelect: () =>
                          updateKeepRemoved(importSource?.keepRemovedTracks === false),
                      }),
                    ]
                  : []),
                optionMenuItem({
                  id: "scrobble",
                  label: "Scrobble tracks",
                  checked: playlist.recordHistory !== false,
                  separatorBefore: !isSyncable,
                  onSelect: () => updateRecordHistory(playlist.recordHistory === false),
                }),
                optionMenuItem({
                  id: "availability",
                  label: "Show track availability",
                  checked: showTrackAvailability,
                  onSelect: () => updateTrackAvailability(!showTrackAvailability),
                }),
                {
                  id: "delete",
                  label: "Delete playlist",
                  icon: Trash2,
                  danger: true,
                  separatorBefore: true,
                  onSelect: () => setConfirmDelete(true),
                },
              ]}
            />
          </>
        }
      />
      <PlaylistTracks
        entry={playlist}
        kind="shared"
        tracks={tracks}
        loading={loading}
        error={error}
        refresh={refresh}
        staticPlaylists={staticPlaylists}
        fetchStatus={fetchStatus}
        emptyMessage="No tracks in this playlist yet."
        showTrackAvailability={showTrackAvailability}
        recordHistory={playlist.recordHistory !== false}
      />

      {mayManageSharing && sharingOpen && <PlaylistSharingEditor playlist={playlist} onClose={() => setSharingOpen(false)} showSuccess={showSuccess} />}
      <PlaylistEditModal
        entry={playlist}
        title="Edit playlist"
        open={editOpen}
        saving={renaming}
        error={renameError}
        onClose={() => {
          setRenameError("");
          setEditOpen(false);
        }}
        onRename={handleRename}
      />
      <ConfirmModal
        open={confirmDelete}
        title={`Delete ${playlist.name}?`}
        body="This removes the playlist and any downloaded files tied to it."
        confirmLabel="Delete playlist"
        busyLabel="Deleting…"
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </CollectionPage>
  );
}


// PHASE8E5_SHARE_UI: share changes are opt-in and constrained by the server to owner/admin.
function PlaylistSharingEditor({ playlist, onClose, showSuccess }) {
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Fetch once on mount. Server returns the eligible recipient roster, no credentials.
  // Mount-only effect is safe because the parent uses a stable playlist detail identity.
  useEffect(() => {
    let alive = true;
    getData(`/playlists/shared-playlists/${encodeURIComponent(playlist.id)}/sharing`)
      .then(data => { if (alive) {
        setUsers(Array.isArray(data.users) ? data.users : []);
        setSelected(Array.isArray(data.viewers) ? data.viewers.map(Number) : []);
        setLoaded(true);
      } })
      .catch(err => { if (alive) setError(err.response?.data?.error || err.message || "Could not load sharing settings"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [playlist.id]);
  const save = async () => {
    if (!loaded || saving) return;
    setSaving(true); setError("");
    try {
      await putData(`/playlists/shared-playlists/${encodeURIComponent(playlist.id)}/sharing`, { viewerUserIds: selected });
      showSuccess("Playlist sharing updated");
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || "Could not save sharing settings");
    } finally { setSaving(false); }
  };
  return <div role="presentation" style={{position:"fixed",inset:0,zIndex:1500,background:"var(--aurral-overlay)",display:"grid",placeItems:"center",padding:16}}>
    <section role="dialog" aria-modal="true" aria-label={`Share ${playlist.name}`} style={{width:"min(460px,100%)",border:"1px solid var(--aurral-border)",borderRadius:12,background:"var(--aurral-surface)",padding:20,color:"inherit"}}>
      <h2 style={{marginTop:0}}>Share {playlist.name}</h2>
      <p>Select Aurral users who can view and play this playlist. You remain the owner; recipients cannot edit or delete it.</p>
      {loading && <p role="status">Loading users…</p>}
      {error && <p role="alert" style={{color:"var(--aurral-danger)"}}>{error}</p>}
      {loaded && <div style={{display:"grid",gap:10,margin:"16px 0"}}>{users.map(person => <label key={person.id} style={{display:"flex",gap:10,alignItems:"center"}}>
        <input type="checkbox" checked={selected.includes(Number(person.id))} disabled={saving} onChange={e => setSelected(previous => e.target.checked ? [...previous,Number(person.id)] : previous.filter(id => id !== Number(person.id)))} />
        {person.username}
      </label>)}{users.length === 0 && <p>No eligible active users.</p>}</div>}
      <div style={{display:"flex",justifyContent:"flex-end",gap:10,marginTop:16}}>
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!loaded || saving} onClick={save}>{saving ? "Saving…" : "Save sharing"}</button>
      </div>
    </section>
  </div>;
}
