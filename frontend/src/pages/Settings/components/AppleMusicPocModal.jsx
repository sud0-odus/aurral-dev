import { useEffect, useState } from "react";
import { getData, postData } from "../../../utils/api/core.js";
import { SettingsIntegrationModal } from "./SettingsIntegrationCards";

const readError = (error) => error?.response?.data?.message || error?.response?.data?.error || error.message || "Request failed";

export function AppleMusicPocModal({ onClose }) {
  const [headers, setHeaders] = useState("");
  const [connected, setConnected] = useState(false);
  const [groups, setGroups] = useState([]);
  const [items, setItems] = useState([]);
  const [chosen, setChosen] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [operation, setOperation] = useState(null);
  const [existingMatches, setExistingMatches] = useState([]);
  const [matchStatus, setMatchStatus] = useState("idle"); // PHASE8C3_OWNER_IMPORT_LOOKUP
  // PHASE8D1_INVENTORY: recommendation-discovered playlists only; not the user's full Apple library.
  const [inventory, setInventory] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  // PHASE8D2_TRACK_COMPARE: cached scan results, read-only. No downloads or imports.
  const [comparing, setComparing] = useState(false);
  const [comparisonError, setComparisonError] = useState("");
  const [comparisons, setComparisons] = useState({});
  const [restoreSelected, setRestoreSelected] = useState({}); // PHASE8D3B_SELECTIVE_RESTORE
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState("");

  const restoreMissing = async (row) => {
    const cmp = comparisons[row.id];
    if (!cmp || cmp.status !== "ready" || row.matches.length !== 1 || restoreBusy) return;
    const indexes = cmp.details.map((t, i) => t.status === "missing" && restoreSelected[`${row.id}:${i}`] ? i : -1).filter(i => i >= 0);
    if (!indexes.length || indexes.length > 50) return;
    setRestoreBusy(true); setRestoreMessage("");
    try {
      const confirmed = window.confirm(`Restore ${indexes.length} selected missing track(s) into ${row.name}? Existing and personal tracks will be preserved. This may queue downloads.`);
      if (!confirmed) return;
      const result = await postData("/playlists/apple-poc/restore-missing", {
        playlistId: row.matches[0].id, applePlaylistId: row.id, selectedIndexes: indexes,
      });
      if (!result.success) throw new Error(result.message || "Restore was not queued");
      setRestoreMessage(`Queued ${result.count} track(s) for ${row.name} (operation #${result.operationId}). Scan & Compare again after processing.`);
      setComparisons({}); setInventory(null); setRestoreSelected({});
    } catch(e) { setRestoreMessage(readError(e)); }
    finally { setRestoreBusy(false); }
  };

  const compareImported = async (rows) => {
    if (!connected || !Array.isArray(rows)) return;
    setComparing(true); setComparisonError(""); setComparisons({});
    const next = {};
    const imported = rows.filter(row => row.matches.length);
    for (const row of imported) {
      if (row.matches.length !== 1) { next[row.id] = { status: "ambiguous-playlist" }; continue; }
      try {
        const apple = await getData("/playlists/apple-poc/tracks", { params: { id: row.id } });
        if (!apple.ok || apple.hasMore || !Array.isArray(apple.tracks)) { next[row.id] = { status: "incomplete" }; continue; }
        const result = await postData("/playlists/apple-poc/compare", {
          playlistId: row.matches[0].id,
          tracks: apple.tracks.map(t => ({ artist: t.artist, title: t.title, album: t.album })),
        });
        next[row.id] = { ...result, status: "ready" };
      } catch(e) { next[row.id] = { status: "failed" }; setComparisonError("Some imported playlists could not be compared. Their status remains unverified."); }
      setComparisons({ ...next });
    }
    setComparing(false);
  };

  const scanInventory = async () => {
    if (scanning || !connected) return;
    setScanning(true); setScanError(""); setInventory(null); setComparisons({}); setComparisonError(""); setRestoreSelected({}); setRestoreMessage("");
    try {
      const owned = await getData("/playlists/apple-poc/inventory");
      if (!Array.isArray(owned.items)) throw new Error("Invalid Aurral inventory response");
      const names = new Map();
      const failures = [];
      // One request at a time prevents flooding the temporary Apple Music bridge.
      for (const group of groups.slice(0, 20)) {
        try {
          const result = await getData("/playlists/apple-poc/group", { params: { id: group.id } });
          if (!result.ok || !Array.isArray(result.items)) throw new Error("Group request failed");
          for (const p of result.items.filter(p => p.type === "playlists" && p.id && p.name)) {
            if (!names.has(p.id)) names.set(p.id, { id: p.id, name: p.name });
          }
        } catch { failures.push(group.name || group.id); }
      }
      const normalize = value => String(value || "").trim().toLocaleLowerCase();
      const rows = [...names.values()].map(p => {
        const matches = owned.items.filter(o => normalize(o.name) === normalize(p.name));
        return { ...p, matches, status: matches.length ? "Imported — tracks not compared" : "Not imported" };
      }).sort((a,b) => a.name.localeCompare(b.name));
      setInventory({ rows, failures, totalGroups: groups.length, scannedGroups: Math.min(groups.length, 20) });
      await compareImported(rows); // PHASE8D3A_SCAN_COMPARE: compare imported only, in the same action
    } catch(e) { setScanError(readError(e)); }
    finally { setScanning(false); }
  };

  const loadGroups = async () => {
    setBusy(true); setMessage("");
    try {
      const result = await getData("/playlists/apple-poc/groups");
      if (!result.ok) throw new Error(result.message || "Unable to load recommendations");
      setConnected(true); setGroups(result.items || []);
    } catch (e) { setConnected(false); setMessage(readError(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { loadGroups(); }, []);

  const connect = async () => {
    setBusy(true); setMessage("");
    try {
      const parsed = JSON.parse(headers);
      const result = await postData("/playlists/apple-poc/connect", parsed);
      setHeaders("");
      if (!result.ok) throw new Error(result.message || "Apple rejected this session");
      setConnected(true); setMessage("Apple Music connected for this temporary session.");
      await loadGroups();
    } catch (e) { setMessage(readError(e)); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true);
    try { await postData("/playlists/apple-poc/disconnect", {}); setConnected(false); setGroups([]); setItems([]); setInventory(null); setChosen(null); setTracks([]); setMessage("Apple Music disconnected."); }
    catch (e) { setMessage(readError(e)); }
    finally { setBusy(false); }
  };

  const openGroup = async (id) => {
    setBusy(true); setItems([]); setChosen(null); setTracks([]); setExistingMatches([]); setMatchStatus("idle"); setOperation(null);
    try {
      const result = await getData("/playlists/apple-poc/group", { params: { id } });
      if (!result.ok) throw new Error(result.message || "Unable to load group");
      setItems(result.items || []); setMessage("");
    } catch (e) { setMessage(readError(e)); }
    finally { setBusy(false); }
  };

  const openPlaylist = async (item) => {
    setBusy(true); setChosen(null); setTracks([]); setExistingMatches([]); setMatchStatus("idle"); setOperation(null);
    try {
      const result = await getData("/playlists/apple-poc/tracks", { params: { id: item.id } });
      if (!result.ok) throw new Error(result.message || "Unable to load playlist");
      setTracks(result.tracks || []); setHasMore(!!result.hasMore); setChosen(item); setMessage("");
      setMatchStatus("loading");
      try {
        const lookup = await getData("/playlists/apple-poc/imported", { params: { name: item.name } });
        setExistingMatches(Array.isArray(lookup.matches) ? lookup.matches : []);
        setMatchStatus("ready");
      } catch (lookupError) {
        setMatchStatus("error");
        setMessage("Unable to check existing playlists. Import is disabled until the check succeeds.");
      }
    } catch (e) { setMessage(readError(e)); }
    finally { setBusy(false); }
  };

  const importPlaylist = async () => {
    if (!chosen || hasMore || !tracks.length || matchStatus !== "ready" || existingMatches.length) return;
    setBusy(true); setMessage("");
    try {
      const payload = { name: chosen.name || "Apple Music Playlist", sourceName: "Apple Music", tracks: tracks.filter(t => t.artist && t.title).map(t => ({ artistName: t.artist, trackName: t.title, albumName: t.album })) };
      if (!payload.tracks.length) throw new Error("No valid tracks to import");
      const result = await postData("/playlists/shared-playlists/import", payload);
      if (!result.success) throw new Error(result.message || "Import was not accepted");
      setOperation(result.operationId);
      setMessage(`Import queued: ${payload.tracks.length} tracks in ${payload.name}.`);
    } catch (e) { setMessage(readError(e)); }
    finally { setBusy(false); }
  };

  return (
    <SettingsIntegrationModal title="Apple Music (experimental)" onClose={onClose}>
      <style>{`
        /* apple-p5-layout-v2: fixed desktop shell, nested track scroll, visible action */
        .settings-page__modal--integration:has(.apple-p5) { width: min(900px, calc(100vw - 28px)); max-width: 900px; max-height: min(94dvh, 980px); display: flex; flex-direction: column; }
        .settings-page__modal--integration:has(.apple-p5) .settings-page__modal-body { min-height: 0; max-height: none; overflow-y: auto; overscroll-behavior: contain; }
        .settings-page__modal--integration:has(.apple-p5) .apple-p5 { gap: 10px; padding-bottom: 6px; }
        .settings-page__modal--integration:has(.apple-p5) .apple-p5__panel { gap: 8px; padding: 11px 14px; }
        .settings-page__modal--integration:has(.apple-p5) .apple-p5__intro { gap: 2px; }
        .settings-page__modal--integration:has(.apple-p5) .apple-p5__tracklist { height: clamp(130px, 21dvh, 220px); max-height: none; overflow-y: scroll; scrollbar-width: auto; scrollbar-color: #898990 #303038; scrollbar-gutter: stable; }
        .settings-page__modal--integration:has(.apple-p5) .apple-p5__tracklist::-webkit-scrollbar { width: 11px; }
        .settings-page__modal--integration:has(.apple-p5) .apple-p5__tracklist::-webkit-scrollbar-thumb { background: #898990; border-radius: 12px; border: 2px solid #303038; }
        .settings-page__modal--integration:has(.apple-p5) .apple-p5__tracklist::-webkit-scrollbar-track { background: #303038; }
        @media (min-height: 760px) and (min-width: 700px) { .settings-page__modal--integration:has(.apple-p5) .settings-page__modal-body { overflow-y: auto; } }
        .apple-p5 { display: grid; gap: 18px; min-width: 0; padding: 4px 2px 12px; }
        .apple-p5__intro { display: grid; gap: 6px; }
        .apple-p5__intro p { margin: 0; line-height: 1.55; }
        .apple-p5__panel { border: 1px solid var(--border-color, #45454d); border-radius: 12px; padding: 16px; min-width: 0; display: grid; gap: 12px; }
        .apple-p5__title { font-size: 1rem; font-weight: 700; margin: 0; line-height: 1.35; }
        .apple-p5__row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        .apple-p5__row .btn { white-space: normal; text-align: left; line-height: 1.35; min-height: 36px; }
        .apple-p5__button { padding: 8px 12px; border-radius: 8px; }
        .apple-p5__status { display: inline-flex; align-items: center; gap: 8px; font-size: .9rem; }
        .apple-p5__dot { width: 8px; height: 8px; border-radius: 50%; background: #929292; }
        .apple-p5__dot.is-connected { background: #43b987; }
        .apple-p5__note { font-size: .86rem; opacity: .8; line-height: 1.5; }
        .apple-p5__feedback { padding: 12px 14px; border: 1px solid #478b74; border-radius: 9px; background: rgba(36, 130, 99, .12); line-height: 1.5; overflow-wrap: anywhere; }
        .apple-p5__tracklist { max-height: 275px; overflow-y: auto; overscroll-behavior: contain; padding: 8px 12px 8px 38px; margin: 0; border: 1px solid var(--border-color, #45454d); border-radius: 8px; }
        .apple-p5__tracklist li { padding: 5px 0; line-height: 1.4; }
        .apple-p5 textarea { box-sizing: border-box; width: 100%; min-height: 96px; }
        @media(max-width: 600px) { .apple-p5__panel { padding: 12px; } .apple-p5__tracklist { max-height: 210px; } }
      `}</style>
      <div className="apple-p5">
        <div className="apple-p5__intro">
          <p>Explore personalized Apple Music recommendations and import selected playlists into Aurral.</p>
          <p className="apple-p5__note">One-time import only; automatic synchronization is disabled. Apple sign-in uses the existing Windows applemusic-mcp helper. The temporary bridge keeps request headers in memory for up to one hour.</p>
        </div>
        <section className="apple-p5__panel" aria-label="Apple Music connection">
          <div className="apple-p5__row" style={{justifyContent:"space-between"}}>
            <h4 className="apple-p5__title">Connection</h4>
            <span className="apple-p5__status"><span className={`apple-p5__dot${connected ? " is-connected" : ""}`} aria-hidden="true" />{connected ? "Connected" : "Not connected"}</span>
          </div>
          {!connected && <>
            <p className="apple-p5__note">Paste the Authorization and Music-User-Token headers as JSON. Do not share them in chat.</p>
            <textarea className="arr-input" rows={4} autoComplete="off" spellCheck={false} placeholder='{"Authorization":"Bearer ...","Music-User-Token":"..."}' value={headers} onChange={e => setHeaders(e.target.value)} />
            <div className="apple-p5__row"><button className="btn btn-primary apple-p5__button" type="button" disabled={busy || !headers.trim()} onClick={connect}>Connect Apple Music</button></div>
          </>}
          {connected && <div className="apple-p5__row">
            <button className="btn btn-secondary apple-p5__button" type="button" disabled={busy} onClick={loadGroups}>Refresh recommendations</button>
            <button className="btn btn-secondary apple-p5__button" type="button" disabled={busy} onClick={disconnect}>Disconnect</button>
          </div>}
          {message && <div role="status" className="apple-p5__feedback">{message}</div>}
          {busy && <p className="apple-p5__note" role="status">Loading…</p>}
        </section>
        {connected && <section className="apple-p5__panel" aria-label="Playlist import status">
          <div className="apple-p5__row" style={{justifyContent:"space-between"}}>
            <h4 className="apple-p5__title">Playlist import status</h4>
            <div className="apple-p5__row">
              <button className="btn btn-secondary apple-p5__button" type="button" disabled={busy || scanning || comparing || !groups.length} onClick={scanInventory}>{comparing ? "Comparing…" : scanning ? "Scanning…" : "Scan & Compare"}</button>
            </div>
          </div>
          <p className="apple-p5__note">Read-only inventory of playlists found in Apple Music recommendation groups, not your complete Apple Music library. Scan & Compare checks only already imported playlists for track differences. Your locally added tracks are preserved.</p>
          {restoreMessage && <p role="status" className="apple-p5__feedback">{restoreMessage}</p>}
          {comparisonError && <p role="alert" className="apple-p5__note">{comparisonError}</p>}
          {scanError && <p role="alert" className="apple-p5__note">Scan failed: {scanError}</p>}
          {inventory && <>
            <p className="apple-p5__note">Discovered {inventory.rows.length} unique playlists · {inventory.rows.filter(p=>p.matches.length).length} previously imported · {inventory.rows.filter(p=>!p.matches.length).length} not imported.</p>
            {(inventory.failures.length > 0 || inventory.scannedGroups < inventory.totalGroups) && <p role="alert" className="apple-p5__note">Partial scan: {inventory.failures.length} recommendation groups failed; {inventory.scannedGroups} of {inventory.totalGroups} groups attempted. Results may be incomplete.</p>}
            {inventory.rows.map(p => <div key={p.id} className="apple-p5__row" style={{justifyContent:"space-between",borderTop:"1px solid var(--border-color, #45454d)",paddingTop:6}}>
              <span>{p.name}</span><span className="apple-p5__note">{comparisons[p.id]?.status === "ready"
                ? `${comparisons[p.id].matched} matched · ${comparisons[p.id].probable} possible · ${comparisons[p.id].missing} missing · ${comparisons[p.id].ambiguous} review · ${comparisons[p.id].localOnly} local additions`
                : comparisons[p.id]?.status === "incomplete" ? "Apple track list incomplete — not compared"
                : comparisons[p.id]?.status === "ambiguous-playlist" ? "Multiple Aurral matches — review"
                : comparisons[p.id]?.status === "failed" ? "Comparison failed — unverified"
                : p.status}{p.matches.length === 1 && !comparisons[p.id] ? ` (${p.matches[0].trackCount} in Aurral)` : ""}</span>
              {comparisons[p.id]?.status === "ready" && comparisons[p.id].missing > 0 && p.matches.length === 1 && <div style={{width:"100%",padding:"8px 0 10px 12px"}}>
                <strong>Missing Apple Music tracks — choose which to restore</strong>
                {comparisons[p.id].details.map((t,i) => t.status === "missing" && <label key={`${p.id}-${i}`} style={{display:"flex",gap:8,alignItems:"center",marginTop:7}}>
                  <input type="checkbox" checked={!!restoreSelected[`${p.id}:${i}`]} onChange={e=>setRestoreSelected(prev=>({...prev,[`${p.id}:${i}`]:e.target.checked}))} />
                  {t.artist} — {t.title}
                </label>)}
                <div style={{marginTop:10}}><button type="button" className="btn btn-secondary apple-p5__button" disabled={scanning || comparing || restoreBusy || !comparisons[p.id].details.some((t,i)=>t.status === "missing" && restoreSelected[`${p.id}:${i}`])} onClick={()=>restoreMissing(p)}>Import selected missing tracks</button></div>
              </div>}
            </div>)}
            {!inventory.rows.length && <p className="apple-p5__note">No supported playlists discovered in these groups.</p>}
          </>}
        </section>}
        {!!groups.length && <section className="apple-p5__panel">
          <h4 className="apple-p5__title">Recommendation groups</h4>
          <div className="apple-p5__row">{groups.map(g => <button className="btn btn-secondary apple-p5__button" type="button" key={g.id} disabled={busy} onClick={() => openGroup(g.id)}>{g.name}</button>)}</div>
        </section>}
        {!!items.length && <section className="apple-p5__panel">
          <h4 className="apple-p5__title">Recommended playlists</h4>
          <div className="apple-p5__row">{items.filter(i=>i.type === "playlists").map(i => <button className="btn btn-secondary apple-p5__button" type="button" key={i.id} disabled={busy} onClick={() => openPlaylist(i)}>{i.name}</button>)}</div>
          {!items.some(i=>i.type === "playlists") && <p className="apple-p5__note">This recommendation group contains no supported playlists. Album and station imports are not enabled.</p>}
        </section>}
        {chosen && <section className="apple-p5__panel">
          <h4 className="apple-p5__title">{chosen.name} — {tracks.length} tracks loaded{hasMore ? " (more available)" : ""}</h4>
          <p className="apple-p5__note" style={{margin:0}}>Scroll inside the track list to review all loaded tracks. {hasMore ? "Apple supplied a next-page link; the full total has not been verified." : "No next-page link was returned."}</p>
          <ol className="apple-p5__tracklist" tabIndex={0} aria-label="Scrollable Apple Music track preview">{tracks.map((t,i)=><li key={`${t.id}-${i}`}>{t.artist} — {t.title}</li>)}</ol>
          {hasMore && <p className="apple-p5__note">Apple returned a next-page link. Only the first {tracks.length} tracks have been loaded; total playlist size is unknown. Import remains disabled until all pages are retrieved.</p>}
          {matchStatus === "loading" && <p className="apple-p5__note">Checking your imported playlists…</p>}
          {matchStatus === "error" && <p role="alert" className="apple-p5__note">Existing playlist check failed. Import blocked.</p>}
          {existingMatches.length > 0 && <div className="apple-p5__feedback">
            <strong>Already imported (name match)</strong>
            <p className="apple-p5__note">Found {existingMatches.length} Apple Music playlist{existingMatches.length === 1 ? "" : "s"} with this name in your Aurral account. Tracks have not been compared.</p>
            {existingMatches.map((match) => <p key={match.id}><a className="settings-page__link" href={`/library/playlists/${encodeURIComponent(match.id)}`} target="_blank" rel="noopener noreferrer">View {match.name} in Aurral ({match.trackCount} tracks)</a></p>)}
          </div>}
          <div className="apple-p5__row" style={{position:"sticky",bottom:0,background:"var(--bg-primary, #222)",padding:"7px 0",zIndex:1}}><button className="btn btn-primary apple-p5__button" type="button" disabled={busy || hasMore || !tracks.length || operation != null || matchStatus !== "ready" || existingMatches.length > 0} onClick={importPlaylist}>{operation != null ? `Import queued (operation #${operation})` : "Import playlist into Aurral"}</button></div>
        </section>}
      </div>
    </SettingsIntegrationModal>
  );
}
