// Search subprocesses are CPU intensive; keep their concurrency independent of downloads.
const MAX_SEARCHES = 8;
function configuredLimit() {
  const raw = Number(process.env.AURRAL_YTDLP_SEARCH_LIMIT ?? 1);
  return Number.isFinite(raw) ? Math.max(1, Math.min(MAX_SEARCHES, Math.floor(raw))) : 1;
}
let active = 0;
const waiters = [];
function release() {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}
export async function withYtdlpSearchSlot(operation) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  if (active >= configuredLimit()) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    return await operation();
  } finally {
    release();
  }
}
export const ytdlpSearchSlotStats = () => ({ active, waiting: waiters.length, limit: configuredLimit() });
