import { useState } from 'react';

import { DASHBOARD_ACTION_CONTRACTS } from '@/contracts/miniappParityContracts';
import {
  UiBadge,
  UiButton,
  UiCard,
  UiInput,
  UiSelect,
  UiStatePanel,
} from '@/components/ui/AdminPrimitives';

type CallEOperationRow = {
  localCallId: string;
  templateId: number | null;
  templateVersion: number | null;
  executionStatus: string;
  callOutcome: string | null;
  resultStatus: string;
  errorCode: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type ActionRunner = (
  action: string,
  payload: Record<string, unknown>,
  onSuccess: (result: Record<string, unknown>) => void,
) => Promise<void>;

type CallEOperationsPanelProps = {
  runAction: ActionRunner;
  busy: boolean;
  error: string;
  formatTime: (value: unknown) => string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function CallEOperationsPanel({ runAction, busy, error, formatTime }: CallEOperationsPanelProps) {
  const [rows, setRows] = useState<CallEOperationRow[]>([]);
  const [summary, setSummary] = useState({ active: 0, failed: 0, resultsReady: 0 });
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [executionStatus, setExecutionStatus] = useState('');
  const [callOutcome, setCallOutcome] = useState('');
  const [resultStatus, setResultStatus] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selectedCallId, setSelectedCallId] = useState('');
  const [timeline, setTimeline] = useState<Array<Record<string, unknown>>>([]);
  const [review, setReview] = useState<Record<string, unknown> | null>(null);
  const selected = rows.find((row) => row.localCallId === selectedCallId) || null;
  const accessDenied = /business operator access is required|missing capability/i.test(error);

  const loadRows = (nextOffset = 0) => {
    void runAction(DASHBOARD_ACTION_CONTRACTS.CALLE_CALLS_LIST, {
      limit: 20,
      offset: nextOffset,
      query: query.trim(),
      execution_status: executionStatus,
      call_outcome: callOutcome,
      result_status: resultStatus,
      start_date: startDate,
      end_date: endDate,
    }, (data) => {
      const nextRows = Array.isArray(data.rows) ? data.rows as CallEOperationRow[] : [];
      const nextSummary = asRecord(data.summary);
      setRows(nextRows);
      setSummary({
        active: Number(nextSummary.active) || 0,
        failed: Number(nextSummary.failed) || 0,
        resultsReady: Number(nextSummary.resultsReady) || 0,
      });
      setTotal(Number(data.total) || 0);
      setOffset(nextOffset);
      setLoaded(true);
      if (!nextRows.some((row) => row.localCallId === selectedCallId)) {
        setSelectedCallId(nextRows[0]?.localCallId || '');
        setTimeline([]);
        setReview(null);
      }
    });
  };

  const reconcileSelected = () => {
    if (!selected) return;
    void runAction(DASHBOARD_ACTION_CONTRACTS.CALLE_OPS_RECONCILE, { local_call_id: selected.localCallId }, (data) => {
      const result = asRecord(data.result);
      const events = Array.isArray(result.events) ? result.events.map(asRecord) : [];
      setTimeline(events.slice(0, 20));
      setReview(null);
      loadRows(offset);
    });
  };

  const reviewSelected = () => {
    if (!selected || !window.confirm('This loads private CALL-E transcript and result content for your authorized business. Continue only if you are permitted to review this call.')) return;
    void runAction(DASHBOARD_ACTION_CONTRACTS.CALLE_OPS_REVIEW, { local_call_id: selected.localCallId }, (data) => {
      setReview(asRecord(data.result));
    });
  };

  return (
    <section className="va-section-block" aria-labelledby="call-e-operations-title">
      <header className="va-section-header">
        <h3 id="call-e-operations-title" className="va-section-title">CALL-E Operations</h3>
        <p className="va-muted">Business-scoped execution history. Private transcript and result content require an explicit review action.</p>
      </header>
      <UiCard className="va-investigation-card">
        <div className="va-ops-card-header">
          <div className="va-ops-card-headline">
            <h3>CALL-E call history</h3>
            <p className="va-muted">Status and outcome summaries come from locally linked Calls V2 records.</p>
          </div>
          <UiBadge variant={accessDenied ? 'error' : busy ? 'info' : loaded ? 'success' : 'meta'}>
            {accessDenied ? 'Access required' : busy ? 'Loading' : loaded ? `${total} calls` : 'Not loaded'}
          </UiBadge>
        </div>

        <div className="va-overview-metrics-grid" aria-label="CALL-E call summary">
          <article className="va-overview-metric-card"><span>Active</span><strong>{summary.active}</strong></article>
          <article className="va-overview-metric-card"><span>Failed</span><strong>{summary.failed}</strong></article>
          <article className="va-overview-metric-card"><span>Results ready</span><strong>{summary.resultsReady}</strong></article>
        </div>

        <div className="va-inline-tools">
          <label className="va-field">
            <span>Call ID search</span>
            <UiInput aria-label="CALL-E local or provider call ID" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="CALL-E call ID" />
          </label>
          <label className="va-field">
            <span>Execution status</span>
            <UiSelect aria-label="Filter by execution status" value={executionStatus} onChange={(event) => setExecutionStatus(event.target.value)}>
              <option value="">All statuses</option><option value="queued">Queued</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="canceled">Canceled</option>
            </UiSelect>
          </label>
          <label className="va-field">
            <span>Call outcome</span>
            <UiSelect aria-label="Filter by call outcome" value={callOutcome} onChange={(event) => setCallOutcome(event.target.value)}>
              <option value="">All outcomes</option><option value="completed">Completed</option><option value="no_answer">No answer</option><option value="busy">Busy</option><option value="declined">Declined</option>
            </UiSelect>
          </label>
          <label className="va-field">
            <span>Result readiness</span>
            <UiSelect aria-label="Filter by result readiness" value={resultStatus} onChange={(event) => setResultStatus(event.target.value)}>
              <option value="">All result states</option><option value="pending">Pending</option><option value="available">Available</option><option value="unavailable">Unavailable</option><option value="not_applicable">Not applicable</option>
            </UiSelect>
          </label>
        </div>
        <div className="va-inline-tools">
          <label className="va-field"><span>Created from</span><UiInput aria-label="Created from date" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
          <label className="va-field"><span>Created through</span><UiInput aria-label="Created through date" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
          <UiButton variant="secondary" disabled={busy} onClick={() => loadRows(0)}>Load CALL-E calls</UiButton>
        </div>

        {error ? (
          <UiStatePanel compact tone={accessDenied ? 'warning' : 'error'} title={accessDenied ? 'Operator access required' : 'CALL-E history unavailable'} description={accessDenied ? 'This workspace lists calls only for current CALL-E business operators.' : error} />
        ) : null}
        {loaded && rows.length === 0 ? (
          <UiStatePanel compact title="No CALL-E calls found" description="No locally linked calls match this business scope and filter set." />
        ) : null}
        {rows.length > 0 ? (
          <div className="va-grid">
            <ul className="va-native-list" aria-label="CALL-E call history">
              {rows.map((row) => (
                <li key={row.localCallId} className="va-native-list-row">
                  <div className="va-native-list-head">
                    <UiButton variant="chip" className={selectedCallId === row.localCallId ? 'is-active' : ''} aria-pressed={selectedCallId === row.localCallId} onClick={() => { setSelectedCallId(row.localCallId); setTimeline([]); setReview(null); }}>
                      {row.localCallId}
                    </UiButton>
                    <span className="va-native-list-value">{row.executionStatus}</span>
                  </div>
                  <div className="va-native-list-meta">
                    <span>Outcome {row.callOutcome || 'pending'}</span>
                    <span>Result {row.resultStatus}</span>
                    <span>Template {row.templateId ?? 'n/a'} v{row.templateVersion ?? 'n/a'}</span>
                    <span>{formatTime(row.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
            <div>
              {selected ? (
                <>
                  <div className="va-inline-tools">
                    <UiButton variant="secondary" disabled={busy} onClick={reconcileSelected}>Refresh status and timeline</UiButton>
                    <UiButton variant="secondary" disabled={busy || selected.resultStatus !== 'available'} onClick={reviewSelected}>Review transcript and result</UiButton>
                  </div>
                  <p className="va-muted">Provider: CALL-E. Recordings, billed cost, and a separate summary are not exposed by this integration.</p>
                  {timeline.length > 0 ? (
                    <ol aria-label="CALL-E status timeline" className="va-native-list">
                      {timeline.map((event, index) => (
                        <li key={`${asText(event.id, 'event')}-${index}`} className="va-native-list-row">
                          <strong>{asText(event.type, 'event')}</strong> <span>{formatTime(event.createdAt)}</span>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {review ? (
                    <section aria-label="CALL-E private call review" className="va-subcard">
                      <h4>Authorized call review</h4>
                      <p>Execution: {asText(review.executionStatus, 'unknown')} · Outcome: {asText(review.callOutcome, 'unknown')} · Result: {asText(review.resultStatus, 'unknown')}</p>
                      <h5>Structured result</h5>
                      <pre>{JSON.stringify(review.result ?? null, null, 2)}</pre>
                      <h5>Transcript</h5>
                      {Array.isArray(review.transcript) && review.transcript.length > 0 ? (
                        <ol>{review.transcript.map((turn, index) => {
                          const item = asRecord(turn);
                          return <li key={`turn-${index}`}><strong>{asText(item.speaker, 'unknown')}:</strong> {asText(item.text)}</li>;
                        })}</ol>
                      ) : <p className="va-muted">No transcript turns are available.</p>}
                      {review.transcriptTruncated === true || review.resultOmittedForSize === true ? <p className="va-muted">Some content was omitted to keep this review bounded.</p> : null}
                    </section>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        ) : null}
        {loaded && total > 0 ? (
          <div className="va-inline-tools" aria-label="CALL-E history pagination">
            <UiButton variant="secondary" disabled={busy || offset === 0} onClick={() => loadRows(Math.max(0, offset - 20))}>Previous</UiButton>
            <span>Showing {offset + 1}–{Math.min(offset + rows.length, total)} of {total}</span>
            <UiButton variant="secondary" disabled={busy || offset + rows.length >= total} onClick={() => loadRows(offset + 20)}>Next</UiButton>
          </div>
        ) : null}
      </UiCard>
    </section>
  );
}
