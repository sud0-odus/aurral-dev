import https from "node:https";
import { flowPlaylistConfig } from "../../../services/playlists/flowPlaylistConfig.js";

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
