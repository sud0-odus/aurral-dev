import { spawn } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { dbOps } from "../db/helpers/index.js";
import { resolveYtdlpStagingRoot } from "./downloadFolderConfig.js";
import { BackgroundEncodeSlots } from "./downloadJobs/backgroundEncodeSlots.js";

const DEFAULT_BINARY = "yt-dlp";
const SEARCH_LIMIT = 5;
// Stalls are controlled separately by the 5-minute no-progress watchdog.
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const AUDIO_FORMAT = "m4a";
const activeDownloads = new Map();
// Opt-in end-to-end yt-dlp limiter. yt-dlp owns FFmpeg postprocessing,
// so this caps *acquisition + conversion*, not conversion alone.
// Honor the provider setting while stage-aware scheduling is active.
const configured = Number(dbOps.getSettings()?.integrations?.ytdlp?.maxActive);
const schedulerLimit = Number.isFinite(configured) && configured >= 1 ? Math.min(8, Math.floor(configured)) : 3;
const pipelineLimit = process.env.AURRAL_PROVIDER_SCHEDULER === "1"
  ? schedulerLimit : Number(process.env.AURRAL_YTDLP_PIPELINE_LIMIT || 0);
const pipelineSlots = Number.isSafeInteger(pipelineLimit) && pipelineLimit > 0
  ? new BackgroundEncodeSlots(pipelineLimit)
  : null;

async function withPipelineSlot(operation, shouldCancel) {
  if (!pipelineSlots) return operation();
  const controller = new AbortController();
  const checkCancelled = () => {
    try {
      if (shouldCancel?.() === true) controller.abort();
    } catch {}
  };
  checkCancelled();
  const poll = setInterval(checkCancelled, 250);
  poll.unref?.();
  try {
    return await pipelineSlots.run(operation, { signal: controller.signal });
  } finally {
    clearInterval(poll);
  }
}


export const ytdlpSettings = Object.freeze({
  key: "ytdlp",
  label: "yt-dlp",
  subtitle: "YouTube / web",
  enabledDefault: true,
  healthKey: "ytdlpConfigured",
  testRequiresEnabled: false,
  fields: Object.freeze([
    Object.freeze({ key: "enabled", label: "Enable yt-dlp", type: "toggle" }),
    Object.freeze({
      key: "priority",
      label: "Source priority",
      type: "number",
      min: 1,
      max: 1000,
      section: "Behavior",
    }),
    Object.freeze({
      key: "preserveSourceAudio",
      label: "Preserve original audio format (experimental)",
      type: "toggle",
      section: "Downloads",
      hint: "Skip forced AAC/M4A conversion. Original Opus/WebM may not match existing quality tiers; test before enabling on a production library.",
    }),
    Object.freeze({
      key: "stagingPath",
      label: "Staging path",
      type: "path",
      section: "Downloads",
      hint: "Temporary downloads stay here until imported.",
    }),
  ]),
  defaults: Object.freeze({ enabled: true, priority: 50, stagingPath: "", preserveSourceAudio: false }),
  validation: Object.freeze({ required: [], url: [] }),
  testConnection: true,
});

function getSettings(config = null) {
  return config || dbOps.getSettings()?.integrations?.ytdlp || {};
}

function getBinaryPath() {
  return DEFAULT_BINARY;
}

function isEnabledFor(config = null) {
  return getSettings(config).enabled !== false;
}

function resolveBinaryExists(binary) {
  const candidates = path.isAbsolute(binary)
    ? [binary]
    : String(process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, binary));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function buildYtdlpInvocationArgs(
  args,
  { nodeAvailable = resolveBinaryExists("node") } = {},
) {
  return [
    ...(nodeAvailable ? ["--no-js-runtimes", "--js-runtimes", "node"] : []),
    ...args,
  ];
}

function isConfiguredFor(config = null) {
  return isEnabledFor(config) && resolveBinaryExists(getBinaryPath());
}

