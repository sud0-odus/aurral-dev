import https from "node:https";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.js";
import { playlistOperationQueue } from "../../../services/playlists/playlistOperationQueue.js"; // PHASE8D3B_SELECTIVE_RESTORE

// Phase 5 homelab bridge: the Apple POC runs on this container only.
// The POC's self-signed certificate is accepted only for this fixed loopback target.
function pocRequest(path, userId, method = "GET", payload = null) {
  return new Promise((resolve, reject) => {
    const data = payload == null ? null : JSON.stringify(payload);
    const req = https.request({
      hostname: "127.0.0.1", port: 3333, path, method,
      rejectUnauthorized: false,
      timeout: 165000,
      headers: {
        Accept: "application/json",
        "X-Aurral-User-Id": String(userId),
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2_000_000) { req.destroy(new Error("Apple response too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        try { resolve({ status: res.statusCode || 502, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new Error("Apple bridge returned invalid JSON")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Apple bridge timed out")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

export function registerAppleMusicPoc(router) {
  // PHASE8D3B_SELECTIVE_RESTORE: revalidate Apple source and current owner playlist before queueing.
  router.post("/apple-poc/restore-missing", async (req, res) => {
    const { playlistId, applePlaylistId, selectedIndexes } = req.body || {};
    if (typeof playlistId !== "string" || !/^[0-9a-f-]{36}$/i.test(playlistId) ||
        typeof applePlaylistId !== "string" || !/^pl\.[A-Za-z0-9_.-]{1,100}$/.test(applePlaylistId) ||
        !Array.isArray(selectedIndexes) || selectedIndexes.length < 1 || selectedIndexes.length > 50 ||
        selectedIndexes.some(i => !Number.isSafeInteger(i) || i < 0 || i >= 3000) ||
        new Set(selectedIndexes).size !== selectedIndexes.length) {
      return res.status(400).json({ error: "Invalid selective restore request (maximum 50 tracks)" });
    }
    const current = flowPlaylistConfig.getStaticPlaylistsOwnedByUser(req.user.id)
      .find(p => p.id === playlistId && String(p.sourceName || "").toLowerCase() === "apple music");
    if (!current) return res.status(404).json({ error: "Owned Apple Music playlist not found" });
    try {
      const result = await pocRequest(`/api/tracks?id=${encodeURIComponent(applePlaylistId)}`, req.user.id);
      if (result.status !== 200 || result.body?.ok !== true || result.body?.hasMore || !Array.isArray(result.body?.tracks)) {
        return res.status(result.status === 401 ? 409 : 422).json({ error: "Apple track list is unavailable or incomplete. Reconnect and scan again." });
      }
      const apple = result.body.tracks;
      if (apple.length > 3000 || selectedIndexes.some(i => i >= apple.length)) return res.status(409).json({ error: "Apple playlist changed. Scan again." });
      const norm = v => String(v || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
      const core = t => `${norm(t?.artistName || t?.artist)}\u0001${norm(t?.trackName || t?.title)}`;
      const album = t => norm(t?.albumName || t?.album);
      const existing = Array.isArray(current.tracks) ? current.tracks : [];
      const chosen = [];
      const seen = new Set();
      for (const i of selectedIndexes) {
        const track = apple[i];
        const identity = core(track);
        if (!track || identity === "\u0001" || seen.has(identity)) return res.status(409).json({ error: "Uncertain or duplicate selection. Scan again." });
        seen.add(identity);
        // A matching artist/title with changed album is POSSIBLE, never automatically 'missing'.
        if (existing.some(t => core(t) === identity)) return res.status(409).json({ error: "Track already exists or is a possible match. Scan again." });
        const artistName = String(track.artist || "").trim();
        const trackName = String(track.title || "").trim();
        if (!artistName || !trackName) return res.status(409).json({ error: "Track metadata incomplete. Scan again." });
        chosen.push({ artistName, trackName, albumName: String(track.album || "").trim() });
      }
      // Refresh owner check immediately before enqueue, and do not overwrite or delete anything.
      if (!flowPlaylistConfig.getStaticPlaylistsOwnedByUser(req.user.id).some(p => p.id === playlistId)) {
        return res.status(404).json({ error: "Playlist no longer belongs to this user" });
      }
      const queued = await playlistOperationQueue.enqueuePayload({
        kind: "shared-playlist-append-tracks",
        label: `shared-playlist:${playlistId}:apple-restore`,
        playlistId,
        tracks: chosen,
      });
      return res.json({ success: true, queued: true, playlistId, count: chosen.length, operationId: queued.operationId });
    } catch (error) {
      return res.status(502).json({ error: "Unable to validate or queue Apple Music restore", message: error.message });
    }
  });

  // PHASE8D2_TRACK_COMPARE: strictly read-only, owner-scoped, no mutations or download queues.
  router.post("/apple-poc/compare", (req, res) => {
    const { playlistId, tracks } = req.body || {};
    if (typeof playlistId !== "string" || !/^[0-9a-f-]{36}$/i.test(playlistId) || !Array.isArray(tracks) || tracks.length > 3000) {
      return res.status(400).json({ error: "Invalid playlist comparison request" });
    }
    const owned = flowPlaylistConfig.getStaticPlaylistsOwnedByUser(req.user.id);
    const target = owned.find(p => p.id === playlistId && String(p.sourceName || "").toLowerCase() === "apple music");
    if (!target) return res.status(404).json({ error: "Imported Apple Music playlist not found" });
    const norm = v => String(v || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const core = t => `${norm(t?.artistName || t?.artist)}\u0001${norm(t?.trackName || t?.title)}`;
    const album = t => norm(t?.albumName || t?.album);
    const existing = (Array.isArray(target.tracks) ? target.tracks : []).filter(t => core(t) !== "\u0001");
    const used = new Set();
    let matched = 0, probable = 0, missing = 0, ambiguous = 0;
    const details = [];
    for (const t of tracks) {
      const key = core(t);
      if (key === "\u0001") { ambiguous++; details.push({ artist: String(t?.artist || ""), title: String(t?.title || ""), status: "needs-review" }); continue; }
      const candidates = existing.map((e,i) => ({e,i})).filter(({e,i}) => !used.has(i) && core(e) === key);
      const exact = candidates.filter(({e}) => album(e) === album(t) && album(e) !== "");
      const chosen = exact.length === 1 ? exact[0] : (exact.length === 0 && candidates.length === 1 ? candidates[0] : null);
      let status;
      if (chosen) {
        used.add(chosen.i);
        status = exact.length === 1 ? "matched" : "possible-match";
        if (status === "matched") matched++; else probable++;
      } else if (candidates.length > 1 || exact.length > 1) { status="needs-review"; ambiguous++; }
      else { status="missing"; missing++; }
      details.push({ artist: String(t?.artist || t?.artistName || ""), title: String(t?.title || t?.trackName || ""), status });
    }
    return res.set("Cache-Control", "no-store").json({
      playlistId, appleTracks: tracks.length, aurralTracks: existing.length,
      matched, probable, missing, ambiguous, localOnly: existing.length-used.size, details,
      // Existing local-only additions are not errors and are never removed here.
    });
  });

  // PHASE8D1_INVENTORY: owner-scoped metadata only; never writes to playlists or queues.
  router.get("/apple-poc/inventory", (req, res) => {
    const normalized = (value) => String(value || "").trim().toLocaleLowerCase();
    const items = flowPlaylistConfig.getStaticPlaylistsOwnedByUser(req.user.id)
      .filter((p) => normalized(p.sourceName) === "apple music")
      .map((p) => ({ id: p.id, name: p.name, trackCount: Array.isArray(p.tracks) ? p.tracks.length : 0 }));
    return res.set("Cache-Control", "no-store").json({ items });
  });

  // PHASE8C3_OWNER_IMPORT_LOOKUP: read-only; do not expose other users' playlists.
  router.get("/apple-poc/imported", (req, res) => {
    const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
    if (!name || name.length > 200) return res.status(400).json({ error: "Valid playlist name required" });
    const normalize = (value) => String(value || "").trim().toLocaleLowerCase();
    const matching = flowPlaylistConfig.getStaticPlaylistsOwnedByUser(req.user.id)
      .filter((playlist) => normalize(playlist.name) === normalize(name) &&
        normalize(playlist.sourceName) === "apple music")
      .map(({ id, name: playlistName, tracks }) => ({
        id, name: playlistName, trackCount: Array.isArray(tracks) ? tracks.length : 0,
      }));
    return res.set("Cache-Control", "no-store").json({ matches: matching });
  });

  router.get("/apple-poc/:action", async (req, res) => {
    const action = req.params.action;
    if (!["groups", "group", "tracks"].includes(action)) return res.status(404).json({ error: "Not found" });
    const id = typeof req.query.id === "string" ? req.query.id : "";
    if (action === "group" && !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return res.status(400).json({ error: "Invalid group ID" });
    if (action === "tracks" && !/^pl\.[A-Za-z0-9_.-]{1,100}$/.test(id)) return res.status(400).json({ error: "Invalid playlist ID" });
    try {
      const path = `/api/${action}${action === "groups" ? "" : `?id=${encodeURIComponent(id)}`}`;
      const result = await pocRequest(path, req.user.id);
      return res.status(result.status === 401 ? 409 : result.status).json(result.body);
    } catch { return res.status(502).json({ error: "Apple Music bridge is unavailable" }); }
  });

  router.post("/apple-poc/:action", async (req, res) => {
    const action = req.params.action;
    if (!["connect", "disconnect"].includes(action)) return res.status(404).json({ error: "Not found" });
    const headers = action === "connect" ? req.body : null;
    if (action === "connect" && (
      typeof headers?.Authorization !== "string" || !headers.Authorization.startsWith("Bearer ") ||
      typeof headers?.["Music-User-Token"] !== "string" || headers["Music-User-Token"].length < 10
    )) return res.status(400).json({ error: "Valid Apple Music authorization headers are required" });
    try {
      const result = await pocRequest(`/api/${action}`, req.user.id, "POST", action === "connect" ? headers : null);
      return res.status(result.status === 401 ? 409 : result.status).json(result.body);
    } catch { return res.status(502).json({ error: "Apple Music bridge is unavailable" }); }
  });
}
