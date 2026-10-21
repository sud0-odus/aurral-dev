import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.js";

const previousScheduler = process.env.AURRAL_PROVIDER_SCHEDULER;
const [isolated, { dbOps }, { YtdlpClient }] = await setupIsolatedBackend(
  "ytdlp-five-lanes",
  "backend/db/helpers/index.js",
  "backend/services/ytdlpClient.js",
);

test.after(async () => {
  if (previousScheduler === undefined) delete process.env.AURRAL_PROVIDER_SCHEDULER;
  else process.env.AURRAL_PROVIDER_SCHEDULER = previousScheduler;
  await cleanupIsolatedState(isolated);
});

test("five configured provider lanes permit five simultaneous yt-dlp acquisitions", {
  skip: process.platform === "win32",
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aurral-five-lanes-"));
  const binary = path.join(dir, "yt-dlp");
  const logPath = path.join(dir, "events.jsonl");
  const priorPath = process.env.PATH;
  const priorLog = process.env.AURRAL_TEST_LANE_LOG;
  process.env.AURRAL_PROVIDER_SCHEDULER = "1";
  process.env.AURRAL_TEST_LANE_LOG = logPath;
  process.env.PATH = `${dir}${path.delimiter}${priorPath || ""}`;
  dbOps.updateSettings({ integrations: { ytdlp: { enabled: true, maxActive: 5 } } });
  await writeFile(binary, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const jobId = new URL(args.at(-1)).searchParams.get('job');",
    "const output = args[args.indexOf('-o') + 1].replace('%(id)s', jobId).replace('%(ext)s', 'm4a');",
    "const event = (type) => fs.appendFileSync(process.env.AURRAL_TEST_LANE_LOG, JSON.stringify({ type, jobId }) + '\\n');",
    "event('start');",
    "setTimeout(() => { fs.writeFileSync(output, 'audio'); event('end'); }, 1400);",
  ].join("\n"));
  await chmod(binary, 0o755);
  try {
    const client = new YtdlpClient({ enabled: true, stagingPath: dir });
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      client.downloadAudio(`https://example.invalid/audio?job=${i}`, { jobId: String(i) })));
    const lines = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
    let active = 0;
    let peak = 0;
    for (const event of lines) {
      active += event.type === "start" ? 1 : -1;
      peak = Math.max(peak, active);
    }
    assert.equal(peak, 5);
    assert.equal(active, 0);
  } finally {
    process.env.PATH = priorPath;
    if (priorLog === undefined) delete process.env.AURRAL_TEST_LANE_LOG;
    else process.env.AURRAL_TEST_LANE_LOG = priorLog;
    await rm(dir, { recursive: true, force: true });
  }
});
