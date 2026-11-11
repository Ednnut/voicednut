import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminPageIntro } from '@/components/admin-dashboard/AdminPageIntro';
import { UiBadge, UiButton, UiCard, UiStatePanel } from '@/components/ui/AdminPrimitives';
import { DASHBOARD_ACTION_CONTRACTS } from '@/contracts/miniappParityContracts';
import { useInvestigationAction } from '@/pages/AdminDashboard/useInvestigationAction';
import type { DashboardVm } from '@/pages/AdminDashboard/types';

type ReviewControlsPageProps = {
  visible: boolean;
  vm: DashboardVm;
};

type WorkflowRun = Record<string, unknown>;

const REVIEWABLE_STATUSES = new Set(['waiting_approval', 'needs_review', 'failed']);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRows(value: unknown): WorkflowRun[] {
  return Array.isArray(value)
    ? value.filter((row): row is WorkflowRun => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    : [];
}

function safeText(value: unknown, fallback = 'Not available'): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'Not recorded';
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function statusLabel(status: unknown): string {
  switch (safeText(status, '').toLowerCase()) {
    case 'waiting_approval': return 'Pending approval';
    case 'needs_review': return 'Needs review';
    case 'failed': return 'Failed';
    default: return safeText(status, 'Unknown');
  }
}

function statusTone(status: unknown): 'info' | 'success' | 'warning' | 'error' {
  const normalized = safeText(status, '').toLowerCase();
  if (normalized === 'needs_review' || normalized === 'failed') return 'error';
  if (normalized === 'waiting_approval') return 'warning';
  return 'info';
}

function isReviewableRun(run: WorkflowRun): boolean {
  return REVIEWABLE_STATUSES.has(safeText(run.status, '').toLowerCase());
}

export function ReviewControlsPage({ visible, vm }: ReviewControlsPageProps) {
  const { investigationBusy, investigationError, runInvestigationAction } = useInvestigationAction(vm.invokeAction);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);

  const loadRuns = useCallback(async (isActive: () => boolean = () => true) => {
    setRunsLoading(true);
    setRunsLoaded(false);
    await runInvestigationAction(DASHBOARD_ACTION_CONTRACTS.WORKFLOW_RUNS, { limit: 100 }, (data) => {
      if (!Array.isArray(data.runs)) throw new Error('Review queue response was invalid.');
      if (!isActive()) return;

      const nextRuns = asRows(data.runs).filter((run) => (
        typeof run.run_id === 'string' && run.run_id.trim().length > 0
      ));
      setRuns(nextRuns);
      setRunsLoaded(true);
      setSelectedRunId((current) => (
        nextRuns.some((run) => run.run_id === current)
          ? current
          : safeText(nextRuns.find(isReviewableRun)?.run_id, '')
      ));
    });
    if (isActive()) setRunsLoading(false);
  }, [runInvestigationAction]);

  useEffect(() => {
    if (!visible) return undefined;
    let active = true;
    void loadRuns(() => active);
    return () => {
      active = false;
    };
  }, [loadRuns, visible]);

  useEffect(() => {
    if (!visible || !runsLoaded || !selectedRunId) {
      setSelectedRun(null);
      setDetailsLoading(false);
      return undefined;
    }

    let active = true;
    setSelectedRun(null);
    setDetailsLoading(true);
    void (async () => {
      await runInvestigationAction(
        DASHBOARD_ACTION_CONTRACTS.WORKFLOW_RUN_GET,
        { run_id: selectedRunId },
        (data) => {
          if (!active) return;
          if (!data.run || typeof data.run !== 'object' || Array.isArray(data.run)) {
            throw new Error('Selected workflow run was not found.');
          }
          setSelectedRun(asRecord(data.run));
        },
      );
      if (active) setDetailsLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [runInvestigationAction, runsLoaded, selectedRunId, visible]);

  const reviewableRuns = useMemo(() => runs.filter(isReviewableRun), [runs]);
  const pendingApprovalCount = runs.filter(
    (run) => safeText(run.status, '').toLowerCase() === 'waiting_approval',
  ).length;
  const needsReviewCount = runs.filter(
    (run) => safeText(run.status, '').toLowerCase() === 'needs_review',
  ).length;
  const failedCount = runs.filter(
    (run) => safeText(run.status, '').toLowerCase() === 'failed',
  ).length;
  const selectedSteps = asRows(selectedRun?.steps);
  const exceptionalSteps = selectedSteps.filter((step) => (
    ['needs_review', 'failed'].includes(safeText(step.status, '').toLowerCase())
      || (typeof step.error_code === 'string' && step.error_code.trim().length > 0)
  ));

  if (!visible) return null;

  return (
    <section aria-label="Review controls" role="region">
      <AdminPageIntro
        eyebrow="Governance"
        title="Review controls"
        summary="Inspect persisted workflow approvals and exceptions. This platform-admin view is read-only."
        meta={(
          <>
            <UiBadge variant="info">Read-only</UiBadge>
            <UiBadge variant="meta">{reviewableRuns.length} requiring review</UiBadge>
          </>
        )}
        note="Only status and sanitized step-audit metadata are shown. No approval, retry, cancellation, dispatch, or advance action is available here."
      />

      {investigationError ? (
        <UiStatePanel
          tone="error"
          title="Review data could not be loaded"
          description={investigationError}
          compact
        />
      ) : null}

      <div className="va-grid" style={{ marginBottom: '1rem' }}>
        <UiCard>
          <div className="va-ops-card-header">
            <div className="va-ops-card-headline">
              <h3>Review overview</h3>
              <p className="va-muted">Counts reflect the latest persisted workflow run response.</p>
            </div>
            <UiButton
              variant="secondary"
              onClick={() => void loadRuns()}
              disabled={runsLoading || Boolean(investigationBusy)}
            >
              Refresh review queue
            </UiButton>
          </div>
          <div className="va-grid">
            <article className="va-overview-metric-card">
              <span>Pending approval</span>
              <strong>{pendingApprovalCount}</strong>
            </article>
            <article className="va-overview-metric-card">
              <span>Needs review</span>
              <strong>{needsReviewCount}</strong>
            </article>
            <article className="va-overview-metric-card">
              <span>Failed</span>
              <strong>{failedCount}</strong>
            </article>
            <article className="va-overview-metric-card">
              <span>Runs loaded</span>
              <strong>{runs.length}</strong>
            </article>
          </div>
        </UiCard>
      </div>

      <div className="va-grid" style={{ marginBottom: '1rem' }}>
        <UiCard>
          <div className="va-ops-card-header">
            <div className="va-ops-card-headline">
              <h3>Review queue</h3>
              <p className="va-muted">Runs waiting for approval, needing review, or failed.</p>
            </div>
          </div>
          {runsLoading && !runsLoaded ? (
            <UiStatePanel title="Loading review queue" description="Reading workflow run statuses." compact />
          ) : reviewableRuns.length === 0 ? (
            <UiStatePanel
              tone="info"
              title={investigationError ? 'Review queue unavailable' : 'No runs need review'}
              description={investigationError
                ? 'Resolve the request error and refresh to load persisted workflow status.'
                : 'No pending approval, review, or failed runs were returned.'}
              compact
            />
          ) : (
            <table aria-label="Review queue table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">Run</th>
                  <th align="left">Business</th>
                  <th align="left">Approval / status</th>
                  <th align="left">Current step</th>
                  <th align="left">Blocker</th>
                  <th align="left">Updated</th>
                  <th align="left">Details</th>
                </tr>
              </thead>
              <tbody>
                {reviewableRuns.map((run) => {
                  const runId = safeText(run.run_id, '');
                  return (
                    <tr key={runId}>
                      <td>{runId}</td>
                      <td>{safeText(run.business_id, '—')}</td>
                      <td><UiBadge variant={statusTone(run.status)}>{statusLabel(run.status)}</UiBadge></td>
                      <td>{safeText(run.current_step_id, '—')}</td>
                      <td>{safeText(run.error_code, 'None reported')}</td>
                      <td>{formatTimestamp(run.updated_at || run.created_at)}</td>
                      <td>
                        <UiButton
                          variant="plain"
                          aria-pressed={selectedRunId === runId}
                          onClick={() => setSelectedRunId(runId)}
                        >
                          {selectedRunId === runId ? 'Selected' : 'Inspect'}
                        </UiButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </UiCard>
      </div>

      <div className="va-grid" style={{ marginBottom: '1rem' }}>
        <UiCard>
          <div className="va-ops-card-header">
            <div className="va-ops-card-headline">
              <h3>Selected run exceptions</h3>
              <p className="va-muted">
                {selectedRun
                  ? `${safeText(selectedRun.run_id)} · ${statusLabel(selectedRun.status)}`
                  : 'Select a run requiring review to inspect step audit.'}
              </p>
            </div>
          </div>
          {detailsLoading ? (
            <UiStatePanel title="Loading run details" description="Reading sanitized step-audit metadata." compact />
          ) : !selectedRun ? (
            <UiStatePanel
              tone="info"
              title="No run selected"
              description="Run details appear here when a review-queue row is selected."
              compact
            />
          ) : exceptionalSteps.length === 0 ? (
            <UiStatePanel
              tone="info"
              title="No step exceptions recorded"
              description="The selected run has no failed or needs-review step audit entries."
              compact
            />
          ) : (
            <ul aria-label="Review exceptions list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {exceptionalSteps.map((step, index) => (
                <li
                  key={`${safeText(step.step_id, 'step')}-${index}`}
                  style={{ padding: '0.75rem 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}>
                    <strong>{safeText(step.step_id, 'Unnamed step')}</strong>
                    <UiBadge variant={statusTone(step.status)}>{statusLabel(step.status)}</UiBadge>
                  </div>
                  <div className="va-muted">
                    {safeText(step.step_type, 'Step')}
                    {typeof step.action_type === 'string' ? ` · ${step.action_type}` : ''}
                  </div>
                  <div>
                    Error code: {safeText(step.error_code, 'None')}
                    {' · '}Started: {formatTimestamp(step.started_at)}
                    {' · '}Completed: {formatTimestamp(step.completed_at)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </UiCard>
      </div>
    </section>
  );
}
