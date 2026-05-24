import { useEffect, useMemo, useState } from 'react';
import { useLaunchParams } from '@tma.js/sdk-react';

import {
  UiBadge,
  UiButton,
  UiCard,
  UiInput,
  UiMetricTile,
  UiSelect,
  UiStatePanel,
} from '@/components/ui/AdminPrimitives';
import { DASHBOARD_ACTION_CONTRACTS } from '@/contracts/miniappParityContracts';
import type {
  CallbackTaskRow,
  CallLogRow,
  DashboardVm,
  DlqEmailRow,
  EmailJob,
  ReviewCaseRow,
} from './types';

type BadgeVariant = 'meta' | 'info' | 'success' | 'warning' | 'error';
type CommandView =
  | 'overview'
  | 'customers'
  | 'automation'
  | 'templates'
  | 'health'
  | 'timeline'
  | 'intelligence'
  | 'approvals';
type AutomationRow = Record<string, unknown>;
type HealthCheckRow = {
  label: string;
  status: string;
  detail: string;
};
type TimelineRow = {
  id: string;
  kind: string;
  title: string;
  detail: string;
  at: unknown;
  status: string;
};
type CustomerProfile = {
  id: string;
  label: string;
  phone: string;
  email: string;
  status: string;
  lastAt: unknown;
  callCount: number;
  emailCount: number;
  riskCount: number;
  automationCount: number;
  intent: string;
  paymentState: string;
  bookingState: string;
  score: number;
};
type TemplateSuggestion = {
  id: string;
  name: string;
  reason: string;
  trigger: string;
  lifecycle: string;
  score: number;
  source: string;
};
type IntelligenceRow = {
  id: string;
  title: string;
  detail: string;
  priority: BadgeVariant;
  status: string;
  actionLabel?: string;
  view?: CommandView;
};
type DeepLinkRoute = {
  label: string;
  token: string;
  detail: string;
  view: CommandView;
};

type CommandCenterPanelProps = {
  busyAction: string;
  loading: boolean;
  invokeAction: DashboardVm['invokeAction'];
  runAction: DashboardVm['runAction'];
  formatTime: DashboardVm['formatTime'];
  toText: DashboardVm['toText'];
  toInt: DashboardVm['toInt'];
  callLogs: CallLogRow[];
  emailJobs: EmailJob[];
  emailDlq: DlqEmailRow[];
};

const COMMAND_TABS: Array<{ id: CommandView; label: string }> = [
  { id: 'overview', label: 'Live' },
  { id: 'customers', label: 'Customers' },
  { id: 'automation', label: 'Studio' },
  { id: 'templates', label: 'Templates' },
  { id: 'health', label: 'Health' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'intelligence', label: 'Intel' },
  { id: 'approvals', label: 'Queue' },
];

const TEMPLATE_LIBRARY: TemplateSuggestion[] = [
  {
    id: 'receipt-payment-succeeded',
    name: 'Payment receipt and next step',
    reason: 'Best for successful payments and paid booking follow-up.',
    trigger: 'payment.succeeded',
    lifecycle: 'approved',
    score: 94,
    source: 'recommended',
  },
  {
    id: 'booking-link-missed',
    name: 'Missed appointment booking link',
    reason: 'Best for callers who missed or need to reschedule a booking.',
    trigger: 'booking.missed',
    lifecycle: 'approved',
    score: 91,
    source: 'recommended',
  },
  {
    id: 'case-summary-escalation',
    name: 'Escalation case summary',
    reason: 'Best for support handoff after a high-risk call or complaint.',
    trigger: 'escalation.created',
    lifecycle: 'approved',
    score: 88,
    source: 'recommended',
  },
  {
    id: 'general-follow-up-completed',
    name: 'Call completed follow-up',
    reason: 'Best default when no payment, booking, or escalation state dominates.',
    trigger: 'call.completed',
    lifecycle: 'approved',
    score: 82,
    source: 'recommended',
  },
];

const ERROR_STATUSES = new Set([
  'failed',
  'failure',
  'error',
  'bounced',
  'blocked',
  'dropped',
  'spam_report',
  'unhealthy',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRows(payload: unknown, keys: string[]): AutomationRow[] {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  for (const key of keys) {
    const rootValue = root[key];
    if (Array.isArray(rootValue)) return rootValue as AutomationRow[];
    const dataValue = data[key];
    if (Array.isArray(dataValue)) return dataValue as AutomationRow[];
  }
  if (Array.isArray(payload)) return payload as AutomationRow[];
  return [];
}

function toDisplayText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value || fallback;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value) || fallback;
  } catch {
    return fallback;
  }
}

function firstDisplayText(values: unknown[], fallback = ''): string {
  for (const value of values) {
    const text = toDisplayText(value).trim();
    if (text) return text;
  }
  return fallback;
}

function readStatus(row: Record<string, unknown>, fallback = 'unknown'): string {
  const value = row.status ?? row.state ?? row.result ?? row.ok ?? row.healthy ?? row.success;
  if (typeof value === 'boolean') return value ? 'healthy' : 'unhealthy';
  const label = toDisplayText(value, fallback).trim().toLowerCase();
  return label || fallback;
}

function statusVariant(status: unknown): BadgeVariant {
  const label = toDisplayText(status).trim().toLowerCase();
  if (!label) return 'meta';
  if (ERROR_STATUSES.has(label)) return 'error';
  if (['degraded', 'pending', 'queued', 'running', 'retrying', 'warning'].includes(label)) {
    return 'warning';
  }
  if (['complete', 'completed', 'delivered', 'healthy', 'ok', 'ready', 'sent', 'success', 'succeeded'].includes(label)) {
    return 'success';
  }
  return 'info';
}

