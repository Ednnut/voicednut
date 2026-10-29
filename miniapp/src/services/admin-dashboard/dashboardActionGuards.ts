import { toText } from '@/services/admin-dashboard/dashboardPrimitives';
import {
  DASHBOARD_ACTION_CONTRACTS,
  DASHBOARD_ACTION_ALIAS_CONTRACTS,
  DASHBOARD_MODULE_ACTION_IDS,
} from '@/contracts/miniappParityContracts';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateProviderAction(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.channel)) return 'channel is required';
  if (!isNonEmptyString(payload.provider)) return 'provider is required';
  return null;
}

function validateSmsBulkSend(payload: Record<string, unknown>): string | null {
  const recipients = payload.recipients;
  if (!isStringArray(recipients) || recipients.length === 0) {
    return 'recipients must be a non-empty string array';
  }
  if (!isNonEmptyString(payload.message)) return 'message is required';
  return null;
}

function validateSmsScheduleSend(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.to)) return 'to is required';
  if (!isNonEmptyString(payload.message)) return 'message is required';
  if (!isNonEmptyString(payload.scheduled_time)) return 'scheduled_time is required';
  return null;
}

function validateEmailBulkSend(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.recipients) || payload.recipients.length === 0) {
    return 'recipients must be a non-empty array';
  }
  if (
    payload.script_id === undefined
    && payload.subject === undefined
    && payload.html === undefined
    && payload.text === undefined
  ) {
    return 'provide script_id or subject/html/text content';
  }
  return null;
}

function validateUserRoleSet(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.telegram_id)) return 'telegram_id is required';
  const role = toText(payload.role, '').toLowerCase();
  if (!['admin', 'operator', 'viewer'].includes(role)) {
    return 'role must be admin, operator, or viewer';
  }
  if (!isNonEmptyString(payload.reason)) return 'reason is required';
  return null;
}

function validateCallScriptIdPayload(payload: Record<string, unknown>): string | null {
  const id = Number(payload.id);
  if (!Number.isFinite(id) || id <= 0) return 'id must be a positive number';
  return null;
}

function validateCallScriptVersionPayload(payload: Record<string, unknown>): string | null {
  const id = Number(payload.id ?? payload.script_id ?? payload.scriptId);
  if (!Number.isSafeInteger(id) || id <= 0) return 'A valid script id is required';
  if (payload.version !== undefined) {
    const version = Number(payload.version);
    if (!Number.isSafeInteger(version) || version <= 0) return 'A positive script version is required';
  }
  for (const key of ['from_version', 'to_version']) {
    if (payload[key] !== undefined) {
      const version = Number(payload[key]);
      if (!Number.isSafeInteger(version) || version <= 0) return `${key} must be a positive script version`;
    }
  }
  if (payload.from_version !== undefined && payload.to_version !== undefined
    && Number(payload.from_version) === Number(payload.to_version)) {
    return 'Choose two different script versions to compare';
  }
  return null;
}

function validateCallEReconcilePayload(payload: Record<string, unknown>): string | null {
  const localCallId = toText(payload.local_call_id || payload.localCallId, '').trim();
  if (!/^call_e_[0-9a-f-]{36}$/i.test(localCallId)) return 'local_call_id must be a valid VOICEDNUT CALL-E call ID';
  return null;
}

function validateCallEOperationsListPayload(payload: Record<string, unknown>): string | null {
  const validFilter = (value: unknown, allowed: string[]) => value === undefined || value === '' ||
    (typeof value === 'string' && allowed.includes(value));
  if (!validFilter(payload.execution_status, ['queued', 'in_progress', 'completed', 'failed', 'canceled'])) {
    return 'execution_status is invalid';
  }
  if (!validFilter(payload.call_outcome, ['completed', 'no_answer', 'busy', 'declined'])) {
    return 'call_outcome is invalid';
  }
  if (!validFilter(payload.result_status, ['pending', 'available', 'unavailable', 'not_applicable'])) {
    return 'result_status is invalid';
  }
  const query = payload.query;
  if (query !== undefined && query !== '' && (typeof query !== 'string' || !/^[A-Za-z0-9_-]{2,200}$/.test(query.trim()))) {
    return 'query must be a safe call identifier';
  }
  for (const key of ['start_date', 'end_date']) {
    const value = payload[key];
    if (value !== undefined && value !== '' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
      return `${key} must use YYYY-MM-DD`;
    }
  }
  return null;
}

