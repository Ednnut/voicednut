import { useEffect, useMemo, useState } from 'react';
import { Cell, Navigation } from '@telegram-apps/telegram-ui';

import type { CallScriptRow, DashboardVm } from './types';
import { selectScriptStudioPageVm } from './vmSelectors';
import {
  CALL_AGENT_LANGUAGE_OPTIONS,
  CALL_AGENT_LISTEN_MODEL_OPTIONS,
  CALL_AGENT_THINK_MODEL_OPTIONS,
  CALL_FALLBACK_VOICE_MODELS,
} from '@/shared/callVoiceModels';
import { Link } from '@/components/Link/Link.tsx';
import { AdminPageIntro } from '@/components/admin-dashboard/AdminPageIntro';
import { DashboardWorkflowContractCard } from '@/components/admin-dashboard/DashboardWorkflowContractCard';
import { useDashboardHaptic } from '@/hooks/admin-dashboard/useDashboardHaptic';
import {
  UiActionBar,
  UiBadge,
  UiButton,
  UiCard,
  UiDisclosure,
  UiInput,
  UiSelect,
  UiStatePanel,
  UiTextarea,
  UiWorkspacePulse,
} from '@/components/ui/AdminPrimitives';
import {
  DASHBOARD_ACTION_CONTRACTS,
  DASHBOARD_MODULE_ROUTE_CONTRACTS,
  MINIAPP_COMMAND_ROUTE_CONTRACTS,
} from '@/contracts/miniappParityContracts';

type ScriptStudioPageProps = {
  visible: boolean;
  vm: DashboardVm;
  initialLane?: ScriptStudioLane;
};

type SmsScriptRow = {
  name?: unknown;
  description?: unknown;
  content?: unknown;
  is_builtin?: unknown;
  lifecycle_state?: unknown;
};

type EmailTemplateRow = {
  template_id?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
  lifecycle_state?: unknown;
};

type ScriptStudioLane = 'call' | 'sms' | 'email';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asRecord(entry));
}

function formatVersionDiffValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const safeText = serialized || '(unavailable)';
  return safeText.length > 1200 ? `${safeText.slice(0, 1200)}… [truncated]` : safeText;
}

function toTexts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

const CALL_E_DISPATCH_BLOCKER_LABELS: Record<string, string> = {
  dispatch_kill_switch_disabled: 'The independent dispatch kill switch is disabled',
  exact_preview_pilot_approval_missing_or_expired: 'No current approval is configured for this exact preview',
  pilot_external_readiness_review_required: 'Account, destination, consent, and recovery reviews have not been attested',
};

function toLifecycleTone(value: unknown): 'info' | 'success' | 'warning' | 'error' {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value).trim().toLowerCase()
      : '';
  if (!normalized) return 'info';
  if (normalized.includes('live') || normalized.includes('active')) return 'success';
  if (normalized.includes('review') || normalized.includes('submitted') || normalized.includes('pending')) {
    return 'warning';
  }
  if (normalized.includes('reject') || normalized.includes('error') || normalized.includes('blocked')) {
    return 'error';
  }
  return 'info';
}

function toCallerFlagTone(value: unknown): 'info' | 'success' | 'warning' | 'error' {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value).trim().toLowerCase()
      : '';
  if (!normalized) return 'info';
  if (normalized.includes('allow')) return 'success';
  if (normalized.includes('spam')) return 'warning';
  if (normalized.includes('block')) return 'error';
  return 'info';
}