function shortId(value: unknown): string {
  const text = toDisplayText(value).trim();
  if (!text) return 'n/a';
  if (text.length <= 18) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function readHealthStatus(payload: Record<string, unknown>): string {
  return readStatus(payload, 'not checked');
}

function readHealthChecks(payload: Record<string, unknown>): HealthCheckRow[] {
  const checks = Array.isArray(payload.checks)
    ? payload.checks
    : Array.isArray(payload.results)
      ? payload.results
      : [];
  if (checks.length > 0) {
    return checks.map((check, index) => {
      const row = asRecord(check);
      return {
        label: firstDisplayText([row.name, row.label, row.key], `Check ${index + 1}`),
        status: readStatus(row),
        detail: firstDisplayText([row.message, row.detail, row.reason, row.value]),
      };
    });
  }

  const summary = asRecord(payload.summary);
  const source = Object.keys(summary).length > 0 ? summary : payload;
  return Object.entries(source)
    .filter(([key, value]) => !['request_id', 'success', 'ok', 'healthy', 'status'].includes(key) && value !== undefined)
    .slice(0, 6)
    .map(([key, value]) => ({
      label: key.replace(/_/g, ' '),
      status: typeof value === 'boolean' ? (value ? 'ok' : 'warning') : 'info',
      detail: toDisplayText(value),
    }));
}

function buildTimelineRows({
  automationRuns,
  callLogs,
  emailDlq,
  emailJobs,
  toInt,
  toText,
}: {
  automationRuns: AutomationRow[];
  callLogs: CallLogRow[];
  emailDlq: DlqEmailRow[];
  emailJobs: EmailJob[];
  toInt: DashboardVm['toInt'];
  toText: DashboardVm['toText'];
}): TimelineRow[] {
  const rows: TimelineRow[] = [];
  callLogs.slice(0, 8).forEach((call, index) => {
    const callSid = toText(call.call_sid, `call-${index + 1}`);
    const status = toText(call.status_normalized, toText(call.status, 'unknown'));
    rows.push({
      id: `call-${callSid}-${index}`,
      kind: 'Call',
      title: `${toText(call.phone_number, 'Unknown caller')} ${status}`,
      detail: `Runtime ${toText(call.voice_runtime, 'default')} | ${toInt(call.duration)}s`,
      at: call.updated_at || call.created_at,
      status,
    });
  });

  emailJobs.slice(0, 8).forEach((job, index) => {
    const jobId = toText(job.job_id, `job-${index + 1}`);
    const status = toText(job.status, 'unknown');
    rows.push({
      id: `email-${jobId}-${index}`,
      kind: 'Email',
      title: `${status} follow-up job`,
      detail: `${toInt(job.sent)}/${toInt(job.total)} sent | ${toInt(job.delivered)} delivered`,
      at: job.updated_at || job.created_at,
      status,
    });
  });

  emailDlq.slice(0, 8).forEach((row, index) => {
    rows.push({
      id: `dlq-email-${toText(row.id, String(index))}-${index}`,
      kind: 'Delivery Risk',
      title: toText(row.reason, 'Email delivery blocked'),
      detail: `Message ${shortId(row.message_id)}`,
      at: undefined,
      status: 'failed',
    });
  });

  automationRuns.slice(0, 8).forEach((run, index) => {
    const runId = toText(run.run_id || run.id, `run-${index + 1}`);
    const status = readStatus(run);
    rows.push({
      id: `automation-${runId}-${index}`,
      kind: 'Automation',
      title: `${toText(run.rule_id, 'Rule')} ${status}`,
      detail: `${toText(run.trigger_event || run.trigger, 'trigger')} | ${shortId(runId)}`,
      at: run.updated_at || run.created_at || run.completed_at,
      status,
    });
  });

  return rows
    .sort((left, right) => {
      const leftTime = Date.parse(toDisplayText(left.at)) || 0;
      const rightTime = Date.parse(toDisplayText(right.at)) || 0;
      return rightTime - leftTime;
    })
    .slice(0, 18);
}

function readTimestamp(...values: unknown[]): number {
  for (const value of values) {
    const timestamp = Date.parse(toDisplayText(value));
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return 0;
}

function normalizeDeepLinkSegment(value: unknown): string {
  const text = toDisplayText(value).trim();
  if (/^[\w-]{0,512}$/.test(text)) return text;
  return text.replace(/[^\w-]/g, '').slice(0, 512);
}

function resolveInitialCommandView(startParam: string): { view: CommandView; customerId: string } {
  const normalized = normalizeDeepLinkSegment(startParam).toLowerCase();
  if (normalized.startsWith('customer_')) {
    return { view: 'customers', customerId: normalized.replace(/^customer_/, '') };
  }
  if (normalized.startsWith('timeline_')) {
    return { view: 'timeline', customerId: normalized.replace(/^timeline_/, '') };
  }

  const routeMap: Record<string, CommandView> = {
    live: 'overview',
    command: 'overview',
    overview: 'overview',
    customers: 'customers',
    customer: 'customers',
    automation: 'automation',
    studio: 'automation',
    templates: 'templates',
    template: 'templates',
    health: 'health',
    timeline: 'timeline',
    intel: 'intelligence',
    intelligence: 'intelligence',
    queue: 'approvals',
    approvals: 'approvals',
  };
  return { view: routeMap[normalized] || 'overview', customerId: '' };
}

function buildCustomerProfiles({
  automationRuns,
  callLogs,
  emailDlq,
  emailJobs,
  toInt,
  toText,
}: {
  automationRuns: AutomationRow[];
  callLogs: CallLogRow[];
  emailDlq: DlqEmailRow[];
  emailJobs: EmailJob[];
  toInt: DashboardVm['toInt'];
  toText: DashboardVm['toText'];
}): CustomerProfile[] {
  const profiles = new Map<string, CustomerProfile>();

  const ensureProfile = (id: string, label: string): CustomerProfile => {
    const safeId = normalizeDeepLinkSegment(id || label || 'customer');
    const existing = profiles.get(safeId);
    if (existing) return existing;
    const created: CustomerProfile = {
      id: safeId,
      label,
      phone: '',
      email: '',
      status: 'active',
      lastAt: undefined,
      callCount: 0,
      emailCount: 0,
      riskCount: 0,
      automationCount: 0,
      intent: 'follow-up',
      paymentState: 'pending',
      bookingState: 'pending',
      score: 100,
    };
    profiles.set(safeId, created);
    return created;
  };

  callLogs.forEach((call, index) => {
    const phone = toText(call.phone_number, '');
    const callSid = toText(call.call_sid, `call-${index + 1}`);
    const profile = ensureProfile(phone ? `phone_${phone.replace(/[^\dA-Za-z_-]/g, '')}` : `call_${callSid}`, phone || `Call ${shortId(callSid)}`);
    const status = toText(call.status_normalized, toText(call.status, 'unknown')).toLowerCase();
    const intent = firstDisplayText([
      call.call_disposition_label,
      call.call_disposition_reason,
      call.ended_reason,
      call.direction,
      status,
    ], profile.intent);
    const timestamp = readTimestamp(call.updated_at, call.created_at);
    const currentTimestamp = readTimestamp(profile.lastAt);
    profile.phone = phone || profile.phone;
    profile.status = status || profile.status;
    profile.intent = intent;
    profile.callCount += 1;
    profile.lastAt = timestamp >= currentTimestamp ? (call.updated_at || call.created_at || profile.lastAt) : profile.lastAt;
    if (ERROR_STATUSES.has(status) || status.includes('failed')) profile.riskCount += 1;
  });

  if (emailJobs.length > 0 || emailDlq.length > 0) {
    const profile = ensureProfile('email_ops_queue', 'Email follow-up queue');
    profile.emailCount = emailJobs.reduce((total, job) => total + Math.max(toInt(job.total), 1), 0);
    profile.riskCount += emailDlq.length;
    profile.status = emailDlq.length > 0 ? 'delivery risk' : toText(emailJobs[0]?.status, 'queued');
    profile.lastAt = emailJobs[0]?.updated_at || emailJobs[0]?.created_at || profile.lastAt;
    profile.intent = 'delivery follow-up';
  }

  if (automationRuns.length > 0) {
    const profile = ensureProfile('automation_ops_queue', 'Automation run queue');
    profile.automationCount = automationRuns.length;
    profile.riskCount += automationRuns.filter((run) => ERROR_STATUSES.has(readStatus(run))).length;
    profile.status = profile.riskCount > 0 ? 'attention' : 'ready';
    profile.intent = 'workflow recovery';
    profile.lastAt = automationRuns[0]?.updated_at || automationRuns[0]?.created_at || profile.lastAt;
  }

  return Array.from(profiles.values())
    .map((profile) => ({
      ...profile,
      score: Math.max(38, Math.min(100, 100 - (profile.riskCount * 14) + Math.min(profile.callCount + profile.emailCount, 8))),
      paymentState: profile.intent.toLowerCase().includes('payment') ? 'succeeded' : profile.paymentState,
      bookingState: profile.intent.toLowerCase().includes('booking') ? 'needs link' : profile.bookingState,
    }))
    .sort((left, right) => readTimestamp(right.lastAt) - readTimestamp(left.lastAt))
    .slice(0, 16);
}

function buildTemplateSuggestions({
  emailTemplates,
  matchedRules,
  previewTrigger,
  selectedCustomer,
}: {
  emailTemplates: AutomationRow[];
  matchedRules: AutomationRow[];
  previewTrigger: string;
  selectedCustomer?: CustomerProfile;
}): TemplateSuggestion[] {
  const apiSuggestions = emailTemplates.slice(0, 10).map((row, index) => {
    const id = firstDisplayText([row.template_id, row.id, row.slug], `template-${index + 1}`);
    const trigger = firstDisplayText([row.trigger_event, row.trigger, row.category, row.type], previewTrigger);
    const lifecycle = firstDisplayText([row.lifecycle_state, row.lifecycle, row.status], 'approved');
    const name = firstDisplayText([row.name, row.title, row.subject], `Template ${index + 1}`);
    const ruleMatchBoost = matchedRules.some((rule) => {
      const ruleTrigger = firstDisplayText([rule.trigger_event, rule.trigger]).toLowerCase();
      return ruleTrigger && trigger.toLowerCase().includes(ruleTrigger);
    }) ? 8 : 0;
    const customerBoost = selectedCustomer?.intent && name.toLowerCase().includes(selectedCustomer.intent.toLowerCase())
      ? 6
      : 0;
    return {
      id,
      name,
      reason: firstDisplayText([row.description, row.summary, row.reason], `Matches ${trigger} context.`),
      trigger,
      lifecycle,
      score: Math.min(99, 78 + ruleMatchBoost + customerBoost),
      source: 'approved',
    };
  });

  const fallback = TEMPLATE_LIBRARY.map((template) => {
    const triggerBoost = template.trigger === previewTrigger ? 4 : 0;
    const customerBoost = selectedCustomer?.intent.toLowerCase().includes(template.trigger.split('.')[0]) ? 3 : 0;
    return { ...template, score: Math.min(99, template.score + triggerBoost + customerBoost) };
  });

  return [...apiSuggestions, ...fallback]
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
}

function buildIntelligenceRows({
  approvalCount,
  callLogs,
  crmStatus,
  deliveryRate,
  emailDlq,
  failedAutomationRuns,
  providerStatus,
}: {
  approvalCount: number;
  callLogs: CallLogRow[];
  crmStatus: string;
  deliveryRate: number | null;
  emailDlq: DlqEmailRow[];
  failedAutomationRuns: AutomationRow[];
  providerStatus: string;
}): IntelligenceRow[] {
  const rows: IntelligenceRow[] = [];
  if (ERROR_STATUSES.has(providerStatus.toLowerCase()) || providerStatus === 'not checked') {
    rows.push({
      id: 'provider-health',
      title: 'Provider readiness needs validation',
      detail: 'Run dry-run health before production follow-up emails.',
      priority: providerStatus === 'not checked' ? 'warning' : 'error',
      status: providerStatus,
      actionLabel: 'Check Health',
      view: 'health',
    });
  }
  if (ERROR_STATUSES.has(crmStatus.toLowerCase())) {
    rows.push({
      id: 'crm-health',
      title: 'CRM sync is not healthy',
      detail: 'Contact records may drift from voice-agent logs until sync is restored.',
      priority: 'error',
      status: crmStatus,
      actionLabel: 'Open Health',
      view: 'health',
    });
  }
  if (failedAutomationRuns.length > 0) {
    rows.push({
      id: 'failed-automation',
      title: 'Automation retries available',
      detail: `${failedAutomationRuns.length} failed workflow runs can be retried or inspected.`,
      priority: 'warning',
      status: `${failedAutomationRuns.length} failed`,
      actionLabel: 'Open Studio',
      view: 'automation',
    });
  }
  if (emailDlq.length > 0) {
    rows.push({
      id: 'email-dlq',
      title: 'Delivery risk queue is open',
      detail: `${emailDlq.length} blocked follow-up emails need review before customer outreach is trusted.`,
      priority: 'warning',
      status: `${emailDlq.length} DLQ`,
      actionLabel: 'Open Queue',
      view: 'approvals',
    });
  }
  if (approvalCount > 0) {
    rows.push({
      id: 'approval-queue',
      title: 'Operator decisions pending',
      detail: 'Review cases, callbacks, delivery failures, and failed rules are grouped in the queue.',
      priority: 'info',
      status: `${approvalCount} open`,
      actionLabel: 'Open Queue',
      view: 'approvals',
    });
  }
  if (deliveryRate !== null && deliveryRate < 85) {
    rows.push({
      id: 'delivery-rate',
      title: 'Email delivery rate is below target',
      detail: `Current delivery rate is ${deliveryRate}%. Inspect templates, sender identity, and suppression lists.`,
      priority: 'warning',
      status: `${deliveryRate}%`,
      actionLabel: 'Open Templates',
      view: 'templates',
    });
  }
  if (callLogs.length === 0) {
    rows.push({
      id: 'no-call-context',
      title: 'No recent call context loaded',
      detail: 'Customer timeline and template intelligence improve once call logs are available.',
      priority: 'meta',
      status: 'waiting',
    });
  }
  return rows.slice(0, 8);
}

export function CommandCenterPanel({
  busyAction,
  loading,
  invokeAction,
  runAction,
  formatTime,
  toText,
  toInt,
  callLogs,
  emailJobs,
  emailDlq,
}: CommandCenterPanelProps) {
  const launchParams = useLaunchParams();
  const startParam = normalizeDeepLinkSegment(launchParams.tgWebAppStartParam);
  const [activeView, setActiveView] = useState<CommandView>('overview');
  const [automationRules, setAutomationRules] = useState<AutomationRow[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRow[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<AutomationRow[]>([]);
  const [providerHealth, setProviderHealth] = useState<Record<string, unknown>>({});
  const [crmHealth, setCrmHealth] = useState<Record<string, unknown>>({});
  const [reviewCases, setReviewCases] = useState<ReviewCaseRow[]>([]);
  const [callbackTasks, setCallbackTasks] = useState<CallbackTaskRow[]>([]);
  const [previewResult, setPreviewResult] = useState<Record<string, unknown>>({});
  const [commandError, setCommandError] = useState<string>('');
  const [localBusy, setLocalBusy] = useState<string>('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [copiedToken, setCopiedToken] = useState<string>('');
  const [emailProvider, setEmailProvider] = useState<string>('sendgrid');
  const [crmProvider, setCrmProvider] = useState<string>('stub');
  const [previewTrigger, setPreviewTrigger] = useState<string>('payment.succeeded');
  const [previewEmail, setPreviewEmail] = useState<string>('customer@example.com');

  const isBusy = loading || Boolean(busyAction) || Boolean(localBusy);
  const failedAutomationRuns = automationRuns.filter((run) => ERROR_STATUSES.has(readStatus(run)));
  const providerStatus = readHealthStatus(providerHealth);
  const crmStatus = readHealthStatus(crmHealth);
  const openReviewCount = reviewCases.filter((row) => {
    const status = toText(row.status, 'open').toLowerCase();
    return status === 'open' || status === 'pending';
  }).length;
  const openCallbackCount = callbackTasks.filter((row) => {
    const status = toText(row.status, 'open').toLowerCase();
    return status === 'open' || status === 'pending' || status === 'queued';
  }).length;
  const approvalCount = openReviewCount + openCallbackCount + emailDlq.length + failedAutomationRuns.length;
  const matchedRules = asRows(previewResult, ['matched_rules', 'rules']);
  const deliveryTotal = emailJobs.reduce((total, job) => total + toInt(job.total), 0);
  const deliverySuccess = emailJobs.reduce((total, job) => total + toInt(job.delivered), 0);
  const deliveryRate = deliveryTotal > 0 ? Math.round((deliverySuccess / deliveryTotal) * 100) : null;
  const timelineRows = useMemo(
    () => buildTimelineRows({ automationRuns, callLogs, emailDlq, emailJobs, toInt, toText }),
    [automationRuns, callLogs, emailDlq, emailJobs, toInt, toText],
  );
  const customerProfiles = useMemo(
    () => buildCustomerProfiles({ automationRuns, callLogs, emailDlq, emailJobs, toInt, toText }),
    [automationRuns, callLogs, emailDlq, emailJobs, toInt, toText],
  );
  const selectedCustomer = customerProfiles.find((profile) => profile.id === selectedCustomerId) || customerProfiles[0];
  const customerTimelineRows = useMemo(() => {
    if (!selectedCustomer) return timelineRows.slice(0, 8);
    const tokens = [selectedCustomer.id, selectedCustomer.phone, selectedCustomer.email, selectedCustomer.label]
      .map((token) => token.toLowerCase())
      .filter(Boolean);
    const matches = timelineRows.filter((row) => {
      const haystack = `${row.id} ${row.title} ${row.detail}`.toLowerCase();
      return tokens.some((token) => token && haystack.includes(token));
    });
    return (matches.length > 0 ? matches : timelineRows).slice(0, 8);
  }, [selectedCustomer, timelineRows]);
  const templateSuggestions = useMemo(
    () => buildTemplateSuggestions({ emailTemplates, matchedRules, previewTrigger, selectedCustomer }),
    [emailTemplates, matchedRules, previewTrigger, selectedCustomer],
  );
  const intelligenceRows = useMemo(
    () => buildIntelligenceRows({
      approvalCount,
      callLogs,
      crmStatus,
      deliveryRate,
      emailDlq,
      failedAutomationRuns,
      providerStatus,
    }),
    [approvalCount, callLogs, crmStatus, deliveryRate, emailDlq, failedAutomationRuns, providerStatus],
  );
  const deepLinkRoutes = useMemo<DeepLinkRoute[]>(() => [
    {
      label: 'Live operations',
      token: 'live',
      detail: 'Open directly into the command center summary.',
      view: 'overview',
    },
    {
      label: 'Customer context',
      token: selectedCustomer ? `customer_${selectedCustomer.id}` : 'customers',
      detail: 'Jump to the active customer profile and their timeline.',
      view: 'customers',
    },
    {
      label: 'Automation studio',
      token: 'automation',
      detail: 'Open rules, previews, and retryable runs.',
      view: 'automation',
    },
    {
      label: 'Provider health',
      token: 'health',
      detail: 'Open SendGrid and CRM readiness checks.',
      view: 'health',
    },
  ], [selectedCustomer]);

  useEffect(() => {
    const route = resolveInitialCommandView(startParam);
    setActiveView(route.view);
    if (route.customerId) setSelectedCustomerId(route.customerId);
  }, [startParam]);

  useEffect(() => {
    if (!selectedCustomerId && customerProfiles[0]) {
      setSelectedCustomerId(customerProfiles[0].id);
    }
  }, [customerProfiles, selectedCustomerId]);

  const runCommand = async (label: string, action: () => Promise<void>): Promise<void> => {
    setCommandError('');
    setLocalBusy(label);
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : toDisplayText(error, 'Command failed.');
      setCommandError(message);
    } finally {
      setLocalBusy('');
    }
  };

  const loadAutomation = async (): Promise<void> => {
    await runCommand('Loading automation', async () => {
      const [rulesPayload, runsPayload] = await Promise.all([
        invokeAction(DASHBOARD_ACTION_CONTRACTS.AUTOMATION_RULES_LIST, { limit: 20 }),
        invokeAction(DASHBOARD_ACTION_CONTRACTS.AUTOMATION_RUNS_LIST, { limit: 12 }),
      ]);
      setAutomationRules(asRows(rulesPayload, ['rules', 'rows']));
      setAutomationRuns(asRows(runsPayload, ['runs', 'rows']));
    });
  };

  const loadHealth = async (live = false): Promise<void> => {
    await runCommand(live ? 'Running live health check' : 'Running dry-run health check', async () => {
      const [emailPayload, crmPayload] = await Promise.all([
        invokeAction(DASHBOARD_ACTION_CONTRACTS.EMAIL_PROVIDER_HEALTH, {
          provider: emailProvider,
          live,
          mode: live ? 'live' : 'dry-run',
        }),
        invokeAction(DASHBOARD_ACTION_CONTRACTS.CRM_HEALTH, { provider: crmProvider }),
      ]);
      setProviderHealth(asRecord(emailPayload));
      setCrmHealth(asRecord(crmPayload));
    });
  };

  const loadTemplates = async (): Promise<void> => {
    await runCommand('Loading templates', async () => {
      const payload = await invokeAction(DASHBOARD_ACTION_CONTRACTS.EMAILTEMPLATE_LIST, {
        limit: 24,
        lifecycle_state: 'approved',
      });
      setEmailTemplates(asRows(payload, ['templates', 'email_templates', 'rows']));
    });
  };

  const runPreview = async (): Promise<void> => {
    await runCommand('Previewing automation', async () => {
      const customerEmail = selectedCustomer?.email || previewEmail.trim() || 'customer@example.com';
      const customerStatus = selectedCustomer?.status || 'active';
      const payload = await invokeAction(DASHBOARD_ACTION_CONTRACTS.AUTOMATION_PREVIEW, {
        trigger_event: previewTrigger,
        call: {
          call_sid: selectedCustomer?.id || 'tg-preview-call',
          phone_number: selectedCustomer?.phone,
          status: 'completed',
        },
        customer: {
          email: customerEmail,
          status: customerStatus,
        },
        payment: {
          status: previewTrigger === 'payment.succeeded' ? 'succeeded' : selectedCustomer?.paymentState || 'pending',
        },
        booking: {
          status: previewTrigger === 'booking.missed' ? 'missed' : selectedCustomer?.bookingState || 'pending',
        },
        escalation: {
          status: previewTrigger === 'escalation.created' ? 'open' : 'none',
        },
        transcript_context: {
          intent: selectedCustomer?.intent || previewTrigger,
          summary: `Telegram command center preview for ${selectedCustomer?.label || 'customer'}`,
        },
      });
      setPreviewResult(asRecord(payload));
    });
  };

  const loadApprovals = async (): Promise<void> => {
    await runCommand('Loading approvals', async () => {
      const [reviewPayload, callbackPayload] = await Promise.all([
        invokeAction(DASHBOARD_ACTION_CONTRACTS.REVIEW_CASES_LIST, { limit: 10 }),
        invokeAction(DASHBOARD_ACTION_CONTRACTS.CALLBACK_TASKS_LIST, { limit: 10 }),
      ]);
      setReviewCases(asRows(reviewPayload, ['review_cases', 'rows']) as ReviewCaseRow[]);
      setCallbackTasks(asRows(callbackPayload, ['callback_tasks', 'rows']) as CallbackTaskRow[]);
    });
  };

  const retryAutomationRun = (runId: string): void => {
    void runAction(
      DASHBOARD_ACTION_CONTRACTS.AUTOMATION_RUN_RETRY,
      { run_id: runId },
      {
        successMessage: 'Automation retry queued.',
        onSuccess: loadAutomation,
      },
    );
  };

  const selectView = (view: CommandView): void => {
    setActiveView(view);
    if (isBusy) return;
    if (view === 'automation' && automationRules.length === 0 && automationRuns.length === 0) {
      void loadAutomation();
      return;
    }
    if (view === 'templates' && emailTemplates.length === 0) {
      void loadTemplates();
      return;
    }
    if (view === 'health' && Object.keys(providerHealth).length === 0 && Object.keys(crmHealth).length === 0) {
      void loadHealth(false);
      return;
    }
    if (view === 'approvals' && reviewCases.length === 0 && callbackTasks.length === 0) {
      void loadApprovals();
    }
  };

  const copyDeepLinkToken = (token: string): void => {
    setCopiedToken(token);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(token).catch(() => undefined);
    }
  };

  const renderAutomationRows = (rows: AutomationRow[], kind: 'rule' | 'run') => {
    if (rows.length === 0) {
      return <p className="va-command-empty">No {kind === 'rule' ? 'rules' : 'runs'} loaded yet.</p>;
    }
    return (
      <div className="va-command-list">
        {rows.slice(0, 12).map((row, index) => {
          const id = toText(row.run_id || row.rule_id || row.id, `${kind}-${index + 1}`);
          const status = readStatus(row, kind === 'rule' ? 'enabled' : 'unknown');
          const trigger = toText(row.trigger_event || row.trigger, 'trigger');
          return (
            <div className="va-command-row" key={`${kind}-${id}-${index}`}>
              <div className="va-command-row-main">
                <strong>{shortId(id)}</strong>
                <span>{kind === 'rule' ? toText(row.name, trigger) : trigger}</span>
              </div>
              <div className="va-command-row-meta">
                <UiBadge variant={statusVariant(status)}>{status}</UiBadge>
                {kind === 'run' && ERROR_STATUSES.has(status) ? (
                  <UiButton
                    variant="secondary"
                    disabled={isBusy}
                    onClick={() => retryAutomationRun(id)}
                  >
                    Retry
                  </UiButton>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderHealthChecks = (title: string, payload: Record<string, unknown>) => {
    const checks = readHealthChecks(payload);
    const status = readHealthStatus(payload);
    return (
      <div className="va-command-panel">
        <div className="va-command-panel-head">
          <div>
            <h4>{title}</h4>
            <p>{checks.length > 0 ? `${checks.length} checks` : 'No check detail loaded yet.'}</p>
          </div>
          <UiBadge variant={statusVariant(status)}>{status}</UiBadge>
        </div>
        <div className="va-command-checks">
          {checks.length === 0 ? (
            <p className="va-command-empty">Run a dry-run or live check to validate credentials, sender identity, templates, and allowlists.</p>
          ) : checks.map((check, index) => (
            <div className="va-command-row" key={`${title}-${check.label}-${index}`}>
              <div className="va-command-row-main">
                <strong>{check.label}</strong>
                <span>{check.detail || 'No details returned.'}</span>
              </div>
              <UiBadge variant={statusVariant(check.status)}>{check.status}</UiBadge>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderTimelineList = (rows: TimelineRow[]) => {
    if (rows.length === 0) {
      return <p className="va-command-empty">Recent call, email, and automation activity will appear here once loaded.</p>;
    }
    return rows.map((row) => (
      <div className="va-command-timeline-row" key={row.id}>
        <span className="va-command-dot" aria-hidden="true" />
        <div className="va-command-row-main">
          <strong>{row.kind}: {row.title}</strong>
          <span>{row.detail}</span>
        </div>
        <div className="va-command-row-meta">
          <UiBadge variant={statusVariant(row.status)}>{row.status}</UiBadge>
          <span>{formatTime(row.at)}</span>
        </div>
      </div>
    ));
  };

  return (
    <UiCard className="va-command-center">
      <div className="va-command-hero">
        <div className="va-command-hero-copy">
          <div className="va-command-hero-top">
            <span className="va-command-logo" aria-hidden="true">VN</span>
            <div>
              <div className="va-command-title-row">
                <h3>VoicedNut Command Center</h3>
                <UiBadge variant="success">Telegram-native</UiBadge>
              </div>
              <p>
                Automations, provider checks, customer history, and approvals in one operator view.
              </p>
            </div>
          </div>
        </div>
        <div className="va-overview-metrics va-command-kpi">
          <UiMetricTile label="Automation rules" value={automationRules.length} />
          <UiMetricTile label="Failed runs" value={failedAutomationRuns.length} />
          <UiMetricTile label="SendGrid health" value={providerStatus} />
          <UiMetricTile label="CRM health" value={crmStatus} />
          <UiMetricTile label="Approvals" value={approvalCount} />
        </div>
      </div>
      <div className="va-command-signal-strip" aria-label="Live command signals">
        <div className="va-command-signal">
          <span>Customers</span>
          <strong>{customerProfiles.length}</strong>
        </div>
        <div className="va-command-signal">
          <span>Delivery</span>
          <strong>{deliveryRate === null ? 'n/a' : `${deliveryRate}%`}</strong>
        </div>
        <div className="va-command-signal">
          <span>Templates</span>
          <strong>{emailTemplates.length || TEMPLATE_LIBRARY.length}</strong>
        </div>
        <div className="va-command-signal">
          <span>Deep link</span>
          <strong>{startParam || 'live'}</strong>
        </div>
      </div>

      <div className="va-command-tabs" role="tablist" aria-label="Command center views">
        {COMMAND_TABS.map((tab) => (
          <UiButton
            key={tab.id}
            variant="chip"
            className={activeView === tab.id ? 'is-active' : ''}
            aria-pressed={activeView === tab.id}
            onClick={() => selectView(tab.id)}
          >
            {tab.label}
          </UiButton>
        ))}
      </div>

      {commandError ? (
        <UiStatePanel
          tone="error"
          compact
          title="Command failed"
          description={commandError}
        />
      ) : null}

      {activeView === 'overview' ? (
        <div className="va-command-grid">
          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Real-Time Command</h4>
                <p>Live status, provider readiness, queue pressure, and deep-link context stay visible.</p>
              </div>
              <UiBadge variant="success">native</UiBadge>
            </div>
            <UiButton variant="secondary" onClick={() => selectView('intelligence')}>
              View Intelligence
            </UiButton>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Customer Timeline</h4>
                <p>Merge calls, email jobs, delivery risks, and automation runs into one scan path.</p>
              </div>
              <UiBadge variant="info">{customerProfiles.length} profiles</UiBadge>
            </div>
            <UiButton variant="secondary" onClick={() => selectView('customers')}>
              Open Customers
            </UiButton>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Automation Studio</h4>
                <p>Preview and retry post-call workflows from the same Telegram admin surface.</p>
              </div>
              <UiBadge variant={failedAutomationRuns.length > 0 ? 'warning' : 'success'}>
                {failedAutomationRuns.length} failed
              </UiBadge>
            </div>
            <UiButton
              variant="secondary"
              disabled={isBusy}
              onClick={() => selectView('automation')}
            >
              Open Automation
            </UiButton>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Template Intelligence</h4>
                <p>Rank approved email templates against intent, payment, booking, and transcript context.</p>
              </div>
              <UiBadge variant="info">{templateSuggestions.length} ranked</UiBadge>
            </div>
            <UiButton
              variant="secondary"
              disabled={isBusy}
              onClick={() => selectView('templates')}
            >
              Open Templates
            </UiButton>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Provider Readiness</h4>
                <p>Validate SendGrid and CRM configuration before follow-up messages go live.</p>
              </div>
              <UiBadge variant={statusVariant(providerStatus)}>{providerStatus}</UiBadge>
            </div>
            <UiButton
              variant="secondary"
              disabled={isBusy}
              onClick={() => selectView('health')}
            >
              Check Providers
            </UiButton>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Advanced Visual System</h4>
                <p>Quiet Telegram wallet-style density with fewer command blocks and stronger hierarchy.</p>
              </div>
              <UiBadge variant="success">quiet</UiBadge>
            </div>
            <UiButton variant="secondary" onClick={() => selectView('timeline')}>
              View Timeline
            </UiButton>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Telegram Deep Links</h4>
                <p>Start parameters route operators into the exact customer, workflow, or health context.</p>
              </div>
              <UiBadge variant="info">{deepLinkRoutes.length} routes</UiBadge>
            </div>
            <UiButton variant="secondary" onClick={() => selectView('intelligence')}>
              View Routes
            </UiButton>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Approvals</h4>
                <p>Keep review cases, callback tasks, DLQ items, and failed automations visible.</p>
              </div>
              <UiBadge variant={approvalCount > 0 ? 'warning' : 'success'}>{approvalCount} open</UiBadge>
            </div>
            <UiButton
              variant="secondary"
              disabled={isBusy}
              onClick={() => selectView('approvals')}
            >
              Open Queue
            </UiButton>
          </div>
        </div>
      ) : null}

      {activeView === 'customers' ? (
        <div className="va-command-workspace">
          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Customer Timeline View</h4>
                <p>Operator-ready profiles built from recent calls, email jobs, delivery risks, and automation runs.</p>
              </div>
              <UiBadge variant="info">{customerProfiles.length} profiles</UiBadge>
            </div>
            <div className="va-command-customer-list">
              {customerProfiles.length === 0 ? (
                <p className="va-command-empty">No customer context loaded yet.</p>
              ) : customerProfiles.map((profile) => (
                <button
                  className={`va-command-customer-button ${selectedCustomer?.id === profile.id ? 'is-selected' : ''}`}
                  key={profile.id}
                  type="button"
                  onClick={() => setSelectedCustomerId(profile.id)}
                >
                  <span>
                    <strong>{profile.label}</strong>
                    <small>{profile.intent}</small>
                  </span>
                  <UiBadge variant={profile.riskCount > 0 ? 'warning' : 'success'}>{profile.score}</UiBadge>
                </button>
              ))}
            </div>
          </div>

          <div className="va-command-panel va-command-panel-wide">
            <div className="va-command-panel-head">
              <div>
                <h4>{selectedCustomer?.label || 'Customer profile'}</h4>
                <p>{selectedCustomer?.phone || selectedCustomer?.email || 'Select a profile to inspect context.'}</p>
              </div>
              <UiBadge variant={selectedCustomer && selectedCustomer.riskCount > 0 ? 'warning' : 'success'}>
                {selectedCustomer?.status || 'ready'}
              </UiBadge>
            </div>
            <div className="va-command-signal-strip va-command-signal-strip-compact">
              <div className="va-command-signal">
                <span>Calls</span>
                <strong>{selectedCustomer?.callCount || 0}</strong>
              </div>
              <div className="va-command-signal">
                <span>Emails</span>
                <strong>{selectedCustomer?.emailCount || 0}</strong>
              </div>
              <div className="va-command-signal">
                <span>Risks</span>
                <strong>{selectedCustomer?.riskCount || 0}</strong>
              </div>
              <div className="va-command-signal">
                <span>Booking</span>
                <strong>{selectedCustomer?.bookingState || 'pending'}</strong>
              </div>
            </div>
            <div className="va-command-timeline">
              {renderTimelineList(customerTimelineRows)}
            </div>
          </div>
        </div>
      ) : null}

      {activeView === 'automation' ? (
        <div className="va-command-grid">
          <div className="va-command-panel va-command-panel-wide">
            <div className="va-command-panel-head">
              <div>
                <h4>Post-Call Rules Engine</h4>
                <p>Load approved rules, inspect recent runs, and preview which rules match the next call context.</p>
              </div>
              <div className="va-command-actions">
                <UiButton variant="secondary" disabled={isBusy} onClick={() => { void loadAutomation(); }}>
                  Refresh
                </UiButton>
                <UiButton variant="primary" disabled={isBusy} onClick={() => { void runPreview(); }}>
                  Preview
                </UiButton>
              </div>
            </div>
            <div className="va-command-field-grid">
              <UiSelect
                value={previewTrigger}
                onChange={(event) => setPreviewTrigger(event.target.value)}
                aria-label="Automation trigger"
              >
                <option value="payment.succeeded">Payment succeeded</option>
                <option value="booking.missed">Booking missed</option>
                <option value="escalation.created">Escalation created</option>
                <option value="call.completed">Call completed</option>
              </UiSelect>
              <UiInput
                value={previewEmail}
                onChange={(event) => setPreviewEmail(event.target.value)}
                placeholder="customer@example.com"
                aria-label="Preview customer email"
              />
            </div>
            <div className="va-command-preview">
              <strong>{matchedRules.length}</strong>
              <span>matched rules for {previewTrigger}</span>
            </div>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Approved Rules</h4>
                <p>{automationRules.length} loaded</p>
              </div>
            </div>
            {renderAutomationRows(automationRules, 'rule')}
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Recent Runs</h4>
                <p>{automationRuns.length} loaded</p>
              </div>
            </div>
            {renderAutomationRows(automationRuns, 'run')}
          </div>
        </div>
      ) : null}

      {activeView === 'templates' ? (
        <div className="va-command-grid">
          <div className="va-command-panel va-command-panel-wide">
            <div className="va-command-panel-head">
              <div>
                <h4>Intelligent Email Template Selection</h4>
                <p>Rank approved templates by trigger, customer state, booking/payment status, and current preview context.</p>
              </div>
              <div className="va-command-actions">
                <UiButton variant="secondary" disabled={isBusy} onClick={() => { void loadTemplates(); }}>
                  Refresh
                </UiButton>
                <UiButton variant="primary" disabled={isBusy} onClick={() => { void runPreview(); }}>
                  Simulate
                </UiButton>
              </div>
            </div>
            <div className="va-command-field-grid">
              <UiSelect
                value={previewTrigger}
                onChange={(event) => setPreviewTrigger(event.target.value)}
                aria-label="Template trigger"
              >
                <option value="payment.succeeded">Payment succeeded</option>
                <option value="booking.missed">Booking missed</option>
                <option value="escalation.created">Escalation created</option>
                <option value="call.completed">Call completed</option>
              </UiSelect>
              <UiInput
                value={previewEmail}
                onChange={(event) => setPreviewEmail(event.target.value)}
                placeholder="customer@example.com"
                aria-label="Template preview customer email"
              />
            </div>
          </div>

          <div className="va-command-template-grid">
            {templateSuggestions.map((template) => (
              <div className="va-command-panel" key={template.id}>
                <div className="va-command-panel-head">
                  <div>
                    <h4>{template.name}</h4>
                    <p>{template.reason}</p>
                  </div>
                  <span className="va-command-template-score">{template.score}</span>
                </div>
                <div className="va-command-row-meta">
                  <UiBadge variant={statusVariant(template.lifecycle)}>{template.lifecycle}</UiBadge>
                  <span>{template.trigger}</span>
                  <span>{template.source}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {activeView === 'health' ? (
        <div className="va-command-grid">
          <div className="va-command-panel va-command-panel-wide">
            <div className="va-command-panel-head">
              <div>
                <h4>Provider Validation</h4>
                <p>Dry-run checks avoid production sends; live mode validates the provider path more deeply.</p>
              </div>
              <div className="va-command-actions">
                <UiButton variant="secondary" disabled={isBusy} onClick={() => { void loadHealth(false); }}>
                  Dry Run
                </UiButton>
                <UiButton variant="primary" disabled={isBusy} onClick={() => { void loadHealth(true); }}>
                  Live Check
                </UiButton>
              </div>
            </div>
            <div className="va-command-field-grid">
              <UiSelect
                value={emailProvider}
                onChange={(event) => setEmailProvider(event.target.value)}
                aria-label="Email provider"
              >
                <option value="sendgrid">SendGrid</option>
                <option value="smtp">SMTP</option>
                <option value="stub">Stub</option>
              </UiSelect>
              <UiSelect
                value={crmProvider}
                onChange={(event) => setCrmProvider(event.target.value)}
                aria-label="CRM provider"
              >
                <option value="stub">Stub</option>
                <option value="hubspot">HubSpot</option>
                <option value="salesforce">Salesforce</option>
                <option value="airtable">Airtable</option>
                <option value="gohighlevel">GoHighLevel</option>
              </UiSelect>
            </div>
          </div>
          <div className="va-command-health-grid">
            {renderHealthChecks('Email Provider', providerHealth)}
            {renderHealthChecks('CRM Sync', crmHealth)}
          </div>
        </div>
      ) : null}

      {activeView === 'timeline' ? (
        <div className="va-command-timeline">
          {renderTimelineList(timelineRows)}
        </div>
      ) : null}

      {activeView === 'intelligence' ? (
        <div className="va-command-grid">
          <div className="va-command-panel va-command-panel-wide">
            <div className="va-command-panel-head">
              <div>
                <h4>Operational Intelligence</h4>
                <p>Prioritized signals from provider health, delivery, automation, callbacks, and review queues.</p>
              </div>
              <UiBadge variant={intelligenceRows.length > 0 ? 'warning' : 'success'}>
                {intelligenceRows.length || 'clear'}
              </UiBadge>
            </div>
            <div className="va-command-list">
              {intelligenceRows.length === 0 ? (
                <p className="va-command-empty">No urgent operational signals detected.</p>
              ) : intelligenceRows.map((row) => (
                <div className="va-command-row" key={row.id}>
                  <div className="va-command-row-main">
                    <strong>{row.title}</strong>
                    <span>{row.detail}</span>
                  </div>
                  <div className="va-command-row-meta">
                    <UiBadge variant={row.priority}>{row.status}</UiBadge>
                    {row.view && row.actionLabel ? (
                      <UiButton variant="secondary" disabled={isBusy} onClick={() => selectView(row.view as CommandView)}>
                        {row.actionLabel}
                      </UiButton>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Native Telegram Layer</h4>
                <p>Main actions, back navigation, haptics, and theme colors are treated as app-level controls.</p>
              </div>
              <UiBadge variant="success">adapted</UiBadge>
            </div>
            <div className="va-command-native-list">
              <div>
                <strong>Main action</strong>
                <span>Used for decisive operator actions like preview, retry, and validation.</span>
              </div>
              <div>
                <strong>Back action</strong>
                <span>Handled by the dashboard shell instead of assuming browser history.</span>
              </div>
              <div>
                <strong>Haptics</strong>
                <span>Reserved for selection and completion feedback to avoid noisy vibration.</span>
              </div>
              <div>
                <strong>Theming</strong>
                <span>Uses Telegram-style surface tokens with quiet contrast and compact density.</span>
              </div>
            </div>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Deep-Link Workflows</h4>
                <p>Use safe start parameter tokens to open the right miniapp workspace from bot messages.</p>
              </div>
              <UiBadge variant="info">{deepLinkRoutes.length}</UiBadge>
            </div>
            <div className="va-command-link-grid">
              {deepLinkRoutes.map((route) => (
                <button
                  className="va-command-link-card"
                  key={route.token}
                  type="button"
                  onClick={() => {
                    copyDeepLinkToken(route.token);
                    selectView(route.view);
                  }}
                >
                  <span>
                    <strong>{route.label}</strong>
                    <small>{route.detail}</small>
                  </span>
                  <code className="va-command-token">{route.token}</code>
                </button>
              ))}
            </div>
            {copiedToken ? <p className="va-command-empty">Copied token: {copiedToken}</p> : null}
          </div>
        </div>
      ) : null}

      {activeView === 'approvals' ? (
        <div className="va-command-grid">
          <div className="va-command-panel va-command-panel-wide">
            <div className="va-command-panel-head">
              <div>
                <h4>Approval Queue</h4>
                <p>Operator decisions and recovery work grouped for Telegram review.</p>
              </div>
              <UiButton variant="secondary" disabled={isBusy} onClick={() => { void loadApprovals(); }}>
                Refresh Queue
              </UiButton>
            </div>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Review Cases</h4>
                <p>{reviewCases.length} loaded</p>
              </div>
            </div>
            {reviewCases.length === 0 ? <p className="va-command-empty">No review cases loaded.</p> : null}
            <div className="va-command-list">
              {reviewCases.slice(0, 10).map((row, index) => (
                <div className="va-command-row" key={`review-${toText(row.id, String(index))}-${index}`}>
                  <div className="va-command-row-main">
                    <strong>{shortId(row.id)}</strong>
                    <span>{toText(row.reason || row.requested_action, 'Review required')}</span>
                  </div>
                  <UiBadge variant={statusVariant(row.status)}>{toText(row.status, 'open')}</UiBadge>
                </div>
              ))}
            </div>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Callback Tasks</h4>
                <p>{callbackTasks.length} loaded</p>
              </div>
            </div>
            {callbackTasks.length === 0 ? <p className="va-command-empty">No callback tasks loaded.</p> : null}
            <div className="va-command-list">
              {callbackTasks.slice(0, 10).map((row, index) => (
                <div className="va-command-row" key={`callback-${toText(row.id, String(index))}-${index}`}>
                  <div className="va-command-row-main">
                    <strong>{shortId(row.id)}</strong>
                    <span>{toText(row.phone_number || row.source_call_sid, 'Callback')}</span>
                  </div>
                  <UiBadge variant={statusVariant(row.status)}>{toText(row.status, 'queued')}</UiBadge>
                </div>
              ))}
            </div>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Delivery Risk</h4>
                <p>{emailDlq.length} open DLQ entries</p>
              </div>
              <UiBadge variant={emailDlq.length > 0 ? 'warning' : 'success'}>{emailDlq.length}</UiBadge>
            </div>
            <div className="va-command-list">
              {emailDlq.slice(0, 10).map((row, index) => (
                <div className="va-command-row" key={`approval-dlq-${toText(row.id, String(index))}-${index}`}>
                  <div className="va-command-row-main">
                    <strong>{shortId(row.message_id || row.id)}</strong>
                    <span>{toText(row.reason, 'Email delivery issue')}</span>
                  </div>
                  <UiBadge variant="error">blocked</UiBadge>
                </div>
              ))}
            </div>
          </div>

          <div className="va-command-panel">
            <div className="va-command-panel-head">
              <div>
                <h4>Failed Automation</h4>
                <p>{failedAutomationRuns.length} retry candidates</p>
              </div>
            </div>
            {renderAutomationRows(failedAutomationRuns, 'run')}
          </div>
        </div>
      ) : null}
    </UiCard>
  );
}
