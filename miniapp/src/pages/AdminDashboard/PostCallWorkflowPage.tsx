import { useCallback, useEffect, useState } from 'react';

import { AdminPageIntro } from '@/components/admin-dashboard/AdminPageIntro';
import { MissionMonitoringPage } from '@/pages/AdminDashboard/MissionMonitoringPage';
import { ReviewControlsPage } from '@/pages/AdminDashboard/ReviewControlsPage';
import {
  UiBadge,
  UiButton,
  UiCard,
  UiInput,
  UiSelect,
  UiStatePanel,
  UiTextarea,
} from '@/components/ui/AdminPrimitives';
import { DASHBOARD_ACTION_CONTRACTS } from '@/contracts/miniappParityContracts';
import { useInvestigationAction } from './useInvestigationAction';
import type { DashboardVm } from './types';

type WorkflowStepType = 'end' | 'approval' | 'wait' | 'branch' | 'action';
type WorkflowTrigger = 'post_call_completed' | 'post_call_outcome_classified' | 'call_e_result_ready';
type WorkflowStep = {
  id: string;
  type: WorkflowStepType;
  next_step_id?: string;
  true_step_id?: string;
  false_step_id?: string;
  seconds?: number;
  action_type?: string;
  config?: Record<string, unknown>;
  condition?: Record<string, unknown>;
};
type ResultClassificationLabel = 'positive' | 'negative' | 'neutral' | 'requires_review' | 'unknown';
type ResultClassificationRule = { id: string; field: string; enum_index: number; label: ResultClassificationLabel };
type WorkflowDefinition = {
  schema_version: 1;
  workflow_id: string;
  business_id?: string;
  template_id?: number;
  template_version?: number;
  result_classifications?: ResultClassificationRule[];
  name: string;
  trigger_event: WorkflowTrigger;
  start_step_id: string;
  steps: WorkflowStep[];
};

type WorkflowVersion = Record<string, unknown>;
type WorkflowRun = Record<string, unknown>;
type WorkflowAuditStep = Record<string, unknown>;

type PostCallWorkflowPageProps = {
  visible: boolean;
  vm: DashboardVm;
};

const STARTER_DEFINITION: WorkflowDefinition = {
  schema_version: 1,
  workflow_id: 'post_call_followup',
  name: 'Post-call follow-up',
  trigger_event: 'post_call_completed',
  start_step_id: 'finish',
  steps: [{ id: 'finish', type: 'end' }],
};

const STEP_TYPE_OPTIONS: WorkflowStepType[] = ['approval', 'wait', 'branch', 'action', 'end'];
const ACTION_TYPE_OPTIONS = ['send_email', 'crm_sync', 'create_ticket'];
const CLASSIFICATION_LABELS: ResultClassificationLabel[] = ['positive', 'negative', 'neutral', 'requires_review', 'unknown'];
const WORKFLOW_ROOT_KEYS = new Set([
  'schema_version', 'workflow_id', 'business_id', 'template_id', 'template_version',
  'result_classifications', 'name', 'trigger_event', 'start_step_id', 'steps',
]);
const ACTION_CONFIG_KEYS: Record<string, Set<string>> = {
  send_email: new Set([
    'to', 'from', 'provider', 'subject', 'text', 'html', 'script_id', 'template_id',
    'select_template', 'template_context', 'variables', 'metadata', 'is_marketing',
  ]),
  crm_sync: new Set(['provider', 'metadata']),
  create_ticket: new Set(['provider', 'contact_id', 'summary', 'metadata']),
};

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function formatLabel(value: unknown, fallback = 'n/a'): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asDefinition(value: unknown): WorkflowDefinition | null {
  const record = asRecord(value);
  if (!hasOnlyKeys(record, WORKFLOW_ROOT_KEYS) || record.schema_version !== 1) return null;
  if (!Array.isArray(record.steps) || record.steps.some((step) => !step || typeof step !== 'object' || Array.isArray(step))) return null;
  if (typeof record.start_step_id !== 'string') return null;
  const steps = asRows(record.steps).map((step) => ({
    ...step,
    id: typeof step.id === 'string' ? step.id : '',
    type: (typeof step.type === 'string' ? step.type : 'end') as WorkflowStepType,
  })) as WorkflowStep[];
  if (typeof record.workflow_id !== 'string' || typeof record.name !== 'string' ||
      typeof record.trigger_event !== 'string' || !steps.length) return null;
  const trigger = record.trigger_event as WorkflowTrigger;
  if (!['post_call_completed', 'post_call_outcome_classified', 'call_e_result_ready'].includes(trigger)) return null;
  const rawSteps = asRows(record.steps);
  for (const step of rawSteps) {
    const type = typeof step.type === 'string' ? step.type : '';
    if (typeof step.id !== 'string' || !step.id.trim()) return null;
    const allowedKeys = {
      action: new Set(['id', 'type', 'action_type', 'config', 'next_step_id']),
      approval: new Set(['id', 'type', 'next_step_id']),
      branch: new Set(['id', 'type', 'condition', 'true_step_id', 'false_step_id']),
      wait: new Set(['id', 'type', 'seconds', 'next_step_id']),
      end: new Set(['id', 'type']),
    }[type];
    if (!allowedKeys || !hasOnlyKeys(step, allowedKeys)) return null;
    if (type === 'branch' && (validateBranchCondition(step.condition) ||
        typeof step.true_step_id !== 'string' || typeof step.false_step_id !== 'string')) return null;
    if (type === 'action') {
      const actionType = typeof step.action_type === 'string' ? step.action_type : '';
      const config = asRecord(step.config);
      if (!ACTION_CONFIG_KEYS[actionType] || !step.config || typeof step.config !== 'object' ||
          Array.isArray(step.config) || !hasOnlyKeys(config, ACTION_CONFIG_KEYS[actionType]) ||
          typeof step.next_step_id !== 'string') return null;
    }
    if (['approval', 'wait'].includes(type) && typeof step.next_step_id !== 'string') return null;
    if (type === 'wait' && (!Number.isSafeInteger(step.seconds) || Number(step.seconds) < 1 || Number(step.seconds) > 2592000)) return null;
  }
  const rawClassifications = record.result_classifications;
  if (rawClassifications !== undefined && !Array.isArray(rawClassifications)) return null;
  for (const entry of (Array.isArray(rawClassifications) ? rawClassifications : [])) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const rule = entry as Record<string, unknown>;
    if (!hasOnlyKeys(rule, new Set(['id', 'field', 'enum_index', 'label'])) ||
        typeof rule.id !== 'string' || typeof rule.field !== 'string' ||
        !Number.isSafeInteger(rule.enum_index) || typeof rule.label !== 'string' ||
        !CLASSIFICATION_LABELS.includes(rule.label as ResultClassificationLabel)) return null;
  }
  if (record.business_id !== undefined && record.business_id !== null && typeof record.business_id !== 'string') return null;
  if (record.template_id !== undefined && record.template_id !== null &&
      (!Number.isSafeInteger(record.template_id) || Number(record.template_id) < 1)) return null;
  if (record.template_version !== undefined && record.template_version !== null &&
      (!Number.isSafeInteger(record.template_version) || Number(record.template_version) < 1)) return null;
  return {
    schema_version: 1,
    workflow_id: record.workflow_id,
    name: record.name,
    trigger_event: trigger,
    business_id: typeof record.business_id === 'string' ? record.business_id : undefined,
    template_id: Number.isSafeInteger(record.template_id) && Number(record.template_id) > 0 ? Number(record.template_id) : undefined,
    template_version: Number.isSafeInteger(record.template_version) && Number(record.template_version) > 0 ? Number(record.template_version) : undefined,
    result_classifications: asRows(record.result_classifications).map((rule) => ({
      id: typeof rule.id === 'string' ? rule.id : '',
      field: typeof rule.field === 'string' ? rule.field : '',
      enum_index: Number.isSafeInteger(rule.enum_index) ? Number(rule.enum_index) : -1,
      label: CLASSIFICATION_LABELS.includes(rule.label as ResultClassificationLabel) ? rule.label as ResultClassificationLabel : 'unknown',
    })),
    start_step_id: typeof record.start_step_id === 'string' ? record.start_step_id : steps[0].id,
    steps,
  };
}