function validateCallerFlagsUpsert(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.phone_number) && !isNonEmptyString(payload.phoneNumber) && !isNonEmptyString(payload.phone)) {
    return 'phone_number is required';
  }
  const status = toText(payload.status, '').toLowerCase();
  if (!['allowed', 'blocked', 'spam'].includes(status)) {
    return 'status must be allowed, blocked, or spam';
  }
  return null;
}

function validateSmsScriptCreate(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.name)) return 'name is required';
  if (!isNonEmptyString(payload.content)) return 'content is required';
  return null;
}

function validateSmsScriptUpdate(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.script_name) && !isNonEmptyString(payload.scriptName) && !isNonEmptyString(payload.id)) {
    return 'script_name is required';
  }
  if (
    payload.description === undefined
    && payload.content === undefined
    && payload.metadata === undefined
  ) {
    return 'at least one update field is required';
  }
  return null;
}

function validateEmailTemplateCreate(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.template_id) && !isNonEmptyString(payload.templateId)) {
    return 'template_id is required';
  }
  if (!isNonEmptyString(payload.subject)) return 'subject is required';
  if (!isNonEmptyString(payload.html) && !isNonEmptyString(payload.text)) {
    return 'html or text is required';
  }
  return null;
}

function validateEmailTemplateUpdate(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.template_id) && !isNonEmptyString(payload.templateId) && !isNonEmptyString(payload.id)) {
    return 'template_id is required';
  }
  if (
    payload.subject === undefined
    && payload.html === undefined
    && payload.text === undefined
  ) {
    return 'at least one update field is required';
  }
  return null;
}

function validateAutomationRunRetry(payload: Record<string, unknown>): string | null {
  if (!isNonEmptyString(payload.run_id) && !isNonEmptyString(payload.runId) && !isNonEmptyString(payload.id)) {
    return 'run_id is required';
  }
  if (payload.payload_overrides !== undefined && !isRecord(payload.payload_overrides)) {
    return 'payload_overrides must be an object';
  }
  return null;
}

