import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { validateExternalUrl } from "../../../middleware/urlValidator.js";
import { getProviderSchedulerStats } from "../../../services/downloadJobs/providerSchedulerRuntime.js";
import {
  getDownloadClient,
  getDownloadClientSettings,
  testDownloadClient,
} from "../../../services/download/downloadClientSettings.js";

function validateDownloadClientTestConfig(key, config) {
  const definition = getDownloadClientSettings()[key];
  const nextConfig =
    config && typeof config === "object" && !Array.isArray(config)
      ? { ...config }
      : {};

  for (const field of definition?.fields || []) {
    if (field.type !== "url") continue;
    const value = nextConfig[field.key];
    if (value == null || String(value).trim() === "") continue;
    const validation = validateExternalUrl(value);
    if (!validation.valid) {
      throw new Error(`${field.label || field.key}: ${validation.error}`);
    }
    nextConfig[field.key] = validation.url;
  }

  return nextConfig;
}

function registerClientTest(router, path, importClient, label, { warning } = {}) {
  router.post(path, async (_req, res) => {
    try {
      const client = await importClient();
      const result = await client.testConnection({ force: true });
      if (!result.configured) {
        return res.status(400).json(result);
      }
      if (!result.ok) {
        return res.status(502).json(result);
      }
      return res.json(
        warning
          ? { success: true, warning: result.warning === true, ...result }
          : { success: true, ...result },
      );
    } catch (error) {
      return res.status(500).json({
        error: `${label} test failed`,
        message: error.message,
      });
    }
  });
}

export function registerDownloadClients(router) {
  router.get("/download-clients/runtime", (_req, res) => {
    // Effective process values: never infer "running" from stored UI preferences.
    let bridge = { state: "unknown", installed: null, enabledAtBoot: null };
    try {
      const active = execFileSync("systemctl", ["is-active", "aurral-apple-poc.service"], {
        encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      bridge = { state: active, installed: true, enabledAtBoot: null };
    } catch (error) {
      const output = String(error.stdout || "").trim();
      bridge = { state: output || "unknown", installed: output !== "unknown" && output !== "not-found", enabledAtBoot: null };
    }
    try {
      const enabled = execFileSync("systemctl", ["is-enabled", "aurral-apple-poc.service"], {
        encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      bridge.enabledAtBoot = enabled === "enabled";
    } catch {
      // Do not invent startup state when systemd cannot answer.
    }
    res.json({
      observedAt: new Date().toISOString(),
      controlAvailable: Boolean(process.env.AURRAL_SERVICE_CONTROL_HELPER),
      scheduler: getProviderSchedulerStats(),
      flags: {
        providerScheduler: process.env.AURRAL_PROVIDER_SCHEDULER === "1",
        acquisitionPaused: process.env.AURRAL_CT119_PAUSE_ACQUISITION === "1",
        pipelineConsumers: process.env.AURRAL_PIPELINE_CONSUMERS === "2" ? 2 : 1,
      },
      applePocBridge: bridge,
    });
  });

  router.post("/download-clients/runtime/apply", async (req, res) => {
    const { feature, enabled } = req.body || {};
    if (!["scheduler", "apple-poc"].includes(feature) || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Invalid service control request" });
    }
    const controller = process.env.AURRAL_SERVICE_CONTROL_HELPER;
    if (!controller || !controller.startsWith("/") || !/^\\/[a-zA-Z0-9/_-]+$/.test(controller)) {
      return res.status(503).json({ error: "Local service controller is not configured" });
    }
    try {
      await execFileAsync(controller, [feature, enabled ? "enable" : "disable"], {
        timeout: 15000, windowsHide: true, shell: false,
      });
      return res.status(202).json({ accepted: true, message: "Change requested; refresh to verify effective runtime state." });
    } catch {
      return res.status(502).json({ error: "Service controller failed; runtime change not verified." });
    }
  });

  router.get("/download-clients/scheduler", (_req, res) => {
    res.json(getProviderSchedulerStats());
  });
  router.get("/download-clients", (_req, res) => {
    res.json({ clients: getDownloadClientSettings() });
  });

  router.post("/download-clients/:key/test", async (req, res) => {
    try {
      const config = validateDownloadClientTestConfig(req.params.key, req.body);
      const result = await testDownloadClient(req.params.key, config);
      if (!result.configured) {
        return res.status(400).json(result);
      }
      if (!result.ok) {
        return res.status(502).json(result);
      }
      return res.json({ success: true, warning: result.warning === true, ...result });
    } catch (error) {
      return res.status(400).json({
        error: "Connection failed",
        message: error.message,
      });
    }
  });

  registerClientTest(
    router,
    "/slskd/test",
    async () => getDownloadClient("slskd"),
    "slskd",
    { warning: true },
  );

  registerClientTest(
    router,
    "/prowlarr/test",
    async () => (await import("../../../services/prowlarrClient.js")).prowlarrClient,
    "Prowlarr",
  );

  router.get("/prowlarr/indexers", async (_req, res) => {
    try {
      const { prowlarrClient } = await import("../../../services/prowlarrClient.js");
      const indexers = await prowlarrClient.listUsenetIndexers({ force: true });
      return res.json({ indexers });
    } catch (error) {
      return res.status(500).json({
        error: "Failed to load Prowlarr indexers",
        message: error.message,
      });
    }
  });

  registerClientTest(
    router,
    "/nzbget/test",
    async () => getDownloadClient("nzbget"),
    "NZBGet",
  );

  registerClientTest(
    router,
    "/sabnzbd/test",
    async () => getDownloadClient("sabnzbd"),
    "SABnzbd",
  );

  registerClientTest(
    router,
    "/ytdlp/test",
    async () => getDownloadClient("ytdlp"),
    "yt-dlp",
  );

  router.post("/gotify/test", async (req, res) => {
    try {
      const { sendGotifyTest } =
        await import("../../../services/notificationService.js");
      const url = req.body?.url?.trim();
      const token = req.body?.token?.trim();
      if (!url || !token) {
        return res.status(400).json({
          error: "URL and token required",
          message: "Provide Gotify URL and application token in the request body",
        });
      }
      const urlValidation = validateExternalUrl(url);
      if (!urlValidation.valid) {
        return res.status(400).json({ error: urlValidation.error });
      }
      await sendGotifyTest(urlValidation.url, token);
      res.json({ success: true, message: "Test notification sent" });
    } catch (error) {
      if (error.code === "MISSING_CONFIG") {
        return res.status(400).json({
          error: "Invalid configuration",
          message: error.message,
        });
      }
      const status = error.response?.status;
      const msg =
        error.response?.data?.description ||
        error.response?.data?.error ||
        error.message;
      res
        .status(status && status >= 400 ? status : 500)
        .json({ error: "Gotify test failed", message: msg });
    }
  });

  router.post("/webhook/test", async (req, res) => {
    const webhook =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? { ...req.body }
        : {};
    const urlValidation = validateExternalUrl(webhook.url);
    if (!urlValidation.valid) {
      return res.status(400).json({ error: urlValidation.error });
    }

    try {
      const { sendWebhookTest } =
        await import("../../../services/notificationService.js");
      await sendWebhookTest({ ...webhook, url: urlValidation.url });
      return res.json({ success: true, message: "Test webhook sent" });
    } catch (error) {
      const status = error.response?.status;
      const msg =
        error.response?.data?.description ||
        error.response?.data?.error ||
        error.message;
      return res
        .status(status && status >= 400 ? status : 500)
        .json({ error: "Webhook test failed", message: msg });
    }
  });
}
