import createHonkerWorker from "./honkerWorkerFactory.js";
import { getPipelineQueue } from "./honkerDb.js";
import {
  continuePipeline,
  processPipelinePayload,
  enqueuePendingJobsWithoutBatch,
  failPipelineJob,
  ALBUM_GRAB_ENDED_REASON,
} from "./downloadPipeline.js";
import { releaseAlbumGrabJobs } from "./albumGrab.js";
import { isPipelinePayloadActive } from "./downloadJobs/downloadCancellation.js";
import { isAnyDownloadSourceConfigured } from "./downloadSourceService.js";
import { logger, safeLogDiagnostic } from "./logger.js";
import { recordAlbumGrabQueued, recordAlbumGrabPhase } from "./albumGrabActivity.js";
import { downloadTracker } from "./downloadJobs/downloadTracker.js";
import { withDownloadPayloadMutation } from "./downloadJobs/mutationGuards.js";
import { providerSchedulerEnabled, reservePipelineProvider, releasePipelineProvider, reconcilePipelineReservations, providerSchedulerMaxWorkers } from "./downloadJobs/providerSchedulerRuntime.js";

async function processLockedPipelineJob(payload, dependencies = {}) {
  const processPayload = dependencies.processPipelinePayload || processPipelinePayload;
  const continuePayload = dependencies.continuePipeline || continuePipeline;
  const failPayload = dependencies.failPipelineJob || failPipelineJob;
  try {
    if (payload?.albumGrab === true && isPipelinePayloadActive(payload)) {
      recordAlbumGrabQueued(payload, downloadTracker.getAll());
      recordAlbumGrabPhase(payload);
    }
    const nextPayload = await processPayload(payload);
    if (providerSchedulerEnabled() && nextPayload == null) releasePipelineProvider(payload);
    if (nextPayload?.albumGrab === true) recordAlbumGrabPhase(nextPayload);
    if (payload?.albumGrab === true
      && !(nextPayload?.albumGrab === true && isPipelinePayloadActive(nextPayload))) {
      releaseAlbumGrabJobs(payload, ALBUM_GRAB_ENDED_REASON);
    }
    await continuePayload(nextPayload);
  } catch (error) {
    if (payload?.manualSelection !== true) throw error;
    const message = safeLogDiagnostic(error) || "Manual download failed";
    logger.error("manual-search", "Selected manual download failed", {
      jobId: payload?.jobId || null,
      source: payload?.source || null,
      reason: message,
    });
    await failPayload(payload, message);
  }
}

export function processPipelineJob(payload, dependencies = {}) {
  return withDownloadPayloadMutation(payload, async (current) => {
    if (providerSchedulerEnabled() && !current?.manualSelection) {
      const reserved = reservePipelineProvider(current);
      if (!reserved) {
        await (dependencies.continuePipeline || continuePipeline)({ ...current, delaySeconds: 2 });
        return;
      }
      return processLockedPipelineJob(reserved, dependencies);
    }
    return processLockedPipelineJob(current, dependencies);
  });
}

// AURRAL_DUAL_PIPELINE_CONSUMER_V1
// Both consumers claim from the SAME persisted queue. No queue migration.
// Default stays at one consumer unless AURRAL_PIPELINE_CONSUMERS=2.
const secondaryPipelineConsumer = createHonkerWorker({
  name: "slskd-pipeline",
  registrationName: "slskd-pipeline-secondary",
  getQueue: getPipelineQueue,
  idlePollS: 2,
  retryDelayS: 30,
  shouldRestart: () => isAnyDownloadSourceConfigured(),
  onStart() {
    if (process.env.AURRAL_PIPELINE_CONSUMERS !== "2" || !isAnyDownloadSourceConfigured()) return false;
    console.log("[pipeline] secondary consumer starting");
    return true;
  },
  processJob: processPipelineJob,
  onFinalFailure(job, error) {
    const message = error?.message || String(error);
    console.error("[downloadPipelineWorker] secondary pipeline job failed:", {
      jobId: job.payload?.jobId || null,
      phase: job.payload?.phase || null,
      message,
    });
    return withDownloadPayloadMutation(job.payload, (payload) => failPipelineJob(payload, message));
  },
});

const {
  start: startPrimaryPipelineWorker,
  stop: stopPrimaryPipelineWorker,
  isRunning: isPrimaryPipelineWorkerRunning,
} = createHonkerWorker({
  name: "slskd-pipeline",
  getQueue: getPipelineQueue,
  idlePollS: 2,
  retryDelayS: 30,
  shouldRestart: () => isAnyDownloadSourceConfigured(),
  onStart() {
    if (!isAnyDownloadSourceConfigured()) return false;
    console.log("[pipeline] worker starting");
    if (providerSchedulerEnabled()) reconcilePipelineReservations();
    enqueuePendingJobsWithoutBatch();
    if (process.env.AURRAL_PIPELINE_CONSUMERS === "2") secondaryPipelineConsumer.start();
    return true;
  },
  processJob: processPipelineJob,
  onFinalFailure(job, error) {
    const message = error?.message || String(error);
    console.error("[downloadPipelineWorker] pipeline job failed:", {
      jobId: job.payload?.jobId || null,
      phase: job.payload?.phase || null,
      candidateIndex: job.payload?.candidateIndex ?? null,
      message,
      stack: error?.stack || null,
    });
    return withDownloadPayloadMutation(job.payload, (payload) => failPipelineJob(payload, message));
  },
});

export function startDownloadPipelineWorker() {
  if (process.env.AURRAL_PIPELINE_CONSUMERS === "2") secondaryPipelineConsumer.start();
  return startPrimaryPipelineWorker();
}
export async function stopDownloadPipelineWorker() {
  await Promise.all([stopPrimaryPipelineWorker(), secondaryPipelineConsumer.stop()]);
}
export function isDownloadPipelineWorkerRunning() {
  return isPrimaryPipelineWorkerRunning();
}
