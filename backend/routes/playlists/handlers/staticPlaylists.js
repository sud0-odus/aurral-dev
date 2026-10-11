import { cleanupBulkOperations, getBulkOperation } from "../../../services/playlists/bulkOperationStore.js";
import { captureStaticPlaylistSelection, getSharedDownloadReferences } from "../../../services/playlists/trackRemoval.js";
import { randomUUID } from "crypto";
import { downloadTracker } from "../../../services/downloadJobs/downloadTracker.js";
import {
  dedupePlaylistTracks,
  flowPlaylistConfig,
} from "../../../services/playlists/flowPlaylistConfig.js";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.js";
import {
  enqueueResearchTrack,
  getAccessibleStaticPlaylist,
} from "./utils.js";
import { normalizeImportSource } from "../../../services/playlists/flowPlaylistConfig.js";
import {
  markDownloadWorkCancelledForJobs,
  markPlaylistDownloadWorkCancelled,
  restoreMarkedPlaylistDownloadWork,
} from "../../../services/downloadJobs/downloadCancellationService.js";
import {
  isDownloadJobCancelled,
  restoreDownloadJobCancellations,
} from "../../../services/downloadJobs/downloadCancellation.js";

async function createOrImportStaticPlaylist(req, res, { requireTracks, label, successHtml = false }) {
  const {
    name,
    sourceName = null,
    sourceFlowId = null,
    tracks,
  } = req.body || {};
  const safeName = String(name || "").trim();
  const normalizedTracks = Array.isArray(tracks) ? dedupePlaylistTracks(tracks) : [];
  const rawTracksProvided = Array.isArray(tracks);

  if (!safeName) {
    return res.status(400).json({ error: "name is required" });
  }
  if (requireTracks && normalizedTracks.length === 0) {
    return res.status(400).json({
      error: "tracks are required",
      message: "Import file must include at least one track",
    });
  }
  if (rawTracksProvided && tracks.length > 0 && normalizedTracks.length === 0) {
    return res.status(400).json({
      error: "tracks are invalid",
      message: "Add at least one valid track",
    });
  }

  const playlistId = randomUUID();
  const result = await playlistOperationQueue.enqueuePayload({
    kind: "shared-playlist-create",
    label,
    playlistId,
    name: safeName,
    sourceName,
    sourceFlowId,
    tracks: normalizedTracks,
    ownerUserId: req.user.id,
  });

  // APPLE_PHASE4_SUCCESS_V1: only the Apple confirmation form requests HTML.
  if (successHtml) {
    const content = `<p>Apple Music playlist <b>${htmlEscape(safeName)}</b> was accepted.</p><p><b>${normalizedTracks.length} tracks</b> have been queued in Aurral.</p><p>Operation ID: ${result.operationId}</p><p><a href="/">Open Aurral</a> to view playlists and download progress.</p><p>You can close this tab or return to the Apple Music POC for another playlist.</p>`;
    return res.set("Cache-Control", "no-store").type("html").send(appleImportPage("Apple Music import queued", content));
  }
  return res.json({
    success: true,
    playlistId,
    queued: true,
    operationId: result.operationId,
  });
}

async function enqueueBulkAction(req, res, action) {
  const source = getAccessibleStaticPlaylist(req.user, req.params.playlistId);
  if (!source) return res.status(404).json({ error: "Playlist not found" });
  const { jobIds, target: requestedTarget } = req.body || {};
  if (!Array.isArray(jobIds) || !jobIds.length || jobIds.some((id) => typeof id !== "string" || !id.trim())) {
    return res.status(400).json({ error: "jobIds must contain at least one track ID" });
  }
  const ids = [...new Set(jobIds.map((id) => id.trim()))];
  let target = null;
  if (action === "move") {
    const playlistId = typeof requestedTarget?.playlistId === "string" ? requestedTarget.playlistId.trim() : "";
    const name = typeof requestedTarget?.name === "string" ? requestedTarget.name.trim() : "";
    if (Boolean(playlistId) === Boolean(name)) return res.status(400).json({ error: "Specify a destination playlist ID or name" });
    if (playlistId === source.id) return res.status(400).json({ error: "Choose a different destination playlist" });
    if (playlistId && !getAccessibleStaticPlaylist(req.user, playlistId)) return res.status(404).json({ error: "Destination playlist not found" });
    target = playlistId ? { playlistId } : { playlistId: randomUUID(), name, create: true };
  }
  const selections = [];
  const rejected = [];
  for (const jobId of ids) {
    const selection = captureStaticPlaylistSelection(source, jobId);
    if (selection) selections.push(selection);
    else rejected.push({ jobId, message: "Track not found in this playlist" });
  }
  if (!selections.length) return res.json({ queued: false, acceptedJobIds: [], rejected });
  const result = await playlistOperationQueue.enqueueBulkPayload({
    ownerUserId: req.user.id, sourcePlaylistId: source.id, action, target, selections,
  });
  return res.json({ ...result, acceptedJobIds: selections.map((selection) => selection.jobId), rejected });
}

