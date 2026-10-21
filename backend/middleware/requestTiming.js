import { logger } from "../services/logger.js";

// Opt-in HTTP latency telemetry. Never logs URLs, query strings, user IDs,
// filenames, tokens, source names or media paths.
function category(path) {
  const value = String(path || "");
  if (value.startsWith("/rest/stream") || value.startsWith("/rest/download")
    || value.startsWith("/api/playback") || value.startsWith("/api/stream")
    || value.startsWith("/stream")) return "playback";
  if (value.startsWith("/api/") || value.startsWith("/rest/")) return "api";
  if (/\.(?:js|css|svg|png|woff2?|webp)$/.test(value)) return "assets";
  return "navigation";
}
const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
};

export function createRequestTiming() {
  if (process.env.AURRAL_DIAG_HTTP_TIMING !== "1") return (_req, _res, next) => next();
  const windows = new Map();
  const timer = setInterval(() => {
    for (const [group, events] of windows) {
      if (!events.length) continue;
      logger.info("perf", "HTTP timing 60s", {
        category: group,
        count: events.length,
        p95FirstByteMs: percentile(events.map((x) => x.firstByteMs), 0.95),
        p95CompleteMs: percentile(events.map((x) => x.completeMs), 0.95),
        errors: events.filter((x) => x.status >= 500).length,
      });
    }
    windows.clear();
  }, 60000);
  timer.unref?.();

  return (req, res, next) => {
    const start = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;
    let firstByteMs = null;
    const originalWriteHead = res.writeHead;
    res.writeHead = function (...args) {
      if (firstByteMs === null) {
        firstByteMs = elapsed();
        if (!res.headersSent) res.setHeader("Server-Timing", `aurral;dur=${firstByteMs.toFixed(1)}`);
      }
      return originalWriteHead.apply(this, args);
    };
    res.once("finish", () => {
      const key = category(req.path);
      const bucket = windows.get(key) || [];
      bucket.push({ firstByteMs: firstByteMs ?? elapsed(), completeMs: elapsed(), status: res.statusCode });
      if (bucket.length > 1000) bucket.shift();
      windows.set(key, bucket);
    });
    next();
  };
}