function runYtdlp(args, { timeoutMs = 120000, idleTimeoutMs = 0, cwd, shouldCancel } = {}) {
  return new Promise((resolve, reject) => {
    const isolatedProcessGroup = process.platform !== "win32";
    const child = spawn(getBinaryPath(), buildYtdlpInvocationArgs(args), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: isolatedProcessGroup,
    });
    const signalProcess = (signal) => {
      if (isolatedProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {}
      }
      child.kill(signal);
    };
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationError = null;
    let forcedKillTimer = null;
    let lastTransferProgressAt = Date.now();
    let progressPercent = -1;
    let progressBytes = -1;
    const progressBuffers = { stdout: "", stderr: "" };
    const progressWatch = idleTimeoutMs > 0 ? setInterval(() => {
      if (terminationError || Date.now() - lastTransferProgressAt < idleTimeoutMs) return;
      const error = new Error("yt-dlp transfer stalled: no progress for five minutes; review this job");
      error.code = "TRANSFER_STALLED";
      terminationError = error;
      signalProcess("SIGTERM");
      forcedKillTimer = setTimeout(() => signalProcess("SIGKILL"), 1000);
    }, 1000) : null;
    progressWatch?.unref?.();
    const timer = setTimeout(() => {
      const error = new Error(`yt-dlp timed out after ${timeoutMs}ms`);
      error.code = "DOWNLOAD_TIMEOUT";
      terminationError = error;
      signalProcess("SIGKILL");
    }, timeoutMs);
    const cancellationTimer = typeof shouldCancel === "function"
      ? setInterval(() => {
          let cancelled = false;
          try {
            cancelled = shouldCancel() === true;
          } catch {}
          if (!cancelled || terminationError) return;
          const error = new Error("yt-dlp download cancelled");
          error.code = "DOWNLOAD_CANCELLED";
          terminationError = error;
          clearTimeout(timer);
          signalProcess("SIGTERM");
          forcedKillTimer = setTimeout(() => signalProcess("SIGKILL"), 1000);
        }, 250)
      : null;
    if (typeof cancellationTimer?.unref === "function") cancellationTimer.unref();
    function clearTimers() {
      clearTimeout(timer);
      if (forcedKillTimer) clearTimeout(forcedKillTimer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      if (progressWatch) clearInterval(progressWatch);
    }
    function settleReject(error) {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    }
    const readProgress = (output, stream) => {
      if (idleTimeoutMs <= 0) return;
      const lines = (progressBuffers[stream] + output).split(/[\\r\\n]+/);
      progressBuffers[stream] = lines.pop()?.slice(-256) || "";
      for (const line of lines) {
        const bytes = /__AURRAL_BYTES__:(\\d+)/.exec(line);
        if (bytes && Number(bytes[1]) > progressBytes) {
          progressBytes = Number(bytes[1]);
          lastTransferProgressAt = Date.now();
          continue;
        }
        const percentage = /\\[download\\]\\s+(\\d+(?:\\.\\d+)?)%/.exec(line);
        if (percentage && Number(percentage[1]) > progressPercent) {
          progressPercent = Number(percentage[1]);
          lastTransferProgressAt = Date.now();
        }
      }
    };
    child.stdout.on("data", (chunk) => {
      const output = chunk.toString();
      // Searches use stdout for JSON; downloads only need a bounded tail.
      stdout = idleTimeoutMs > 0 ? (stdout + output).slice(-8192) : stdout + output;
      readProgress(output, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      const output = chunk.toString();
      stderr = (stderr + output).slice(-8192);
      readProgress(output, "stderr");
    });
    child.on("error", (error) => {
      settleReject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (terminationError) {
        signalProcess("SIGKILL");
        reject(terminationError);
        return;
      }
      if (code !== 0) {
        const detail = String(stderr || stdout || "").trim().slice(-500);
        reject(new Error(detail || `yt-dlp exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function testConnectionFor(config = null, { force: _force = false } = {}) {
  if (!isEnabledFor(config)) {
    return { configured: false, ok: false, message: "yt-dlp is disabled" };
  }
  const binary = getBinaryPath();
  if (!resolveBinaryExists(binary)) {
    return {
      configured: false,
      ok: false,
      message: `yt-dlp binary not found (${binary}). Install yt-dlp and ffmpeg.`,
    };
  }
  try {
    const { stdout } = await runYtdlp(["--version"], { timeoutMs: 15000 });
    const version = String(stdout || "").trim().split(/\s+/)[0] || "ok";
    return { configured: true, ok: true, version, message: `yt-dlp ${version}` };
  } catch (error) {
    return { configured: true, ok: false, message: error?.message || String(error) };
  }
}

async function searchFor(_config = null, query, { limit = SEARCH_LIMIT, shouldCancel, timeoutMs = 60000 } = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  const capped = Math.min(Math.max(Number(limit) || SEARCH_LIMIT, 1), 10);
  const { stdout } = await runYtdlp(
    [
      "--flat-playlist",
      "--dump-json",
      "--no-download",
      "--no-warnings",
      `ytsearch${capped}:${trimmed}`,
    ],
    { timeoutMs, shouldCancel },
  );
  const results = [];
  for (const line of String(stdout || "").split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      const entry = JSON.parse(raw);
      const id = String(entry.id || entry.url || "").trim();
      if (!id) continue;
      results.push({
        id,
        title: String(entry.title || "").trim(),
        url:
          String(entry.webpage_url || entry.url || "").trim() ||
          `https://www.youtube.com/watch?v=${id}`,
        channel: String(entry.channel || entry.uploader || "").trim(),
        durationSec:
          Number.isFinite(Number(entry.duration)) && Number(entry.duration) > 0
            ? Number(entry.duration)
            : null,
        liveStatus: String(entry.live_status || "").trim().toLowerCase(),
      });
    } catch {
    }
  }
  return results;
}

async function inspectVideoFor(_config = null, videoId, { shouldCancel, timeoutMs = 60000 } = {}) {
  const id = String(videoId || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const url = `https://www.youtube.com/watch?v=${id}`;
  const { stdout } = await runYtdlp(
    ["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", "--", url],
    { timeoutMs, shouldCancel },
  );
  const entry = JSON.parse(stdout);
  if (String(entry.id || "") !== id) return null;
  return {
    id,
    title: String(entry.title || "").trim(),
    url,
    channel: String(entry.channel || entry.uploader || "").trim(),
    durationSec: Number.isFinite(Number(entry.duration)) && Number(entry.duration) > 0
      ? Number(entry.duration) : null,
    liveStatus: String(entry.live_status || "").trim().toLowerCase(),
  };
}

function resolveStagingDir(config, jobId) {
  return path.join(
    resolveYtdlpStagingRoot(getSettings(config).stagingPath),
    "ytdlp",
    String(jobId || "unknown"),
  );
}

async function findDownloadedAudio(dir, videoId = null) {
  const entries = await fsPromises.readdir(dir).catch(() => []);
  const audioExt = new Set([".m4a", ".mp3", ".opus", ".flac", ".ogg", ".webm", ".wav"]);
  for (const name of entries) {
    const full = path.join(dir, name);
    if (!audioExt.has(path.extname(name).toLowerCase())) continue;
    if (videoId && path.parse(name).name !== videoId) continue;
    const stat = await fsPromises.stat(full).catch(() => null);
    if (stat?.isFile() && stat.size > 0) return full;
  }
  return null;
}

async function downloadAudioFor(config = null, videoUrl, { jobId, videoId, shouldCancel } = {}) {
  const url = String(videoUrl || "").trim();
  if (!url) throw new Error("Missing yt-dlp download URL");
  const stagingDir = resolveStagingDir(config, jobId);
  // The remote acquisition may have completed immediately before a worker
  // crash. A finished yt-dlp output is named <video-id>.<ext>; only reuse an
  // exact candidate ID and still validate it in the normal finalize phase.
  const identity = /^[A-Za-z0-9_-]{11}$/.test(String(videoId || "")) ? String(videoId) : null;
  const recovered = identity ? await findDownloadedAudio(stagingDir, identity) : null;
  if (recovered) {
    if (shouldCancel?.() === true) throw new Error("yt-dlp recovery cancelled");
    return { filePath: recovered, stagingDir, recovered: true };
  }
  await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  await fsPromises.mkdir(stagingDir, { recursive: true });
  const outTemplate = path.join(stagingDir, "%(id)s.%(ext)s");
  const preserveSourceAudio = getSettings(config).preserveSourceAudio === true;
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress-template", "download:__AURRAL_BYTES__:%(progress.downloaded_bytes)s",
    ...(preserveSourceAudio ? ["-f", "bestaudio/best"] : ["-x", "--embed-metadata"]),
    "--parse-metadata",
    "title:^(?P<artist>.+?)\\s+[-–—]\\s+(?P<title>.+)$",
    ...(!preserveSourceAudio ? ["--audio-format", AUDIO_FORMAT, "--audio-quality", "0"] : []),
    "-o",
    outTemplate,
    "--",
    url,
  ];
  try {
    await withPipelineSlot(async () => {
      try {
        await runYtdlp(args, { timeoutMs: DOWNLOAD_TIMEOUT_MS, idleTimeoutMs: 300000, cwd: stagingDir, shouldCancel });
      } catch (error) {
        // Keep the slot through the retry so retried downloads cannot exceed the cap.
        if (!/HTTP Error 403/u.test(error?.message || "")) throw error;
        await runYtdlp(args, { timeoutMs: DOWNLOAD_TIMEOUT_MS, idleTimeoutMs: 300000, cwd: stagingDir, shouldCancel });
      }
    }, shouldCancel);
  } catch (error) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const filePath = await findDownloadedAudio(stagingDir);
  if (!filePath) {
    await fsPromises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw new Error("yt-dlp finished without an audio file");
  }
  return { filePath, stagingDir };
}

async function cleanupStagingFor(config = null, jobId) {
  await activeDownloads.get(String(jobId || ""))?.catch(() => {});
  await fsPromises.rm(resolveStagingDir(config, jobId), { recursive: true, force: true }).catch(() => {});
}

export class YtdlpClient {
  constructor(config = null) {
    this.key = "ytdlp";
    this.name = "yt-dlp";
    this._config = config;
  }

  updateConfig(config = null) {
    this._config = config;
  }

  isEnabled() {
    return isEnabledFor(this._config);
  }

  isConfigured() {
    return isConfiguredFor(this._config);
  }

  getStatus() {
    return {
      enabled: this.isEnabled(),
      configured: this.isConfigured(),
    };
  }

  testConnection(options) {
    return testConnectionFor(this._config, options);
  }

  search(query, options) {
    return searchFor(this._config, query, options);
  }
  inspectVideo(videoId, options) {
    return inspectVideoFor(this._config, videoId, options);
  }

  downloadAudio(videoUrl, options) {
    const download = downloadAudioFor(this._config, videoUrl, options);
    const jobId = String(options?.jobId || "");
    if (jobId) {
      activeDownloads.set(jobId, download);
      const forget = () => {
        if (activeDownloads.get(jobId) === download) activeDownloads.delete(jobId);
      };
      void download.then(forget, forget);
    }
    return download;
  }

  cleanupStaging(jobId) {
    return cleanupStagingFor(this._config, jobId);
  }
}

const defaultYtdlpClient = new YtdlpClient();

export function isYtdlpEnabled() {
  return defaultYtdlpClient.isEnabled();
}

export function isConfigured() {
  return defaultYtdlpClient.isConfigured();
}

export function testConnection(options) {
  return defaultYtdlpClient.testConnection(options);
}

export function search(query, options) {
  return defaultYtdlpClient.search(query, options);
}

export function downloadAudio(videoUrl, options) {
  return defaultYtdlpClient.downloadAudio(videoUrl, options);
}

export function cleanupStaging(jobId) {
  return defaultYtdlpClient.cleanupStaging(jobId);
}

export const ytdlpClient = defaultYtdlpClient;
