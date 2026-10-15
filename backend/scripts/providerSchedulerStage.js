// CT119-only staging helper for real multi-provider scheduler testing.
// Usage: AURRAL_DATA_DIR=/opt/aurral_data node backend/scripts/providerSchedulerStage.js configure
//        AURRAL_DATA_DIR=/opt/aurral_data node backend/scripts/providerSchedulerStage.js status
import fs from "node:fs";
import os from "node:os";

const action = process.argv[2];
if (!["configure", "status"].includes(action)) {
  console.error("Usage: node backend/scripts/providerSchedulerStage.js [configure|status]");
  process.exit(2);
}

// Check the container and data directory BEFORE importing application modules,
// because some modules initialize SQLite during import.
if (os.hostname() !== "aurral-scheduler-dev"
    || process.env.AURRAL_DATA_DIR !== "/opt/aurral_data"
    || process.env.AURRAL_DB_PATH) {
  throw new Error("This tool is restricted to CT119 and /opt/aurral_data.");
}
if (!fs.existsSync("/opt/aurral_data/aurral.db")) {
  throw new Error("CT119 database not found; refusing to create a replacement.");
}

const { db } = await import("../config/db-sqlite.js");
const { dbOps } = await import("../db/helpers/index.js");
const { dmmToken } = await import("../services/dmmSettings.js");
const { getDownloadSourceStatus } = await import("../services/downloadSourceService.js");

const active = () => db.prepare(
  "SELECT COUNT(*) AS n FROM playlist_download_jobs WHERE status IN (?, ?)"
).get("pending", "downloading").n;
const pipeline = () => db.prepare(
  "SELECT COUNT(*) AS n FROM _honker_live WHERE queue = ?"
).get("slskd-pipeline").n;
const reservations = () => db.prepare(
  "SELECT provider_id, COUNT(*) AS n FROM download_provider_reservations GROUP BY provider_id"
).all();

function status() {
  const integrations = dbOps.getSettings()?.integrations || {};
  const source = getDownloadSourceStatus();
  for (const id of ["slskd", "sabnzbd", "nzbget", "deemix", "dmm", "ytdlp"]) {
    const cfg = integrations[id] || {};
    const configured = id === "dmm" ? source.dmm.configured
      : id === "ytdlp" ? source.ytdlp.configured
        : undefined;
    console.log(
      `PROVIDER=${id} ENABLED=${cfg.enabled === true} MAX_ACTIVE=${cfg.maxActive ?? "default"}`
      + ` PRIORITY=${cfg.priority ?? "default"}`
      + (configured === undefined ? "" : ` CONFIGURED=${configured}`)
    );
  }
  console.log(`ACTIVE_DOWNLOAD_JOBS=${active()}`);
  console.log(`PIPELINE_QUEUE_JOBS=${pipeline()}`);
  console.log(`RESERVATIONS=${JSON.stringify(reservations())}`);
}

if (action === "configure") {
  if (active() !== 0 || pipeline() !== 0 || reservations().length !== 0) {
    throw new Error("Staging has active jobs, pipeline messages, or reservations; no changes made.");
  }
  if (!dmmToken()) throw new Error("DMM token is missing; no changes made.");
  fs.accessSync("/downloads/aurral", fs.constants.W_OK);

  const backup = `/opt/aurral_data/aurral.before-multiprovider-${Date.now()}.db`;
  await db.backup(backup);
  console.log(`DATABASE_BACKUP=${backup}`);

  const integrations = structuredClone(dbOps.getSettings()?.integrations || {});
  for (const id of ["slskd", "sabnzbd", "nzbget", "deemix"]) {
    integrations[id] = { ...(integrations[id] || {}), enabled: false };
  }
  integrations.dmm = {
    ...(integrations.dmm || {}),
    enabled: true,
    priority: 10,
    maxActive: 1,
    stagingPath: "/downloads/aurral/.dmm-staging",
  };
  integrations.ytdlp = {
    ...(integrations.ytdlp || {}),
    enabled: true,
    priority: 20,
    maxActive: 2,
  };
  dbOps.updateSettings({ integrations });
  dbOps.invalidateSettingsCache();
  const source = getDownloadSourceStatus();
  console.log(`DMM_CONFIGURED=${source.dmm.configured}`);
  console.log(`YTDLP_CONFIGURED=${source.ytdlp.configured}`);
  console.log("TEST_CONFIGURATION=DMM:1 YTDLP:2");
  if (!source.dmm.configured || !source.ytdlp.configured) {
    throw new Error("Provider configuration failed; backup is available for recovery.");
  }
}

status();
db.close();
