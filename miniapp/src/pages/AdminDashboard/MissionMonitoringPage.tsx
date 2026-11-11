import { useCallback, useEffect, useMemo, useState } from 'react';

import { AdminPageIntro } from '@/components/admin-dashboard/AdminPageIntro';
import { UiBadge, UiButton, UiCard, UiStatePanel } from '@/components/ui/AdminPrimitives';
import { DASHBOARD_ACTION_CONTRACTS } from '@/contracts/miniappParityContracts';
import { useInvestigationAction } from '@/pages/AdminDashboard/useInvestigationAction';
import type { DashboardVm } from '@/pages/AdminDashboard/types';

type MissionMonitoringPageProps = {
  visible: boolean;
  vm: DashboardVm;
};

type WorkflowRun = Record<string, unknown>;

const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting', 'waiting_approval']);

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

function statusTone(status: unknown): 'info' | 'success' | 'warning' | 'error' {
  const normalized = safeText(status, '').toLowerCase();
  if (['failed', 'needs_review'].includes(normalized)) return 'error';
  if (['waiting', 'waiting_approval'].includes(normalized)) return 'warning';
  if (['queued', 'running', 'completed'].includes(normalized)) return 'success';
  return 'info';
}

export function MissionMonitoringPage({ visible, vm }: MissionMonitoringPageProps) {
  const { investigationBusy, investigationError, runInvestigationAction } = useInvestigationAction(vm.invokeAction);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedRun, setSelectedRun] = useState<WorkflowRun | null>(null);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState('');

  const loadRuns = useCallback(async (isActive: () => boolean = () => true) => {
    setRunsLoading(true);
    setRunsLoaded(false);
    await runInvestigationAction(DASHBOARD_ACTION_CONTRACTS.WORKFLOW_RUNS, { limit: 100 }, (data) => {
      if (!Array.isArray(data.runs)) throw new Error('Workflow run response was invalid.');
      if (!isActive()) return;

      const nextRuns = asRows(data.runs).filter((run) => (
        typeof run.run_id === 'string' && run.run_id.trim().length > 0
      ));
      setRuns(nextRuns);
      setSelectedRunId((current) => (
        nextRuns.some((run) => run.run_id === current)
          ? current
          : safeText(nextRuns[0]?.run_id, '')
      ));
      setLastRefreshed(new Date().toLocaleTimeString());
      setRunsLoaded(true);
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

  const activeRunCount = runs.filter(
    (run) => ACTIVE_STATUSES.has(safeText(run.status, '').toLowerCase()),
  ).length;
  const waitingApprovalCount = runs.filter(
    (run) => safeText(run.status, '').toLowerCase() === 'waiting_approval',
  ).length;
  const reviewCount = runs.filter(
    (run) => safeText(run.status, '').toLowerCase() === 'needs_review',
  ).length;
  const failedCount = runs.filter(
    (run) => safeText(run.status, '').toLowerCase() === 'failed',
  ).length;
  const steps = useMemo(() => (
    asRows(selectedRun?.steps).slice().sort((left, right) => {
      const leftTime = Date.parse(safeText(left.completed_at || left.started_at, ''));
      const rightTime = Date.parse(safeText(right.completed_at || right.started_at, ''));
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    })
  ), [selectedRun]);

  if (!visible) return null;

  return (
    <section aria-label="Mission monitoring overview" role="region">
      <AdminPageIntro
        eyebrow="Operations"
        title="Mission monitoring"
        summary="Monitor persisted workflow run status and sanitized step progress without mutating workflow state."
        meta={(
          <>
            <UiBadge variant="info">Read-only</UiBadge>
            <UiBadge variant="meta">{activeRunCount} active runs</UiBadge>
          </>
        )}
        note="This view reads existing workflow run and step-audit endpoints. It does not expose dispatch, override, retry, or approval actions."
      />

      {investigationError ? (
        <UiStatePanel
          tone="error"
          title="Mission data could not be loaded"
          description={investigationError}
          compact
        />
      ) : null}

      <div className="va-grid" style={{ marginBottom: '1rem' }}>
        <UiCard>
          <div className="va-ops-card-header">
            <div className="va-ops-card-headline">
              <h3>Overview</h3>
              <p className="va-muted">{lastRefreshed ? `Last refreshed ${lastRefreshed}` : 'Waiting for persisted workflow status.'}</p>
            </div>
            <UiButton
              variant="secondary"
              onClick={() => void loadRuns()}
              disabled={runsLoading || Boolean(investigationBusy)}
            >
              Refresh mission status
            </UiButton>
          </div>
          {!runsLoaded ? (
            <UiStatePanel
              tone={runsLoading ? 'info' : 'error'}
              title={runsLoading ? 'Loading mission status' : 'Mission status unavailable'}
              description={runsLoading ? 'Reading persisted workflow run statuses.' : 'Refresh after resolving the request error to load accurate status counts.'}
              compact
            />
          ) : (
            <div className="va-grid">
              <article className="va-overview-metric-card">
                <span>Active</span>
                <strong>{activeRunCount}</strong>
              </article>
              <article className="va-overview-metric-card">
                <span>Waiting approval</span>
                <strong>{waitingApprovalCount}</strong>
              </article>
              <article className="va-overview-metric-card">
                <span>Needs review</span>
                <strong>{reviewCount}</strong>
              </article>
              <article className="va-overview-metric-card">
                <span>Failed</span>
                <strong>{failedCount}</strong>
              </article>
              <article className="va-overview-metric-card">
                <span>Runs listed</span>
                <strong>{runs.length}</strong>
              </article>
            </div>
          )}
        </UiCard>
      </div>

      <div className="va-grid" style={{ marginBottom: '1rem' }}>
        <UiCard>
          <div className="va-ops-card-header">
            <div className="va-ops-card-headline">
              <h3>Workflow runs</h3>
              <p className="va-muted">Latest persisted run summaries visible to this platform-admin session.</p>
            </div>
          </div>
          {runsLoading && !runsLoaded ? (
            <UiStatePanel title="Loading workflow runs" description="Reading persisted run summaries." compact />
          ) : !runsLoaded ? (
            <UiStatePanel
              tone="error"
              title="Workflow runs unavailable"
              description="Refresh after resolving the request error to load run summaries."
              compact
            />
          ) : runs.length === 0 ? (
            <UiStatePanel
              tone="info"
              title="No workflow runs"
              description="No persisted workflow runs were returned."
              compact
            />
          ) : (
            <div className="va-grid" aria-label="Mission monitoring run list">
              {runs.map((run) => {
                const runId = safeText(run.run_id, '');
                return (
                  <button
                    key={runId}
                    type="button"
                    className={selectedRunId === runId ? 'va-chip is-selected' : 'va-chip'}
                    onClick={() => setSelectedRunId(runId)}
                    aria-pressed={selectedRunId === runId}
                    style={{
                      justifyContent: 'space-between',
                      border: selectedRunId === runId ? '1px solid rgba(116, 140, 255, 0.8)' : '1px solid rgba(255,255,255,0.12)',
                      background: selectedRunId === runId ? 'rgba(116, 140, 255, 0.08)' : 'transparent',
                    }}
                  >
                    <span>{runId}</span>
                    <UiBadge variant={statusTone(run.status)}>{safeText(run.status, 'unknown')}</UiBadge>
                  </button>
                );
              })}
            </div>
          )}
        </UiCard>
      </div>

      <div className="va-grid" style={{ marginBottom: '1rem' }}>
        <UiCard>
          <div className="va-ops-card-header">
            <div className="va-ops-card-headline">
              <h3>Step timeline</h3>
              <p className="va-muted">
                {selectedRun
                  ? `${safeText(selectedRun.run_id)} · ${safeText(selectedRun.status, 'unknown')}`
                  : 'Select a run to inspect its sanitized step audit.'}
              </p>
            </div>
            {selectedRun ? <UiBadge variant={statusTone(selectedRun.status)}>{safeText(selectedRun.status)}</UiBadge> : null}
          </div>
          {detailsLoading ? (
            <UiStatePanel title="Loading run details" description="Reading sanitized workflow step status." compact />
          ) : !selectedRun ? (
            <UiStatePanel
              tone="info"
              title="No run selected"
              description="Run step details will appear here when a workflow run is selected."
              compact
            />
          ) : steps.length === 0 ? (
            <UiStatePanel
              tone="info"
              title="No step audit available"
              description="The selected run has no persisted step audit entries."
              compact
            />
          ) : (
            <table aria-label="Mission monitoring step timeline" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">Step</th>
                  <th align="left">Type</th>
                  <th align="left">Status</th>
                  <th align="left">Error code</th>
                  <th align="left">Started</th>
                  <th align="left">Completed</th>
                </tr>
              </thead>
              <tbody>
                {steps.map((step, index) => (
                  <tr key={`${safeText(step.step_id, 'step')}-${index}`}>
                    <td>{safeText(step.step_id, 'Unnamed step')}</td>
                    <td>{safeText(step.step_type, 'Not available')}</td>
                    <td><UiBadge variant={statusTone(step.status)}>{safeText(step.status, 'unknown')}</UiBadge></td>
                    <td>{safeText(step.error_code, 'None')}</td>
                    <td>{formatTimestamp(step.started_at)}</td>
                    <td>{formatTimestamp(step.completed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </UiCard>
      </div>
    </section>
  );
}