const ACTION_GUARDS: Record<string, (payload: Record<string, unknown>) => string | null> = {
  [DASHBOARD_ACTION_CONTRACTS.PROVIDER_SET]: validateProviderAction,
  [DASHBOARD_ACTION_CONTRACTS.PROVIDER_ROLLBACK]: validateProviderAction,
  [DASHBOARD_ACTION_CONTRACTS.PROVIDER_PREFLIGHT]: validateProviderAction,
  [DASHBOARD_ACTION_CONTRACTS.SMS_BULK_SEND]: validateSmsBulkSend,
  [DASHBOARD_ACTION_CONTRACTS.SMS_SCHEDULE_SEND]: validateSmsScheduleSend,
  [DASHBOARD_ACTION_CONTRACTS.EMAIL_BULK_SEND]: validateEmailBulkSend,
  [DASHBOARD_ACTION_CONTRACTS.USERS_ROLE_SET]: validateUserRoleSet,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_UPDATE]: validateCallScriptIdPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_VERSIONS]: validateCallScriptVersionPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_DIFF]: validateCallScriptVersionPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_ROLLBACK]: validateCallScriptVersionPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_SUBMIT_REVIEW]: validateCallScriptIdPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_REVIEW]: validateCallScriptIdPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_PROMOTE_LIVE]: validateCallScriptIdPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_SIMULATE]: validateCallScriptIdPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_CALLE_PREVIEW]: validateCallScriptIdPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_CALLE_CONFIRM]: (payload) => {
    if (!Number.isSafeInteger(Number(payload.template_id)) || Number(payload.template_id) <= 0) return 'template_id is required';
    const destination = payload.destination;
    if (!isNonEmptyString(destination) || !/^\+[1-9]\d{7,14}$/.test(destination.trim())) return 'destination must be E.164';
    const previewFingerprint = payload.preview_fingerprint;
    if (!isNonEmptyString(previewFingerprint) || !/^[a-f0-9]{64}$/i.test(previewFingerprint)) return 'preview_fingerprint is required';
    if (!isRecord(payload.result_schema)) return 'result_schema must be an object';
    return null;
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLE_CALL_RECONCILE]: validateCallEReconcilePayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLE_CALL_REVIEW]: validateCallEReconcilePayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLE_OPS_RECONCILE]: validateCallEReconcilePayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLE_OPS_REVIEW]: validateCallEReconcilePayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLE_CALL_CANCEL]: validateCallEReconcilePayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLE_CALLS_LIST]: validateCallEOperationsListPayload,
  [DASHBOARD_ACTION_CONTRACTS.CALLERFLAGS_UPSERT]: validateCallerFlagsUpsert,
  [DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_CREATE]: validateSmsScriptCreate,
  [DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_UPDATE]: validateSmsScriptUpdate,
  [DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_CREATE]: validateEmailTemplateCreate,
  [DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_UPDATE]: validateEmailTemplateUpdate,
  [DASHBOARD_ACTION_CONTRACTS.AUTOMATION_RUN_RETRY]: validateAutomationRunRetry,
};

const ACTION_ALIASES = DASHBOARD_ACTION_ALIAS_CONTRACTS;

export type DashboardActionRisk = 'safe' | 'caution' | 'danger';
export type DashboardActionResolution = {
  normalizedAction: string;
  actionId: string;
  supported: boolean;
  wasAliased: boolean;
};

export type DashboardActionPolicy = {
  capability?: string;
  risk: DashboardActionRisk;
  confirmTitle?: string;
  confirmTone?: 'default' | 'warning' | 'danger';
  confirmConsequence?: string;
  confirmIrreversible?: boolean;
  confirmLabel?: string;
};