// APPLE_IMPORT_BRIDGE_V1: import only in Aurral's authenticated user context.
// The Apple POC is contacted server-to-server on loopback. No browser cookies are forwarded.
import https from "node:https";

const APPLE_ID = /^pl\.[A-Za-z0-9_.-]{1,100}$/;
function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));
}
function appleExport(playlistId, name) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({id: playlistId, name});
    const req = https.get({hostname:"127.0.0.1",port:3333,path:`/api/export?${qs}`,
      // Local POC uses a self-signed development certificate; restrict exception to loopback.
      rejectUnauthorized:false,timeout:30000}, (res) => {
      let buffer="";
      res.setEncoding("utf8");
      res.on("data", chunk => {buffer+=chunk;if(buffer.length>1024*1024)res.destroy(new Error("Apple response too large"));});
      res.on("end", () => {
        if(res.statusCode!==200) return reject(new Error(`Apple POC HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(buffer)); } catch (err) { reject(err); }
      });
      res.on("error",reject);
    });
    req.on("timeout",()=>req.destroy(new Error("Apple POC timeout")));
    req.on("error",reject);
  });
}
function appleImportPage(title, content) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{font:16px system-ui;max-width:700px;margin:4rem auto;padding:1rem;background:#141820;color:#fff}button{background:#d94462;border:0;color:#fff;padding:12px 20px;cursor:pointer;border-radius:6px}a{color:#a5d5ff}li{margin:6px 0}</style><h1>${htmlEscape(title)}</h1>${content}</html>`;
}
function appleParams(req) {
  const playlistId=String(req.query.id||req.body?.id||"");
  const name=String(req.query.name||req.body?.name||"Apple Music Playlist").trim().slice(0,120);
  if(!APPLE_ID.test(playlistId)||!name) return null;
  return {playlistId,name};
}

export function registerStaticPlaylists(router) {
  // Aurral-owned confirmation flow; requireAuth/accessFlow already applied by parent router.
  router.get("/shared-playlists/apple-import", async (req, res) => {
    const args=appleParams(req);
    if(!args) return res.status(400).send("Invalid Apple playlist");
    try {
      const payload=await appleExport(args.playlistId,args.name);
      const tracks=Array.isArray(payload.tracks)?payload.tracks:[];
      if(!tracks.length) return res.status(422).send("No tracks returned from Apple POC");
      const body=`<p>Signed in to Aurral. Preview the Apple playlist before importing.</p><p><b>${htmlEscape(args.name)}</b> — ${tracks.length} tracks</p><ol>${tracks.slice(0,30).map(t=>`<li>${htmlEscape(t.artistName)} — ${htmlEscape(t.trackName)}</li>`).join("")}</ol>${tracks.length>30?"<p>Showing first 30 tracks.</p>":""}<form method="post" action="/api/playlists/shared-playlists/apple-import?id=${encodeURIComponent(args.playlistId)}&amp;name=${htmlEscape(encodeURIComponent(args.name))}"><button type="submit">Confirm import into Aurral</button></form><p>Existing JSON export remains available in the Apple POC.</p>`;
      res.set("Cache-Control","no-store").type("html").send(appleImportPage("Import Apple Music playlist",body));
    } catch(err) {res.status(502).type("html").send(appleImportPage("Apple connection unavailable","<p>Reconnect in the Apple POC and retry. No playlist was created.</p>"));}
  });
  router.post("/shared-playlists/apple-import", async (req,res) => {
    const args=appleParams(req);
    if(!args) return res.status(400).send("Invalid Apple playlist");
    try {
      const payload=await appleExport(args.playlistId,args.name);
      if(!Array.isArray(payload.tracks)||!payload.tracks.length) return res.status(422).send("No tracks returned");
      req.body={name:args.name,sourceName:"Apple Music",tracks:payload.tracks};
      // Exact same owner-scoped queue and validation as the existing JSON import.
      const result=await createOrImportStaticPlaylist(req,res,{requireTracks:true,label:"shared-playlist:apple-import",successHtml:true});
      return result;
    } catch(err) { return res.status(502).json({error:"Apple import unavailable",message:"Reconnect Apple POC and retry. No import queued."}); }
  });

  for (const [path, action] of [["track-removals", "remove"], ["track-moves", "move"]]) {
    router.post(`/shared-playlists/:playlistId/${path}`, async (req, res) => {
      try { return await enqueueBulkAction(req, res, action); }
      catch (error) { return res.status(500).json({ error: "Failed to queue playlist action", message: error.message }); }
    });
  }
  router.get("/shared-playlists/:playlistId/operations/:operationId", (req, res) => {
    try {
      cleanupBulkOperations();
      const record = getBulkOperation(req.params.operationId);
      if (!record || record.ownerUserId !== req.user.id || record.sourcePlaylistId !== req.params.playlistId ||
          !getAccessibleStaticPlaylist(req.user, req.params.playlistId)) {
        return res.status(404).json({ error: "Playlist operation not found" });
      }
      return res.json({ operationId: record.operationId, state: record.state, action: record.action,
        outcomes: record.outcomes, targetPlaylistId: record.target?.playlistId || null,
        message: record.message || null });
    } catch (error) { return res.status(500).json({ error: "Failed to read playlist operation", message: error.message }); }
  });
  router.post("/shared-playlists", async (req, res) => {
    try {
      return await createOrImportStaticPlaylist(req, res, {
        requireTracks: false,
        label: "shared-playlist:create",
      });
    } catch (error) {
      if (error?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
        return res.status(400).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      res.status(500).json({
        error: "Failed to create playlist",
        message: error.message,
      });
    }
  });

  router.post("/shared-playlists/import", async (req, res) => {
    try {
      return await createOrImportStaticPlaylist(req, res, {
        requireTracks: true,
        label: "shared-playlist:import",
      });
    } catch (error) {
      if (error?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
        return res.status(400).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      res.status(500).json({
        error: "Failed to import playlist",
        message: error.message,
      });
    }
  });

  router.post("/shared-playlists/:playlistId/tracks", async (req, res) => {
    try {
      const { playlistId } = req.params;
      const playlist = getAccessibleStaticPlaylist(req.user, playlistId);
      if (!playlist) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      const rawTracks = req.body?.tracks;
      const normalizedTracks = Array.isArray(rawTracks) ? dedupePlaylistTracks(rawTracks) : [];
      if (Array.isArray(rawTracks) && rawTracks.length > 0 && normalizedTracks.length === 0) {
        return res.status(400).json({
          error: "tracks are invalid",
          message: "Add at least one valid track",
        });
      }
      if (normalizedTracks.length === 0) {
        return res.status(400).json({
          error: "tracks are required",
          message: "Add at least one valid track",
        });
      }

      const result = await playlistOperationQueue.enqueuePayload({
        kind: "shared-playlist-append-tracks",
        label: `shared-playlist:${playlistId}:tracks:add`,
        playlistId,
        tracks: normalizedTracks,
      });

      return res.json({
        success: true,
        playlistId,
        queued: true,
        operationId: result.operationId,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to add playlist tracks",
        message: error.message,
      });
    }
  });

  router.put("/shared-playlists/:playlistId/track-availability", (req, res) => {
    const { playlistId } = req.params;
    if (!getAccessibleStaticPlaylist(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    const playlist = flowPlaylistConfig.updateStaticPlaylist(playlistId, {
      showTrackAvailability: req.body.enabled,
    });
    return res.json({ success: true, showTrackAvailability: playlist.showTrackAvailability });
  });

  router.put("/shared-playlists/:playlistId/record-history", (req, res) => {
    const { playlistId } = req.params;
    if (!getAccessibleStaticPlaylist(req.user, playlistId)) {
      return res.status(404).json({ error: "Playlist not found" });
    }
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    const playlist = flowPlaylistConfig.updateStaticPlaylist(playlistId, {
      recordHistory: req.body.enabled,
    });
    return res.json({ success: true, recordHistory: playlist.recordHistory });
  });

  router.put("/shared-playlists/:playlistId", async (req, res) => {
    try {
      const { playlistId } = req.params;
      const { name, tracks } = req.body || {};
      const body = req.body || {};
      const hasNameUpdate = Object.hasOwn(body, "name");
      const hasTracksUpdate = Object.hasOwn(body, "tracks");
      const hasImportSourceUpdate = Object.hasOwn(body, "importSource");
      if (!hasNameUpdate && !hasTracksUpdate && !hasImportSourceUpdate) {
        return res.status(400).json({
          error: "At least one playlist field is required",
        });
      }
      const currentPlaylist = getAccessibleStaticPlaylist(req.user, playlistId);
      if (!currentPlaylist) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      const safeName = hasNameUpdate
        ? String(name || "").trim()
        : String(currentPlaylist.name || "").trim();
      if (!safeName) {
        return res.status(400).json({ error: "name is required" });
      }
      const normalizedTracks = hasTracksUpdate
        ? Array.isArray(tracks) ? dedupePlaylistTracks(tracks) : []
        : currentPlaylist.tracks;
      if (
        hasTracksUpdate &&
        Array.isArray(tracks) &&
        tracks.length > 0 &&
        normalizedTracks.length === 0
      ) {
        return res.status(400).json({
          error: "tracks are invalid",
          message: "Playlist update must include at least one valid track",
        });
      }
      let importSource = null;
      if (hasImportSourceUpdate) {
        if (!currentPlaylist.importSource) {
          return res.status(400).json({
            error: "Playlist has no import source",
          });
        }
        importSource = normalizeImportSource({
          ...currentPlaylist.importSource,
          ...(req.body?.importSource || {}),
        });
        if (!importSource) {
          return res.status(400).json({
            error: "importSource is invalid",
          });
        }
      }

      const result = await playlistOperationQueue.enqueuePayload({
        kind: "shared-playlist-update",
        label: `shared-playlist:${playlistId}:update`,
        playlistId,
        name: safeName,
        tracks: normalizedTracks,
        hasNameUpdate,
        hasTracksUpdate,
        hasImportSourceUpdate,
        importSource,
      });
      return res.json({
        success: true,
        playlistId,
        queued: true,
        operationId: result.operationId,
      });
    } catch (error) {
      if (error?.code === "STATIC_PLAYLIST_NAME_CONFLICT") {
        return res.status(400).json({
          error: "Playlist name already exists",
          message: error.message,
        });
      }
      res.status(500).json({
        error: "Failed to update playlist",
        message: error.message,
      });
    }
  });

  router.delete(
    "/shared-playlists/:playlistId/tracks/:jobId",
    async (req, res) => {
      try {
        const { playlistId, jobId } = req.params;
        const playlist = getAccessibleStaticPlaylist(req.user, playlistId);
        if (!playlist) {
          return res.status(404).json({ error: "Playlist not found" });
        }
        const job = downloadTracker.getJob(jobId);
        const playlistReferencesJob = playlist.tracks?.some(
          (track) => String(track?.canonicalJobId || "") === String(jobId || ""),
        );
        if (!job || (job.playlistType !== playlistId && !playlistReferencesJob)) {
          return res.status(404).json({ error: "Track not found" });
        }
        const shouldCancelJob = !playlistReferencesJob && getSharedDownloadReferences(job.id, playlistId).length === 0;
        const wasJobCancelled = isDownloadJobCancelled(job.id);
        if (shouldCancelJob) {
          markDownloadWorkCancelledForJobs([job]);
        }
        let result;
        try {
          result = await playlistOperationQueue.enqueuePayload({
            kind: "shared-playlist-delete-track",
            label: `shared-playlist:${playlistId}:track:${jobId}:delete`,
            playlistId,
            jobId,
          });
        } catch (error) {
          if (shouldCancelJob && !wasJobCancelled) {
            restoreDownloadJobCancellations([job.id]);
          }
          throw error;
        }

        return res.json({
          success: true,
          playlistId,
          removedJobId: jobId,
          queued: true,
          operationId: result.operationId,
        });
      } catch (error) {
        res.status(500).json({
          error: "Failed to remove playlist track",
          message: error.message,
        });
      }
    },
  );

  router.post(
    "/shared-playlists/:playlistId/tracks/:jobId/research",
    async (req, res) => {
      try {
        const { playlistId, jobId } = req.params;
        return await enqueueResearchTrack(
          req,
          res,
          playlistId,
          jobId,
          "shared-playlist",
        );
      } catch (error) {
        res.status(500).json({
          error: "Failed to re-search playlist track",
          message: error.message,
        });
      }
    },
  );

  router.delete("/shared-playlists/:playlistId", async (req, res) => {
    try {
      const { playlistId } = req.params;
      const exists = getAccessibleStaticPlaylist(req.user, playlistId);
      if (!exists) {
        return res.status(404).json({ error: "Playlist not found" });
      }
      const ownedJobs = downloadTracker.getByPlaylistId(playlistId);
      const retainsDownloads = ownedJobs.some((job) => getSharedDownloadReferences(job.id, playlistId).length > 0);
      const cancellation = retainsDownloads ? null : markPlaylistDownloadWorkCancelled(playlistId, ownedJobs);

      let deleted;
      try {
        deleted = await playlistOperationQueue.enqueuePayload({
          kind: "shared-playlist-delete",
          label: `shared-playlist:${playlistId}:delete`,
          playlistId,
        });
      } catch (error) {
        if (cancellation) restoreMarkedPlaylistDownloadWork(playlistId, cancellation);
        throw error;
      }
      return res.json({
        success: true,
        playlistId,
        queued: true,
        operationId: deleted.operationId,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to delete playlist",
        message: error.message,
      });
    }
  });
}
