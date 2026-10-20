import { useEffect, useState } from "react";
import {
  getDownloadWorkerSettings,
  getDownloadRuntimeStatus,
  applyRuntimeSetting,
  updateDownloadWorkerSettings,
  testDownloadClientConnection,
} from "../../../utils/api/endpoints/settings.js";

import { Plus, RefreshCw, Trash2, Wrench } from "lucide-react";
import { DotLoader } from "../../../components/DotLoader";
import DownloadFolderField from "../../../components/DownloadFolderField";
import { IntegrationCard, SettingsIntegrationModal } from "./SettingsIntegrationCards";
import { SettingsAdapterFields } from "./SettingsAdapterFields";
import { SettingsArrFieldSet, SettingsArrFormGroup } from "./arr/SettingsArrLayout";
import { SettingsInput } from "./SettingsField";
import { RootOverlapWarning } from "./RootOverlapWarning";
import { getProviderStatus } from "../utils/integrationStatus";
import { PATH_MAPPING_SOURCE_OPTIONS, PathMappingModal } from "./PathMappingModal";
import { QUALITY_TIER_LABELS, QualityProfileModal } from "./QualityProfileModal";

const PATH_MAPPING_SOURCE_VALUES = new Set(
  PATH_MAPPING_SOURCE_OPTIONS.map((option) => option.value),
);

function normalizePathMappingSource(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return PATH_MAPPING_SOURCE_VALUES.has(normalized) ? normalized : "all";
}

function coercePathMappings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    source: normalizePathMappingSource(entry?.source),
    remote: String(entry?.remote || "").trim(),
    local: String(entry?.local || "").trim(),
  }));
}

function sourceLabel(source) {
  return PATH_MAPPING_SOURCE_OPTIONS.find((option) => option.value === source)?.label || source;
}

function isClientEnabled(definition, config) {
  return definition.enabledDefault === true ? config.enabled !== false : config.enabled === true;
}

function isClientConfigured(definition, config, health) {
  if (definition.healthKey) return health?.[definition.healthKey] === true;
  return (definition.validation?.required || []).every((key) => String(config[key] || "").trim());
}

function missingRequiredFields(definition, config) {
  return (definition.validation?.required || [])
    .filter((key) => !String(config[key] || "").trim())
    .map((key) => definition.fields.find((field) => field.key === key)?.label || key);
}

function clientMeta(definition, config) {
  const priorityField = definition.fields.find((field) => field.key === "priority");
  if (!priorityField) return null;
  const priority = config.priority ?? definition.defaults?.priority;
  return priority == null ? null : `Priority ${priority}`;
}

const QUALITY_PROFILE_MODAL = "quality-profile";
const ADD_CLIENT_MODAL = "add-client";