function createStep(type: WorkflowStepType, id: string, nextId: string): WorkflowStep {
  if (type === 'approval') return { id, type, next_step_id: nextId };
  if (type === 'wait') return { id, type, seconds: 60, next_step_id: nextId };
  if (type === 'branch') {
    return {
      id,
      type,
      condition: { field: 'result_status', exists: true },
      true_step_id: nextId,
      false_step_id: nextId,
    };
  }
  if (type === 'action') return { id, type, action_type: 'send_email', config: {}, next_step_id: nextId };
  return { id, type };
}

function isEditableSimpleBranchCondition(condition: unknown): boolean {
  if (typeof condition === 'string') {
    try {
      condition = JSON.parse(condition) as unknown;
    } catch {
      return false;
    }
  }
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return false;
  const record = condition as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2 && keys.includes('field') &&
    ((typeof record.field === 'string' && typeof record.exists === 'boolean') ||
      (typeof record.field === 'string' && typeof record.equals === 'string'));
}

function validateBranchCondition(condition: unknown, stepId?: string, depth = 0): string {
  if (depth > 8) return stepId ? `Branch condition for “${stepId}” is nested too deeply.` : 'Branch condition is nested too deeply.';
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return stepId ? `Branch condition for “${stepId}” must be a JSON object.` : 'Branch condition must be a JSON object.';
  }
  const record = condition as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && ['all', 'any'].includes(keys[0])) {
    const clauses = record[keys[0]];
    if (!Array.isArray(clauses) || clauses.length < 1 || clauses.length > 20) {
      return stepId ? `Branch group for “${stepId}” must contain between 1 and 20 clauses.` : 'Branch group must contain between 1 and 20 clauses.';
    }
    for (const clause of clauses) {
      const error = validateBranchCondition(clause, stepId, depth + 1);
      if (error) return error;
    }
    return '';
  }
  const operatorKeys = keys.filter((key) => ['exists', 'equals', 'in', 'includes'].includes(key));
  if (keys.length !== 2 || !keys.includes('field') || operatorKeys.length !== 1) {
    return stepId ? `Complete the condition for branch step “${stepId}”.` : 'Complete the branch condition.';
  }
  const field = typeof record.field === 'string' ? record.field.trim() : '';
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(field)) {
    return stepId ? `Condition field for “${stepId}” is invalid.` : 'Condition field is invalid.';
  }
  const operator = operatorKeys[0];
  const value = record[operator];
  if (operator === 'exists' && typeof value !== 'boolean') return stepId ? `Branch condition “${stepId}” must use a boolean exists value.` : 'Branch condition exists must be boolean.';
  if (operator === 'includes' && (typeof value !== 'string' || value.length > 256)) return stepId ? `Branch condition “${stepId}” must use a string value of 256 characters or fewer.` : 'Branch condition includes must be a string of 256 characters or fewer.';
  if (operator === 'in' && (!Array.isArray(value) || value.length < 1 || value.length > 50 || value.some((entry) => !['string', 'number', 'boolean'].includes(typeof entry)))) {
    return stepId ? `Branch condition “${stepId}” must contain 1 to 50 scalar values.` : 'Branch condition in must contain 1 to 50 scalar values.';
  }
  if (operator === 'equals' && value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
    return stepId ? `Branch condition “${stepId}” equals must use a scalar value.` : 'Branch condition equals must use a scalar value.';
  }
  return '';
}