const ACTION_POLICIES: Record<string, DashboardActionPolicy> = {
  [DASHBOARD_ACTION_CONTRACTS.PROVIDER_SET]: {
    capability: 'provider_manage',
    risk: 'danger',
    confirmTitle: 'Confirm provider switch',
    confirmTone: 'danger',
    confirmConsequence: 'Active and new calls may route through a different provider immediately.',
    confirmIrreversible: false,
    confirmLabel: 'Switch Provider',
  },
  [DASHBOARD_ACTION_CONTRACTS.PROVIDER_ROLLBACK]: {
    capability: 'provider_manage',
    risk: 'danger',
    confirmTitle: 'Confirm provider rollback',
    confirmTone: 'danger',
    confirmConsequence: 'Provider routing will be reverted for this channel and traffic behavior will change.',
    confirmIrreversible: false,
    confirmLabel: 'Rollback Provider',
  },
  [DASHBOARD_ACTION_CONTRACTS.PROVIDER_PREFLIGHT]: {
    capability: 'provider_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.PROVIDER_GET]: {
    capability: 'provider_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.RUNTIME_MAINTENANCE_ENABLE]: {
    capability: 'dashboard_view',
    risk: 'danger',
    confirmTitle: 'Confirm maintenance mode',
    confirmTone: 'danger',
    confirmConsequence: 'Runtime maintenance mode can interrupt outbound operations and automated flows.',
    confirmIrreversible: false,
    confirmLabel: 'Enable Maintenance',
  },
  [DASHBOARD_ACTION_CONTRACTS.RUNTIME_MAINTENANCE_DISABLE]: {
    capability: 'dashboard_view',
    risk: 'danger',
    confirmTitle: 'Confirm maintenance reset',
    confirmTone: 'danger',
    confirmConsequence: 'Disabling maintenance re-opens execution paths for live traffic.',
    confirmIrreversible: false,
    confirmLabel: 'Disable Maintenance',
  },
  [DASHBOARD_ACTION_CONTRACTS.RUNTIME_CANARY_SET]: {
    capability: 'dashboard_view',
    risk: 'caution',
    confirmTitle: 'Confirm canary override',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.RUNTIME_CANARY_CLEAR]: {
    capability: 'dashboard_view',
    risk: 'caution',
    confirmTitle: 'Confirm canary reset',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMS_BULK_SEND]: {
    capability: 'sms_bulk_manage',
    risk: 'danger',
    confirmTitle: 'Confirm bulk SMS send',
    confirmTone: 'danger',
    confirmConsequence: 'Messages will be queued for recipients and may trigger billable provider usage.',
    confirmIrreversible: true,
    confirmLabel: 'Queue SMS Batch',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMS_SCHEDULE_SEND]: {
    capability: 'sms_bulk_manage',
    risk: 'danger',
    confirmTitle: 'Confirm scheduled SMS',
    confirmTone: 'danger',
    confirmConsequence: 'Scheduled messages will execute automatically at the configured time.',
    confirmIrreversible: true,
    confirmLabel: 'Schedule SMS',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAIL_BULK_SEND]: {
    capability: 'email_bulk_manage',
    risk: 'danger',
    confirmTitle: 'Confirm bulk email send',
    confirmTone: 'danger',
    confirmConsequence: 'Email jobs will queue and may contact all selected recipients.',
    confirmIrreversible: true,
    confirmLabel: 'Queue Email Batch',
  },
  [DASHBOARD_ACTION_CONTRACTS.USERS_ROLE_SET]: {
    capability: 'users_manage',
    risk: 'danger',
    confirmTitle: 'Confirm role update',
    confirmTone: 'danger',
    confirmConsequence: 'User permissions will change immediately after this action.',
    confirmIrreversible: false,
    confirmLabel: 'Apply Role Change',
  },
  [DASHBOARD_ACTION_CONTRACTS.DLQ_CALL_REPLAY]: {
    capability: 'dashboard_view',
    risk: 'caution',
    confirmTitle: 'Confirm call DLQ replay',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.DLQ_EMAIL_REPLAY]: {
    capability: 'dashboard_view',
    risk: 'caution',
    confirmTitle: 'Confirm email DLQ replay',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_UPDATE]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Confirm script update',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_VERSIONS]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_DIFF]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_ROLLBACK]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Restore an earlier agent version',
    confirmTone: 'warning',
    confirmConsequence: 'The selected saved definition will be restored as a new draft version. It will not become live automatically.',
    confirmLabel: 'Restore Draft Version',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_SUBMIT_REVIEW]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Confirm review submission',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_REVIEW]: {
    capability: 'caller_flags_manage',
    risk: 'danger',
    confirmTitle: 'Confirm script review decision',
    confirmTone: 'danger',
    confirmConsequence: 'This review decision updates governance state for the selected script.',
    confirmIrreversible: false,
    confirmLabel: 'Apply Review Decision',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_PROMOTE_LIVE]: {
    capability: 'caller_flags_manage',
    risk: 'danger',
    confirmTitle: 'Confirm live promotion',
    confirmTone: 'danger',
    confirmConsequence: 'The selected script will become live for production call handling.',
    confirmIrreversible: false,
    confirmLabel: 'Promote Live',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_SIMULATE]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_CALLE_PREVIEW]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLSCRIPT_CALLE_CONFIRM]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Record CALL-E operator confirmation',
    confirmTone: 'warning',
    confirmConsequence: 'This records your confirmation of the exact preview. It will not place a call.',
    confirmLabel: 'Record Confirmation',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLE_STATUS]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLE_CALLS_LIST]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLE_CALL_RECONCILE]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLE_CALL_REVIEW]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Review CALL-E result and transcript',
    confirmTone: 'warning',
    confirmConsequence: 'This loads private call content for authorized business operators. Handle transcript and result data as sensitive information.',
    confirmLabel: 'Review call content',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLE_OPS_RECONCILE]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLE_OPS_REVIEW]: {
    capability: 'dashboard_view',
    risk: 'caution',
    confirmTitle: 'Review CALL-E result and transcript',
    confirmTone: 'warning',
    confirmConsequence: 'This loads private call content for authorized business operators. Handle transcript and result data as sensitive information.',
    confirmLabel: 'Review call content',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLE_CALL_CANCEL]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Cancel queued CALL-E task call',
    confirmTone: 'warning',
    confirmConsequence: 'CALL-E will reject cancellation after provider submission starts. This cannot hang up an active call.',
    confirmLabel: 'Cancel queued call',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_LIST]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_GET]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_CREATE]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Confirm SMS script creation',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_UPDATE]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Confirm SMS script update',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMSSCRIPT_DELETE]: {
    capability: 'caller_flags_manage',
    risk: 'danger',
    confirmTitle: 'Confirm SMS script deletion',
    confirmTone: 'danger',
    confirmConsequence: 'The selected SMS script will be removed and no longer available in operator flows.',
    confirmIrreversible: true,
    confirmLabel: 'Delete SMS Script',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_LIST]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_GET]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_CREATE]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Confirm email template creation',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_UPDATE]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Confirm email template update',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_DELETE]: {
    capability: 'caller_flags_manage',
    risk: 'danger',
    confirmTitle: 'Confirm email template deletion',
    confirmTone: 'danger',
    confirmConsequence: 'The selected email template will be removed and cannot be reused.',
    confirmIrreversible: true,
    confirmLabel: 'Delete Email Template',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLERFLAGS_LIST]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLERFLAGS_UPSERT]: {
    capability: 'caller_flags_manage',
    risk: 'caution',
    confirmTitle: 'Confirm caller flag update',
    confirmTone: 'warning',
  },
  [DASHBOARD_ACTION_CONTRACTS.PERSONA_LIST]: {
    capability: 'caller_flags_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLS_LIST]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLS_SEARCH]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLS_GET]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CALLS_EVENTS]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMS_MESSAGES_RECENT]: {
    capability: 'users_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMS_MESSAGES_CONVERSATION]: {
    capability: 'users_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMS_MESSAGE_STATUS]: {
    capability: 'sms_bulk_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMS_STATS]: {
    capability: 'users_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.SMS_BULK_STATUS]: {
    capability: 'users_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAIL_MESSAGE_STATUS]: {
    capability: 'email_bulk_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAIL_BULK_STATS]: {
    capability: 'email_bulk_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAIL_PREVIEW]: {
    capability: 'email_bulk_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.EMAIL_PROVIDER_HEALTH]: {
    capability: 'email_bulk_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.CRM_HEALTH]: {
    capability: 'provider_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.AUTOMATION_RULES_LIST]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.AUTOMATION_PREVIEW]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.AUTOMATION_RUNS_LIST]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.AUTOMATION_RUN_RETRY]: {
    capability: 'provider_manage',
    risk: 'danger',
    confirmTitle: 'Confirm automation retry',
    confirmTone: 'danger',
    confirmConsequence: 'The selected post-call automation may send email, sync CRM data, or create a support task again.',
    confirmIrreversible: false,
    confirmLabel: 'Retry Automation',
  },
  [DASHBOARD_ACTION_CONTRACTS.USERS_LIST]: {
    capability: 'users_manage',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.AUDIT_FEED]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
  [DASHBOARD_ACTION_CONTRACTS.INCIDENTS_SUMMARY]: {
    capability: 'dashboard_view',
    risk: 'safe',
  },
};

