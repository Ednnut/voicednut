import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  UiBadge,
  UiButton,
  UiCard,
  UiInput,
  UiSelect,
  UiStatePanel,
  UiTextarea,
} from '@/components/ui/AdminPrimitives';
import { useMiniAppCommandSession } from '@/hooks/useMiniAppCommandSession';

type StepKind = 'approval' | 'wait' | 'action';
type ActionKind = 'send_email' | 'crm_sync' | 'create_ticket';
type StepDraft = {
  kind: StepKind;
  actionType: ActionKind;
  seconds: string;
  to: string;
  subject: string;
  text: string;
  provider: string;
  summary: string;
  contactId: string;
};
type WorkflowVersion = {
  workflow_id: string;
  business_id?: string | null;
  version: number;
  name: string;
  trigger_event: string;
  status: 'draft' | 'approved';
  definition: Record<string, unknown>;
};
type WorkflowRun = {
  run_id: string;
  workflow_id: string;
  workflow_version: number;
  status: string;
  current_step_id?: string | null;
  error_code?: string | null;
  created_at?: string;
};

const EMPTY_STEP: StepDraft = {
  kind: 'approval',
  actionType: 'send_email',
  seconds: '60',
  to: '',
  subject: '',
  text: '',
  provider: '',
  summary: '',
  contactId: '',
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asVersions(value: unknown): WorkflowVersion[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is WorkflowVersion => {
    const row = asObject(entry);
    return typeof row.workflow_id === 'string' && Number.isSafeInteger(Number(row.version));
  });
}

function asRuns(value: unknown): WorkflowRun[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is WorkflowRun => {
    const row = asObject(entry);
    return typeof row.run_id === 'string' && typeof row.status === 'string';
  });
}

function workflowPath(businessId: string): string {
  return `/miniapp/businesses/${encodeURIComponent(businessId)}/post-call`;
}