export function SettingsDownloadClientsSection({
  settings,
  downloadClientSettings,
  updateSettings,
  health,
  handleSaveSettings,
  showSuccess,
  showError,
  showInfo,
}) {
  const [workerConcurrency, setWorkerConcurrency] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const [schedulerNotice, setSchedulerNotice] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const [workerDraft, setWorkerDraft] = useState(3);
  const [workerSaving, setWorkerSaving] = useState(false);
  const [workerError, setWorkerError] = useState("");
  const [activeModal, setActiveModal] = useState(null);
  const [testingClient, setTestingClient] = useState(null);
  const [testStatus, setTestStatus] = useState(null);
  const [mappingModal, setMappingModal] = useState(null);

  useEffect(() => {
    setTestStatus(null);
  }, [activeModal]);

  useEffect(() => {
    let cancelled = false;
    getDownloadWorkerSettings()
      .then((result) => {
        if (cancelled) return;
        const value = Number(result?.concurrency);
        if (Number.isInteger(value) && value >= 1 && value <= 10) {
          setWorkerConcurrency(value);
          setWorkerDraft(value);
        } else {
          setWorkerError("Worker setting is unavailable.");
        }
      })
      .catch(() => {
        if (!cancelled) setWorkerError("Worker settings require an administrator account.");
      });
    return () => { cancelled = true; };
  }, []);

  const refreshRuntime = async () => {
    try {
      const [status, worker] = await Promise.all([getDownloadRuntimeStatus(), getDownloadWorkerSettings()]);
      setRuntime(status);
      setRuntimeError("");
      const value = Number(worker?.concurrency);
      if (Number.isInteger(value) && value >= 1 && value <= 10) {
        setWorkerConcurrency(value);
        setWorkerDraft(value);
      } else {
        setRuntimeError("Could not verify saved worker concurrency.");
      }
    } catch (error) {
      setRuntimeError(error?.message || "Could not read running configuration.");
    }
  };

  useEffect(() => { refreshRuntime(); }, []);

  const changeScheduler = async () => {
    if (!runtime?.controlAvailable || schedulerBusy) return;
    const enabled = !runtime.flags.providerScheduler;
    if (!window.confirm("Change scheduler mode? Active downloads may restart.")) return;
    setSchedulerBusy(true);
    setSchedulerNotice("");
    try {
      await applyRuntimeSetting("scheduler", enabled);
      setSchedulerNotice("Change requested. Refresh after the service restarts to verify running state.");
    } catch (error) {
      setSchedulerNotice(error?.response?.data?.error || error?.message || "Could not apply change.");
    } finally { setSchedulerBusy(false); }
  };

  const saveWorkerConcurrency = async () => {
    if (!Number.isInteger(workerDraft) || workerDraft < 1 || workerDraft > 10) return;
    setWorkerSaving(true);
    setWorkerError("");
    try {
      const result = await updateDownloadWorkerSettings(workerDraft);
      const saved = Number(result?.settings?.concurrency);
      if (saved !== workerDraft) throw new Error("Worker rejected the requested concurrency.");
      const verified = await getDownloadWorkerSettings();
      if (Number(verified?.concurrency) !== saved) throw new Error("Saved concurrency did not match server readback.");
      setWorkerConcurrency(saved);
      await refreshRuntime();
      showSuccess(`Aurral download concurrency set to ${saved}.`);
    } catch (error) {
      const message = error.response?.data?.message || error.response?.data?.error || error.message || "Could not update concurrency.";
      setWorkerError(message);
      showError(message);
    } finally {
      setWorkerSaving(false);
    }
  };

  const integrations = settings.integrations || {};
  const pathMappings = coercePathMappings(settings.pathMappings).filter(
    (entry) => entry.remote || entry.local,
  );
  const qualityProfile = settings.qualityProfile || {};
  const qualityOrder = Array.isArray(qualityProfile.order)
    ? qualityProfile.order
    : Object.keys(QUALITY_TIER_LABELS);
  const qualityEnabled = new Set(
    Array.isArray(qualityProfile.enabled) ? qualityProfile.enabled : qualityOrder,
  );
  const missingTrackSearch = settings.missingTrackSearch || {};
  const clientDefinitions = downloadClientSettings
    ? Object.values(downloadClientSettings)
    : [];
  const enabledClientDefinitions = clientDefinitions.filter((definition) =>
    isClientEnabled(definition, integrations[definition.key] || {}),
  );
  const availableClientDefinitions = clientDefinitions.filter(
    (definition) => !isClientEnabled(definition, integrations[definition.key] || {}),
  );
  const activeClient = downloadClientSettings?.[activeModal] || null;

  const updateIntegration = (key, patch) => {
    setTestStatus(null);
    updateSettings({
      ...settings,
      integrations: {
        ...settings.integrations,
        [key]: {
          ...(settings.integrations?.[key] || {}),
          ...patch,
        },
      },
    });
  };

  const addClient = (definition) => {
    updateIntegration(definition.key, { enabled: true });
    setActiveModal(definition.key);
  };

  const updatePathMappings = (nextMappings) => {
    updateSettings({
      ...settings,
      pathMappings: coercePathMappings(nextMappings),
    });
  };

  const updateQualityProfile = (patch) => {
    updateSettings({
      ...settings,
      qualityProfile: { ...qualityProfile, ...patch },
    });
  };

  const updateMissingTrackSearch = (patch) => {
    updateSettings({
      ...settings,
      missingTrackSearch: { ...missingTrackSearch, ...patch },
    });
  };

  const openAddMapping = () => {
    setMappingModal({ mode: "add", index: null });
  };

  const openEditMapping = (index) => {
    setMappingModal({ mode: "edit", index });
  };

  const closeMappingModal = () => {
    setMappingModal(null);
  };

  const saveMapping = (mapping) => {
    if (mappingModal?.mode === "edit" && mappingModal.index != null) {
      const nextMappings = [...pathMappings];
      nextMappings[mappingModal.index] = mapping;
      updatePathMappings(nextMappings);
    } else {
      updatePathMappings([...pathMappings, mapping]);
    }
    closeMappingModal();
  };

  const deleteMapping = (index) => {
    updatePathMappings(pathMappings.filter((_entry, entryIndex) => entryIndex !== index));
  };

  const handleTestClient = async (definition) => {
    const config = integrations[definition.key] || {};
    const missing = missingRequiredFields(definition, config);
    if (definition.testRequiresEnabled && !isClientEnabled(definition, config)) {
      const message = `Enable ${definition.label} and enter its required settings first.`;
      setTestStatus({ tone: "error", message });
      showError(message);
      return;
    }
    if (missing.length > 0) {
      const message = `Enter ${missing.join(" and ")} first.`;
      setTestStatus({ tone: "error", message });
      showError(message);
      return;
    }

    setTestStatus(null);
    setTestingClient(definition.key);
    try {
      const saved = await handleSaveSettings();
      if (saved === false) return;
      const result = await testDownloadClientConnection(definition.key, config);
      if (result.success || result.ok) {
        if (result.warning || result.soulseekConnected === false) {
          const warning =
            result.message || `${definition.label} is reachable, but its service is not connected`;
          setTestStatus({ tone: "warning", message: warning });
          showInfo(warning);
        } else {
          setTestStatus({ tone: "success", message: "Connected." });
          showSuccess(result.message || `${definition.label} connection OK`);
        }
      } else {
        const message = result.message || `${definition.label} connection failed`;
        setTestStatus({ tone: "error", message });
        showError(message);
      }
    } catch (error) {
      const message =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        `${definition.label} connection failed`;
      setTestStatus({ tone: "error", message });
      showError(message);
    } finally {
      setTestingClient(null);
    }
  };

  return (
    <>
      <div className="settings-page__section">
        <div className="settings-page__integration-card-grid">
          {clientDefinitions.length > 0 ? (
            enabledClientDefinitions.map((definition) => {
              const config = integrations[definition.key] || {};
              return (
                <IntegrationCard
                  key={definition.key}
                  title={definition.label}
                  subtitle={definition.subtitle}
                  status={getProviderStatus(
                    true,
                    isClientConfigured(definition, config, health),
                  )}
                  meta={clientMeta(definition, config)}
                  onClick={() => setActiveModal(definition.key)}
                />
              );
            })
          ) : (
            <div className="arr-info">
              {downloadClientSettings
                ? "No download clients are available."
                : "Download client settings are unavailable. Refresh the page to retry."}
            </div>
          )}
          {availableClientDefinitions.length > 0 ? (
            <button
              type="button"
              className="download-client-add"
              aria-label="Add download client"
              onClick={() => setActiveModal(ADD_CLIENT_MODAL)}
            >
              <Plus aria-hidden />
            </button>
          ) : null}
        </div>
      </div>

      <SettingsArrFieldSet legend="Running download scheduler">
        <div className="arr-info" role="status">
          {runtime ? (
            <>
              <p><strong>Scheduler:</strong> {runtime.flags.providerScheduler ? "Provider scheduler ACTIVE" : "Legacy mode"}</p>
              <p><strong>Acquisition:</strong> {runtime.flags.acquisitionPaused ? "PAUSED — no new downloads" : "Active"}</p>
              <p><strong>Legacy pipeline consumers:</strong> {runtime.flags.pipelineConsumers}{runtime.flags.providerScheduler ? " (not used in scheduler mode)" : ""}</p>
              <p><strong>Provider capacity:</strong> {(runtime.scheduler?.providers || []).filter((p) => p.enabled).map((p) => `${p.id}: ${p.active}/${p.maxActive}`).join(" · ") || "Unavailable"}</p>
              <small>Observed: {runtime.observedAt}. Values reflect the running server, not a pending settings change.</small>
            </>
          ) : <p>Running settings not yet verified.</p>}
          {runtimeError ? <p role="alert">{runtimeError}</p> : null}
          <button type="button" className="btn btn-secondary" onClick={refreshRuntime}>Refresh running settings</button>
          <button type="button" className="btn btn-secondary" disabled={!runtime?.controlAvailable || schedulerBusy} onClick={changeScheduler}>
            {schedulerBusy ? "Applying..." : runtime?.flags?.providerScheduler ? "Disable provider scheduler" : "Enable provider scheduler"}
          </button>
          {!runtime?.controlAvailable && <p>Service control is not installed.</p>}
          {schedulerNotice && <p role="status">{schedulerNotice}</p>
        </div>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Download concurrency">
        <SettingsArrFormGroup
          label="Simultaneous Aurral jobs"
          labelFor="download-clients-concurrency"
          help="Controls how many tracks Aurral searches/processes concurrently across providers; not the transfer limits inside SABnzbd or slskd. Normal: 2-3. Higher: 4-10 for bulk imports (watch provider load and worker restarts)."
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <SettingsInput
              id="download-clients-concurrency"
              type="number"
              min={1}
              max={10}
              step={1}
              disabled={workerConcurrency == null || workerSaving}
              value={workerDraft}
              onChange={(event) => setWorkerDraft(Number(event.target.value))}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={workerConcurrency == null || workerSaving || workerDraft === workerConcurrency || !Number.isInteger(workerDraft) || workerDraft < 1 || workerDraft > 10}
              onClick={saveWorkerConcurrency}
            >
              {workerSaving ? "Applying..." : "Apply"}
            </button>
            {workerConcurrency != null ? <span>Current: {workerConcurrency}</span> : null}
          </div>
          {workerError ? <p role="alert">{workerError}</p> : null}
        </SettingsArrFormGroup>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Provider capacity (scheduler test mode)">
        <div className="arr-info">
          When AURRAL_PROVIDER_SCHEDULER=1, each enabled provider has independent
          download slots. Save settings after editing. Scheduler mode must be
          validated in an isolated instance before production activation.
        </div>
        {enabledClientDefinitions.map((definition) => {
          const config = integrations[definition.key] || {};
          const fallback = definition.key === "dmm" ? 1
            : ["nzbget", "sabnzbd", "deemix"].includes(definition.key) ? 2 : 3;
          return (
            <SettingsArrFormGroup
              key={definition.key}
              label={`${definition.label} simultaneous jobs`}
              labelFor={`provider-capacity-${definition.key}`}
              help="Maximum active Aurral attempts assigned to this download client."
            >
              <SettingsInput
                id={`provider-capacity-${definition.key}`}
                type="number"
                min={1}
                max={8}
                step={1}
                value={config.maxActive ?? fallback}
                onChange={(event) => {
                  const number = Number(event.target.value);
                  updateIntegration(definition.key, {
                    maxActive: Number.isFinite(number) ? Math.min(8, Math.max(1, Math.trunc(number))) : fallback,
                  });
                }}
              />
            </SettingsArrFormGroup>
          );
        })}
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Quality profile">
        <div className="arr-info">
          Choose formats, order, upgrades, and searches for missing tracks.
        </div>
        <IntegrationCard
          title="Default"
          subtitle={`${qualityEnabled.size} qualities allowed`}
          status={{ label: "Configured", className: "is-enabled" }}
          meta={`Cutoff ${QUALITY_TIER_LABELS[qualityProfile.cutoff] || "not set"}`}
          onClick={() => setActiveModal(QUALITY_PROFILE_MODAL)}
        />
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Downloads folder">
        <RootOverlapWarning rootWarnings={settings.rootWarnings} />
        <SettingsArrFormGroup
          label="Path"
          labelFor="download-clients-download-folder"
          help="Where Aurral keeps the music it adds, including flow tracks. Example: /data/downloads/aurral"
        >
          <DownloadFolderField
            id="download-clients-download-folder"
            value={settings.downloadFolderPath || ""}
            autoApplySuggestion={false}
            onChange={(nextPath) =>
              updateSettings({
                ...settings,
                downloadFolderPath: nextPath,
              })
            }
          />
        </SettingsArrFormGroup>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Review queue">
        <SettingsArrFormGroup
          label="Maximum wait (hours)"
          labelFor="download-clients-review-timeout"
          help="Songs held for review longer than this are denied, and Aurral searches for them again. 0 keeps them until you decide."
        >
          <SettingsInput
            id="download-clients-review-timeout"
            type="number"
            min={0}
            max={720}
            step={1}
            value={settings.reviewTimeoutHours ?? 0}
            onChange={(event) => {
              const raw = Number(event.target.value);
              updateSettings({
                ...settings,
                reviewTimeoutHours: Number.isFinite(raw)
                  ? Math.max(0, Math.min(720, Math.floor(raw)))
                  : 0,
              });
            }}
          />
        </SettingsArrFormGroup>
      </SettingsArrFieldSet>

      <SettingsArrFieldSet legend="Remote path mappings">
        <div className="arr-info">
          Only needed when client and Aurral paths differ. Shared mounts need no mapping.
        </div>

        <div className="arr-table-wrap">
          <table className="arr-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Remote path</th>
                <th scope="col">Local path</th>
                <th scope="col" className="arr-table__actions-head">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pathMappings.length === 0 ? (
                <tr className="arr-table__empty-row">
                  <td colSpan={4}>No path mappings configured.</td>
                </tr>
              ) : (
                pathMappings.map((mapping, index) => (
                  <tr key={`path-mapping-${index}`}>
                    <td>{sourceLabel(mapping.source)}</td>
                    <td>
                      <code className="arr-table__path">{mapping.remote}</code>
                    </td>
                    <td>
                      <code className="arr-table__path">{mapping.local}</code>
                    </td>
                    <td className="arr-table__actions">
                      <div className="arr-table__actions-inner">
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          aria-label={`Edit path mapping ${index + 1}`}
                          onClick={() => openEditMapping(index)}
                        >
                          <Wrench className="artist-icon-sm" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="arr-btn arr-btn--ghost arr-btn--icon"
                          aria-label={`Delete path mapping ${index + 1}`}
                          onClick={() => deleteMapping(index)}
                        >
                          <Trash2 className="artist-icon-sm" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="arr-table-footer">
          <button
            type="button"
            className="arr-btn arr-btn--ghost arr-btn--icon"
            aria-label="Add path mapping"
            onClick={openAddMapping}
          >
            <Plus className="artist-icon-sm" aria-hidden />
          </button>
        </div>
      </SettingsArrFieldSet>

      {mappingModal ? (
        <PathMappingModal
          title={
            mappingModal.mode === "edit" ? "Edit remote path mapping" : "Add remote path mapping"
          }
          initialValue={
            mappingModal.mode === "edit" && mappingModal.index != null
              ? pathMappings[mappingModal.index]
              : undefined
          }
          onClose={closeMappingModal}
          onSave={saveMapping}
        />
      ) : null}

      {activeModal === ADD_CLIENT_MODAL ? (
        <SettingsIntegrationModal
          title="Add download client"
          wide={false}
          onClose={() => setActiveModal(null)}
        >
          <div className="download-client-picker">
            <p className="download-client-picker__intro">
              Choose a client to add and configure.
            </p>
            <div className="download-client-picker__list">
              {availableClientDefinitions.map((definition) => (
                <button
                  key={definition.key}
                  type="button"
                  className="download-client-picker__option"
                  onClick={() => addClient(definition)}
                >
                  <span className="download-client-picker__copy">
                    <span className="download-client-picker__name">{definition.label}</span>
                    {definition.subtitle ? (
                      <span className="download-client-picker__subtitle">
                        {definition.subtitle}
                      </span>
                    ) : null}
                  </span>
                  <Plus className="artist-icon-sm" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        </SettingsIntegrationModal>
      ) : null}

      {activeModal === QUALITY_PROFILE_MODAL && (
        <QualityProfileModal
          profile={{ ...qualityProfile, order: qualityOrder, enabled: [...qualityEnabled] }}
          onChange={updateQualityProfile}
          missingTrackSearch={missingTrackSearch}
          onMissingTrackSearchChange={updateMissingTrackSearch}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeClient ? (
        <SettingsIntegrationModal
          title={activeClient.label}
          onClose={() => setActiveModal(null)}
          testStatus={testStatus}
          footerActions={
            <button
              type="button"
              className="btn btn-secondary"
              disabled={testingClient === activeClient.key}
              onClick={() => handleTestClient(activeClient)}
            >
              {testingClient === activeClient.key ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <RefreshCw className="artist-icon-sm" aria-hidden />
              )}
              {testingClient === activeClient.key ? "Testing..." : "Test connection"}
            </button>
          }
        >
          <SettingsAdapterFields
            key={activeClient.key}
            definition={activeClient}
            settings={integrations[activeClient.key] || {}}
            onChange={(patch) => updateIntegration(activeClient.key, patch)}
          />
        </SettingsIntegrationModal>
      ) : null}
    </>
  );
}