export function ScriptStudioPage({ visible, vm, initialLane = 'call' }: ScriptStudioPageProps) {
  if (!visible) return null;

  const { triggerHaptic } = useDashboardHaptic();

  const {
    scriptFlowFilter,
    setScriptFlowFilter,
    refreshCallScriptsModule,
    callScriptsTotal,
    callScripts,
    toInt,
    toText,
    selectedCallScriptId,
    setSelectedCallScriptId,
    selectedCallScript,
    selectedCallScriptLifecycleState,
    selectedCallScriptLifecycle,
    formatTime,
    scriptNameInput,
    setScriptNameInput,
    scriptDefaultProfileInput,
    setScriptDefaultProfileInput,
    scriptDescriptionInput,
    setScriptDescriptionInput,
    scriptPromptInput,
    setScriptPromptInput,
    scriptFirstMessageInput,
    setScriptFirstMessageInput,
    scriptObjectiveTagsInput,
    setScriptObjectiveTagsInput,
    busyAction,
    saveCallScriptDraft,
    submitCallScriptForReview,
    scriptReviewNoteInput,
    setScriptReviewNoteInput,
    reviewCallScript,
    promoteCallScriptLive,
    scriptSimulationVariablesInput,
    setScriptSimulationVariablesInput,
    simulateCallScript,
    scriptSimulationResult,
    runAction,
    invokeAction,
  } = selectScriptStudioPageVm(vm);

  const [studioBusy, setStudioBusy] = useState<string>('');
  const [studioError, setStudioError] = useState<string>('');
  const [agentRuntimeConfigInput, setAgentRuntimeConfigInput] = useState<string>('');
  const [scriptVoiceModelInput, setScriptVoiceModelInput] = useState<string>('');
  const [voiceAgentSettingsEnabled, setVoiceAgentSettingsEnabled] = useState(false);
  const [voiceAgentLanguage, setVoiceAgentLanguage] = useState('en');
  const [voiceAgentListenModel, setVoiceAgentListenModel] = useState('nova-2');
  const [voiceAgentThinkProvider, setVoiceAgentThinkProvider] = useState('open_ai');
  const [voiceAgentThinkModel, setVoiceAgentThinkModel] = useState('gpt-4o-mini');
  const [smsScripts, setSmsScripts] = useState<SmsScriptRow[]>([]);
  const [selectedSmsScriptName, setSelectedSmsScriptName] = useState<string>('');
  const [smsScriptDescriptionInput, setSmsScriptDescriptionInput] = useState<string>('');
  const [smsScriptContentInput, setSmsScriptContentInput] = useState<string>('');
  const [smsScriptCreateName, setSmsScriptCreateName] = useState<string>('');
  const [smsScriptCreateContent, setSmsScriptCreateContent] = useState<string>('');
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplateRow[]>([]);
  const [selectedEmailTemplateId, setSelectedEmailTemplateId] = useState<string>('');
  const [emailTemplateSubjectInput, setEmailTemplateSubjectInput] = useState<string>('');
  const [emailTemplateHtmlInput, setEmailTemplateHtmlInput] = useState<string>('');
  const [emailTemplateTextInput, setEmailTemplateTextInput] = useState<string>('');
  const [emailTemplateCreateId, setEmailTemplateCreateId] = useState<string>('');
  const [emailTemplateCreateSubject, setEmailTemplateCreateSubject] = useState<string>('');
  const [emailTemplateCreateText, setEmailTemplateCreateText] = useState<string>('');
  const [activeScriptStudioLane, setActiveScriptStudioLane] = useState<ScriptStudioLane>(initialLane);
  const [callerFlags, setCallerFlags] = useState<Array<Record<string, unknown>>>([]);
  const [callerFlagsStatusFilter, setCallerFlagsStatusFilter] = useState<string>('all');
  const [callerFlagPhoneInput, setCallerFlagPhoneInput] = useState<string>('');
  const [callerFlagStatusInput, setCallerFlagStatusInput] = useState<string>('blocked');
  const [callerFlagNoteInput, setCallerFlagNoteInput] = useState<string>('');
  const [callEPhoneInput, setCallEPhoneInput] = useState<string>('');
  const [callEResultSchemaInput, setCallEResultSchemaInput] = useState<string>(JSON.stringify({
    type: 'object', additionalProperties: false, required: ['outcome'],
    properties: { outcome: { type: 'string', description: 'Verified call outcome' } },
  }, null, 2));
  const [callEDeploymentStatus, setCallEDeploymentStatus] = useState<Record<string, unknown> | null>(null);
  const [callEPreview, setCallEPreview] = useState<Record<string, unknown> | null>(null);
  const [callEConfirmation, setCallEConfirmation] = useState<Record<string, unknown> | null>(null);
  const [callELocalIdInput, setCallELocalIdInput] = useState<string>('');
  const [callEReconciliation, setCallEReconciliation] = useState<Record<string, unknown> | null>(null);
  const [callEReview, setCallEReview] = useState<Record<string, unknown> | null>(null);
  const [personaBuiltin, setPersonaBuiltin] = useState<Array<Record<string, unknown>>>([]);
  const [personaCustom, setPersonaCustom] = useState<Array<Record<string, unknown>>>([]);
  const [callScriptVersions, setCallScriptVersions] = useState<Array<Record<string, unknown>>>([]);
  const [selectedRollbackVersion, setSelectedRollbackVersion] = useState('');
  const [selectedDiffFromVersion, setSelectedDiffFromVersion] = useState('');
  const [selectedDiffToVersion, setSelectedDiffToVersion] = useState('');
  const [callScriptVersionDiff, setCallScriptVersionDiff] = useState<Record<string, unknown> | null>(null);
  const [restoreNotice, setRestoreNotice] = useState('');

  const selectedSmsScript = useMemo(() => (
    smsScripts.find((script) => toText(script.name, '') === selectedSmsScriptName) || null
  ), [selectedSmsScriptName, smsScripts, toText]);
  const selectedEmailTemplate = useMemo(() => (
    emailTemplates.find((template) => toText(template.template_id, '') === selectedEmailTemplateId) || null
  ), [emailTemplates, selectedEmailTemplateId, toText]);

  useEffect(() => {
    setCallEPreview(null);
    setCallEConfirmation(null);
    setCallScriptVersions([]);
    setSelectedRollbackVersion('');
    setSelectedDiffFromVersion('');
    setSelectedDiffToVersion('');
    setCallScriptVersionDiff(null);
    setRestoreNotice('');
  }, [selectedCallScriptId]);

  useEffect(() => {
    if (!selectedCallScript) {
      setAgentRuntimeConfigInput('');
      setScriptVoiceModelInput('');
      setVoiceAgentSettingsEnabled(false);
      return;
    }
    const config = asRecord(selectedCallScript.agent_config);
    setAgentRuntimeConfigInput(Object.keys(config).length > 0 ? JSON.stringify(config, null, 2) : '');
    const voiceModel = toText(selectedCallScript.voice_model, '');
    setScriptVoiceModelInput(voiceModel);
    const voiceSettings = asRecord(config.voice_agent_settings);
    const language = toText(voiceSettings.language, voiceModel.endsWith('-es') ? 'es' : 'en');
    const thinkProvider = toText(voiceSettings.think_provider, 'open_ai');
    setVoiceAgentSettingsEnabled(Object.keys(voiceSettings).length > 0 || voiceModel.endsWith('-es'));
    setVoiceAgentLanguage(language);
    setVoiceAgentListenModel(toText(voiceSettings.listen_model, language === 'es' ? 'flux-general-multi' : 'nova-2'));
    setVoiceAgentThinkProvider(thinkProvider);
    setVoiceAgentThinkModel(toText(voiceSettings.think_model, 'gpt-4o-mini'));
  }, [selectedCallScript]);

  useEffect(() => {
    if (!selectedSmsScript) return;
    setSmsScriptDescriptionInput(toText(selectedSmsScript.description, ''));
    setSmsScriptContentInput(toText(selectedSmsScript.content, ''));
  }, [selectedSmsScript, toText]);

  useEffect(() => {
    if (!selectedEmailTemplate) return;
    setEmailTemplateSubjectInput(toText(selectedEmailTemplate.subject, ''));
    setEmailTemplateHtmlInput(toText(selectedEmailTemplate.html, ''));
    setEmailTemplateTextInput(toText(selectedEmailTemplate.text, ''));
  }, [selectedEmailTemplate, toText]);

  const executeStudioAction = async (
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    setStudioBusy(action);
    setStudioError('');
    try {
      const data = await invokeAction(action, payload);
      return asRecord(data);
    } catch (error) {
      setStudioError(error instanceof Error ? error.message : String(error));
      return {};
    } finally {
      setStudioBusy('');
    }
  };

  const loadCallScriptVersions = async (): Promise<void> => {
    if (selectedCallScriptId <= 0) return;
    const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_VERSIONS, {
      id: selectedCallScriptId,
    });
    const versions = toRows(data.versions);
    setCallScriptVersions(versions);
    setSelectedRollbackVersion(versions.length > 0 ? String(toInt(versions[0].version, 0)) : '');
    setSelectedDiffFromVersion(versions.length > 0 ? String(toInt(versions[0].version, 0)) : '');
    setSelectedDiffToVersion(versions.length > 1 ? String(toInt(versions[1].version, 0)) : '');
    setCallScriptVersionDiff(null);
  };

  const compareCallScriptVersions = async (): Promise<void> => {
    const fromVersion = Number(selectedDiffFromVersion);
    const toVersion = Number(selectedDiffToVersion);
    if (selectedCallScriptId <= 0 || !Number.isSafeInteger(fromVersion) || !Number.isSafeInteger(toVersion) || fromVersion <= 0 || toVersion <= 0 || fromVersion === toVersion) return;
    const result = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_DIFF, {
      id: selectedCallScriptId,
      from_version: fromVersion,
      to_version: toVersion,
    });
    if (result.success === true) setCallScriptVersionDiff(result);
  };

  const restoreCallScriptVersion = (): void => {
    const version = Number(selectedRollbackVersion);
    if (selectedCallScriptId <= 0 || !Number.isSafeInteger(version) || version <= 0) return;
    if (!window.confirm(`Restore agent definition version ${version} as a new draft? It will not become live automatically.`)) return;
    void (async () => {
      const result = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_ROLLBACK, {
        id: selectedCallScriptId,
        version,
      });
      if (result.success !== true) return;
      setRestoreNotice(`Version ${version} was restored as a new draft version.`);
      await refreshCallScriptsModule();
      await loadCallScriptVersions();
    })();
  };

  const saveCallScriptWithRuntimeConfig = (): void => {
    let agentConfig: Record<string, unknown> | null = null;
    if (agentRuntimeConfigInput.trim()) {
      try {
        const parsed: unknown = JSON.parse(agentRuntimeConfigInput);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setStudioError('Agent runtime configuration must be a JSON object.');
          return;
        }
        agentConfig = parsed as Record<string, unknown>;
      } catch {
        setStudioError('Agent runtime configuration must be valid JSON.');
        return;
      }
    }
    const currentVoiceModel = toText(selectedCallScript?.voice_model, '');
    const voiceModelUpdate = currentVoiceModel === scriptVoiceModelInput
      ? undefined
      : scriptVoiceModelInput || null;
    if (voiceAgentSettingsEnabled) {
      agentConfig = {
        ...(agentConfig || {}),
        schema_version: 6,
        voice_agent_settings: {
          language: voiceAgentLanguage,
          listen_model: voiceAgentListenModel,
          think_provider: voiceAgentThinkProvider,
          think_model: voiceAgentThinkModel,
        },
      };
    } else if (agentConfig?.voice_agent_settings !== undefined) {
      delete agentConfig.voice_agent_settings;
      if (Object.keys(agentConfig).every((key) => key === 'schema_version')) {
        agentConfig = null;
      }
    }
    void saveCallScriptDraft(agentConfig, voiceModelUpdate);
  };

  const loadSmsScripts = async (): Promise<void> => {
    const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_LIST, {
      include_builtins: true,
      detailed: true,
    });
    const customRows = toRows(data.scripts);
    const builtinRows = toRows(data.builtin);
    const merged = [...customRows, ...builtinRows] as SmsScriptRow[];
    setSmsScripts(merged);
    setSelectedSmsScriptName((current) => {
      if (merged.length === 0) return '';
      const currentExists = merged.some((script) => toText(script.name, '') === current);
      return currentExists ? current : toText(merged[0].name, '');
    });
  };

  const loadEmailTemplates = async (): Promise<void> => {
    const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_LIST, { limit: 120 });
    const rows = toRows(data.templates) as EmailTemplateRow[];
    setEmailTemplates(rows);
    setSelectedEmailTemplateId((current) => {
      if (rows.length === 0) return '';
      const currentExists = rows.some((template) => toText(template.template_id, '') === current);
      return currentExists ? current : toText(rows[0].template_id, '');
    });
  };

  const loadCallerFlags = async (): Promise<void> => {
    const status = callerFlagsStatusFilter === 'all' ? undefined : callerFlagsStatusFilter;
    const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLERFLAGS_LIST, {
      status,
      limit: 120,
    });
    setCallerFlags(toRows(data.flags));
  };

  const loadPersonas = async (): Promise<void> => {
    const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.PERSONA_LIST, {});
    setPersonaBuiltin(toRows(data.builtin));
    setPersonaCustom(toRows(data.custom));
  };

  useEffect(() => {
    void loadSmsScripts();
    void loadEmailTemplates();
    void loadCallerFlags();
    void loadPersonas();
  }, []);

  useEffect(() => {
    setActiveScriptStudioLane(initialLane);
  }, [initialLane]);

  const activeScriptStudioLaneLabel = activeScriptStudioLane === 'call'
    ? 'Call scripts'
    : activeScriptStudioLane === 'sms'
      ? 'SMS scripts'
      : 'Email templates';
  const activeScriptStudioSelection = activeScriptStudioLane === 'call'
    ? (selectedCallScript ? toText(selectedCallScript.name, 'Unknown') : 'None')
    : activeScriptStudioLane === 'sms'
      ? (selectedSmsScriptName || 'None')
      : (selectedEmailTemplateId || 'None');
  const activeScriptStudioCount = activeScriptStudioLane === 'call'
    ? callScriptsTotal
    : activeScriptStudioLane === 'sms'
      ? smsScripts.length
      : emailTemplates.length;
  const pulseTone = studioError
    ? 'error'
    : busyAction.length > 0 || studioBusy.length > 0
      ? 'info'
      : activeScriptStudioSelection !== 'None'
        ? 'success'
        : 'neutral';
  const pulseStatus = studioError
    ? 'Needs attention'
    : busyAction.length > 0 || studioBusy.length > 0
      ? (busyAction || studioBusy || 'Refreshing')
      : activeScriptStudioSelection !== 'None'
        ? `Editing ${activeScriptStudioLaneLabel}`
        : `${activeScriptStudioLaneLabel} ready`;
  const totalPersonas = personaBuiltin.length + personaCustom.length;
  const selectedCallScriptLifecycleTone = toLifecycleTone(selectedCallScriptLifecycleState);

  const renderSmsScriptsCard = () => (
    <UiCard>
      <h3>SMS Scripts</h3>
      <p className="va-muted">Create, update, and maintain SMS script assets.</p>
      <div className="va-inline-tools">
        <UiButton
          variant="secondary"
          disabled={studioBusy.length > 0 || busyAction.length > 0}
          onClick={() => {
            triggerHaptic('impact', 'light');
            void loadSmsScripts();
          }}
        >
          Refresh SMS Scripts
        </UiButton>
        <UiInput
          placeholder="Create script name"
          value={smsScriptCreateName}
          onChange={(event) => setSmsScriptCreateName(event.target.value)}
        />
      </div>
      <UiTextarea
        placeholder="Create script content"
        value={smsScriptCreateContent}
        onChange={(event) => setSmsScriptCreateContent(event.target.value)}
        rows={3}
      />
      <div className="va-inline-tools">
        <UiButton
          variant="primary"
          disabled={
            studioBusy.length > 0
            || busyAction.length > 0
            || !smsScriptCreateName.trim()
            || !smsScriptCreateContent.trim()
          }
          onClick={() => {
            void runAction(
              DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_CREATE,
              {
                name: smsScriptCreateName.trim(),
                content: smsScriptCreateContent,
              },
              {
                successMessage: `Created SMS script "${smsScriptCreateName.trim()}"`,
                onSuccess: () => {
                  setSmsScriptCreateName('');
                  setSmsScriptCreateContent('');
                  void loadSmsScripts();
                },
              },
            );
          }}
        >
          Create SMS Script
        </UiButton>
      </div>
      {smsScripts.length === 0 ? (
        <UiStatePanel
          compact
          title="No SMS scripts found"
          description="Create a script or refresh to pull the latest content."
        />
      ) : (
        <ul className="va-list va-list-dense">
          {smsScripts.slice(0, 40).map((script, index) => {
            const scriptName = toText(script.name, `sms-script-${index + 1}`);
            const builtin = script.is_builtin === true;
            const active = scriptName === selectedSmsScriptName;
            return (
              <li key={`sms-script-row-${scriptName}`}>
                <strong>{scriptName}</strong>
                <span>
                  <UiBadge variant={toLifecycleTone(script.lifecycle_state)}>
                    {toText(script.lifecycle_state, builtin ? 'builtin' : 'draft')}
                  </UiBadge>
                </span>
                <span>
                  <UiBadge variant={builtin ? 'info' : 'meta'}>
                    {builtin ? 'Built-in (read-only)' : 'Custom'}
                  </UiBadge>
                </span>
                <UiButton
                  variant="chip"
                  className={active ? 'is-active' : ''}
                  onClick={() => {
                    triggerHaptic('selection');
                    setSelectedSmsScriptName(scriptName);
                  }}
                >
                  {active ? 'Selected' : 'Select'}
                </UiButton>
              </li>
            );
          })}
        </ul>
      )}
      {selectedSmsScript ? (
        <>
          <h4>SMS Script Editor</h4>
          {selectedSmsScript.is_builtin === true ? (
            <UiStatePanel
              compact
              title="Read-only built-in script"
              description="Clone this script into a custom entry if you need to modify the content."
              tone="info"
            />
          ) : null}
          <UiInput value={selectedSmsScriptName} disabled />
          <UiTextarea
            placeholder="Description"
            value={smsScriptDescriptionInput}
            onChange={(event) => setSmsScriptDescriptionInput(event.target.value)}
            rows={2}
            disabled={selectedSmsScript.is_builtin === true}
          />
          <UiTextarea
            placeholder="SMS script content"
            value={smsScriptContentInput}
            onChange={(event) => setSmsScriptContentInput(event.target.value)}
            rows={4}
            disabled={selectedSmsScript.is_builtin === true}
          />
          <div className="va-inline-tools">
            <UiButton
              variant="primary"
              disabled={
                studioBusy.length > 0
                || busyAction.length > 0
                || selectedSmsScript.is_builtin === true
                || !selectedSmsScriptName
              }
              onClick={() => {
                void runAction(
                  DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_UPDATE,
                  {
                    script_name: selectedSmsScriptName,
                    description: smsScriptDescriptionInput,
                    content: smsScriptContentInput,
                  },
                  {
                    successMessage: `Updated SMS script "${selectedSmsScriptName}"`,
                    onSuccess: () => {
                      void loadSmsScripts();
                    },
                  },
                );
              }}
            >
              Save SMS Script
            </UiButton>
            <UiButton
              variant="secondary"
              disabled={
                studioBusy.length > 0
                || busyAction.length > 0
                || selectedSmsScript.is_builtin === true
                || !selectedSmsScriptName
              }
              onClick={() => {
                void runAction(
                  DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_DELETE,
                  { script_name: selectedSmsScriptName },
                  {
                    confirmText: `Delete SMS script "${selectedSmsScriptName}"?`,
                    successMessage: `Deleted SMS script "${selectedSmsScriptName}"`,
                    onSuccess: () => {
                      void loadSmsScripts();
                    },
                  },
                );
              }}
            >
              Delete SMS Script
            </UiButton>
          </div>
        </>
      ) : null}
    </UiCard>
  );

  const renderEmailTemplatesCard = () => (
    <UiCard>
      <h3>Email Templates</h3>
      <p className="va-muted">Manage outbound email templates from the app.</p>
      <div className="va-inline-tools">
        <UiButton
          variant="secondary"
          disabled={studioBusy.length > 0}
          onClick={() => {
            triggerHaptic('impact', 'light');
            void loadEmailTemplates();
          }}
        >
          Refresh Templates
        </UiButton>
        <UiInput
          placeholder="Create template ID"
          value={emailTemplateCreateId}
          onChange={(event) => setEmailTemplateCreateId(event.target.value)}
        />
        <UiInput
          placeholder="Create subject"
          value={emailTemplateCreateSubject}
          onChange={(event) => setEmailTemplateCreateSubject(event.target.value)}
        />
      </div>
      <UiTextarea
        placeholder="Create plain-text body"
        value={emailTemplateCreateText}
        onChange={(event) => setEmailTemplateCreateText(event.target.value)}
        rows={3}
      />
      <UiButton
        variant="primary"
        disabled={
          studioBusy.length > 0
          || busyAction.length > 0
          || !emailTemplateCreateId.trim()
          || !emailTemplateCreateSubject.trim()
          || !emailTemplateCreateText.trim()
        }
        onClick={() => {
          void runAction(
            DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_CREATE,
            {
              template_id: emailTemplateCreateId.trim(),
              subject: emailTemplateCreateSubject.trim(),
              text: emailTemplateCreateText,
            },
            {
              successMessage: `Created template "${emailTemplateCreateId.trim()}"`,
              onSuccess: () => {
                setEmailTemplateCreateId('');
                setEmailTemplateCreateSubject('');
                setEmailTemplateCreateText('');
                void loadEmailTemplates();
              },
            },
          );
        }}
      >
        Create Template
      </UiButton>
      {emailTemplates.length === 0 ? (
        <UiStatePanel
          compact
          title="No templates found"
          description="Create a template or refresh to load the latest set."
        />
      ) : (
        <ul className="va-list va-list-dense">
          {emailTemplates.slice(0, 40).map((template, index) => {
            const templateId = toText(template.template_id, `template-${index + 1}`);
            const active = templateId === selectedEmailTemplateId;
            return (
              <li key={`email-template-row-${templateId}`}>
                <strong>{templateId}</strong>
                <span>
                  <UiBadge variant={toLifecycleTone(template.lifecycle_state)}>
                    {toText(template.lifecycle_state, 'draft')}
                  </UiBadge>
                </span>
                <UiButton
                  variant="chip"
                  className={active ? 'is-active' : ''}
                  onClick={() => {
                    triggerHaptic('selection');
                    setSelectedEmailTemplateId(templateId);
                  }}
                >
                  {active ? 'Selected' : 'Select'}
                </UiButton>
              </li>
            );
          })}
        </ul>
      )}
      {selectedEmailTemplate ? (
        <>
          <h4>Email Template Editor</h4>
          <UiInput value={selectedEmailTemplateId} disabled />
          <UiInput
            placeholder="Subject"
            value={emailTemplateSubjectInput}
            onChange={(event) => setEmailTemplateSubjectInput(event.target.value)}
          />
          <UiTextarea
            placeholder="HTML"
            value={emailTemplateHtmlInput}
            onChange={(event) => setEmailTemplateHtmlInput(event.target.value)}
            rows={3}
          />
          <UiTextarea
            placeholder="Text"
            value={emailTemplateTextInput}
            onChange={(event) => setEmailTemplateTextInput(event.target.value)}
            rows={3}
          />
          <div className="va-inline-tools">
            <UiButton
              variant="primary"
              disabled={studioBusy.length > 0 || busyAction.length > 0 || !selectedEmailTemplateId}
              onClick={() => {
                void runAction(
                  DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_UPDATE,
                  {
                    template_id: selectedEmailTemplateId,
                    subject: emailTemplateSubjectInput,
                    html: emailTemplateHtmlInput,
                    text: emailTemplateTextInput,
                  },
                  {
                    successMessage: `Updated template "${selectedEmailTemplateId}"`,
                    onSuccess: () => {
                      void loadEmailTemplates();
                    },
                  },
                );
              }}
            >
              Save Template
            </UiButton>
            <UiButton
              variant="secondary"
              disabled={studioBusy.length > 0 || busyAction.length > 0 || !selectedEmailTemplateId}
              onClick={() => {
                void runAction(
                  DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_DELETE,
                  { template_id: selectedEmailTemplateId },
                  {
                    confirmText: `Delete template "${selectedEmailTemplateId}"?`,
                    successMessage: `Deleted template "${selectedEmailTemplateId}"`,
                    onSuccess: () => {
                      void loadEmailTemplates();
                    },
                  },
                );
              }}
            >
              Delete Template
            </UiButton>
          </div>
        </>
      ) : null}
    </UiCard>
  );

  return (
    <>
      <AdminPageIntro
        eyebrow="Voice agents"
        title="AI Agent Studio"
        summary="Configure call-agent purpose, instructions, opening message, goals, and safe test variables alongside existing script governance."
        metaAriaLabel="AI Agent Studio summary"
        meta={
          <>
            <UiBadge variant={pulseTone === 'neutral' ? 'meta' : pulseTone}>
              {pulseStatus}
            </UiBadge>
          <UiBadge variant="meta">Agent Studio</UiBadge>
            <UiBadge variant="info">{activeScriptStudioLaneLabel}</UiBadge>
            <UiBadge variant="meta">{activeScriptStudioCount} in lane</UiBadge>
          </>
        }
        note="The call-agent lane uses the existing versioned script and runtime profile contracts. Include identity, disclosure, data limits, stop conditions, and human handoff in the agent instructions."
      />
      <UiWorkspacePulse
        title="Workspace pulse"
        description="Track the active script lane, current selection, and shared policy context in one compact summary."
        tone={pulseTone}
        status={pulseStatus}
        items={[
          { label: 'Active lane', value: activeScriptStudioLaneLabel },
          { label: 'Selected', value: activeScriptStudioSelection },
          { label: activeScriptStudioLaneLabel, value: activeScriptStudioCount },
          { label: 'Shared context', value: `${callerFlags.length} flags · ${totalPersonas} personas` },
        ]}
      />
      <DashboardWorkflowContractCard moduleId="content" />
      <UiCard>
        <div className="va-ops-card-header">
          <div className="va-ops-card-headline">
            <h3>Designer switchboard</h3>
            <p className="va-muted">
              Match the bot-side Script Designer by switching between call scripts, SMS scripts, and email templates from one page.
            </p>
          </div>
          <UiBadge variant="meta">{activeScriptStudioSelection}</UiBadge>
        </div>
        <div className="va-inline-tools">
          <UiButton
            variant="chip"
            className={activeScriptStudioLane === 'call' ? 'is-active' : ''}
            onClick={() => {
              triggerHaptic('selection');
              setActiveScriptStudioLane('call');
            }}
          >
            Call Scripts
          </UiButton>
          <UiButton
            variant="chip"
            className={activeScriptStudioLane === 'sms' ? 'is-active' : ''}
            onClick={() => {
              triggerHaptic('selection');
              setActiveScriptStudioLane('sms');
            }}
          >
            SMS Scripts
          </UiButton>
          <UiButton
            variant="chip"
            className={activeScriptStudioLane === 'email' ? 'is-active' : ''}
            onClick={() => {
              triggerHaptic('selection');
              setActiveScriptStudioLane('email');
            }}
          >
            Email Templates
          </UiButton>
        </div>
        <Link to={MINIAPP_COMMAND_ROUTE_CONTRACTS.SCRIPTS}>
          <Cell
            subtitle="Open the scripts overview before moving to another content workspace."
            after={<Navigation>Open</Navigation>}
          >
            Scripts overview
          </Cell>
        </Link>
        <Link to={DASHBOARD_MODULE_ROUTE_CONTRACTS.scriptsparity}>
          <Cell
            subtitle="Open the focused message entry when you want this same designer to land directly on the SMS and email lanes."
            after={<Navigation>Open</Navigation>}
          >
            Focused Message Entry
          </Cell>
        </Link>
      </UiCard>
      <UiDisclosure
        title="Workspace coverage"
        subtitle="Expose the current combined designer surface while keeping supported lane behavior explicit."
      >
        <UiStatePanel
          compact
          tone="success"
          title="Available here now"
          description="Switch between call, SMS, and email lanes. Call scripts support draft review, approval, promotion, and simulation here, while SMS and email lanes support create, update, inspect, and delete."
        />
        <UiStatePanel
          compact
          tone="info"
          title="Focused entry behavior"
          description="The focused message entry reuses this same Script Designer surface and starts on the message lanes. It does not expose a separate SMS or email governance workflow."
        />
      </UiDisclosure>
      <section className="va-grid">
        {activeScriptStudioLane === 'call' ? (
          <>
        <UiCard>
          <h3>Call Scripts</h3>
          <p className="va-muted">
            Draft edits, review approvals, and promote-live workflow for call scripts.
          </p>
          <div className="va-inline-tools">
            <UiInput
              placeholder="Flow filter (optional)"
              value={scriptFlowFilter}
              onChange={(event) => setScriptFlowFilter(event.target.value)}
            />
            <UiButton
              variant="secondary"
              onClick={() => {
                triggerHaptic('impact', 'light');
                void refreshCallScriptsModule();
              }}
            >
              Refresh Scripts
            </UiButton>
          </div>
          <p className="va-muted">
            Scripts available: <strong>{callScriptsTotal}</strong>
          </p>
          <ul className="va-list va-list-dense">
            {callScripts.slice(0, 60).map((script: CallScriptRow) => {
              const scriptId = toInt(script.id);
              const lifecycle = toText(script.lifecycle_state, 'draft');
              const lifecycleTone = toLifecycleTone(lifecycle);
              const active = scriptId === selectedCallScriptId;
              return (
                <li key={`call-script-${scriptId}`}>
                  <strong>{toText(script.name, `script-${scriptId || 'unknown'}`)}</strong>
                  <span>
                    ID: {scriptId} | Flow: {toText(script.flow_type, 'general')} | v{toInt(script.version, 1)}
                  </span>
                  <span>
                    <UiBadge variant={lifecycleTone}>
                      {lifecycle}
                    </UiBadge>
                    {' '}
                    Persona(default_profile): <strong>{toText(script.default_profile, 'general')}</strong>
                  </span>
                  <UiButton
                    variant="chip"
                    className={active ? 'is-active' : ''}
                    onClick={() => {
                      triggerHaptic('selection');
                      setSelectedCallScriptId(scriptId);
                    }}
                  >
                    {active ? 'Selected' : 'Select'}
                  </UiButton>
                </li>
              );
            })}
          </ul>
        </UiCard>

        <UiCard>
            <h3>Agent definition</h3>
          {selectedCallScript ? (
            <>
              <UiStatePanel
                compact
                tone={selectedCallScriptLifecycleTone}
                title={`Editing ${toText(selectedCallScript.name, 'unknown')}`}
                description={(
                  <>
                    Script #{selectedCallScriptId} is currently <strong>{selectedCallScriptLifecycleState}</strong>.
                    {' '}Submitted <strong>{formatTime(selectedCallScriptLifecycle.submitted_for_review_at)}</strong>,
                    reviewed <strong>{formatTime(selectedCallScriptLifecycle.reviewed_at)}</strong>.
                  </>
                )}
              />
              <UiInput
                aria-label="Agent name"
                placeholder="Agent name"
                value={scriptNameInput}
                onChange={(event) => setScriptNameInput(event.target.value)}
              />
              <UiInput
                aria-label="Runtime profile"
                placeholder="Runtime profile (default_profile)"
                value={scriptDefaultProfileInput}
                onChange={(event) => setScriptDefaultProfileInput(event.target.value)}
              />
              <UiTextarea
                aria-label="Agent purpose"
                placeholder="Agent purpose"
                value={scriptDescriptionInput}
                onChange={(event) => setScriptDescriptionInput(event.target.value)}
                rows={2}
              />
              <UiTextarea
                aria-label="Agent instructions"
                placeholder="Instructions: role, scope, disclosure, data limits, stop and handoff rules"
                value={scriptPromptInput}
                onChange={(event) => setScriptPromptInput(event.target.value)}
                rows={6}
              />
              <UiTextarea
                aria-label="Opening message"
                placeholder="Opening message"
                value={scriptFirstMessageInput}
                onChange={(event) => setScriptFirstMessageInput(event.target.value)}
                rows={3}
              />
              <UiInput
                aria-label="Conversation goals"
                placeholder="Conversation goals (comma-separated tags)"
                value={scriptObjectiveTagsInput}
                onChange={(event) => setScriptObjectiveTagsInput(event.target.value)}
              />
              <label className="va-field-label" htmlFor="script-voice-model">Deepgram speech voice</label>
              <UiSelect
                id="script-voice-model"
                aria-label="Deepgram speech voice"
                value={scriptVoiceModelInput}
                onChange={(event) => {
                  const model = event.target.value;
                  setScriptVoiceModelInput(model);
                  if (!model) {
                    setVoiceAgentLanguage('en');
                    setVoiceAgentListenModel('nova-2');
                  } else if (model.endsWith('-es')) {
                    setVoiceAgentSettingsEnabled(true);
                    setVoiceAgentLanguage('es');
                    setVoiceAgentListenModel('flux-general-multi');
                  } else if (model.endsWith('-en')) {
                    setVoiceAgentLanguage('en');
                    if (!CALL_AGENT_LISTEN_MODEL_OPTIONS.some((option) => option.id === voiceAgentListenModel && option.languages.includes('en'))) {
                      setVoiceAgentListenModel('nova-2');
                    }
                  }
                }}
              >
                <option value="">Use configured profile voice</option>
                {scriptVoiceModelInput && !CALL_FALLBACK_VOICE_MODELS.some((voice) => voice.id === scriptVoiceModelInput) && (
                  <option value={scriptVoiceModelInput}>Keep existing voice ({scriptVoiceModelInput})</option>
                )}
                {CALL_FALLBACK_VOICE_MODELS.map((voice) => (
                  <option key={voice.id} value={voice.id}>{voice.label} · {voice.style}</option>
                ))}
              </UiSelect>
              <label className="va-checkbox-label">
                <input
                  type="checkbox"
                  aria-label="Override Deepgram Voice Agent settings for this script"
                  checked={voiceAgentSettingsEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setVoiceAgentSettingsEnabled(enabled);
                    if (enabled && !scriptVoiceModelInput.endsWith(`-${voiceAgentLanguage}`)) {
                      setScriptVoiceModelInput(voiceAgentLanguage === 'es'
                        ? 'aura-2-celeste-es'
                        : 'aura-2-andromeda-en');
                    }
                    if (!enabled && voiceAgentLanguage === 'es') {
                      setVoiceAgentLanguage('en');
                      setVoiceAgentListenModel('nova-2');
                      setScriptVoiceModelInput('aura-2-andromeda-en');
                    }
                  }}
                />
                Override Deepgram language and model settings for this script
              </label>
              <label className="va-field-label" htmlFor="voice-agent-language">Agent language</label>
              <UiSelect
                id="voice-agent-language"
                aria-label="Agent language"
                disabled={!voiceAgentSettingsEnabled}
                value={voiceAgentLanguage}
                onChange={(event) => {
                  const language = event.target.value;
                  setVoiceAgentLanguage(language);
                  if (language === 'es') {
                    setScriptVoiceModelInput('aura-2-celeste-es');
                    setVoiceAgentListenModel('flux-general-multi');
                  } else {
                    if (scriptVoiceModelInput.endsWith('-es')) setScriptVoiceModelInput('aura-2-andromeda-en');
                    if (!CALL_AGENT_LISTEN_MODEL_OPTIONS.some((model) => model.id === voiceAgentListenModel && model.languages.includes('en'))) {
                      setVoiceAgentListenModel('nova-2');
                    }
                  }
                }}
              >
                {CALL_AGENT_LANGUAGE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </UiSelect>
              <label className="va-field-label" htmlFor="voice-agent-listen-model">Speech recognition model</label>
              <UiSelect
                id="voice-agent-listen-model"
                aria-label="Speech recognition model"
                disabled={!voiceAgentSettingsEnabled}
                value={voiceAgentListenModel}
                onChange={(event) => setVoiceAgentListenModel(event.target.value)}
              >
                {CALL_AGENT_LISTEN_MODEL_OPTIONS.filter((model) => model.languages.includes(voiceAgentLanguage as 'en' | 'es')).map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </UiSelect>
              <label className="va-field-label" htmlFor="voice-agent-think-model">Reasoning model</label>
              <UiSelect
                id="voice-agent-think-model"
                aria-label="Reasoning model"
                disabled={!voiceAgentSettingsEnabled}
                value={`${voiceAgentThinkProvider}:${voiceAgentThinkModel}`}
                onChange={(event) => {
                  const [provider, model] = event.target.value.split(':');
                  setVoiceAgentThinkProvider(provider);
                  setVoiceAgentThinkModel(model);
                }}
              >
                {CALL_AGENT_THINK_MODEL_OPTIONS.map((option) => (
                  <option key={`${option.provider}:${option.model}`} value={`${option.provider}:${option.model}`}>{option.label}</option>
                ))}
              </UiSelect>
              <p className="va-muted-copy">Settings are disabled by default. The selected language, recognition model, reasoning model, and explicit speech voice are validated together. Only Deepgram managed reasoning models are listed; custom endpoints and credentials are not accepted here. Spanish requires the Spanish Celeste voice. Edit the prompt and opening message in the selected language yourself.</p>
              <UiTextarea
                aria-label="Agent runtime configuration JSON"
                placeholder={'{"schema_version":6,"approved_tools":[],"voice_agent_settings":{"language":"en","listen_model":"nova-2","think_provider":"open_ai","think_model":"gpt-4o-mini"},"business_context":{"business_name":"Example business","facts":[{"label":"Support hours","value":"Weekdays, 9 AM to 5 PM"}]},"escalation_policy":{"allowed_outcomes":["review_case"],"default_outcome":"review_case"},"tool_failure_policy":{"on_tool_error":"end_call"},"handoff_policy":{"enabled":false,"confirmation":"dtmf_1"}}'}
                value={agentRuntimeConfigInput}
                onChange={(event) => setAgentRuntimeConfigInput(event.target.value)}
                rows={5}
              />
              <p className="va-muted-copy">
                Approved tool names are checked against this agent’s generated tools; an empty list denies all tools. Business context is bounded reference data, not instructions. An escalation policy can choose only review-case or secure-follow-up outcomes and cannot schedule callbacks. The optional schema-v4 tool failure policy can keep the agent running or end the active call with the standard error closing; it never retries a failed tool. Schema-v5 handoff is Twilio-only, requires a live script, verified stream authentication, and a fixed E.164 destination approved by your organization; transfer starts only after the caller presses 1 and pressing 2 cancels. Schema-v6 supports validated Deepgram language and model selections. Handoff is disabled by default. Do not include secrets or customer data. Leave blank for existing profile policy behavior. Timeout must be 1000–30000 ms and cannot exceed the server limit.
              </p>
              <UiTextarea
                placeholder="Review note / approval reason"
                value={scriptReviewNoteInput}
                onChange={(event) => setScriptReviewNoteInput(event.target.value)}
                rows={2}
              />
              <UiActionBar
                title={busyAction.length > 0 ? 'Call script action in progress' : 'Call script ready'}
                description={busyAction.length > 0
                  ? `${busyAction} is running for the selected script.`
                  : 'Save changes, route the draft for review, or run a quick simulation before approving.'}
                actions={(
                  <>
                    <UiButton
                      variant="primary"
                      disabled={busyAction.length > 0}
                      onClick={saveCallScriptWithRuntimeConfig}
                    >
                      Save Draft
                    </UiButton>
                    <UiButton
                      variant="secondary"
                      disabled={busyAction.length > 0}
                      onClick={() => { void submitCallScriptForReview(); }}
                    >
                      Submit Review
                    </UiButton>
                    <UiButton
                      variant="secondary"
                      disabled={busyAction.length > 0}
                      onClick={() => { void simulateCallScript(); }}
                    >
                      Run Simulation
                    </UiButton>
                  </>
                )}
              />
              <div className="va-inline-tools">
                <UiButton
                  variant="secondary"
                  disabled={busyAction.length > 0}
                  onClick={() => { void reviewCallScript('approve'); }}
                >
                  Approve
                </UiButton>
                <UiButton
                  variant="secondary"
                  disabled={busyAction.length > 0}
                  onClick={() => { void reviewCallScript('reject'); }}
                >
                  Reject
                </UiButton>
                <UiButton
                  variant="secondary"
                  disabled={busyAction.length > 0}
                  onClick={() => { void promoteCallScriptLive(); }}
                >
                  Promote Live
                </UiButton>
              </div>
              <UiDisclosure
                title="CALL-E deployment status"
                subtitle="Check server configuration and rollout availability. This status request never contacts CALL-E."
                tone={callEDeploymentStatus?.integrationEnabled === true ? 'info' : 'neutral'}
              >
                <UiStatePanel compact tone="warning" title="Dispatch gated" description="Dispatch requires both server switches, an unexpired approval for one exact preview, operator confirmation, consent, and an allowlisted destination." />
                <UiButton
                  variant="secondary"
                  disabled={studioBusy.length > 0 || busyAction.length > 0}
                  onClick={() => {
                    void (async () => {
                      const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLE_STATUS, {});
                      setCallEDeploymentStatus(asRecord(data.status));
                    })();
                  }}
                >
                  Refresh CALL-E availability
                </UiButton>
                {callEDeploymentStatus ? (
                  <div aria-live="polite">
                    <p>Integration flag: <strong>{callEDeploymentStatus.integrationEnabled === true ? 'enabled' : 'disabled'}</strong></p>
                    <p>Dispatch kill switch: <strong>{callEDeploymentStatus.dispatchKillSwitchEnabled === true ? 'enabled' : 'disabled'}</strong></p>
                    <p>Exact-preview approval: <strong>{callEDeploymentStatus.pilotApprovalReady === true ? 'configured' : 'missing or expired'}</strong></p>
                    <p>External pilot review: <strong>{callEDeploymentStatus.pilotReady === true ? 'complete' : 'incomplete'}</strong></p>
                    <p>Provider access readiness: <strong>{callEDeploymentStatus.providerAccessReady === true ? 'ready' : 'disabled or incomplete'}</strong></p>
                    <p>Destination allowlist: <strong>{callEDeploymentStatus.destinationAllowlistReady === true ? 'configured' : 'empty'}</strong></p>
                    <p>Local preview: <strong>{callEDeploymentStatus.previewAvailable === true ? 'available' : 'unavailable'}</strong></p>
                    <p>Call dispatch: <strong>{callEDeploymentStatus.dispatchAvailable === true ? 'available' : 'unavailable'}</strong></p>
                    <p>Pilot readiness: <strong>{callEDeploymentStatus.pilotReady === true ? 'ready' : 'blocked'}</strong></p>
                    {Array.isArray(callEDeploymentStatus.dispatchBlockers) ? (
                      <ul aria-label="CALL-E dispatch blockers">
                        {callEDeploymentStatus.dispatchBlockers
                          .filter((blocker): blocker is string => typeof blocker === 'string')
                          .map((blocker) => (
                            <li key={blocker}>{CALL_E_DISPATCH_BLOCKER_LABELS[blocker] || 'Additional dispatch requirement is incomplete'}</li>
                          ))}
                      </ul>
                    ) : null}
                  </div>
                ) : (
                  <UiStatePanel compact tone="info" title="Deployment status not loaded" description="Refresh availability to inspect the server-side flag and configuration state." />
                )}
              </UiDisclosure>
              <UiDisclosure
                title="CALL-E compatibility preview"
                subtitle="Build a no-call Calls V2 preview for this saved template version. The destination is masked in the result."
                tone={callEPreview ? 'info' : 'neutral'}
              >
                <UiStatePanel compact tone="warning" title="Preview only" description="This action never places a call. Live CALL-E execution remains disabled until template, account, and policy reviews are complete." />
                <label className="va-field-label" htmlFor="call-e-preview-phone">Destination in E.164 format</label>
                <UiInput id="call-e-preview-phone" type="tel" autoComplete="off" placeholder="+15551234567" value={callEPhoneInput} onChange={(event) => { setCallEPhoneInput(event.target.value); setCallEPreview(null); setCallEConfirmation(null); }} />
                <label className="va-field-label" htmlFor="call-e-preview-schema">Flat scalar result schema (JSON)</label>
                <UiTextarea id="call-e-preview-schema" value={callEResultSchemaInput} onChange={(event) => { setCallEResultSchemaInput(event.target.value); setCallEPreview(null); setCallEConfirmation(null); }} rows={7} />
                <UiButton
                  variant="secondary"
                  disabled={studioBusy.length > 0 || busyAction.length > 0 || !callEPhoneInput.trim()}
                  onClick={() => {
                    let resultSchema: unknown;
                    try { resultSchema = JSON.parse(callEResultSchemaInput); }
                    catch { setStudioError('Result schema must be valid JSON.'); setCallEPreview(null); return; }
                    void (async () => {
                      const data = await executeStudioAction('callscript.calle_preview', {
                        id: selectedCallScriptId,
                        phone: callEPhoneInput.trim(),
                        result_schema: resultSchema,
                      });
                      setCallEPreview(asRecord(data.preview));
                      setCallEConfirmation(null);
                    })();
                  }}
                >
                  Preview CALL-E mapping
                </UiButton>
                {callEPreview?.compatible === true && typeof callEPreview.fingerprint === 'string' && String(selectedCallScriptLifecycleState).toLowerCase() === 'live' ? (
                  <div>
                    <p className="va-muted">Preview destination: {toText(asRecord(callEPreview.requestSummary).phoneMasked, 'masked in preview')} · Version: {toText(asRecord(callEPreview.source).templateVersion, 'unknown')}</p>
                    <UiButton
                      variant="secondary"
                      disabled={studioBusy.length > 0 || busyAction.length > 0 || !selectedCallScriptId || Boolean(callEConfirmation)}
                      onClick={() => {
                        let resultSchema: unknown;
                        try { resultSchema = JSON.parse(callEResultSchemaInput); }
                        catch { setStudioError('Result schema must be valid JSON.'); return; }
                        void (async () => {
                          const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_CALLE_CONFIRM, {
                            template_id: Number(selectedCallScriptId),
                            destination: callEPhoneInput.trim(),
                            region: asRecord(callEPreview.requestSummary).region,
                            locale: asRecord(callEPreview.requestSummary).locale,
                            result_schema: resultSchema,
                            preview_fingerprint: callEPreview.fingerprint,
                          });
                          setCallEConfirmation(asRecord(data).confirmed === true ? asRecord(data) : null);
                        })();
                      }}
                    >
                      Confirm this preview
                    </UiButton>
                    {callEConfirmation ? <UiStatePanel compact tone="success" title="Operator confirmation recorded" description="The exact preview and operator were recorded. No call was placed." /> : null}
                    {callEConfirmation ? (
                      <UiButton
                        variant="primary"
                        disabled={studioBusy.length > 0 || busyAction.length > 0 || callEDeploymentStatus?.dispatchAvailable !== true || callEDeploymentStatus?.pilotReady !== true}
                        onClick={() => {
                          if (!window.confirm('This may place a real CALL-E call and incur charges. Continue only for the explicitly approved pilot destination.')) return;
                          let resultSchema: unknown;
                          try { resultSchema = JSON.parse(callEResultSchemaInput); }
                          catch { setStudioError('Result schema must be valid JSON.'); return; }
                          void (async () => {
                            const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_CALLE_DISPATCH, {
                              template_id: Number(selectedCallScriptId),
                              destination: callEPhoneInput.trim(),
                              region: asRecord(callEPreview.requestSummary).region,
                              locale: asRecord(callEPreview.requestSummary).locale,
                              result_schema: resultSchema,
                              preview_fingerprint: callEPreview.fingerprint,
                            });
                            setCallELocalIdInput(toText(asRecord(data).localCallId, ''));
                          })();
                        }}
                      >
                        Place approved pilot call
                      </UiButton>
                    ) : null}
                  </div>
                ) : null}
                {callEPreview ? <pre aria-live="polite">{JSON.stringify(callEPreview, null, 2)}</pre> : null}
              </UiDisclosure>
              <UiDisclosure
                title="CALL-E call status"
                subtitle="Refresh lifecycle and event metadata for a locally recorded CALL-E call. Queued calls can be canceled before provider submission; this cannot hang up an active call."
                tone={callEReconciliation ? 'info' : 'neutral'}
              >
                <label className="va-field-label" htmlFor="call-e-local-id">VOICEDNUT local Call ID</label>
                <UiInput
                  id="call-e-local-id"
                  autoComplete="off"
                  placeholder="call_e_…"
                  value={callELocalIdInput}
                  onChange={(event) => {
                    setCallELocalIdInput(event.target.value);
                    setCallEReconciliation(null);
                    setCallEReview(null);
                  }}
                />
                <UiButton
                  variant="secondary"
                  disabled={studioBusy.length > 0 || busyAction.length > 0 || !/^call_e_[0-9a-f-]{36}$/i.test(callELocalIdInput.trim())}
                  onClick={() => {
                    void (async () => {
                      const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLE_CALL_RECONCILE, {
                        local_call_id: callELocalIdInput.trim(),
                      });
                      setCallEReconciliation(asRecord(data.result));
                      setCallEReview(null);
                    })();
                  }}
                >
                  Refresh CALL-E status
                </UiButton>
                {callEReconciliation ? (
                  <UiButton
                    variant="secondary"
                    disabled={studioBusy.length > 0 || busyAction.length > 0}
                    onClick={() => {
                      if (!window.confirm('This loads private transcript and result content for authorized business operators. Continue only if you are permitted to review this call.')) return;
                      void (async () => {
                        const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLE_CALL_REVIEW, {
                          local_call_id: callELocalIdInput.trim(),
                        });
                        const review = asRecord(data.result);
                        setCallEReview(Object.keys(review).length ? review : null);
                      })();
                    }}
                  >
                    Review CALL-E result and transcript
                  </UiButton>
                ) : null}
                {callEReconciliation?.executionStatus === 'queued' ? (
                  <UiButton
                    variant="secondary"
                    disabled={studioBusy.length > 0 || busyAction.length > 0}
                    onClick={() => {
                      if (!window.confirm('Cancel this queued CALL-E call before provider submission? This cannot hang up an active call.')) return;
                      void (async () => {
                        const data = await executeStudioAction(DASHBOARD_ACTION_CONTRACTS.CALLE_CALL_CANCEL, {
                          local_call_id: callELocalIdInput.trim(),
                        });
                        setCallEReconciliation(asRecord(data.result));
                        setCallEReview(null);
                      })();
                    }}
                  >
                    Cancel queued CALL-E call
                  </UiButton>
                ) : null}
                {callEReconciliation ? (
                  <div aria-live="polite">
                    <p>
                      Execution: <strong>{toText(callEReconciliation.executionStatus, 'unknown')}</strong>
                      {' · '}Outcome: <strong>{toText(callEReconciliation.callOutcome, 'unknown')}</strong>
                      {' · '}Result: <strong>{toText(callEReconciliation.resultStatus, 'unknown')}</strong>
                    </p>
                    <p className="va-muted">Structured result available: {callEReconciliation.resultAvailable === true ? 'yes' : 'no'}.{callEReview ? ' Authorized review content is shown below.' : ' Transcript and result content require a separate review action.'}</p>
                    <pre>{JSON.stringify(toRows(callEReconciliation.events).map((item) => ({
                      id: item.id,
                      type: item.type,
                      createdAt: item.createdAt,
                    })), null, 2)}</pre>
                  </div>
                ) : (
                  <UiStatePanel compact tone="info" title="No status snapshot loaded" description="Enter a local Call ID to fetch normalized state when CALL-E is enabled and the record exists." />
                )}
                {callEReview ? (
                  <section aria-label="CALL-E private call review">
                    <h4>Private call content</h4>
                    <p className="va-muted">Review is restricted to current business operators. Do not copy transcript or result content into ordinary logs or unrelated records.</p>
                    <p>Result status: <strong>{toText(callEReview.resultStatus, 'unknown')}</strong></p>
                    {callEReview.resultOmittedForSize === true ? (
                      <p role="status">Structured result omitted because it exceeds the review response limit.</p>
                    ) : callEReview.result !== null && callEReview.result !== undefined ? (
                      <pre aria-label="CALL-E structured result">{JSON.stringify(callEReview.result, null, 2)}</pre>
                    ) : <p>No structured result is available.</p>}
                    {callEReview.transcriptTruncated === true ? (
                      <p role="status">Transcript excerpt is truncated to the review response limit.</p>
                    ) : null}
                    {toRows(callEReview.transcript).length ? (
                      <ol aria-label="CALL-E transcript">
                        {toRows(callEReview.transcript).map((turn, index) => (
                          <li key={`${index}-${toText(turn.speaker, 'unknown')}`}>
                            <strong>{toText(turn.speaker, 'unknown')}</strong>
                            {turn.offsetSeconds !== null && turn.offsetSeconds !== undefined ? ` · ${toText(turn.offsetSeconds, '')}s` : ''}
                            <p>{toText(turn.text, '')}</p>
                          </li>
                        ))}
                      </ol>
                    ) : <p>No transcript turns are available.</p>}
                  </section>
                ) : null}
              </UiDisclosure>
              <UiDisclosure
                title="Simulation preview"
                subtitle="Deterministically render template variables. This preview does not call an AI model, place a call, or contact anyone."
                tone={scriptSimulationResult ? 'success' : 'neutral'}
              >
                <UiTextarea
                  aria-label="Mock template variable values"
                  placeholder={'Test variables JSON, e.g. {"customer_name":"Ada"}'}
                  value={scriptSimulationVariablesInput}
                  onChange={(event) => setScriptSimulationVariablesInput(event.target.value)}
                  rows={3}
                />
                {scriptSimulationResult ? (
                  (() => {
                    const simulation = asRecord(asRecord(scriptSimulationResult).simulation || scriptSimulationResult);
                    return (
                      <div aria-live="polite">
                        <p role="status">Required variables: {toTexts(simulation.required_variables).join(', ') || 'none'}.</p>
                        {toTexts(simulation.missing_variables).length > 0 ? (
                          <UiStatePanel compact tone="warning" title="Some variables are missing" description={`Add test values for: ${toTexts(simulation.missing_variables).join(', ')}.`} />
                        ) : null}
                        <h4>Rendered opening</h4>
                        <p>{toText(simulation.rendered_first_message, 'No opening message rendered.')}</p>
                        <h4>Rendered instructions</h4>
                        <pre>{toText(simulation.rendered_prompt, 'No instructions rendered.')}</pre>
                      </div>
                    );
                  })()
                ) : (
                  <UiStatePanel
                    compact
                    title="No simulation output yet"
                    description="Run a simulation to inspect the resolved conversation content."
                    tone="info"
                  />
                )}
              </UiDisclosure>
              <UiDisclosure
                title="Agent definition versions"
                subtitle="Inspect saved version metadata or restore a prior version as a new draft. Restoration never publishes automatically."
                tone={callScriptVersions.length > 0 ? 'info' : 'neutral'}
              >
                {restoreNotice ? <UiStatePanel compact tone="success" title="Draft version restored" description={restoreNotice} /> : null}
                <UiButton
                  variant="secondary"
                  disabled={studioBusy.length > 0 || busyAction.length > 0 || selectedCallScriptId <= 0}
                  onClick={() => { void loadCallScriptVersions(); }}
                >
                  Load version history
                </UiButton>
                {callScriptVersions.length > 0 ? (
                  <>
                    <ul aria-label="Agent definition version history" className="va-native-list">
                      {callScriptVersions.map((row) => (
                        <li key={`agent-version-${toInt(row.version, 0)}`} className="va-native-list-row">
                          <strong>Version {toInt(row.version, 0)}</strong>
                          <span>{toText(row.reason, 'saved')}</span>
                          <span>{formatTime(row.created_at)}</span>
                        </li>
                      ))}
                    </ul>
                    <label className="va-field">
                      <span>Version to restore</span>
                      <UiSelect aria-label="Version to restore" value={selectedRollbackVersion} onChange={(event) => setSelectedRollbackVersion(event.target.value)}>
                        {callScriptVersions.map((row) => (
                          <option key={`agent-version-option-${toInt(row.version, 0)}`} value={String(toInt(row.version, 0))}>
                            Version {toInt(row.version, 0)} · {toText(row.reason, 'saved')}
                          </option>
                        ))}
                      </UiSelect>
                    </label>
                    <UiButton
                      variant="secondary"
                      disabled={studioBusy.length > 0 || busyAction.length > 0 || !selectedRollbackVersion || Number(selectedRollbackVersion) === toInt(selectedCallScript?.version, 1)}
                      onClick={restoreCallScriptVersion}
                    >
                      Restore as draft
                    </UiButton>
                  </>
                ) : (
                  <UiStatePanel compact tone="info" title="No version history loaded" description="Load saved version metadata for the selected agent definition." />
                )}
                {callScriptVersions.length > 1 ? (
                  <section aria-label="Agent definition version comparison" style={{ display: 'grid', gap: 12 }}>
                    <h4>Compare versions</h4>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 12 }}>
                      <label className="va-field">
                        <span>From version</span>
                        <UiSelect aria-label="Compare from version" value={selectedDiffFromVersion} onChange={(event) => { setSelectedDiffFromVersion(event.target.value); setCallScriptVersionDiff(null); }}>
                          {callScriptVersions.map((row) => (
                            <option key={`agent-diff-from-${toInt(row.version, 0)}`} value={String(toInt(row.version, 0))}>
                              Version {toInt(row.version, 0)} · {toText(row.reason, 'saved')}
                            </option>
                          ))}
                        </UiSelect>
                      </label>
                      <label className="va-field">
                        <span>To version</span>
                        <UiSelect aria-label="Compare to version" value={selectedDiffToVersion} onChange={(event) => { setSelectedDiffToVersion(event.target.value); setCallScriptVersionDiff(null); }}>
                          {callScriptVersions.map((row) => (
                            <option key={`agent-diff-to-${toInt(row.version, 0)}`} value={String(toInt(row.version, 0))}>
                              Version {toInt(row.version, 0)} · {toText(row.reason, 'saved')}
                            </option>
                          ))}
                        </UiSelect>
                      </label>
                    </div>
                    <UiButton
                      variant="secondary"
                      disabled={studioBusy.length > 0 || busyAction.length > 0 || !selectedDiffFromVersion || !selectedDiffToVersion || selectedDiffFromVersion === selectedDiffToVersion}
                      onClick={() => { void compareCallScriptVersions(); }}
                    >
                      Compare versions
                    </UiButton>
                    {callScriptVersionDiff ? (
                      <div role="region" aria-label="Version comparison results" style={{ display: 'grid', gap: 12 }}>
                        {toRows(callScriptVersionDiff.changes).length > 0 ? toRows(callScriptVersionDiff.changes).map((change) => (
                          <article key={`version-diff-${toText(change.field, 'field')}`} className="va-card">
                            <h5>{toText(change.field, 'Changed field')}</h5>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 12 }}>
                              <div>
                                <strong>Version {toInt(callScriptVersionDiff.from_version, 0)}</strong>
                                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto' }}>{formatVersionDiffValue(change.from)}</pre>
                              </div>
                              <div>
                                <strong>Version {toInt(callScriptVersionDiff.to_version, 0)}</strong>
                                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto' }}>{formatVersionDiffValue(change.to)}</pre>
                              </div>
                            </div>
                          </article>
                        )) : (
                          <UiStatePanel compact tone="success" title="Versions match" description="No saved fields differ between these versions." />
                        )}
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </UiDisclosure>
            </>
          ) : (
            <UiStatePanel
              title="No call script selected"
              description="Choose a script from the list to start editing, reviewing, or simulating."
              tone="info"
            />
          )}
        </UiCard>
          </>
        ) : null}
        {activeScriptStudioLane === 'sms' ? renderSmsScriptsCard() : null}
        {activeScriptStudioLane === 'email' ? renderEmailTemplatesCard() : null}
      </section>

      <UiDisclosure
        title="Shared policy context"
        subtitle={`${callerFlags.length} caller flags, ${totalPersonas} personas`}
      >
        <section className="va-grid">
          <UiCard>
            <h3>Caller Flags Moderation</h3>
            <p className="va-muted">Allow, block, and spam classifications for inbound caller controls.</p>
            <div className="va-inline-tools">
              <UiSelect
                value={callerFlagsStatusFilter}
                onChange={(event) => setCallerFlagsStatusFilter(event.target.value)}
              >
                <option value="all">All</option>
                <option value="allowed">Allowed</option>
                <option value="blocked">Blocked</option>
                <option value="spam">Spam</option>
              </UiSelect>
              <UiButton
                variant="secondary"
                disabled={studioBusy.length > 0}
                onClick={() => {
                  triggerHaptic('impact', 'light');
                  void loadCallerFlags();
                }}
              >
                Refresh Flags
              </UiButton>
            </div>
            <div className="va-inline-tools">
              <UiInput
                placeholder="Phone (+1555...)"
                value={callerFlagPhoneInput}
                onChange={(event) => setCallerFlagPhoneInput(event.target.value)}
              />
              <UiSelect
                value={callerFlagStatusInput}
                onChange={(event) => setCallerFlagStatusInput(event.target.value)}
              >
                <option value="blocked">Blocked</option>
                <option value="allowed">Allowed</option>
                <option value="spam">Spam</option>
              </UiSelect>
              <UiInput
                placeholder="Note (optional)"
                value={callerFlagNoteInput}
                onChange={(event) => setCallerFlagNoteInput(event.target.value)}
              />
              <UiButton
                variant="primary"
                disabled={studioBusy.length > 0 || busyAction.length > 0 || !callerFlagPhoneInput.trim()}
                onClick={() => {
                  void runAction(
                    DASHBOARD_ACTION_CONTRACTS.CALLERFLAGS_UPSERT,
                    {
                      phone_number: callerFlagPhoneInput.trim(),
                      status: callerFlagStatusInput,
                      note: callerFlagNoteInput.trim() || undefined,
                    },
                    {
                      successMessage: `Updated caller flag for ${callerFlagPhoneInput.trim()}`,
                      onSuccess: () => {
                        setCallerFlagPhoneInput('');
                        setCallerFlagNoteInput('');
                        void loadCallerFlags();
                      },
                    },
                  );
                }}
              >
                Upsert Flag
              </UiButton>
            </div>
            {callerFlags.length === 0 ? (
              <UiStatePanel
                compact
                title="No caller flags loaded"
                description="Refresh the moderation feed or add a new number to begin reviewing states."
              />
            ) : (
              <ul className="va-list va-list-dense">
                {callerFlags.slice(0, 40).map((flag, index) => (
                  <li key={`caller-flag-${index}`}>
                    <strong>{toText(flag.phone_number, 'n/a')}</strong>
                    <span>
                      <UiBadge variant={toCallerFlagTone(flag.status)}>
                        {toText(flag.status, 'unknown')}
                      </UiBadge>
                    </span>
                    <span>{toText(flag.note, 'no note')}</span>
                  </li>
                ))}
              </ul>
            )}
          </UiCard>

          <UiCard>
            <h3>Persona Manager</h3>
            <p className="va-muted">
              Persona catalog visibility for script review and policy checks.
            </p>
            <div className="va-inline-tools">
              <UiButton
                variant="secondary"
                disabled={studioBusy.length > 0}
                onClick={() => {
                  triggerHaptic('impact', 'light');
                  void loadPersonas();
                }}
              >
                Refresh Personas
              </UiButton>
            </div>
            <div className="va-inline-tools">
              <UiCard tone="subcard">
                <h4>Built-in Personas ({personaBuiltin.length})</h4>
                {personaBuiltin.length === 0 ? (
                  <UiStatePanel
                    title="No built-in personas reported"
                    description="Refresh the catalog to recheck the shared persona set."
                    tone="info"
                    compact
                  />
                ) : (
                  <ul className="va-list va-list-dense">
                    {personaBuiltin.slice(0, 20).map((persona, index) => (
                      <li key={`persona-builtin-${index}`}>
                        <strong>{toText(persona.label, toText(persona.name, `builtin-${index + 1}`))}</strong>
                        <span>{toText(persona.id, 'n/a')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </UiCard>
              <UiCard tone="subcard">
                <h4>Custom Personas ({personaCustom.length})</h4>
                {personaCustom.length === 0 ? (
                  <UiStatePanel
                    title="No custom personas available"
                    description="This environment currently exposes built-ins only."
                    tone="info"
                    compact
                  />
                ) : (
                  <ul className="va-list va-list-dense">
                    {personaCustom.slice(0, 20).map((persona, index) => (
                      <li key={`persona-custom-${index}`}>
                        <strong>{toText(persona.label, toText(persona.name, `custom-${index + 1}`))}</strong>
                        <span>{toText(persona.slug, toText(persona.id, 'n/a'))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </UiCard>
            </div>
          </UiCard>
        </section>
      </UiDisclosure>

      {studioError ? (
        <div className="va-card">
          <UiStatePanel
            title="Studio action failed"
            description={studioError}
            tone="error"
          />
        </div>
      ) : null}
    </>
  );
}
