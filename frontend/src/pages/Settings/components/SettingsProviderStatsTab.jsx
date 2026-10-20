import { useEffect, useState } from "react";
import { fetchProviderSchedulerStats } from "../../../utils/api/endpoints/settings.js";

const SOURCES = { slskd: "slskd", ytdlp: "yt-dlp", sabnzbd: "SABnzbd", nzbget: "NZBGet", dmm: "DMM", deemix: "Deemix" };
const fmtAge = (value) => value == null ? "—" : (value / 60000).toFixed(1) + " min";

export function SettingsProviderStatsTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [hours, setHours] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    const refresh = async () => {
      try {
        const result = await fetchProviderSchedulerStats({ signal: controller.signal });
        if (alive) { setData(result); setError(""); }
      } catch (err) {
        if (alive && !controller.signal.aborted) setError(err?.message || "Statistics unavailable");
      }
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => { alive = false; clearInterval(timer); controller.abort(); };
  }, []);
  const period = data?.historicalOutcomes?.find((item) => item.hours === hours);
  const events = data?.lastHourProviderEvents || [];
  const sumEvent = (provider, event) => events.filter((r) => r.provider === provider && r.event === event)
    .reduce((n, r) => n + r.count, 0);
  const outcomes = data?.sourceOutcomes || [];
  const sourceStatus = (source, status) => outcomes.find((r) => r.source === source)?.statuses?.[status] || 0;
  return (
    <div className="arr-page">
      <h2>Provider performance</h2>
      <p>Read-only statistics. A reservation is not an active transfer. Job completions may include reused files; provider attribution can be missing.</p>
      {error && <p role="alert">{error}</p>}
      {!data ? <p>Loading provider statistics…</p> : (
        <>
          <p>Scheduler: {data.enabled ? "Enabled" : "Disabled"} · Worker ceiling: {data.workerCeiling} · Sampled: {new Date(data.sampledAt).toLocaleString()}</p>
          <div role="group" aria-label="History window">
            {[1, 24, 168].map((windowHours) => (
              <button key={windowHours} type="button" className="btn btn-secondary"
                aria-pressed={hours === windowHours} onClick={() => setHours(windowHours)}>
                {windowHours === 1 ? "1 hour" : windowHours === 24 ? "24 hours" : "7 days"}
              </button>
            ))}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="arr-table">
              <thead><tr><th>Provider</th><th>Reserved / capacity</th><th>Oldest</th><th>Selected (1h)</th><th>Failed (1h)</th><th>Fallback (1h)</th><th>Job completions / hour*</th><th>Currently downloading**</th></tr></thead>
              <tbody>
                {(data.providers || []).filter((p) => p.enabled).map((p) => {
                  const source = p.id === "sabnzbd" || p.id === "nzbget" ? "usenet" : p.id;
                  const completed = (period?.outcomes || []).filter((e) => e.provider === source && e.event === "done")
                    .reduce((n, e) => n + e.count, 0);
                  return <tr key={p.id}>
                    <th scope="row">{SOURCES[p.id] || p.id}</th>
                    <td>{p.active} / {p.maxActive}</td>
                    <td>{fmtAge(p.oldestReservationAgeMs)}</td>
                    <td>{sumEvent(p.id, "provider_selected")}</td>
                    <td>{sumEvent(p.id, "provider_failed")}</td>
                    <td>{sumEvent(p.id, "fallback")}</td>
                    <td>{source === "usenet" ? "Shared Usenet source" : (completed / hours).toFixed(2)}</td>
                    <td>{sourceStatus(source, "downloading")}{source === "usenet" ? " (shared)" : ""}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          <p>* Historical job completion events per hour, not provider transfer throughput or verified success rate. ** Job state is not proof of an active transfer. Historical completion attribution may be incomplete.</p>
          <h3>Queue claim diagnostics</h3>
          {data.reservationClaims === null ? <p>Honker claim data unavailable.</p> :
            <p>{(data.reservationClaims || []).reduce((n, r) => n + (!r.hasQueueClaim ? r.count : 0), 0)} reservations without a matching queued claim (not automatically stalled).</p>}
          <p>Automatic capacity tuning is not enabled. Reliable per-attempt outcomes and transfer timings are prerequisites to safe optimization.</p>
        </>
      )}
    </div>
  );
}
