import { useCallback, useEffect, useState } from 'react';

import { UiActionBar, UiBadge, UiButton, UiCard, UiInput, UiSurfaceState } from '@/components/ui/AdminPrimitives';
import type { DashboardVm } from './types';

type CartesiaStatus = {
  enabled?: boolean;
  configured?: boolean;
  apiVersion?: string | null;
  dispatchEnabled?: boolean;
  lineRuntimeEnabled?: boolean;
  lineDataHandlingReviewed?: boolean;
  ttsProvider?: string;
  sttProvider?: string;
  callHistoryAvailable?: boolean;
  phoneAssignmentAvailable?: boolean;
  reviewAuditAvailable?: boolean;
  adminActionAuditAvailable?: boolean;
  phoneNumberOperationAuditAvailable?: boolean;
  providerOperationAuditAvailable?: boolean;
  callOperationAuditAvailable?: boolean;
};

type CartesiaPhoneAssignmentPreview = {
  phoneNumberId: string;
  number: string | null;
  currentAgentId: string | null;
  targetAgentId: string | null;
  requiresChange: boolean;
  requestFingerprint: string;
};

type CartesiaOverview = {
  success?: boolean;
  business_id?: string | null;
  status?: CartesiaStatus;
  capabilities?: Array<{ layer?: string; name?: string; platform?: string }>;
  phoneNumbers?: Array<{
    id?: string;
    label?: string | null;
    number?: string | null;
    ownership?: string;
    agent?: { id?: string; name?: string | null } | null;
    provider?: { id?: string | null; type?: string; label?: string | null } | null;
  }>;
  telephonyProviders?: Array<{
    id?: string;
    type?: string;
    label?: string | null;
    region?: string | null;
    inboundConfigured?: boolean | null;
    outboundConfigured?: boolean | null;
  }>;
  calls?: Array<{
    localCallId?: string;
    providerCallId?: string;
    agentId?: string;
    phoneNumberMasked?: string | null;
    direction?: string;
    status?: string;
    startTime?: string | null;
    endTime?: string | null;
    endReason?: string | null;
    telephonyAccountType?: string | null;
  }>;
  reviewAudit?: Array<{
    id?: number | null;
    actorTelegramId?: string;
    businessId?: string | null;
    providerCallId?: string;
    outcome?: string;
    reasonCode?: string | null;
    createdAt?: string | null;
  }>;
  adminActionAudit?: Array<{
    id?: number | null;
    actorTelegramId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    outcome?: string;
    previousAgentId?: string | null;
    targetAgentId?: string | null;
    reasonCode?: string | null;
    createdAt?: string | null;
  }>;
  phoneNumberOperationAudit?: Array<{
    id?: number | null;
    actorType?: string;
    actorId?: string;
    action?: string;
    resourceId?: string;
    outcome?: string;
    targetAgentId?: string | null;
    reasonCode?: string | null;
    createdAt?: string | null;
  }>;
  providerOperationAudit?: Array<{
    id?: number | null;
    actorType?: string;
    actorId?: string;
    action?: string;
    resourceId?: string;
    outcome?: string;
    reasonCode?: string | null;
    createdAt?: string | null;
  }>;
  callOperationAudit?: Array<{
    id?: number | null;
    actorType?: string;
    actorId?: string;
    action?: string;
    resourceId?: string;
    outcome?: string;
    reasonCode?: string | null;
    createdAt?: string | null;
  }>;
  warnings?: Array<{ source?: string; code?: string }>;
};

type CartesiaCallReview = {
  success?: boolean;
  call?: {
    providerCallId?: string;
    agentId?: string;
    status?: string;
    startTime?: string | null;
    endTime?: string | null;
    direction?: string | null;
    fromNumberMasked?: string | null;
    toNumberMasked?: string | null;
    telephonyAccountType?: string | null;
    summary?: string | null;
    transcript?: Array<{ role?: string; text?: string; startTimestamp?: number | null; endTimestamp?: number | null }>;
    transcriptTruncated?: boolean;
    zdrEnabled?: boolean;
    endReason?: string | null;
  };
};

