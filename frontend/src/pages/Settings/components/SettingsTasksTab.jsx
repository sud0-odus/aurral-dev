import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { getSettingsTasks, clearSettingsStaleTasks } from "../../../utils/api/endpoints/settings.js";
import { getData } from "../../../utils/api/core.js";
import { queryClient, queryKeys } from "../../../queryClient.js";
import { SettingsArrFieldSet } from "./arr/SettingsArrLayout";

import { AlertCircle, Check, Clock, XCircle } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import Tooltip from "../../../components/Tooltip";
import { formatRelativeTime } from "../../../utils/dateTime.js";
const POLL_INTERVAL_MS = 5000;

const STATUS_META = {
  interrupted: {
    label: "Interrupted",
    tone: "muted",
    icon: Clock,
    title: "Unfinished work was returned to the queue",
  },
  completed: {
    label: "Completed",
    tone: "ok",
    icon: Check,
    title: null,
  },
  failed: {
    label: "Failed",
    tone: "danger",
    icon: XCircle,
    title: null,
  },
  running: {
    label: "Running",
    tone: "active",
    spinning: true,
    title: null,
  },
  queued: {
    label: "Queued",
    tone: "queued",
    icon: Clock,
    title: null,
  },
  scheduled: {
    label: "Scheduled",
    tone: "queued",
    icon: Clock,
    title: null,
  },
  idle: {
    label: "Idle",
    tone: "muted",
    icon: Check,
    title: "Processor is loaded and waiting for work",
  },
  not_loaded: {
    label: "Standby",
    tone: "muted",
    icon: AlertCircle,
    title: "Processor is stopped until new work arrives",
  },
};

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatRelative(value, empty = "Never") {
  const date = parseDate(value);
  return date ? formatRelativeTime(date) : empty;
}

function formatDuration(ms) {
  if (ms == null || ms === "") return "—";
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return "<1s";
  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) ? count : 0;
}

function isFutureRunAt(task) {
  if (task.status !== "scheduled") return false;
  const runAt = parseDate(task.runAt);
  return runAt ? runAt.getTime() > Date.now() : false;
}

function formatQueueDuration(task) {
  if (task.status === "running") {
    return formatDuration(task.runningForMs);
  }
  return formatDuration(task.durationMs);
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || {
    label: status || "Unknown",
    tone: "muted",
    icon: AlertCircle,
    title: null,
  };
  const Icon = meta.icon || AlertCircle;
  return (
    <Tooltip content={meta.title || undefined}>
      <span
        className={`arr-task-status arr-task-status--${meta.tone}`}
      >
        {meta.spinning ? (
          <DotLoader size="sm" label={null} className="arr-task-status__icon" />
        ) : (
          <Icon className="arr-task-status__icon" aria-hidden />
        )}
        {meta.label}
      </span>
    </Tooltip>
  );
}

function EmptyRows({ colSpan }) {
  return (
    <tr className="arr-table__empty-row">
      <td colSpan={colSpan}>No task data available.</td>
    </tr>
  );
}

function LoadingRows({ colSpan }) {
  return (
    <tr className="arr-table__empty-row">
      <td colSpan={colSpan}>
        <DotLoader size="sm" label={null} /> Loading task data...
      </td>
    </tr>
  );
}

