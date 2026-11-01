import { useEffect, useRef, useState } from 'react';

import { UiBadge, UiButton, UiCard, UiStatePanel, UiTextarea } from '@/components/ui/AdminPrimitives';

const MAX_DESTINATIONS = 25;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

type PreviewResult = {
  phoneMasked: string;
  status: 'compatible' | 'blocked';
  detail: string;
};

type CallECampaignRehearsalPanelProps = {
  templateId: number;
  templateName: string;
  businessId: string;
  resultSchemaJson: string;
  onPreview: (phone: string, resultSchema: unknown) => Promise<Record<string, unknown>>;
  onCampaignAction: (action: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function maskPhone(phone: string): string {
  const prefix = phone.startsWith('+') ? '+' : '';
  const digits = phone.replace(/\D/g, '');
  return `${prefix}${'•'.repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

function splitDestinations(value: string): string[] {
  return value.split(/[\n,;\t ]+/).map((phone) => phone.trim()).filter(Boolean);
}

export function CallECampaignRehearsalPanel({
  templateId,
  templateName,
  businessId,
  resultSchemaJson,
  onPreview,
  onCampaignAction,
}: CallECampaignRehearsalPanelProps) {
  const [destinationsInput, setDestinationsInput] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [campaignBusy, setCampaignBusy] = useState(false);
  const [campaignError, setCampaignError] = useState('');
  const [campaignNotice, setCampaignNotice] = useState('');
  const [savedCampaign, setSavedCampaign] = useState<Record<string, unknown> | null>(null);
  const [campaigns, setCampaigns] = useState<Array<Record<string, unknown>>>([]);
  const [campaignQueueLoaded, setCampaignQueueLoaded] = useState(false);
  const [selectedReport, setSelectedReport] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<PreviewResult[]>([]);
  const activeRun = useRef(0);
  const activeCampaignScope = useRef(0);

  useEffect(() => {
    activeRun.current += 1;
    activeCampaignScope.current += 1;
    setBusy(false);
    setResults([]);
    setError('');
    setAuthorized(false);
    setSavedCampaign(null);
    setCampaigns([]);
    setCampaignQueueLoaded(false);
    setSelectedReport(null);
    setCampaignNotice('');
  }, [templateId, businessId, resultSchemaJson]);

  const destinations = splitDestinations(destinationsInput);

  const runRehearsal = async (): Promise<void> => {
    setError('');
    setResults([]);
    setSavedCampaign(null);
    setCampaignNotice('');
    if (!Number.isSafeInteger(templateId) || templateId < 1) {
      setError('Select a saved CALL-E template before running the rehearsal.');
      return;
    }
    if (!authorized) {
      setError('Confirm that you are authorized to contact every destination before running previews.');
      return;
    }
    if (destinations.length === 0) {
      setError('Enter at least one destination.');
      return;
    }
    if (destinations.length > MAX_DESTINATIONS) {
      setError(`A rehearsal can preview at most ${MAX_DESTINATIONS} destinations.`);
      return;
    }

    let resultSchema: unknown;
    try {
      resultSchema = JSON.parse(resultSchemaJson);
      if (!resultSchema || typeof resultSchema !== 'object' || Array.isArray(resultSchema)) {
        throw new Error('The result schema must be a JSON object.');
      }
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'The result schema must be valid JSON.');
      return;
    }

    setBusy(true);
    const runId = ++activeRun.current;
    const seen = new Set<string>();
    const nextResults: PreviewResult[] = [];
    const appendResult = (result: PreviewResult): void => {
      if (activeRun.current !== runId) return;
      nextResults.push(result);
      setResults([...nextResults]);
    };
    try {
      for (const phone of destinations) {
        if (activeRun.current !== runId) return;
        const phoneMasked = maskPhone(phone);
        if (!E164_PATTERN.test(phone)) {
          appendResult({ phoneMasked, status: 'blocked', detail: 'Invalid E.164 format.' });
          continue;
        }
        if (seen.has(phone)) {
          appendResult({ phoneMasked, status: 'blocked', detail: 'Duplicate destination in this rehearsal.' });
          continue;
        }
        seen.add(phone);
        try {
          const preview = asRecord(await onPreview(phone, resultSchema));
          appendResult({
            phoneMasked,
            status: preview.compatible === true ? 'compatible' : 'blocked',
            detail: preview.compatible === true ? 'Template compatibility preview passed.' : 'Template compatibility preview is blocked.',
          });
        } catch {
          appendResult({ phoneMasked, status: 'blocked', detail: 'Template compatibility preview could not be completed.' });
        }
      }
    } finally {
      if (activeRun.current === runId) setBusy(false);
    }
  };

  const compatibleCount = results.filter((result) => result.status === 'compatible').length;
  const loadCampaigns = async (): Promise<void> => {
    if (!businessId) return;
    const scopeRun = activeCampaignScope.current;
    setCampaignBusy(true);
    setCampaignError('');
    try {
      const response = asRecord(await onCampaignAction('calle.campaign.list', { business_id: businessId, limit: 20 }));
      const rows = Array.isArray(response.campaigns) ? response.campaigns : Array.isArray(response.rows) ? response.rows : [];
      if (activeCampaignScope.current === scopeRun) {
        setCampaigns(rows.map(asRecord));
        setCampaignQueueLoaded(true);
      }
    } catch {
      if (activeCampaignScope.current === scopeRun) setCampaignError('Campaign review queue could not be loaded. Check your business operator access and try again.');
    } finally {
      if (activeCampaignScope.current === scopeRun) setCampaignBusy(false);
    }
  };

  const saveReviewDraft = async (): Promise<void> => {
    if (!businessId || results.length !== destinations.length || results.length === 0) return;
    const scopeRun = activeCampaignScope.current;
    let resultSchema: unknown;
    try { resultSchema = JSON.parse(resultSchemaJson); } catch { setCampaignError('The result schema must be valid JSON.'); return; }
    setCampaignBusy(true);
    setCampaignError('');
    setCampaignNotice('');
    try {
      const response = asRecord(await onCampaignAction('calle.campaign.create', {
        business_id: businessId,
        template_id: templateId,
        destinations,
        result_schema: resultSchema,
        authorized: authorized,
      }));
      if (activeCampaignScope.current !== scopeRun) return;
      const campaign = asRecord(response.campaign);
      setSavedCampaign(response);
      setSelectedReport(response);
      setCampaignNotice('Durable review draft saved. The server stored masked destinations only; this is not a dispatch queue.');
      if (Object.keys(campaign).length > 0) setCampaigns((current) => [campaign, ...current.filter((item) => item.campaign_id !== campaign.campaign_id)]);
    } catch {
      if (activeCampaignScope.current === scopeRun) setCampaignError('Campaign review draft could not be saved. The server requires current business access and consent for every destination.');
    } finally {
      if (activeCampaignScope.current === scopeRun) setCampaignBusy(false);
    }
  };

  const reviewCampaign = async (campaignId: string, decision: 'approve' | 'reject'): Promise<void> => {
    const scopeRun = activeCampaignScope.current;
    setCampaignBusy(true);
    setCampaignError('');
    try {
      const response = asRecord(await onCampaignAction('calle.campaign.review', { business_id: businessId, campaign_id: campaignId, decision }));
      if (activeCampaignScope.current !== scopeRun) return;
      const campaign = asRecord(response.campaign);
      if (Object.keys(campaign).length > 0) {
        setCampaigns((current) => current.map((item) => item.campaign_id === campaignId ? campaign : item));
      }
      setCampaignNotice(`Campaign review ${decision === 'approve' ? 'approved' : 'rejected'}. This records a review decision only and does not dispatch calls.`);
    } catch {
      if (activeCampaignScope.current === scopeRun) setCampaignError('Campaign review could not be recorded. A different policy manager must decide, and approved reports cannot contain blocked destinations.');
    } finally {
      if (activeCampaignScope.current === scopeRun) setCampaignBusy(false);
    }
  };

  const inspectCampaign = async (campaignId: string): Promise<void> => {
    const scopeRun = activeCampaignScope.current;
    setCampaignBusy(true);
    setCampaignError('');
    try {
      const report = asRecord(await onCampaignAction('calle.campaign.get', { business_id: businessId, campaign_id: campaignId }));
      if (activeCampaignScope.current === scopeRun) setSelectedReport(report);
    } catch {
      if (activeCampaignScope.current === scopeRun) setCampaignError('Campaign review details could not be loaded for this business.');
    } finally {
      if (activeCampaignScope.current === scopeRun) setCampaignBusy(false);
    }
  };

  const preflightCampaign = async (campaignId: string): Promise<void> => {
    if (!authorized || destinations.length < 1 || destinations.length > MAX_DESTINATIONS) {
      setCampaignError('Re-enter the approved destination list and confirm authorization before preflight.');
      return;
    }
    let resultSchema: unknown;
    try { resultSchema = JSON.parse(resultSchemaJson); } catch { setCampaignError('The result schema must be valid JSON.'); return; }
    const scopeRun = activeCampaignScope.current;
    setCampaignBusy(true);
    setCampaignError('');
    try {
      const response = asRecord(await onCampaignAction('calle.campaign.preflight', {
        business_id: businessId,
        campaign_id: campaignId,
        destinations,
        result_schema: resultSchema,
        authorized: true,
      }));
      if (activeCampaignScope.current !== scopeRun) return;
      setSelectedReport(response);
      setCampaignNotice(response.all_ready === true
        ? 'Preflight passed for all destinations. Calls are not queued or dispatched.'
        : 'Preflight found blocked destinations. Calls are not queued or dispatched.');
    } catch {
      if (activeCampaignScope.current === scopeRun) setCampaignError('Preflight failed. Re-enter the exact approved destinations; current consent and template compatibility are checked again.');
    } finally {
      if (activeCampaignScope.current === scopeRun) setCampaignBusy(false);
    }
  };

  return (
    <section className="va-section-block" aria-labelledby="call-e-campaign-rehearsal-title">
      <UiCard>
        <div className="va-ops-card-header">
          <div className="va-ops-card-headline">
            <h3 id="call-e-campaign-rehearsal-title">CALL-E campaign rehearsal</h3>
            <p className="va-muted">Recipient compatibility preview and business-scoped campaign review reports for {templateName || `template ${templateId}`}.</p>
          </div>
          <UiBadge variant="info">No calls placed</UiBadge>
        </div>

        <UiStatePanel
          compact
          tone="warning"
          title="Preview checks template compatibility only"
          description="The preview checks template compatibility only. Saving a durable report rechecks consent and template compatibility on the server, then stores masked numbers and status codes only. Nothing is reserved or dispatched."
        />
        {!businessId ? <UiStatePanel compact tone="warning" title="Business scope required" description="Select a business-scoped CALL-E template to save a durable review draft." /> : null}

        <label className="va-field-label" htmlFor="call-e-campaign-destinations">Destinations (E.164; one per line)</label>
        <UiTextarea
          id="call-e-campaign-destinations"
          disabled={busy || campaignBusy}
          value={destinationsInput}
          onChange={(event) => {
            setDestinationsInput(event.target.value);
            setAuthorized(false);
            setResults([]);
            setSavedCampaign(null);
            setSelectedReport(null);
            setCampaignNotice('');
            setError('');
          }}
          placeholder="+14155550123\n+442079460123"
          rows={5}
          aria-describedby="call-e-campaign-destinations-hint"
          aria-invalid={Boolean(error)}
        />
        <p id="call-e-campaign-destinations-hint" className="va-field-hint">
          Up to {MAX_DESTINATIONS} destinations. Numbers are masked in the rehearsal results.
        </p>

        <div className="va-inline-tools">
          <label htmlFor="call-e-campaign-authorized">
            <input
              id="call-e-campaign-authorized"
              type="checkbox"
              disabled={busy || campaignBusy}
              checked={authorized}
              onChange={(event) => {
                setAuthorized(event.target.checked);
                if (!event.target.checked) setResults([]);
                setError('');
              }}
            />{' '}
            I confirm that I am authorized to contact every destination entered above.
          </label>
        </div>

        <div className="va-inline-tools">
          <UiButton variant="secondary" disabled={busy || !destinationsInput.trim() || !authorized} onClick={() => { void runRehearsal(); }}>
            {busy ? 'Previewing destinations…' : 'Run compatibility previews'}
          </UiButton>
          <span className="va-muted">{destinations.length} / {MAX_DESTINATIONS} destinations</span>
        </div>

        {error ? <UiStatePanel compact tone="error" title="Could not run preview" description={error} /> : null}
        {campaignError ? <UiStatePanel compact tone="error" title="Campaign review unavailable" description={campaignError} /> : null}
        {campaignNotice ? <UiStatePanel compact tone="success" title="Campaign review updated" description={campaignNotice} /> : null}
        <div className="va-inline-tools">
          <UiButton variant="plain" disabled={campaignBusy || !businessId} onClick={() => { void loadCampaigns(); }}>
            {campaignBusy ? 'Loading review queue…' : 'Refresh review queue'}
          </UiButton>
        </div>
        {busy ? <p role="status" aria-live="polite">Checking template compatibility. No calls are being placed.</p> : null}
        {!busy && results.length === 0 && !error ? (
          <UiStatePanel compact tone="info" title="No rehearsal results yet" description="Enter destinations and run a compatibility preview to see the client-only readiness list." />
        ) : null}
        {results.length > 0 ? (
          <section aria-label="Simulated CALL-E readiness results" aria-live="polite">
            <h4>Simulated readiness list <span className="va-muted">(not saved)</span></h4>
            <p role="status">{compatibleCount} compatible · {results.length - compatibleCount} blocked</p>
            <p className="va-field-hint">The durable report rechecks business consent and template compatibility on the server. It stores masked destinations only and cannot dispatch calls.</p>
            <ol className="va-native-list">
              {results.map((result, index) => (
                <li key={`${result.phoneMasked}-${index}`} className="va-native-list-row">
                  <div className="va-ops-card-header">
                    <strong>{result.phoneMasked}</strong>
                    <UiBadge variant={result.status === 'compatible' ? 'success' : 'warning'}>{result.status}</UiBadge>
                  </div>
                  <p className="va-muted">{result.detail}</p>
                </li>
              ))}
            </ol>
            <div className="va-inline-tools">
              <UiButton variant="secondary" disabled={busy || campaignBusy || !businessId || !authorized || results.length !== destinations.length || results.length === 0 || Boolean(savedCampaign)} onClick={() => { void saveReviewDraft(); }}>
                {campaignBusy ? 'Saving review draft…' : 'Save durable review draft'}
              </UiButton>
            </div>
          </section>
        ) : null}
        {savedCampaign ? (
          <section aria-label="Saved CALL-E campaign review">
            <h4>Saved review report</h4>
            <p className="va-muted">Status: {String(asRecord(savedCampaign.campaign).status || 'draft')} · {Number(asRecord(savedCampaign.campaign).ready_count) || 0} compatible · {Number(asRecord(savedCampaign.campaign).blocked_count) || 0} blocked</p>
            <p>Recipient numbers are not stored; this report contains masked numbers only.</p>
          </section>
        ) : null}
        {campaigns.length > 0 ? (
          <section aria-label="CALL-E campaign review queue">
            <h4>Business review queue</h4>
            <ol className="va-native-list">
              {campaigns.map((campaign) => {
                const campaignId = String(campaign.campaign_id || '');
                const status = String(campaign.status || 'unknown');
                return (
                  <li key={campaignId} className="va-native-list-row">
                    <div className="va-ops-card-header"><strong>{campaignId.slice(0, 22)}</strong><UiBadge variant={status === 'approved' ? 'success' : status === 'rejected' ? 'warning' : 'info'}>{status}</UiBadge></div>
                    <p className="va-muted">{Number(campaign.ready_count) || 0} compatible · {Number(campaign.blocked_count) || 0} blocked · {Number(campaign.recipient_count) || 0} destinations</p>
                    <UiButton variant="plain" disabled={campaignBusy} onClick={() => { void inspectCampaign(campaignId); }}>View masked review rows</UiButton>
                    {status === 'approved' ? <UiButton variant="secondary" disabled={campaignBusy || !authorized || !destinationsInput.trim()} onClick={() => { void preflightCampaign(campaignId); }}>Re-enter destinations and preflight</UiButton> : null}
                    {status === 'draft' && campaign.can_review === true ? (
                      <div className="va-inline-tools">
                        <UiButton variant="secondary" disabled={campaignBusy || Number(campaign.blocked_count) > 0} onClick={() => { void reviewCampaign(campaignId, 'approve'); }}>Approve review report</UiButton>
                        <UiButton variant="plain" disabled={campaignBusy} onClick={() => { void reviewCampaign(campaignId, 'reject'); }}>Reject review report</UiButton>
                      </div>
                    ) : status === 'draft' ? <p className="va-muted">A different policy manager must review this report.</p> : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}
        {campaignQueueLoaded && campaigns.length === 0 ? (
          <UiStatePanel compact tone="info" title="No campaign review reports" description="This business has no saved CALL-E campaign review reports yet." />
        ) : null}
        {selectedReport ? (
          <section aria-label="CALL-E campaign review recipients">
            <h4>Masked destination review</h4>
            <ol className="va-native-list">
              {(Array.isArray(selectedReport.recipients) ? selectedReport.recipients : []).map((value, index) => {
                const recipient = asRecord(value);
                return <li key={`${String(recipient.position || index)}-${index}`} className="va-native-list-row">
                  <div className="va-ops-card-header"><strong>{String(recipient.destination_masked || '••••0000')}</strong><UiBadge variant={recipient.status === 'ready' ? 'success' : 'warning'}>{String(recipient.status || 'blocked')}</UiBadge></div>
                  <p className="va-muted">{String(recipient.reason_code || 'preview_failed').replace(/_/g, ' ')}</p>
                </li>;
              })}
            </ol>
          </section>
        ) : null}
      </UiCard>
    </section>
  );
}