export function PostCallWorkflowBuilder() {
  const { request } = useMiniAppCommandSession();
  const [businessId, setBusinessId] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [name, setName] = useState('');
  const [triggerEvent, setTriggerEvent] = useState('post_call_completed');
  const [steps, setSteps] = useState<StepDraft[]>([{ ...EMPTY_STEP }]);
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const [selectedIsEditable, setSelectedIsEditable] = useState(true);

  const selected = useMemo(
    () => versions.find((version) => `${version.workflow_id}:${version.version}` === selectedVersion) || null,
    [selectedVersion, versions],
  );

  const loadWorkspace = useCallback(async () => {
    const scope = businessId.trim();
    if (!scope) {
      setError('Enter the business ID assigned to your workflow role.');
      return;
    }
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const base = workflowPath(scope);
      const [versionResponse, runResponse] = await Promise.all([
        request<{ versions?: unknown }>(`${base}/workflows`, { method: 'GET' }),
        request<{ runs?: unknown }>(`${base}/workflow-runs`, { method: 'GET' }),
      ]);
      const nextVersions = asVersions(versionResponse.versions);
      setVersions(nextVersions);
      setRuns(asRuns(runResponse.runs));
      setSelectedVersion((current) => nextVersions.some((version) => `${version.workflow_id}:${version.version}` === current)
        ? current
        : nextVersions[0] ? `${nextVersions[0].workflow_id}:${nextVersions[0].version}` : '');
      setHasLoaded(true);
    } catch {
      setError('Could not load this business workspace. Check the business ID and your active workflow membership.');
      setHasLoaded(false);
    } finally {
      setLoading(false);
    }
  }, [businessId, request]);

  useEffect(() => {
    if (!selected) return;
    setWorkflowId(selected.workflow_id);
    setName(selected.name);
    setTriggerEvent(selected.trigger_event);
    const definition = selected.definition || {};
    const sourceSteps = Array.isArray(definition.steps) ? definition.steps.map(asObject) : [];
    if (sourceSteps.some((step) => step.type === 'branch')) {
      setSelectedIsEditable(false);
      setError('This version contains branch steps. It is available for review but cannot be edited in the current linear builder.');
      return;
    }
    const unsupportedActionConfig = sourceSteps.some((step) => {
      if (step.type !== 'action') return false;
      const config = asObject(step.config);
      const supported = step.action_type === 'send_email'
        ? ['to', 'subject', 'text']
        : step.action_type === 'crm_sync'
          ? ['provider']
          : step.action_type === 'create_ticket'
            ? ['provider', 'contact_id', 'summary']
            : [];
      return Object.keys(config).some((key) => !supported.includes(key));
    });
    if (unsupportedActionConfig) {
      setSelectedIsEditable(false);
      setError('This version contains action settings the current editor cannot preserve. It is available for review but cannot be edited here.');
      return;
    }
    setSelectedIsEditable(true);
    setError('');
    const drafts = sourceSteps.filter((step) => step.type !== 'end').map((step) => {
      const config = asObject(step.config);
      const actionType = (['send_email', 'crm_sync', 'create_ticket'].includes(String(step.action_type))
        ? step.action_type
        : 'send_email') as ActionKind;
      return {
        ...EMPTY_STEP,
        kind: (['approval', 'wait', 'action'].includes(String(step.type)) ? step.type : 'approval') as StepKind,
        actionType,
        seconds: safeText(step.seconds, '60'),
        to: safeText(config.to),
        subject: safeText(config.subject),
        text: safeText(config.text),
        provider: safeText(config.provider),
        summary: safeText(config.summary),
        contactId: safeText(config.contact_id),
      };
    });
    setSteps(drafts.length ? drafts : [{ ...EMPTY_STEP }]);
  }, [selected]);

  const updateStep = (index: number, update: Partial<StepDraft>) => {
    setSteps((current) => current.map((step, stepIndex) => stepIndex === index ? { ...step, ...update } : step));
  };

  const createDefinition = () => {
    const workflow = workflowId.trim();
    const title = name.trim();
    const event = triggerEvent.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(workflow)) throw new Error('Use a workflow ID with letters, numbers, _ or - (up to 120 characters).');
    if (!title || title.length > 120) throw new Error('Enter a workflow name up to 120 characters.');
    if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(event)) throw new Error('Use a lowercase event name such as post_call_completed.');
    const normalizedSteps = steps.map((step, index) => {
      const id = `step_${index + 1}`;
      const next = `step_${index + 2}`;
      if (step.kind === 'approval') return { id, type: 'approval', next_step_id: next };
      if (step.kind === 'wait') {
        const seconds = Number(step.seconds);
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2_592_000) throw new Error(`Step ${index + 1} wait must be from 1 second to 30 days.`);
        return { id, type: 'wait', seconds, next_step_id: next };
      }
      const config: Record<string, unknown> = {};
      if (step.actionType === 'send_email') {
        if (!step.to.trim() && !step.text.trim()) throw new Error(`Email step ${index + 1} needs a recipient or message body.`);
        if (step.to.trim()) config.to = step.to.trim();
        if (step.subject.trim()) config.subject = step.subject.trim();
        if (step.text.trim()) config.text = step.text.trim();
      } else if (step.actionType === 'crm_sync') {
        if (step.provider.trim()) config.provider = step.provider.trim();
      } else {
        if (step.provider.trim()) config.provider = step.provider.trim();
        if (step.contactId.trim()) config.contact_id = step.contactId.trim();
        if (step.summary.trim()) config.summary = step.summary.trim();
      }
      return { id, type: 'action', action_type: step.actionType, config, next_step_id: next };
    });
    const endId = `step_${normalizedSteps.length + 1}`;
    if (!normalizedSteps.length) throw new Error('Add at least one workflow step.');
    if (normalizedSteps.length > 49) throw new Error('A workflow can contain at most 49 editable steps.');
    const final = normalizedSteps[normalizedSteps.length - 1];
    if ('next_step_id' in final) final.next_step_id = endId;
    return {
      schema_version: 1,
      workflow_id: workflow,
      name: title,
      trigger_event: event,
      start_step_id: 'step_1',
      steps: [...normalizedSteps, { id: endId, type: 'end' }],
    };
  };

  const saveDraft = async () => {
    setError('');
    setNotice('');
    try {
      const definition = createDefinition();
      setSaving(true);
      const response = await request<{ version?: WorkflowVersion }>(`${workflowPath(businessId.trim())}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(definition),
      });
      if (response.version) setSelectedVersion(`${response.version.workflow_id}:${response.version.version}`);
      await loadWorkspace();
      setNotice(`Draft version ${response.version?.version || ''} saved. Review and approve it to activate event triggers.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The workflow draft could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const approveVersion = async () => {
    if (!selected || selected.status !== 'draft') return;
    if (!window.confirm(`Approve ${selected.name} version ${selected.version}? Matching ${selected.trigger_event} events can then run its email, CRM, or ticket actions.`)) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request(`${workflowPath(businessId.trim())}/workflows/${encodeURIComponent(selected.workflow_id)}/versions/${selected.version}/approve`, { method: 'POST' });
      await loadWorkspace();
      setNotice('Workflow version approved. Matching events may now start it.');
    } catch {
      setError('The workflow version could not be approved. Your business role may not include policy management.');
    } finally {
      setSaving(false);
    }
  };

  const addStep = () => setSteps((current) => current.length >= 49 ? current : [...current, { ...EMPTY_STEP }]);

  return (
    <section className="va-section-block" aria-labelledby="post-call-workflow-title">
      <header className="va-section-header">
        <h2 className="va-section-title" id="post-call-workflow-title">Post-call workflow builder</h2>
        <p className="va-muted">Build a linear workflow from supported steps. Drafts do not run; approving a version activates it for matching business events.</p>
      </header>
      {error ? <UiStatePanel title="Workflow workspace issue" description={error} tone="error" /> : null}
      {notice ? <UiStatePanel title="Workflow update" description={notice} tone="info" /> : null}
      <UiCard>
        <div className="va-card-grid">
          <label className="va-form-field">
            <span>Business ID</span>
            <UiInput value={businessId} onChange={(event) => setBusinessId(event.target.value)} autoComplete="off" aria-describedby="workflow-business-help" />
            <small id="workflow-business-help" className="va-muted">Your active business operator membership is checked on every request.</small>
          </label>
          <div className="va-inline-tools va-align-end">
            <UiButton onClick={() => void loadWorkspace()} disabled={loading || !businessId.trim()}>{loading ? 'Loading…' : 'Load business workflows'}</UiButton>
          </div>
        </div>
      </UiCard>
      {hasLoaded ? (
        <div className="va-grid">
          <UiCard>
            <div className="va-ops-card-header">
              <div className="va-ops-card-headline"><h3>Versions and runs</h3><p className="va-muted">Review version state and recent executions for this business.</p></div>
              <UiBadge variant="meta">{versions.length} versions</UiBadge>
            </div>
            {versions.length ? (
              <label className="va-form-field"><span>Workflow version</span>
                <UiSelect value={selectedVersion} onChange={(event) => setSelectedVersion(event.target.value)}>
                  {versions.map((version) => <option key={`${version.workflow_id}:${version.version}`} value={`${version.workflow_id}:${version.version}`}>{version.name} · v{version.version} · {version.status}</option>)}
                </UiSelect>
              </label>
            ) : <p className="va-muted">No versions yet. Create a draft to begin.</p>}
            <h4>Recent runs</h4>
            {runs.length ? <ul className="va-list">{runs.slice(0, 8).map((run) => <li key={run.run_id}><strong>{run.workflow_id} v{run.workflow_version}</strong> · {run.status}{run.error_code ? ` · ${run.error_code}` : ''}</li>)}</ul> : <p className="va-muted">No runs recorded for this business.</p>}
          </UiCard>
          <UiCard>
            <div className="va-ops-card-header"><div className="va-ops-card-headline"><h3>Workflow details</h3><p className="va-muted">Save edits as a new immutable draft version.</p></div>{selected ? <UiBadge variant={selected.status === 'approved' ? 'success' : 'warning'}>{selected.status} · v{selected.version}</UiBadge> : null}</div>
            {!selectedIsEditable ? <UiStatePanel title="Read-only workflow" description="This version has settings outside the editor's supported visual subset. Choose a supported workflow or create a new one to make changes." tone="warning" compact /> : null}
            <div className="va-card-grid">
              <label className="va-form-field"><span>Workflow ID</span><UiInput value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} placeholder="customer_follow_up" /></label>
              <label className="va-form-field"><span>Name</span><UiInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Customer follow-up" /></label>
              <label className="va-form-field"><span>Trigger event</span><UiInput value={triggerEvent} onChange={(event) => setTriggerEvent(event.target.value)} placeholder="post_call_completed" /></label>
            </div>
            <ol className="post-call-workflow-flow" aria-label="Workflow steps">
              {steps.map((step, index) => (
                <li className="post-call-workflow-node" key={`workflow-step-${index}`}>
                  <div className="post-call-workflow-node-heading"><span className="post-call-workflow-node-number">{index + 1}</span><strong>Step {index + 1}</strong><UiButton variant="plain" aria-label={`Remove step ${index + 1}`} onClick={() => setSteps((current) => current.filter((_, stepIndex) => stepIndex !== index))} disabled={steps.length <= 1}>Remove</UiButton></div>
                  <label className="va-form-field"><span>Step type</span>
                    <UiSelect aria-label={`Step ${index + 1} type`} value={step.kind} onChange={(event) => updateStep(index, { kind: event.target.value as StepKind })}>
                      <option value="approval">Human approval</option><option value="wait">Wait</option><option value="action">Action</option>
                    </UiSelect>
                  </label>
                  {step.kind === 'wait' ? <label className="va-form-field"><span>Wait seconds (max 30 days)</span><UiInput type="number" min={1} max={2592000} value={step.seconds} onChange={(event) => updateStep(index, { seconds: event.target.value })} /></label> : null}
                  {step.kind === 'action' ? <div className="post-call-workflow-action-fields">
                    <label className="va-form-field"><span>Action</span><UiSelect aria-label={`Step ${index + 1} action`} value={step.actionType} onChange={(event) => updateStep(index, { actionType: event.target.value as ActionKind })}><option value="send_email">Send email</option><option value="crm_sync">Sync CRM</option><option value="create_ticket">Create ticket</option></UiSelect></label>
                    {step.actionType === 'send_email' ? <>
                      <label className="va-form-field"><span>Recipient (optional if event has customer email)</span><UiInput type="email" value={step.to} onChange={(event) => updateStep(index, { to: event.target.value })} /></label>
                      <label className="va-form-field"><span>Subject</span><UiInput value={step.subject} onChange={(event) => updateStep(index, { subject: event.target.value })} /></label>
                      <label className="va-form-field"><span>Email text</span><UiTextarea rows={3} value={step.text} onChange={(event) => updateStep(index, { text: event.target.value })} /></label>
                    </> : null}
                    {step.actionType === 'crm_sync' ? <label className="va-form-field"><span>CRM provider (optional)</span><UiInput value={step.provider} onChange={(event) => updateStep(index, { provider: event.target.value })} /></label> : null}
                    {step.actionType === 'create_ticket' ? <>
                      <label className="va-form-field"><span>Ticket provider (optional)</span><UiInput value={step.provider} onChange={(event) => updateStep(index, { provider: event.target.value })} /></label>
                      <label className="va-form-field"><span>Contact ID (optional)</span><UiInput value={step.contactId} onChange={(event) => updateStep(index, { contactId: event.target.value })} /></label>
                      <label className="va-form-field"><span>Summary</span><UiTextarea rows={3} value={step.summary} onChange={(event) => updateStep(index, { summary: event.target.value })} /></label>
                    </> : null}
                  </div> : null}
                </li>
              ))}
            </ol>
            <UiButton onClick={addStep} disabled={steps.length >= 49}>Add step</UiButton>
            <div className="post-call-workflow-end"><span aria-hidden="true">↓</span><strong>Finish</strong></div>
            <div className="va-inline-tools">
              <UiButton variant="primary" onClick={() => void saveDraft()} disabled={saving || !businessId.trim() || !selectedIsEditable}>{saving ? 'Saving…' : 'Save draft version'}</UiButton>
              <UiButton onClick={() => void approveVersion()} disabled={saving || !selected || selected.status !== 'draft'}>Approve selected draft</UiButton>
            </div>
          </UiCard>
        </div>
      ) : null}
    </section>
  );
}