function TasksHealthSummary({ summary, loading, clearing = false, onClearStale }) {
  if (loading || !summary) {
    return (
      <div className="arr-info arr-info--tasks">
        <DotLoader size="sm" label={null} /> Loading background task status...
      </div>
    );
  }

  const { healthy, activeCount, staleCount, failedCount, workersFailedCount, completedCount } =
    summary;
  const needsAttention = !healthy;

  return (
    <div className={`arr-info arr-info--tasks${healthy ? "" : " arr-info--tasks-warning"}`}>
      {healthy ? (
        <p className="arr-info__lead">
          Background tasks are healthy.
          {completedCount > 0
            ? ` ${completedCount} job${completedCount === 1 ? "" : "s"} completed in the last hour.`
            : ""}
        </p>
      ) : (
        <>
          <p className="arr-info__lead">
            {staleCount > 0
              ? `${staleCount} job${staleCount === 1 ? "" : "s"} running longer than expected. `
              : ""}
            {failedCount > 0
              ? `${failedCount} failed job${failedCount === 1 ? "" : "s"} in the last hour. `
              : ""}
            {workersFailedCount > 0
              ? `${workersFailedCount} worker${workersFailedCount === 1 ? "" : "s"} reported failures. `
              : ""}
            {activeCount > 0
              ? `${activeCount} active job${activeCount === 1 ? "" : "s"} in progress.`
              : ""}
          </p>
          {staleCount > 0 ? (
            <p className="arr-info__help">
              These are usually leftover job records from an earlier run, not active workers. Clear
              them to reset the queue. Aurral will re-enqueue normal startup work if needed.
            </p>
          ) : null}
        </>
      )}
      {needsAttention && staleCount > 0 && onClearStale ? (
        <div className="arr-info__actions">
          <button
            type="button"
            className="arr-btn arr-btn--primary"
            onClick={onClearStale}
            disabled={clearing}
          >
            {clearing ? <DotLoader size="sm" label={null} /> : null}
            {clearing ? "Clearing stuck jobs…" : "Clear stuck jobs"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ScheduledTable({ scheduled = [], loading = false }) {
  return (
    <div className="arr-table-wrap">
      <table className="arr-table arr-table--tasks" aria-busy={loading}>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Interval</th>
            <th scope="col">Last run</th>
            <th scope="col">Duration</th>
            <th scope="col">Next run</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <LoadingRows colSpan={6} />
          ) : scheduled.length === 0 ? (
            <EmptyRows colSpan={6} />
          ) : (
            scheduled.map((task) => (
              <tr key={task.id || task.scheduleName || task.name}>
                <td>
                  <span className="arr-table__primary">{task.name}</span>
                  {task.description ? (
                    <span className="arr-table__subtle">{task.description}</span>
                  ) : null}
                </td>
                <td>{task.interval || task.schedule || "—"}</td>
                <td>{formatRelative(task.lastExecutionAt)}</td>
                <td>{formatDuration(task.lastDurationMs)}</td>
                <td>{formatRelative(task.nextExecutionAt, "Not scheduled")}</td>
                <td>
                  {task.lastStatus ? (
                    <StatusBadge status={task.lastStatus} />
                  ) : (
                    <span className="arr-table__subtle">No runs yet</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function isIdleWorker(worker) {
  return (
    worker.status === "not_loaded" &&
    formatCount(worker.processing) === 0 &&
    formatCount(worker.queued) === 0 &&
    formatCount(worker.scheduled) === 0 &&
    formatCount(worker.failed) === 0 &&
    !worker.lastRunAt
  );
}

function WorkersTable({ workers = [], loading = false, showAllWorkers = false }) {
  const visibleWorkers = useMemo(() => {
    if (showAllWorkers) return workers;
    return workers.filter((worker) => !isIdleWorker(worker));
  }, [showAllWorkers, workers]);

  return (
    <div className="arr-table-wrap">
      <table className="arr-table arr-table--tasks" aria-busy={loading}>
        <thead>
          <tr>
            <th scope="col">Worker</th>
            <th scope="col">Status</th>
            <th scope="col">Active</th>
            <th scope="col">Queued</th>
            <th scope="col">Scheduled</th>
            <th scope="col">Failed</th>
            <th scope="col">Last run</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <LoadingRows colSpan={7} />
          ) : visibleWorkers.length === 0 ? (
            <EmptyRows colSpan={7} />
          ) : (
            visibleWorkers.map((worker) => (
              <tr key={worker.queue}>
                <td>
                  <span className="arr-table__primary">{worker.name || worker.queueLabel}</span>
                  {worker.description ? (
                    <span className="arr-table__subtle">{worker.description}</span>
                  ) : null}
                </td>
                <td>
                  <StatusBadge status={worker.status} />
                </td>
                <td>{formatCount(worker.processing)}</td>
                <td>{formatCount(worker.queued)}</td>
                <td>{formatCount(worker.scheduled)}</td>
                <td>
                  <span
                    className={
                      formatCount(worker.failed) > 0
                        ? "arr-task-count arr-task-count--danger"
                        : "arr-task-count"
                    }
                  >
                    {formatCount(worker.failed)}
                  </span>
                </td>
                <td>{formatRelative(worker.lastRunAt)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function QueueTable({ queue = [], loading = false }) {
  return (
    <div className="arr-table-wrap">
      <table className="arr-table arr-table--tasks arr-table--task-queue" aria-busy={loading}>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
            <th scope="col">Started</th>
            <th scope="col">Ended</th>
            <th scope="col">
              {queue.some((task) => task.status === "running") ? "Running for" : "Duration"}
            </th>
            <Tooltip content="Retry count for jobs that can fail and re-run">
              <th scope="col" >
                Attempt
                </th>
            </Tooltip>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <LoadingRows colSpan={7} />
          ) : queue.length === 0 ? (
            <EmptyRows colSpan={7} />
          ) : (
            queue.map((task) => (
              <tr key={task.id} className={task.isStale ? "arr-table__row--warning" : undefined}>
                <td>
                  <span className="arr-table__primary">{task.name}</span>
                  {task.description || task.payloadSummary ? (
                    <span className="arr-table__subtle">
                      {task.description || task.payloadSummary}
                    </span>
                  ) : null}
                  {task.error ? (
                    <span className="arr-table__subtle arr-table__subtle--danger">
                      {task.error}
                    </span>
                  ) : null}
                  {task.isStale ? (
                    <span className="arr-table__subtle arr-table__subtle--warning">
                      Running longer than expected
                    </span>
                  ) : null}
                  {Number(task.duplicateCount || 1) > 1 ? (
                    <span className="arr-table__subtle">
                      {task.duplicateCount}{" "}
                      {task.status === "scheduled" ? "delayed copies" : "recent runs"} grouped
                    </span>
                  ) : null}
                </td>
                <td>
                  <StatusBadge status={task.status} />
                </td>
                <td>{formatRelative(task.queuedAt, "—")}</td>
                <td>
                  {isFutureRunAt(task) ? (
                    <Tooltip content="Runs at">
                      <span >
                        <span className="arr-table__subtle">Runs at </span>
                        {formatRelative(task.runAt, "—")}
                      </span>
                    </Tooltip>
                  ) : task.startedAt ? (
                    formatRelative(task.startedAt)
                  ) : (
                    "—"
                  )}
                </td>
                <td>{formatRelative(task.endedAt, "—")}</td>
                <td>{formatQueueDuration(task)}</td>
                <td>
                  {task.maxAttempts
                    ? `${formatCount(task.attempt)} / ${formatCount(task.maxAttempts)}`
                    : formatCount(task.attempt)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}


const QUEUE_STATUS_ORDER = ["running", "queued", "scheduled", "failed", "interrupted", "completed"];
function QueueSections({ queue = [], loading = false }) {
  const groups = useMemo(() => {
    const byStatus = new Map();
    for (const task of queue) {
      const status = String(task.status || "unknown").toLowerCase();
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(task);
    }
    return [...byStatus.entries()].sort(([left], [right]) => {
      const a = QUEUE_STATUS_ORDER.indexOf(left);
      const b = QUEUE_STATUS_ORDER.indexOf(right);
      if (a === -1 && b === -1) return left.localeCompare(right);
      if (a === -1) return 1;
      if (b === -1) return -1;
      return a - b;
    });
  }, [queue]);
  const [expanded, setExpanded] = useState({});
  if (loading) return <p className="arr-form-help">Loading queue…</p>;
  if (!queue.length) return <p className="arr-form-help">No queued task records.</p>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <p className="arr-form-help">
        {queue.length.toLocaleString()} task records shown · Grouped by current status · Expand a group to inspect individual tasks.
      </p>
      {groups.map(([status, items]) => {
        const open = expanded[status] === true;
        const stale = items.filter((item) => item.isStale).length;
        return (
          <section key={status} style={{ border: "1px solid var(--aurral-border)", borderRadius: 8, overflow: "hidden" }}>
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`task-queue-${status.replace(/[^a-z0-9_-]/g, "-")}`}
              onClick={() => setExpanded((current) => ({ ...current, [status]: !current[status] }))}
              className="btn btn-secondary"
              style={{ width: "100%", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, textAlign: "left" }}
            >
              <span><StatusBadge status={status} /> <strong>{items.length.toLocaleString()}</strong>{stale ? ` · ${stale} potentially stale` : ""}</span>
              <span aria-hidden="true">{open ? "▾" : "▸"}</span>
            </button>
            {open && (
              <div id={`task-queue-${status.replace(/[^a-z0-9_-]/g, "-")}`}>
                <QueueTable queue={items} />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function SettingsTasksTab({ showError, showSuccess }) {
  const [clearing, setClearing] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyProvider, setHistoryProvider] = useState("");
  const [historyCursor, setHistoryCursor] = useState(null);
  const eventHistory = useQuery({
    queryKey: ["download-event-history", historySearch, historyProvider, historyCursor],
    queryFn: ({ signal }) => getData("/playlists/operations/events", {
      signal, params: { search: historySearch, provider: historyProvider,
        before: historyCursor, limit: 75 },
    }),
    refetchInterval: 15000,
  });
  const diagnostics = useQuery({ queryKey: ["download-operations-diagnostics"],
    queryFn: ({ signal }) => getData("/playlists/operations/diagnostics", { signal }),
    staleTime: 0, refetchInterval: 15000 });
  const [showAllWorkers, setShowAllWorkers] = useState(false);
  const tasksQuery = useQuery({
    queryKey: queryKeys.settingsTasks,
    queryFn: ({ signal }) => getSettingsTasks({ signal }),
    staleTime: 0,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
  const tasks = tasksQuery.data;
  const loading = tasksQuery.isPending;
  const loadError =
    tasksQuery.error?.response?.data?.message ||
    tasksQuery.error?.response?.data?.error ||
    tasksQuery.error?.message ||
    null;
  const clearMutation = useMutation({
    mutationFn: clearSettingsStaleTasks,
    onSuccess: (result) => queryClient.setQueryData(queryKeys.settingsTasks, result.tasks || null),
  });

  const clearStaleJobs = useCallback(async () => {
    setClearing(true);
    try {
      const result = await clearMutation.mutateAsync();
      const cleared = Number(result.cleared || 0);
      if (cleared > 0) {
        showSuccess?.(`Cleared ${cleared} stuck job${cleared === 1 ? "" : "s"}.`);
      } else {
        showSuccess?.("No stuck jobs needed clearing.");
      }
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Failed to clear stuck jobs";
      showError(message);
    } finally {
      setClearing(false);
    }
  }, [clearMutation, showError, showSuccess]);

  const idleWorkerCount = useMemo(() => {
    const workerRows = tasks?.workers || [];
    return workerRows.filter((worker) => isIdleWorker(worker)).length;
  }, [tasks?.workers]);
  const workers = tasks?.workers || [];

  return (
    <div className="arr-page">
      {loadError ? (
        <p className="arr-form-help arr-form-help--error" role="alert">
          {loadError}
        </p>
      ) : null}

      <TasksHealthSummary
        summary={tasks?.summary}
        loading={loading}
        clearing={clearing}
        onClearStale={clearStaleJobs}
      />

      <SettingsArrFieldSet legend="Scheduled">
        <ScheduledTable scheduled={tasks?.scheduled || []} loading={loading} />
      </SettingsArrFieldSet>

      <SettingsArrFieldSet
        legend="Workers"
        actions={
          idleWorkerCount > 0 ? (
            <button
              type="button"
              className="arr-btn arr-btn--ghost"
              onClick={() => setShowAllWorkers((value) => !value)}
            >
              {showAllWorkers ? "Hide idle workers" : `Show all workers (${workers.length})`}
            </button>
          ) : null
        }
      >
        <WorkersTable workers={workers} loading={loading} showAllWorkers={showAllWorkers} />
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Queue">
        <QueueSections queue={tasks?.queue || []} loading={loading} />
      </SettingsArrFieldSet>
      <SettingsArrFieldSet legend="Download diagnostics">
        <p className="arr-form-help">Read-only live status. A search waiting in slskd is not automatically a stalled download.</p>
        {diagnostics.error ? <p role="alert" className="arr-form-help arr-form-help--error">Could not load download diagnostics.</p> : null}
        <div className="arr-table-wrap">
          <table className="arr-table">
            <thead><tr><th>Provider</th><th>Reserved</th><th>Capacity</th><th>Available</th></tr></thead>
            <tbody>{(diagnostics.data?.providers?.providers || []).map(provider => (
              <tr key={provider.id}><td>{provider.id}</td><td>{provider.active}</td>
                <td>{provider.maxActive}</td><td>{provider.available}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div className="arr-form-row">
          <label htmlFor="download-history-search">Search history</label>
          <input id="download-history-search" value={historySearch} placeholder="Job ID, event, error…"
            onChange={(event) => { setHistorySearch(event.target.value); setHistoryCursor(null); }} />
          <label htmlFor="download-history-provider">Provider</label>
          <select id="download-history-provider" value={historyProvider}
            onChange={(event) => { setHistoryProvider(event.target.value); setHistoryCursor(null); }}>
            <option value="">All providers</option>
            {["slskd","dmm","ytdlp","deemix","sabnzbd","nzbget","usenet"].map(provider => (
              <option key={provider} value={provider}>{provider}</option>
            ))}
          </select>
        </div>
        {eventHistory.error ? <p role="alert">Could not load download event history.</p> : null}
        <div className="arr-table-wrap">
          <table className="arr-table">
            <thead><tr><th>When</th><th>Job / attempt</th><th>Event</th><th>Provider</th><th>Reason</th><th>Details</th></tr></thead>
            <tbody>{(eventHistory.data?.events || []).map(entry => (
              <tr key={entry.id}><td>{new Date(entry.occurredAt).toLocaleString()}</td>
                <td>{entry.jobId?.slice(0,8) || "—"}{entry.attemptId ? " / " + entry.attemptId.slice(0,8) : ""}</td>
                <td>{entry.event}</td><td>{entry.provider || "—"}</td>
                <td>{entry.reasonCode || "—"}</td><td>{entry.detail || "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div className="arr-form-actions">
          <button type="button" className="arr-btn arr-btn--ghost"
            disabled={!eventHistory.data?.hasMore || eventHistory.isFetching}
            onClick={() => setHistoryCursor(eventHistory.data.nextBefore)}>
            Older events
          </button>
          {historyCursor != null ? <button type="button" className="arr-btn arr-btn--ghost"
            onClick={() => setHistoryCursor(null)}>Newest events</button> : null}
        </div>
        <p className="arr-form-help">Pipeline: {Object.entries(diagnostics.data?.pipeline || {}).map(([name, total]) => `${name}: ${total}`).join(" · ") || "No queued pipeline work"}.
          Potentially slow jobs: {diagnostics.data?.stalledCandidates?.length ?? 0}. These are not automatically cancelled.</p>
        <div className="arr-table-wrap">
          <table className="arr-table">
            <thead><tr><th>Track</th><th>Provider</th><th>Status</th><th>Failure or retry reason</th></tr></thead>
            <tbody>{(diagnostics.data?.recentJobs || []).slice(0, 30).map(job => (
              <tr key={job.id}><td>{job.artist} — {job.track}</td>
                <td>{job.provider || "—"}</td><td>{job.status}</td>
                <td>{job.error || "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </SettingsArrFieldSet>
    </div>
  );
}