function validateDraft(definition: WorkflowDefinition, configTexts: Record<string, string>, conditionTexts: Record<string, string>): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(definition.workflow_id.trim())) return 'Workflow ID must start with a letter or number and use at most 120 letters, numbers, underscores, or hyphens.';
  if (!definition.name.trim() || definition.name.trim().length > 160) return 'Enter a workflow name up to 160 characters.';
  if (definition.trigger_event === 'call_e_result_ready' && !/^[A-Za-z0-9._:-]{1,120}$/.test(String(definition.business_id || '').trim())) return 'Enter the business ID for this CALL-E result-ready workflow.';
  const classifications = definition.result_classifications || [];
  if (classifications.length > 16) return 'A workflow can contain at most 16 result classification mappings.';
  if (definition.trigger_event === 'call_e_result_ready' && classifications.length > 0) {
    if (!Number.isSafeInteger(definition.template_id) || Number(definition.template_id) < 1) return 'Enter a positive CALL-E template ID for result classifications.';
    if (!Number.isSafeInteger(definition.template_version) || Number(definition.template_version) < 1) return 'Enter a positive CALL-E template version for result classifications.';
    const classificationIds = new Set<string>();
    for (const rule of classifications) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(rule.id) || classificationIds.has(rule.id)) return `Classification IDs must be unique and use 1–40 letters, numbers, underscores, or hyphens. Check “${rule.id || 'unnamed mapping'}”.`;
      classificationIds.add(rule.id);
      if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(rule.field)) return `Enter a valid result field for classification “${rule.id}”.`;
      if (!Number.isSafeInteger(rule.enum_index) || rule.enum_index < 0 || rule.enum_index > 31) return `Enum option index for “${rule.id}” must be between 0 and 31.`;
      if (!CLASSIFICATION_LABELS.includes(rule.label)) return `Choose an outcome label for classification “${rule.id}”.`;
    }
  }
  if (definition.steps.length < 1 || definition.steps.length > 50) return 'A workflow must contain between 1 and 50 steps.';
  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(step.id) || ids.has(step.id)) return `Step IDs must be unique and valid. Check “${step.id || 'unnamed step'}”.`;
    ids.add(step.id);
  }
  if (!ids.has(definition.start_step_id)) return 'Choose a start step that exists in this workflow.';
  const edges = new Map<string, string[]>();
  let totalWaitSeconds = 0;
  for (const step of definition.steps) {
    if (step.type === 'action' && definition.trigger_event === 'call_e_result_ready') return 'CALL-E result-ready workflows can use branch, wait, approval, and end steps only.';
    const targets = step.type === 'branch'
      ? [step.true_step_id, step.false_step_id]
      : ['end', 'action'].includes(step.type) ? (step.type === 'end' ? [] : [step.next_step_id])
        : [step.next_step_id];
    if (targets.some((target) => !target || !ids.has(target))) return `Choose an existing next step for “${step.id}”.`;
    if (step.type === 'wait' && (!Number.isSafeInteger(step.seconds) || Number(step.seconds) < 1 || Number(step.seconds) > 2592000)) return `Wait step “${step.id}” must be between 1 second and 30 days.`;
    if (step.type === 'wait') totalWaitSeconds += Number(step.seconds);
    if (step.type === 'branch') {
      let parsedCondition: unknown;
      try {
        parsedCondition = JSON.parse(conditionTexts[step.id] ?? JSON.stringify(step.condition || { field: 'result_status', exists: true }));
      } catch {
        return `Branch condition for “${step.id}” must be valid JSON.`;
      }
      const conditionError = validateBranchCondition(parsedCondition, step.id);
      if (conditionError) return conditionError;
      step.condition = parsedCondition as Record<string, unknown>;
    }
    if (step.type === 'action') {
      try {
        const config = JSON.parse(configTexts[step.id] ?? JSON.stringify(step.config || {})) as unknown;
        if (!config || typeof config !== 'object' || Array.isArray(config)) return `Action config for “${step.id}” must be a JSON object.`;
        step.config = config as Record<string, unknown>;
      } catch {
        return `Action config for “${step.id}” must be valid JSON.`;
      }
    }
    edges.set(step.id, step.type === 'branch'
      ? [String(step.true_step_id), String(step.false_step_id)]
      : step.type === 'end' ? [] : [String(step.next_step_id)]);
  }
  if (totalWaitSeconds > 2592000) return 'Total wait time cannot exceed 30 days.';
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (stepId: string): string => {
    if (active.has(stepId)) return `Workflow paths cannot contain loops (check “${stepId}”).`;
    if (visited.has(stepId)) return '';
    active.add(stepId);
    for (const target of edges.get(stepId) || []) {
      const error = visit(target);
      if (error) return error;
    }
    active.delete(stepId);
    visited.add(stepId);
    return '';
  };
  const graphError = visit(definition.start_step_id);
  if (graphError) return graphError;
  if (visited.size !== definition.steps.length) return 'Every step must be reachable from the selected start step.';
  return '';
}

