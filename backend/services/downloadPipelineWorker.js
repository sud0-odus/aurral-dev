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

// Each consumer claims a different durable Honker message. Capacity is
// independently enforced by SQLite reservations, not the number of consumers.
const pipelineConsumers = Array.from({ length: 16 }, (_, index) => createHonkerWorker({
  name: "slskd-pipeline",
  registrationName: `slskd-pipeline-${index + 1}`,
  getQueue: getPipelineQueue,
  idlePollS: 2,
  retryDelayS: 30,
  shouldRestart: () => process.env.AURRAL_CT119_PAUSE_ACQUISITION !== "1" && isAnyDownloadSourceConfigured(),
  onStart() {
    if (process.env.AURRAL_CT119_PAUSE_ACQUISITION === "1") return false;
    if (!isAnyDownloadSourceConfigured()) return false;
    if (providerSchedulerEnabled()) {
      if (index >= providerSchedulerMaxWorkers()) return false;
      if (index === 0) reconcilePipelineReservations();
    } else if (index > (process.env.AURRAL_PIPELINE_CONSUMERS === "2" ? 1 : 0)) {
      return false;
    }
    if (index === 0) enqueuePendingJobsWithoutBatch();
    return true;
  },
  processJob: processPipelineJob,
  onFinalFailure(job, error) {
    const message = error?.message || String(error);
    logger.error("downloads", "Pipeline job failed permanently", {
      jobId: job.payload?.jobId, source: job.payload?.source, reason: message,
    });
    releasePipelineProvider(job.payload);
    return withDownloadPayloadMutation(job.payload, (payload) => failPipelineJob(payload, message));
  },
}));

export function startDownloadPipelineWorker() {
  for (const consumer of pipelineConsumers) consumer.start();
}
export async function stopDownloadPipelineWorker() {
  await Promise.all(pipelineConsumers.map((consumer) => consumer.stop()));
}
export function isDownloadPipelineWorkerRunning() {
  return pipelineConsumers.some((consumer) => consumer.isRunning());
}