const EXTRA_SUPPORTED_ACTION_IDS = [
  ...DASHBOARD_MODULE_ACTION_IDS,
  DASHBOARD_ACTION_CONTRACTS.SMS_STATS,
  DASHBOARD_ACTION_CONTRACTS.SMS_BULK_STATUS,
  DASHBOARD_ACTION_CONTRACTS.EMAIL_MESSAGE_STATUS,
  DASHBOARD_ACTION_CONTRACTS.EMAIL_BULK_STATS,
  DASHBOARD_ACTION_CONTRACTS.EMAIL_BULK_JOB,
  DASHBOARD_ACTION_CONTRACTS.EMAIL_BULK_HISTORY,
  DASHBOARD_ACTION_CONTRACTS.PROVIDER_GET,
  DASHBOARD_ACTION_CONTRACTS.RUNBOOK_SMS_RECONCILE,
  DASHBOARD_ACTION_CONTRACTS.RUNBOOK_PAYMENT_RECONCILE,
  DASHBOARD_ACTION_CONTRACTS.RUNBOOK_PROVIDER_PREFLIGHT,
];

const STATIC_SUPPORTED_ACTION_IDS = new Set<string>([
  ...Object.keys(ACTION_GUARDS),
  ...Object.keys(ACTION_POLICIES),
  ...EXTRA_SUPPORTED_ACTION_IDS,
]);