type CartesiaVoice = { id: string; name: string; description?: string | null; language?: string | null; gender?: string | null; };

type Request = DashboardVm['request'];

function statusLabel(status: CartesiaStatus | undefined): string {
  if (!status?.enabled) return 'Disabled';
  if (!status.configured) return 'Configuration incomplete';
  return 'Configured · connection not checked';
}

function prettyLabel(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return 'unknown';
  return String(value || 'unknown').replace(/_/g, ' ');
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'Time unavailable';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Time unavailable';
}

export function CartesiaOperationsPanel({ request }: { request: Request }) {
  const [overview, setOverview] = useState<CartesiaOverview | null>(null);
  const [businessId, setBusinessId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reviewingCallId, setReviewingCallId] = useState('');
  const [reviewedCall, setReviewedCall] = useState<CartesiaCallReview['call'] | null>(null);
  const [reviewError, setReviewError] = useState('');
  const [reviewErrorCallId, setReviewErrorCallId] = useState('');
  const [assignmentPhoneNumberId, setAssignmentPhoneNumberId] = useState('');
  const [assignmentAgentId, setAssignmentAgentId] = useState('');
  const [assignmentPreview, setAssignmentPreview] = useState<(CartesiaPhoneAssignmentPreview & { idempotencyKey: string }) | null>(null);
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [assignmentError, setAssignmentError] = useState('');
  const [assignmentNotice, setAssignmentNotice] = useState('');
  const [voiceQuery, setVoiceQuery] = useState('');
  const [voices, setVoices] = useState<CartesiaVoice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState('');
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [voicesNextPage, setVoicesNextPage] = useState<string | null>(null);

  const refresh = useCallback(async (requestedBusinessId = '') => {
    setLoading(true);
    setError('');
    try {
      const scope = requestedBusinessId.trim();
      const query = new URLSearchParams({ limit: '20' });
      if (scope) query.set('business_id', scope);
      const result = await request<CartesiaOverview>(`/miniapp/cartesia/overview?${query.toString()}`);
      if (result?.success !== true || !result.status) throw new Error('Cartesia operations data is unavailable.');
      setOverview(result);
    } catch (cause) {
      setOverview(null);
      setError(cause instanceof Error ? cause.message : 'Cartesia operations data is unavailable.');
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reviewCall = useCallback(async (providerCallId: string, requestedBusinessId = '') => {
    if (!window.confirm('This loads private Cartesia transcript and summary content for administrators with call-history access. Continue only if you are permitted to review this call.')) return;
    setReviewingCallId(providerCallId);
    setReviewedCall(null);
    setReviewError('');
    setReviewErrorCallId('');
    try {
      const reviewBody: Record<string, unknown> = { confirm_private_data_review: true };
      if (requestedBusinessId) reviewBody.business_id = requestedBusinessId;
      const result = await request<CartesiaCallReview>(`/miniapp/cartesia/calls/${encodeURIComponent(providerCallId)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reviewBody),
      });
      if (result?.success !== true || !result.call) throw new Error('Cartesia call review is unavailable.');
      setReviewedCall(result.call);
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : 'Cartesia call review is unavailable.');
      setReviewErrorCallId(providerCallId);
    } finally {
      setReviewingCallId('');
    }
  }, [request]);

  const preparePhoneAssignment = useCallback(async () => {
    const phoneNumberId = assignmentPhoneNumberId.trim();
    const targetAgentId = assignmentAgentId.trim() || null;
    if (!phoneNumberId) {
      setAssignmentError('Choose a Cartesia phone number first.');
      return;
    }
    setAssignmentLoading(true);
    setAssignmentError('');
    setAssignmentNotice('');
    setAssignmentPreview(null);
    try {
      const result = await request<{ success?: boolean; preview?: CartesiaPhoneAssignmentPreview }>(
        `/miniapp/cartesia/phone-numbers/${encodeURIComponent(phoneNumberId)}/assignment/preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: targetAgentId }),
        },
      );
      if (result?.success !== true || !result.preview?.requestFingerprint) throw new Error('Cartesia assignment preview is unavailable.');
      setAssignmentPreview({ ...result.preview, idempotencyKey: `ui-${crypto.randomUUID()}` });
    } catch (cause) {
      setAssignmentError(cause instanceof Error ? cause.message : 'Cartesia assignment preview is unavailable.');
    } finally {
      setAssignmentLoading(false);
    }
  }, [assignmentAgentId, assignmentPhoneNumberId, request]);

  const applyPhoneAssignment = useCallback(async () => {
    if (!assignmentPreview) return;
    const target = assignmentPreview.targetAgentId || 'unassigned';
    if (!window.confirm(`Change inbound routing for ${assignmentPreview.number || assignmentPreview.phoneNumberId} from ${assignmentPreview.currentAgentId || 'unassigned'} to ${target}?`)) return;
    setAssignmentLoading(true);
    setAssignmentError('');
    setAssignmentNotice('');
    try {
      const result = await request<{ success?: boolean; assignment?: { changed?: boolean; idempotentReplay?: boolean } }>(
        `/miniapp/cartesia/phone-numbers/${encodeURIComponent(assignmentPreview.phoneNumberId)}/assignment`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: assignmentPreview.targetAgentId,
            approved: true,
            confirmed_fingerprint: assignmentPreview.requestFingerprint,
            idempotency_key: assignmentPreview.idempotencyKey,
          }),
        },
      );
      if (result?.success !== true || !result.assignment) throw new Error('Cartesia did not confirm the phone assignment.');
      setAssignmentPreview(null);
      setAssignmentNotice(result.assignment.idempotentReplay ? 'Cartesia confirmed the previously completed assignment.' : 'Cartesia confirmed the phone assignment.');
      await refresh(businessId);
    } catch (cause) {
      setAssignmentError(cause instanceof Error ? cause.message : 'Cartesia phone assignment is unavailable.');
    } finally {
      setAssignmentLoading(false);
    }
  }, [assignmentPreview, businessId, refresh, request]);

  const status = overview?.status;
  const summaryLabel = statusLabel(status);
  const statusTone = !status?.enabled || !status.configured ? 'warning' : 'info';
  const loadVoices = useCallback(async (append = false) => {
    setVoicesLoading(true);
    setVoicesError('');
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (voiceQuery.trim()) query.set('q', voiceQuery.trim());
      if (append && voicesNextPage) query.set('starting_after', voicesNextPage);
      const result = await request<{ success?: boolean; voices?: CartesiaVoice[]; nextPage?: string | null }>(`/miniapp/cartesia/voices?${query.toString()}`);
      if (result?.success !== true || !Array.isArray(result.voices)) throw new Error('Cartesia voice catalog is unavailable.');
      setVoices((current) => append ? [...current, ...result.voices!] : result.voices!);
      setVoicesNextPage(typeof result.nextPage === 'string' ? result.nextPage : null);
      setVoicesLoaded(true);
    } catch (cause) {
      setVoicesError(cause instanceof Error ? cause.message : 'Cartesia voice catalog is unavailable.');
    } finally {
      setVoicesLoading(false);
    }
  }, [request, voiceQuery, voicesNextPage]);

  return (
    <section className="va-cartesia-operations" aria-label="Cartesia operations">
      <UiCard>
        <div className="va-ops-card-header">
          <div className="va-ops-card-headline">
            <h3>Cartesia operations</h3>
          <p className="va-muted">Managed Agent telephony and Cartesia speech/runtime status. Call reviews and inbound routing changes require separate, explicitly confirmed admin actions; the operator review flag does not represent caller consent or legal approval.</p>
          </div>
          <UiBadge variant={statusTone}>{loading && !overview ? 'Loading' : summaryLabel}</UiBadge>
        </div>
        <UiActionBar
          title="Read-only provider snapshot"
          description="Refresh configuration, phone inventory, linked carrier metadata, and recent stored call outcomes. Provider connection health is not inferred from configuration."
          actions={(
              <UiButton variant="secondary" disabled={loading} onClick={() => { void refresh(businessId); }}>
              {loading ? 'Refreshing…' : 'Refresh Cartesia status'}
            </UiButton>
          )}
        />
        {error ? (
          <UiSurfaceState
            cardTone="subcard"
            eyebrow="Provider snapshot"
            status="Unavailable"
            statusVariant="warning"
            title="Cartesia data could not be loaded"
            description={error}
            tone="warning"
            compact
          />
        ) : null}
        {overview ? (
          <>
            <dl className="va-cartesia-status-grid">
              <div><dt>Managed Agents</dt><dd>{status?.enabled ? (status.configured ? 'Configured' : 'Needs server configuration') : 'Disabled by server'}</dd></div>
              <div><dt>Outbound dispatch</dt><dd>{status?.dispatchEnabled ? 'Enabled by server policy' : 'Disabled by server policy'}</dd></div>
              <div><dt>Hosted agent runtime</dt><dd>{status?.lineRuntimeEnabled ? 'Gate enabled' : 'Gate disabled'}</dd></div>
              <div><dt>Operator data review flag</dt><dd>{status?.lineDataHandlingReviewed ? 'On' : 'Off'}</dd></div>
              <div><dt>Sonic TTS</dt><dd>{status?.ttsProvider === 'cartesia' ? 'Selected in server configuration' : 'Not selected'}</dd></div>
              <div><dt>Ink STT</dt><dd>{status?.sttProvider === 'cartesia' ? 'Selected in server configuration' : 'Not selected'}</dd></div>
              <div><dt>Call history</dt><dd>{status?.callHistoryAvailable ? (overview.business_id ? 'Business membership' : 'Admin access') : 'Restricted'}</dd></div>
              <div><dt>API version</dt><dd>{status?.apiVersion || 'Not configured'}</dd></div>
            </dl>

            {overview.warnings?.length ? (
              <p className="va-cartesia-warning" role="status">
                Some inventory data did not load: {overview.warnings.map((warning) => `${prettyLabel(warning.source)} (${warning.code || 'unavailable'})`).join(', ')}.
              </p>
            ) : null}

            <div className="va-cartesia-subgrid">
              <section aria-labelledby="cartesia-phone-inventory-heading">
                <h4 id="cartesia-phone-inventory-heading">Phone numbers</h4>
                {overview.phoneNumbers?.length ? (
                  <ul className="va-list" aria-label="Cartesia phone number inventory">
                    {overview.phoneNumbers.map((number) => (
                      <li key={number.id}>
                        <strong>{number.label || number.number || number.id}</strong>
                        <span>{number.number || 'Number unavailable'} · {prettyLabel(number.ownership)}</span>
                        <span>Agent: {number.agent?.name || number.agent?.id || 'Unassigned'}</span>
                        <span>Telephony: {number.provider?.label || number.provider?.type || 'Cartesia'}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="va-muted">No Cartesia phone numbers are available in this snapshot.</p>
                )}
                {status?.phoneAssignmentAvailable ? (
                  <div className="va-subcard" aria-label="Inbound agent assignment">
                    <h5>Inbound agent assignment</h5>
                    <p className="va-muted">Prepare and review the current and target agent before changing the number’s inbound routing. Leave the target ID blank to unassign it.</p>
                    <div className="va-inline-tools">
                      <label className="va-field">
                        <span>Cartesia phone number</span>
                        <select className="va-input" aria-label="Cartesia phone number for assignment" value={assignmentPhoneNumberId} onChange={(event) => { setAssignmentPhoneNumberId(event.target.value); setAssignmentPreview(null); }}>
                          <option value="">Choose a number</option>
                          {(overview.phoneNumbers || []).map((number) => (
                            <option key={number.id} value={number.id}>{number.label || number.number || number.id}</option>
                          ))}
                        </select>
                      </label>
                      <label className="va-field">
                        <span>Target Cartesia agent ID</span>
                        <UiInput aria-label="Target Cartesia agent ID" value={assignmentAgentId} onChange={(event) => { setAssignmentAgentId(event.target.value); setAssignmentPreview(null); }} placeholder="agent_… or blank to unassign" />
                      </label>
                      <UiButton variant="secondary" disabled={assignmentLoading || !assignmentPhoneNumberId} onClick={() => { void preparePhoneAssignment(); }}>
                        {assignmentLoading ? 'Working…' : 'Preview assignment'}
                      </UiButton>
                    </div>
                    {assignmentPreview ? (
                      <section className="va-subcard" aria-label="Cartesia phone assignment preview">
                        <strong>Review inbound routing change</strong>
                        <p>{assignmentPreview.number || assignmentPreview.phoneNumberId}: {assignmentPreview.currentAgentId || 'unassigned'} → {assignmentPreview.targetAgentId || 'unassigned'}</p>
                        {assignmentPreview.requiresChange ? (
                          <UiButton variant="primary" disabled={assignmentLoading} onClick={() => { void applyPhoneAssignment(); }}>Confirm inbound assignment</UiButton>
                        ) : <p className="va-muted">This number already has the selected assignment.</p>}
                      </section>
                    ) : null}
                    {assignmentError ? <p role="alert" className="va-cartesia-warning">{assignmentError}</p> : null}
                    {assignmentNotice ? <p role="status" className="va-muted">{assignmentNotice}</p> : null}
                  </div>
                ) : null}
              </section>
              <section aria-labelledby="cartesia-linked-providers-heading">
                <h4 id="cartesia-linked-providers-heading">Linked telephony providers</h4>
                {overview.telephonyProviders?.length ? (
                  <ul className="va-list" aria-label="Cartesia linked telephony providers">
                    {overview.telephonyProviders.map((provider) => (
                      <li key={provider.id}>
                        <strong>{provider.label || provider.id}</strong>
                        <span>{prettyLabel(provider.type)}{provider.region ? ` · ${provider.region}` : ''}</span>
                        <span>
                          SIP configuration: inbound {provider.inboundConfigured === null ? 'not applicable' : provider.inboundConfigured ? 'present' : 'not present'}, outbound {provider.outboundConfigured === null ? 'not applicable' : provider.outboundConfigured ? 'present' : 'not present'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="va-muted">No linked Cartesia telephony providers are available in this snapshot.</p>
                )}
              </section>
            </div>

            <section aria-labelledby="cartesia-call-history-heading">
              <div className="va-ops-card-header">
                <div className="va-ops-card-headline">
                  <h4 id="cartesia-call-history-heading">Recent managed calls</h4>
                  <p className="va-muted">{overview.business_id ? `Business-scoped history for ${overview.business_id}.` : 'The history shows local lifecycle metadata only.'} Private Cartesia call details load only after an explicit review confirmation.</p>
                </div>
                <UiBadge variant="meta">{overview.calls?.length || 0} records</UiBadge>
              </div>
              <div className="va-inline-tools">
                <label className="va-field">
                  <span>Business ID for scoped call history</span>
                  <UiInput aria-label="Business ID for scoped Cartesia call history" value={businessId} onChange={(event) => setBusinessId(event.target.value)} placeholder="Business ID" />
                </label>
                <UiButton variant="secondary" disabled={loading || !businessId.trim()} onClick={() => { void refresh(businessId); }}>Load business call history</UiButton>
              </div>
              {!status?.callHistoryAvailable ? (
                <p className="va-muted">Enter a business ID where you have an active call-operator or policy-manager membership, or use global call-history access if your administrator role provides it.</p>
              ) : overview.calls?.length ? (
                <ul className="va-list" aria-label="Recent Cartesia call history">
                  {overview.calls.map((call) => (
                    <li key={call.localCallId || call.providerCallId}>
                      <div className="va-entity-head">
                        <strong>{prettyLabel(call.direction)} · {prettyLabel(call.status)}</strong>
                        <UiBadge variant={call.status === 'completed' ? 'success' : call.status === 'failed' ? 'warning' : 'info'}>
                          {prettyLabel(call.status)}
                        </UiBadge>
                      </div>
                      <span>{call.phoneNumberMasked || 'Number unavailable'} · {prettyLabel(call.telephonyAccountType)}</span>
                      <span>Agent {call.agentId || 'unknown'} · {formatDate(call.startTime)}</span>
                      <span>Call reference {call.providerCallId || call.localCallId || 'unavailable'}</span>
                      {status?.callHistoryAvailable && call.providerCallId ? (
                        <UiButton
                          variant="secondary"
                          disabled={Boolean(reviewingCallId)}
                          onClick={() => { void reviewCall(call.providerCallId || '', overview.business_id || ''); }}
                        >
                          {reviewingCallId === call.providerCallId ? 'Loading private review…' : 'Review transcript and summary'}
                        </UiButton>
                      ) : null}
                      {reviewingCallId === call.providerCallId ? <p role="status" className="va-muted">Loading private call details from Cartesia…</p> : null}
                      {reviewError && reviewErrorCallId === call.providerCallId ? <p role="alert" className="va-cartesia-warning">{reviewError}</p> : null}
                      {reviewedCall && reviewedCall.providerCallId === call.providerCallId ? (
                        <section className="va-subcard" aria-label="Cartesia private call review">
                          <h5>Authorized call review</h5>
                          <p>Cartesia-provided data · {prettyLabel(reviewedCall.status)} · {prettyLabel(reviewedCall.direction)} · Agent {reviewedCall.agentId || 'unknown'}</p>
                          <p>{reviewedCall.fromNumberMasked || 'From unavailable'} → {reviewedCall.toNumberMasked || 'To unavailable'} · {prettyLabel(reviewedCall.telephonyAccountType)}</p>
                          {reviewedCall.zdrEnabled ? (
                            <p className="va-muted">Zero Data Retention is enabled; transcript and summary content is not available for this call.</p>
                          ) : (
                            <>
                              <h6>Cartesia summary</h6>
                              <p>{reviewedCall.summary || 'No summary is available.'}</p>
                              <h6>Transcript</h6>
                              {reviewedCall.transcript?.length ? (
                                <ol aria-label="Cartesia call transcript">
                                  {reviewedCall.transcript.map((turn, index) => (
                                    <li key={`cartesia-turn-${index}`}><strong>{prettyLabel(turn.role)}:</strong> {turn.text || ''}</li>
                                  ))}
                                </ol>
                              ) : <p className="va-muted">No transcript turns are available.</p>}
                              {reviewedCall.transcriptTruncated ? <p className="va-muted">The transcript was shortened to keep this review bounded.</p> : null}
                            </>
                          )}
                        </section>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="va-muted">No stored Cartesia managed-call records yet.</p>
              )}
            </section>

            {status?.reviewAuditAvailable ? (
              <section aria-labelledby="cartesia-review-audit-heading">
                <div className="va-ops-card-header">
                  <div className="va-ops-card-headline">
                    <h4 id="cartesia-review-audit-heading">Private call review audit</h4>
                    <p className="va-muted">Access metadata only. Transcript, summary, phone number, and provider payload are not stored in this ledger.</p>
                  </div>
                  <UiBadge variant="meta">{overview.reviewAudit?.length || 0} recent events</UiBadge>
                </div>
                {overview.reviewAudit?.length ? (
                  <ul className="va-list" aria-label="Cartesia private call review audit events">
                    {overview.reviewAudit.map((event) => (
                      <li key={event.id || `${event.providerCallId}:${event.createdAt}`}>
                        <strong>{prettyLabel(event.outcome)} · {event.providerCallId || 'Call ID unavailable'}</strong>
                        <span>Operator {event.actorTelegramId || 'unknown'}{event.businessId ? ` · Business ${event.businessId}` : ''}</span>
                        <span>{event.reasonCode ? `Reason ${prettyLabel(event.reasonCode)} · ` : ''}{formatDate(event.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="va-muted">No private Cartesia call reviews have been recorded.</p>}
              </section>
            ) : null}

            {status?.adminActionAuditAvailable ? (
              <section aria-labelledby="cartesia-admin-action-audit-heading">
                <div className="va-ops-card-header">
                  <div className="va-ops-card-headline">
                    <h4 id="cartesia-admin-action-audit-heading">Cartesia admin action audit</h4>
                    <p className="va-muted">Recent phone-agent assignment attempts. Entries contain IDs and outcomes only; credentials and phone numbers are not stored.</p>
                  </div>
                  <UiBadge variant="meta">{overview.adminActionAudit?.length || 0} recent events</UiBadge>
                </div>
                {overview.adminActionAudit?.length ? (
                  <ul className="va-list" aria-label="Cartesia admin action audit events">
                    {overview.adminActionAudit.map((event) => (
                      <li key={event.id || `${event.resourceId}:${event.outcome}:${event.createdAt}`}>
                        <strong>{prettyLabel(event.outcome)} · {prettyLabel(event.action)}</strong>
                        <span>{prettyLabel(event.resourceType)} {event.resourceId || 'unknown'} · Operator {event.actorTelegramId || 'unknown'}</span>
                        <span>{event.previousAgentId || 'unassigned'} → {event.targetAgentId || 'unassigned'}{event.reasonCode ? ` · ${prettyLabel(event.reasonCode)}` : ''}</span>
                        <span>{formatDate(event.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="va-muted">No Cartesia admin actions have been recorded.</p>}
              </section>
            ) : null}

            {status?.phoneNumberOperationAuditAvailable ? (
              <section aria-labelledby="cartesia-phone-operation-audit-heading">
                <div className="va-ops-card-header">
                  <div className="va-ops-card-headline">
                    <h4 id="cartesia-phone-operation-audit-heading">Cartesia phone-number operation audit</h4>
                    <p className="va-muted">Import, provision, release, and admin API assignment events. The shared admin token cannot identify an individual operator.</p>
                  </div>
                  <UiBadge variant="meta">{overview.phoneNumberOperationAudit?.length || 0} recent events</UiBadge>
                </div>
                {overview.phoneNumberOperationAudit?.length ? (
                  <ul className="va-list" aria-label="Cartesia phone-number operation audit events">
                    {overview.phoneNumberOperationAudit.map((event) => (
                      <li key={event.id || `${event.resourceId}:${event.action}:${event.outcome}:${event.createdAt}`}>
                        <strong>{prettyLabel(event.outcome)} · {prettyLabel(event.action)}</strong>
                        <span>Resource {event.resourceId || 'unknown'} · {event.actorType === 'admin_api' ? 'Shared admin API token' : `Mini App user ${event.actorId || 'unknown'}`}</span>
                        <span>{event.targetAgentId ? `Target agent ${event.targetAgentId}` : 'No agent assignment change'}{event.reasonCode ? ` · ${prettyLabel(event.reasonCode)}` : ''}</span>
                        <span>{formatDate(event.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="va-muted">No Cartesia phone-number operation events have been recorded.</p>}
              </section>
            ) : null}

            {status?.providerOperationAuditAvailable ? (
              <section aria-labelledby="cartesia-provider-operation-audit-heading">
                <div className="va-ops-card-header">
                  <div className="va-ops-card-headline">
                    <h4 id="cartesia-provider-operation-audit-heading">Cartesia provider operation audit</h4>
                    <p className="va-muted">Twilio and SIP provider changes, provider deletion, webhook creation, and agent webhook assignment. The shared admin token cannot identify an individual operator.</p>
                  </div>
                  <UiBadge variant="meta">{overview.providerOperationAudit?.length || 0} recent events</UiBadge>
                </div>
                {overview.providerOperationAudit?.length ? (
                  <ul className="va-list" aria-label="Cartesia provider operation audit events">
                    {overview.providerOperationAudit.map((event) => (
                      <li key={event.id || `${event.resourceId}:${event.action}:${event.outcome}:${event.createdAt}`}>
                        <strong>{prettyLabel(event.outcome)} · {prettyLabel(event.action)}</strong>
                        <span>Resource {event.resourceId || 'unknown'} · Shared admin API token</span>
                        {event.reasonCode ? <span>{prettyLabel(event.reasonCode)}</span> : null}
                        <span>{formatDate(event.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="va-muted">No Cartesia provider operation events have been recorded.</p>}
              </section>
            ) : null}

            {status?.callOperationAuditAvailable ? (
              <section aria-labelledby="cartesia-call-operation-audit-heading">
                <div className="va-ops-card-header">
                  <div className="va-ops-card-headline">
                    <h4 id="cartesia-call-operation-audit-heading">Cartesia call operation audit</h4>
                    <p className="va-muted">Approved outbound dispatch and cancellation attempts. Destination numbers and call context are not shown.</p>
                  </div>
                  <UiBadge variant="meta">{overview.callOperationAudit?.length || 0} recent events</UiBadge>
                </div>
                {overview.callOperationAudit?.length ? (
                  <ul className="va-list" aria-label="Cartesia call operation audit events">
                    {overview.callOperationAudit.map((event) => (
                      <li key={event.id || `${event.resourceId}:${event.action}:${event.outcome}:${event.createdAt}`}>
                        <strong>{prettyLabel(event.outcome)} · {prettyLabel(event.action)}</strong>
                        <span>Call {event.resourceId || 'pending'} · Shared admin API token</span>
                        {event.reasonCode ? <span>{prettyLabel(event.reasonCode)}</span> : null}
                        <span>{formatDate(event.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="va-muted">No Cartesia call operation events have been recorded.</p>}
              </section>
            ) : null}

            <section aria-labelledby="cartesia-capability-heading">
              <h4 id="cartesia-capability-heading">Capability availability</h4>
              <ul className="va-cartesia-capability-list" aria-label="Cartesia implemented and planned capabilities">
                {(overview.capabilities || []).map((capability) => (
                  <li key={`${capability.layer}:${capability.name}`}>
                    <span>{prettyLabel(capability.layer)} · {prettyLabel(capability.name)}</span>
                    <UiBadge variant={capability.platform === 'implemented' ? 'success' : capability.platform === 'not_implemented' ? 'warning' : 'meta'}>
                      {prettyLabel(capability.platform)}
                    </UiBadge>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="cartesia-voice-catalog-heading">
              <h4 id="cartesia-voice-catalog-heading">Cartesia voice catalog</h4>
              <p className="va-muted">Read-only provider catalog. API credentials remain on the server; selecting a voice does not change the active call profile.</p>
              <div className="va-inline-tools">
                <label className="va-field">
                  <span>Search voices</span>
                  <UiInput value={voiceQuery} maxLength={100} onChange={(event) => setVoiceQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void loadVoices(); }} />
                </label>
                <UiButton variant="secondary" disabled={voicesLoading || !status?.configured} onClick={() => { setVoices([]); setVoicesNextPage(null); setVoicesLoaded(false); void loadVoices(); }}>{voicesLoading ? 'Loading…' : 'Load voices'}</UiButton>
              </div>
              {voicesError ? <p className="va-cartesia-warning" role="alert">{voicesError}</p> : null}
              {voicesLoaded && !voicesError && !voices.length ? <p className="va-muted">No matching Cartesia voices were returned.</p> : null}
              {voices.length ? <ul className="va-list" aria-label="Cartesia voice catalog">{voices.map((voice) => <li key={voice.id}><strong>{voice.name || voice.id}</strong><span>{voice.id} · {voice.language || 'Language unavailable'} · {voice.gender || 'Gender unavailable'}</span>{voice.description ? <span>{voice.description}</span> : null}</li>)}</ul> : null}
              {voicesNextPage ? <UiButton variant="secondary" disabled={voicesLoading} onClick={() => { void loadVoices(true); }}>{voicesLoading ? 'Loading…' : 'Load more voices'}</UiButton> : null}
            </section>
          </>
        ) : !error ? (
          <p className="va-muted" role="status">Loading Cartesia configuration and stored operations data…</p>
        ) : null}
      </UiCard>
    </section>
  );
}