export function PostCallWorkflowPage({ visible, vm }: PostCallWorkflowPageProps) {
  const { investigationBusy, investigationError, runInvestigationAction } = useInvestigationAction(vm.invokeAction);
  const [definition, setDefinition] = useState<WorkflowDefinition>(STARTER_DEFINITION);
  const [configTexts, setConfigTexts] = useState<Record<string, string>>({});
  const [conditionTexts, setConditionTexts] = useState<Record<string, string>>({});
  const [addStepType, setAddStepType] = useState<WorkflowStepType>('approval');
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const busy = Boolean(investigationBusy);
  const callEResultTrigger = definition.trigger_event === 'call_e_result_ready';

  const loadWorkspace = useCallback(async (clearNotice = true) => {
    if (clearNotice) setNotice('');
    await runInvestigationAction(DASHBOARD_ACTION_CONTRACTS.WORKFLOW_VERSIONS, { limit: 100 }, (data) => {
      setVersions(asRows(data.versions));
    });
    await runInvestigationAction(DASHBOARD_ACTION_CONTRACTS.WORKFLOW_RUNS, { limit: 100 }, (data) => {
      setRuns(asRows(data.runs));
    });
  }, [runInvestigationAction]);

  useEffect(() => {
    if (visible) void loadWorkspace();
  }, [visible, loadWorkspace]);

  const updateStep = (stepId: string, patch: Partial<WorkflowStep>) => {
    setDefinition((current) => ({
      ...current,
      steps: current.steps.map((step) => step.id === stepId ? { ...step, ...patch } : step),
    }));
  };

  const addStep = () => {
    if (callEResultTrigger && addStepType === 'action') return;
    const terminalIndex = definition.steps.map((step) => step.type).lastIndexOf('end');
    if (terminalIndex < 0) {
      setFormError('Keep at least one end step before adding another step.');
      return;
    }
    const used = new Set(definition.steps.map((step) => step.id));
    let suffix = definition.steps.length + 1;
    while (used.has(`step_${suffix}`) || used.has(`finish_${suffix}`)) suffix += 1;
    const nextId = `finish_${suffix}`;
    if (addStepType === 'end') {
      setDefinition((current) => ({ ...current, steps: [...current.steps, { id: nextId, type: 'end' }] }));
      setFormError('');
      return;
    }
    const priorEnd = definition.steps[terminalIndex];
    const inserted = createStep(addStepType, priorEnd.id, nextId);
    setDefinition((current) => ({
      ...current,
      steps: [...current.steps.map((step) => step.id === priorEnd.id ? inserted : step), { id: nextId, type: 'end' }],
    }));
    setConfigTexts((current) => ({ ...current, [priorEnd.id]: '{}' }));
    if (addStepType === 'branch') setConditionTexts((current) => ({ ...current, [priorEnd.id]: JSON.stringify({ field: 'result_status', exists: true }, null, 2) }));
    setFormError('');
  };

  const removeStep = (stepId: string) => {
    const step = definition.steps.find((candidate) => candidate.id === stepId);
    const endSteps = definition.steps.filter((candidate) => candidate.type === 'end');
    if (!step || (step.type === 'end' && endSteps.length <= 1)) return;
    const fallback = (step.type === 'end' ? endSteps.find((candidate) => candidate.id !== stepId)?.id : undefined)
      || step.next_step_id || step.true_step_id || step.false_step_id
      || endSteps.find((candidate) => candidate.id !== stepId)?.id;
    const remaining = definition.steps.filter((candidate) => candidate.id !== stepId).map((candidate) => {
      if (candidate.next_step_id === stepId) return { ...candidate, next_step_id: fallback };
      if (candidate.true_step_id === stepId || candidate.false_step_id === stepId) {
        return {
          ...candidate,
          true_step_id: candidate.true_step_id === stepId ? fallback : candidate.true_step_id,
          false_step_id: candidate.false_step_id === stepId ? fallback : candidate.false_step_id,
        };
      }
      return candidate;
    });
    setDefinition((current) => ({ ...current, steps: remaining, start_step_id: current.start_step_id === stepId ? fallback || remaining[0]?.id : current.start_step_id }));
    setConfigTexts((current) => {
      const next = { ...current };
      delete next[stepId];
      return next;
    });
    setConditionTexts((current) => {
      const next = { ...current };
      delete next[stepId];
      return next;
    });
  };

  const loadVersion = (version: WorkflowVersion) => {
    const loaded = asDefinition(version.definition);
    if (!loaded) {
      setFormError('This saved version contains unsupported or invalid fields and cannot be edited safely.');
      return;
    }
    setDefinition(loaded);
    setConfigTexts(Object.fromEntries(loaded.steps.filter((step) => step.type === 'action').map((step) => [step.id, JSON.stringify(step.config || {}, null, 2)])));
    setConditionTexts(Object.fromEntries(loaded.steps.filter((step) => step.type === 'branch').map((step) => [step.id, JSON.stringify(step.condition || { field: 'result_status', exists: true }, null, 2)])));
    setFormError('');
    setNotice(`Loaded ${loaded.workflow_id} v${formatLabel(version.version)} as an editable starting point. Saving creates a new draft.`);
  };

  const saveDraft = async () => {
    setFormError('');
    setNotice('');
    const draft: WorkflowDefinition = {
      ...definition,
      workflow_id: definition.workflow_id.trim(),
      name: definition.name.trim(),
      business_id: callEResultTrigger ? String(definition.business_id || '').trim() : undefined,
      template_id: callEResultTrigger && (definition.result_classifications || []).length ? definition.template_id : undefined,
      template_version: callEResultTrigger && (definition.result_classifications || []).length ? definition.template_version : undefined,
      result_classifications: callEResultTrigger ? (definition.result_classifications || []).map((rule) => ({ ...rule })) : undefined,
      steps: definition.steps.map((step) => ({ ...step })),
    };
    const validationError = validateDraft(draft, configTexts, conditionTexts);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    const payload = { ...draft, business_id: draft.business_id || null };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 64 * 1024) {
      setFormError('Workflow definition must be 64 KiB or smaller.');
      return;
    }
    await runInvestigationAction(DASHBOARD_ACTION_CONTRACTS.WORKFLOW_DRAFT, { definition: payload }, (data) => {
      const version = asRecord(data.version);
      setNotice(`Draft saved: ${formatLabel(version.workflow_id)} version ${formatLabel(version.version)}.`);
      void loadWorkspace(false);
    });
  };

  const loadRun = async (runId: string) => {
    await runInvestigationAction(DASHBOARD_ACTION_CONTRACTS.WORKFLOW_RUN_GET, { run_id: runId }, (data) => {
      setSelectedRun(asRecord(data.run));
    });
  };

  if (!visible) return null;
  const error = formError || investigationError;
  const selectedSteps = asRows(selectedRun?.steps) as WorkflowAuditStep[];
  const stepIds = definition.steps.map((step) => step.id);
  const endStepCount = definition.steps.filter((step) => step.type === 'end').length;
  const targetOptions = (current: string | undefined) => (
    <>
      <option value="">Choose a step</option>
      {stepIds.map((id) => <option key={id} value={id}>{id}{id === current ? ' (current)' : ''}</option>)}
    </>
  );

  return (
    <>
      <MissionMonitoringPage visible={visible} vm={vm} />
      <ReviewControlsPage visible={visible} vm={vm} />
      <AdminPageIntro
        eyebrow="Automation"
        title="Post-call workflows"
        summary="Build immutable workflow drafts and inspect execution status and step audit."
        meta={(<><UiBadge variant="info">Platform admin</UiBadge><UiBadge variant="meta">{versions.length} versions</UiBadge><UiBadge variant="meta">{runs.length} runs</UiBadge></>)}
        note="Saving creates a draft only. Approval and execution remain separate; approved workflows execute only when POST_CALL_WORKFLOWS_ENABLED is true."
      />

      {error ? <UiStatePanel compact tone="error" title="Workflow request needs attention" description={error} /> : null}
      {notice ? <UiStatePanel compact tone="success" title="Workflow update" description={notice} /> : null}

      <section className="va-grid">
        <UiCard>
          <header className="va-ops-card-header"><div className="va-ops-card-headline"><h3>Workflow details</h3><p className="va-muted">Drafts are validated again by the server before they are saved.</p></div></header>
          <div className="va-grid">
            <div><label className="va-field-label" htmlFor="workflow-id">Workflow ID</label><UiInput id="workflow-id" value={definition.workflow_id} maxLength={120} onChange={(event) => setDefinition((current) => ({ ...current, workflow_id: event.target.value }))} /></div>
            <div><label className="va-field-label" htmlFor="workflow-name">Workflow name</label><UiInput id="workflow-name" value={definition.name} maxLength={160} onChange={(event) => setDefinition((current) => ({ ...current, name: event.target.value }))} /></div>
          </div>
          <label className="va-field-label" htmlFor="workflow-trigger">Trigger</label>
          <UiSelect id="workflow-trigger" value={definition.trigger_event} onChange={(event) => setDefinition((current) => ({ ...current, trigger_event: event.target.value as WorkflowTrigger, business_id: event.target.value === 'call_e_result_ready' ? current.business_id : undefined, template_id: event.target.value === 'call_e_result_ready' ? current.template_id : undefined, template_version: event.target.value === 'call_e_result_ready' ? current.template_version : undefined, result_classifications: event.target.value === 'call_e_result_ready' ? current.result_classifications : undefined }))}>
            <option value="post_call_completed">Post-call completed</option>
            <option value="post_call_outcome_classified">Post-call outcome classified</option>
            <option value="call_e_result_ready">CALL-E result ready (business-scoped)</option>
          </UiSelect>
          {callEResultTrigger ? (
            <>
              <label className="va-field-label" htmlFor="workflow-business-id">Business ID</label>
              <UiInput id="workflow-business-id" value={definition.business_id || ''} maxLength={120} onChange={(event) => setDefinition((current) => ({ ...current, business_id: event.target.value }))} />
              <p className="va-field-hint">Runs only for this business after CALL-E confirms and validates a result. The payload contains status metadata, not result content. External action steps are unavailable for this trigger.</p>
              <fieldset className="va-subcard">
                <legend>CALL-E result classifications</legend>
                <p className="va-field-hint">Mappings are pinned to the template ID and version. Each enum option index produces only the selected fixed label in the workflow payload; CALL-E result values are never stored there.</p>
                <p className="va-field-hint">Map an enum option index from a pinned template version to a workflow label. These rules apply only to this business and template version. Raw values are never stored.</p>
                {(definition.result_classifications || []).length > 0 ? <div className="va-grid">
                  <div><label className="va-field-label" htmlFor="workflow-template-id">Template ID</label><UiInput id="workflow-template-id" type="number" min={1} value={definition.template_id ?? ''} onChange={(event) => setDefinition((current) => ({ ...current, template_id: event.target.value === '' ? undefined : Number(event.target.value) }))} /></div>
                  <div><label className="va-field-label" htmlFor="workflow-template-version">Template version</label><UiInput id="workflow-template-version" type="number" min={1} value={definition.template_version ?? ''} onChange={(event) => setDefinition((current) => ({ ...current, template_version: event.target.value === '' ? undefined : Number(event.target.value) }))} /></div>
                </div> : null}
                <ol className="va-native-list" aria-label="CALL-E result classification mappings">{(definition.result_classifications || []).map((rule, index) => (
                  <li className="va-native-list-row" key={`${rule.id}-${index}`}><fieldset className="va-subcard"><legend>{`Mapping ${index + 1}`}</legend>
                    <div className="va-grid">
                      <div><label className="va-field-label" htmlFor={`workflow-classification-id-${index}`}>Classification ID</label><UiInput id={`workflow-classification-id-${index}`} value={rule.id} maxLength={40} onChange={(event) => setDefinition((current) => ({ ...current, result_classifications: (current.result_classifications || []).map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item) }))} /></div>
                      <div><label className="va-field-label" htmlFor={`workflow-classification-field-${index}`}>Result field</label><UiInput id={`workflow-classification-field-${index}`} value={rule.field} maxLength={80} onChange={(event) => setDefinition((current) => ({ ...current, result_classifications: (current.result_classifications || []).map((item, itemIndex) => itemIndex === index ? { ...item, field: event.target.value } : item) }))} /></div>
                      <div><label className="va-field-label" htmlFor={`workflow-classification-enum-${index}`}>Enum option index</label><UiInput id={`workflow-classification-enum-${index}`} type="number" min={0} max={31} value={rule.enum_index} onChange={(event) => setDefinition((current) => ({ ...current, result_classifications: (current.result_classifications || []).map((item, itemIndex) => itemIndex === index ? { ...item, enum_index: event.target.value === '' ? -1 : Number(event.target.value) } : item) }))} /></div>
                      <div><label className="va-field-label" htmlFor={`workflow-classification-label-${index}`}>Outcome label</label><UiSelect id={`workflow-classification-label-${index}`} value={rule.label} onChange={(event) => setDefinition((current) => ({ ...current, result_classifications: (current.result_classifications || []).map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value as ResultClassificationLabel } : item) }))}>{CLASSIFICATION_LABELS.map((label) => <option key={label} value={label}>{label.replace(/_/g, ' ')}</option>)}</UiSelect></div>
                    </div><UiButton variant="plain" onClick={() => setDefinition((current) => ({ ...current, result_classifications: (current.result_classifications || []).filter((_, itemIndex) => itemIndex !== index), ...((current.result_classifications || []).length <= 1 ? { template_id: undefined, template_version: undefined } : {}) }))}>Remove mapping</UiButton>
                  </fieldset></li>
                ))}</ol>
                <UiButton variant="secondary" disabled={(definition.result_classifications || []).length >= 16} onClick={() => setDefinition((current) => ({ ...current, result_classifications: [...(current.result_classifications || []), { id: '', field: '', enum_index: 0, label: 'unknown' }] }))}>Add classification</UiButton>
              </fieldset>
            </>
          ) : null}
        </UiCard>

        <UiCard>
          <header className="va-ops-card-header"><div className="va-ops-card-headline"><h3>Steps</h3><p className="va-muted">Connect each step to an existing next step. Every path must end.</p></div><UiBadge variant="meta">{definition.steps.length} / 50</UiBadge></header>
          <label className="va-field-label" htmlFor="workflow-start-step">Start step</label>
          <UiSelect id="workflow-start-step" value={definition.start_step_id} onChange={(event) => setDefinition((current) => ({ ...current, start_step_id: event.target.value }))}>
            {targetOptions(definition.start_step_id)}
          </UiSelect>
          <div className="va-inline-tools" aria-label="Add workflow step">
            <label className="va-field-label" htmlFor="workflow-add-step">New step type</label>
            <UiSelect id="workflow-add-step" value={addStepType} onChange={(event) => setAddStepType(event.target.value as WorkflowStepType)}>
              {STEP_TYPE_OPTIONS.map((type) => <option key={type} value={type} disabled={callEResultTrigger && type === 'action'}>{type === 'approval' ? 'Human approval' : type === 'wait' ? 'Wait' : type === 'branch' ? 'Branch' : type === 'end' ? 'End' : 'External action'}</option>)}
            </UiSelect>
            <UiButton variant="secondary" disabled={busy || definition.steps.length >= 50 || (callEResultTrigger && addStepType === 'action')} onClick={addStep}>Add step</UiButton>
          </div>
          <ol className="va-native-list" aria-label="Workflow steps">
            {definition.steps.map((step, index) => (
              <li className="va-native-list-row" key={`${step.id}-${index}`}>
                <fieldset className="va-subcard">
                  <legend>{`Step ${index + 1}: ${step.type}`}</legend>
                  <div className="va-grid">
                    <div><label className="va-field-label" htmlFor={`workflow-step-id-${index}`}>Step ID</label><UiInput id={`workflow-step-id-${index}`} value={step.id} maxLength={80} onChange={(event) => {
                      const oldId = step.id;
                      const newId = event.target.value;
                      setDefinition((current) => ({
                        ...current,
                        start_step_id: current.start_step_id === oldId ? newId : current.start_step_id,
                        steps: current.steps.map((candidate) => {
                          const next = { ...candidate };
                          if (next.id === oldId) next.id = newId;
                          if (next.next_step_id === oldId) next.next_step_id = newId;
                          if (next.true_step_id === oldId) next.true_step_id = newId;
                          if (next.false_step_id === oldId) next.false_step_id = newId;
                          return next;
                        }),
                      }));
                      setConfigTexts((current) => {
                        if (!(oldId in current)) return current;
                        const next = { ...current, [newId]: current[oldId] };
                        delete next[oldId];
                        return next;
                      });
                      setConditionTexts((current) => {
                        if (!(oldId in current)) return current;
                        const next = { ...current, [newId]: current[oldId] };
                        delete next[oldId];
                        return next;
                      });
                    }} /></div>
                    <div><label className="va-field-label" htmlFor={`workflow-step-type-${index}`}>Step type</label><UiSelect id={`workflow-step-type-${index}`} value={step.type} disabled={step.type === 'end'} onChange={(event) => {
                      const type = event.target.value as WorkflowStepType;
                      if (callEResultTrigger && type === 'action') return;
                      const next = createStep(type, step.id, step.next_step_id || definition.steps.find((candidate) => candidate.type === 'end' && candidate.id !== step.id)?.id || step.id);
                      updateStep(step.id, next);
                      if (type === 'action') setConfigTexts((current) => ({ ...current, [step.id]: '{}' }));
                      if (type === 'branch') setConditionTexts((current) => ({ ...current, [step.id]: JSON.stringify(next.condition || { field: 'result_status', exists: true }, null, 2) }));
                    }}>
                      <option value="end">End</option><option value="approval">Human approval</option><option value="wait">Wait</option><option value="branch">Branch</option><option value="action" disabled={callEResultTrigger}>External action</option>
                    </UiSelect></div>
                  </div>
                  {step.type === 'wait' ? <><label className="va-field-label" htmlFor={`workflow-wait-${index}`}>Wait seconds</label><UiInput id={`workflow-wait-${index}`} type="number" min={1} max={2592000} value={step.seconds || 1} onChange={(event) => updateStep(step.id, { seconds: Number(event.target.value) })} /><label className="va-field-label" htmlFor={`workflow-next-${index}`}>Next step</label><UiSelect id={`workflow-next-${index}`} value={step.next_step_id || ''} onChange={(event) => updateStep(step.id, { next_step_id: event.target.value })}>{targetOptions(step.next_step_id)}</UiSelect></> : null}
                  {step.type === 'approval' ? <><label className="va-field-label" htmlFor={`workflow-next-${index}`}>Next step after approval</label><UiSelect id={`workflow-next-${index}`} value={step.next_step_id || ''} onChange={(event) => updateStep(step.id, { next_step_id: event.target.value })}>{targetOptions(step.next_step_id)}</UiSelect></> : null}
                  {step.type === 'branch' ? <>
                    {isEditableSimpleBranchCondition(conditionTexts[step.id] ?? step.condition) ? <>
                    <label className="va-field-label" htmlFor={`workflow-branch-field-${index}`}>Condition field</label><UiInput id={`workflow-branch-field-${index}`} value={typeof step.condition?.field === 'string' ? step.condition.field : ''} maxLength={160} placeholder="result_status" onChange={(event) => {
                      const nextCondition = { ...(step.condition ?? {} as Record<string, unknown>), field: event.target.value } as Record<string, unknown>;
                      if (!('exists' in nextCondition) && !('equals' in nextCondition) && !('in' in nextCondition) && !('includes' in nextCondition) && !('all' in nextCondition) && !('any' in nextCondition)) {
                        nextCondition.exists = true;
                      }
                      updateStep(step.id, { condition: nextCondition });
                      setConditionTexts((current) => ({ ...current, [step.id]: JSON.stringify(nextCondition, null, 2) }));
                    }} />
                    <label className="va-field-label" htmlFor={`workflow-branch-operator-${index}`}>Condition operator</label><UiSelect id={`workflow-branch-operator-${index}`} value={step.condition && typeof step.condition === 'object' && 'exists' in step.condition ? 'exists' : 'equals'} onChange={(event) => {
                      const field = typeof step.condition?.field === 'string' ? step.condition.field : '';
                      const nextCondition = (event.target.value === 'exists' ? { field, exists: true } : { field, equals: '' }) as Record<string, unknown>;
                      updateStep(step.id, { condition: nextCondition });
                      setConditionTexts((current) => ({ ...current, [step.id]: JSON.stringify(nextCondition, null, 2) }));
                    }}><option value="exists">Field exists</option><option value="equals">Equals text</option></UiSelect>
                    {'equals' in (step.condition || {}) ? <><label className="va-field-label" htmlFor={`workflow-branch-value-${index}`}>Expected value</label><UiInput id={`workflow-branch-value-${index}`} value={typeof step.condition?.equals === 'string' ? step.condition.equals : ''} maxLength={256} onChange={(event) => {
                      const nextCondition = { ...(step.condition ?? {} as Record<string, unknown>), equals: event.target.value } as Record<string, unknown>;
                      updateStep(step.id, { condition: nextCondition });
                      setConditionTexts((current) => ({ ...current, [step.id]: JSON.stringify(nextCondition, null, 2) }));
                    }} /></> : null}
                    </> : null}
                    <label className="va-field-label" htmlFor={`workflow-branch-condition-json-${index}`}>Condition JSON</label>
                    <UiTextarea id={`workflow-branch-condition-json-${index}`} value={conditionTexts[step.id] ?? JSON.stringify(step.condition || { field: 'result_status', exists: true }, null, 2)} rows={6} maxLength={16000} onChange={(event) => {
                      const value = event.target.value;
                      setConditionTexts((current) => ({ ...current, [step.id]: value }));
                      try {
                        const parsed = JSON.parse(value) as Record<string, unknown>;
                        updateStep(step.id, { condition: parsed });
                      } catch {
                        // Keep the raw JSON text until it parses cleanly.
                      }
                    }} />
                    <p className="va-field-hint">Use full branch conditions such as {`{"field":"status","equals":"completed"}`} or {`{"all":[{"field":"status","equals":"completed"},{"field":"priority","in":["vip","rush"]}]}`}. The server accepts the same condition grammar used for runtime branch evaluation.</p>
                    <div className="va-grid"><div><label className="va-field-label" htmlFor={`workflow-branch-true-${index}`}>When true</label><UiSelect id={`workflow-branch-true-${index}`} value={step.true_step_id || ''} onChange={(event) => updateStep(step.id, { true_step_id: event.target.value })}>{targetOptions(step.true_step_id)}</UiSelect></div><div><label className="va-field-label" htmlFor={`workflow-branch-false-${index}`}>When false</label><UiSelect id={`workflow-branch-false-${index}`} value={step.false_step_id || ''} onChange={(event) => updateStep(step.id, { false_step_id: event.target.value })}>{targetOptions(step.false_step_id)}</UiSelect></div></div>
                  </> : null}
                  {step.type === 'action' ? <>
                    <label className="va-field-label" htmlFor={`workflow-action-type-${index}`}>Action</label><UiSelect id={`workflow-action-type-${index}`} value={step.action_type || 'send_email'} onChange={(event) => updateStep(step.id, { action_type: event.target.value })}>{ACTION_TYPE_OPTIONS.map((action) => <option key={action} value={action}>{action.replace(/_/g, ' ')}</option>)}</UiSelect>
                    <label className="va-field-label" htmlFor={`workflow-action-config-${index}`}>Action configuration (JSON object)</label><UiTextarea id={`workflow-action-config-${index}`} value={configTexts[step.id] ?? JSON.stringify(step.config || {}, null, 2)} rows={4} maxLength={16000} onChange={(event) => setConfigTexts((current) => ({ ...current, [step.id]: event.target.value }))} />
                    <label className="va-field-label" htmlFor={`workflow-next-${index}`}>Next step</label><UiSelect id={`workflow-next-${index}`} value={step.next_step_id || ''} onChange={(event) => updateStep(step.id, { next_step_id: event.target.value })}>{targetOptions(step.next_step_id)}</UiSelect>
                  </> : null}
                  {step.type !== 'end' ? <div className="va-inline-tools"><UiButton variant="plain" disabled={busy} aria-label={`Remove step ${step.id}`} onClick={() => removeStep(step.id)}>Remove step</UiButton></div> : <>
                    <p className="va-field-hint">End of this workflow path.</p>
                    <UiButton variant="plain" disabled={busy || endStepCount <= 1} aria-label={`Remove end step ${step.id}`} onClick={() => removeStep(step.id)}>Remove end step</UiButton>
                  </>}
                </fieldset>
              </li>
            ))}
          </ol>
          <p className="va-field-hint">Branch and action details are bounded by the server schema. All paths must be reachable, acyclic, and end at an end step.</p>
          <div className="va-inline-tools">
            <UiButton variant="primary" disabled={busy} onClick={() => { void saveDraft(); }}>{busy ? 'Saving…' : 'Save draft'}</UiButton>
            <UiButton variant="secondary" disabled={busy} onClick={() => { void loadWorkspace(); }}>Refresh workflows</UiButton>
          </div>
        </UiCard>

        <UiCard>
          <div className="va-ops-card-header"><div className="va-ops-card-headline"><h3>Saved versions</h3><p className="va-muted">Load a version as a starting point; saving creates a new immutable draft.</p></div></div>
          {versions.length === 0 ? <UiStatePanel compact tone={busy ? 'info' : 'warning'} title={busy ? 'Loading versions' : 'No saved versions'} description={busy ? 'Loading workflow definitions.' : 'Save a valid workflow definition to create the first draft.'} /> : (
            <ul className="va-native-list" aria-label="Workflow versions">{versions.map((version, index) => {
              const workflowId = formatLabel(version.workflow_id);
              return <li className="va-native-list-row" key={`${workflowId}-${formatLabel(version.version)}-${index}`}>
                <div className="va-native-list-head"><strong>{formatLabel(version.name, workflowId)}</strong><UiBadge variant={version.status === 'approved' ? 'success' : 'meta'}>{formatLabel(version.status)}</UiBadge></div>
                <div className="va-native-list-meta"><span>{workflowId} · v{formatLabel(version.version)}</span><span>{formatLabel(version.trigger_event)}</span></div>
                <UiButton variant="chip" disabled={busy} onClick={() => loadVersion(version)}>Use as starting point</UiButton>
              </li>;
            })}</ul>
          )}
        </UiCard>
      </section>

      <section className="va-section-block">
        <header className="va-section-header"><h3 className="va-section-title">Execution review</h3><p className="va-muted">Run and step status only. Trigger payloads and action result data are intentionally excluded.</p></header>
        <section className="va-grid">
          <UiCard>
            <div className="va-ops-card-header"><div className="va-ops-card-headline"><h3>Recent workflow runs</h3><p className="va-muted">Select a run to inspect its sanitized step audit.</p></div></div>
            {runs.length === 0 ? <UiStatePanel compact tone={busy ? 'info' : 'warning'} title={busy ? 'Loading runs' : 'No workflow runs'} description={busy ? 'Loading execution history.' : 'Runs appear after an approved workflow matches a completed call while execution is enabled.'} /> : (
              <ul className="va-native-list" aria-label="Recent workflow runs">{runs.map((run) => {
                const runId = formatLabel(run.run_id);
                return <li className="va-native-list-row" key={runId}>
                  <div className="va-native-list-head"><strong>{formatLabel(run.workflow_id)} · v{formatLabel(run.workflow_version)}</strong><UiBadge variant={run.status === 'completed' ? 'success' : run.status === 'needs_review' ? 'warning' : 'info'}>{formatLabel(run.status)}</UiBadge></div>
                  <div className="va-native-list-meta"><span>Run {runId}</span><span>{vm.formatTime(run.created_at)}</span></div>
                  <div className="va-inline-tools"><UiButton variant="chip" disabled={busy} aria-label={`Inspect run ${runId}`} onClick={() => { void loadRun(runId); }}>Inspect steps</UiButton>{run.error_code ? <span className="va-muted">Issue: {formatLabel(run.error_code)}</span> : null}</div>
                </li>;
              })}</ul>
            )}
          </UiCard>
          <UiCard>
            <div className="va-ops-card-header"><div className="va-ops-card-headline"><h3>Step audit</h3><p className="va-muted">{selectedRun ? `Run ${formatLabel(selectedRun.run_id)}` : 'Choose a run to see step metadata.'}</p></div></div>
            {selectedRun ? selectedSteps.length > 0 ? <ul className="va-native-list" aria-label="Workflow step audit">{selectedSteps.map((step, index) => (
              <li className="va-native-list-row" key={`${formatLabel(step.step_id)}-${index}`}>
                <div className="va-native-list-head"><strong>{formatLabel(step.step_id)}</strong><UiBadge variant={step.status === 'completed' || step.status === 'approved' ? 'success' : step.status === 'needs_review' ? 'warning' : 'info'}>{formatLabel(step.status)}</UiBadge></div>
                <div className="va-native-list-meta"><span>{formatLabel(step.step_type)}{step.action_type ? ` · ${formatLabel(step.action_type)}` : ''}</span><span>{formatLabel(step.error_code, '')}</span></div>
              </li>
            ))}</ul> : <UiStatePanel compact tone="info" title="No step audit yet" description="This run has not recorded any workflow steps." /> : <UiStatePanel compact tone="info" title="Run not selected" description="Choose an execution above to inspect its step status." />}
          </UiCard>
        </section>
      </section>
    </>
  );
}