let serverSupportedActionIds: Set<string> | null = null;

function normalizeDashboardAction(action: string): string {
  return String(action || '').trim().toLowerCase();
}

function normalizeDashboardActionId(action: string): string {
  const normalizedAction = normalizeDashboardAction(action);
  const directAlias = ACTION_ALIASES[normalizedAction];
  if (directAlias) return directAlias;

  // Support bot callback payload patterns such as EMAIL_STATUS:<message_id>.
  const prefixAction = normalizedAction.split(':')[0];
  const prefixAlias = ACTION_ALIASES[prefixAction];
  if (prefixAlias) return prefixAlias;

  return normalizedAction;
}

function isSupportedDashboardActionId(actionId: string): boolean {
  const supportedActionSet = serverSupportedActionIds || STATIC_SUPPORTED_ACTION_IDS;
  return supportedActionSet.has(actionId);
}

export function setDashboardSupportedActions(actions: unknown): void {
  if (!Array.isArray(actions)) {
    serverSupportedActionIds = null;
    return;
  }
  const normalizedActions = new Set<string>();
  for (const action of actions) {
    if (typeof action !== 'string') continue;
    const normalizedActionId = normalizeDashboardActionId(action);
    if (normalizedActionId) {
      normalizedActions.add(normalizedActionId);
    }
  }
  // Respect explicit server contracts, including an intentionally empty allow-list.
  serverSupportedActionIds = normalizedActions;
}

export function resolveDashboardAction(action: string): DashboardActionResolution {
  const normalizedAction = normalizeDashboardAction(action);
  if (!normalizedAction) {
    return {
      normalizedAction,
      actionId: '',
      supported: false,
      wasAliased: false,
    };
  }
  const actionId = normalizeDashboardActionId(normalizedAction);
  return {
    normalizedAction,
    actionId,
    supported: isSupportedDashboardActionId(actionId),
    wasAliased: actionId !== normalizedAction,
  };
}

export function resolveDashboardActionId(action: string): string {
  return resolveDashboardAction(action).actionId;
}

export function isDashboardActionSupported(action: string): boolean {
  return resolveDashboardAction(action).supported;
}

export function validateDashboardActionPayload(action: string, payload: unknown): string | null {
  if (!isRecord(payload)) {
    return 'payload must be an object';
  }
  const actionResolution = resolveDashboardAction(action);
  const guard = ACTION_GUARDS[actionResolution.actionId];
  if (!guard) return null;
  return guard(payload);
}

export function getDashboardActionPolicy(action: string): DashboardActionPolicy {
  const actionResolution = resolveDashboardAction(action);
  return ACTION_POLICIES[actionResolution.actionId] || { risk: 'safe' };
}
