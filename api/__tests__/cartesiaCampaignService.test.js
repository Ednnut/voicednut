'use strict';

const assert = require('node:assert/strict');
const { CartesiaCampaignService, confirmationPhrase, safeCampaign } = require('../services/cartesiaCampaignService');

function makeHarness(options = {}) {
  let saved = null;
  let providerSubmissions = 0;
  let providerBatchInput = null;
  let providerRetries = 0;
  let batchDetails = options.batch || null;
  let submissionClaim = null;
  const eligibilityChecks = [];
  const retryClaims = new Set();
  const retryAttempts = new Map();
  const reservations = [];
  const completionStatuses = [];
  const db = {
    async createCartesiaCampaignDraft(input) {
      if (saved) return { ...saved, idempotentReplay: true };
      const campaign = {
        campaign_id: input.campaign_id, business_id: input.business_id, created_by: input.created_by,
        request_hash: input.request_hash, campaign_name: input.name, agent_id: input.agent_id,
        from_number_id: input.from_number_id, target_concurrency_limit: input.target_concurrency_limit,
        scheduled_at: input.scheduled_at || null,
        dispatch_requested_at: null,
        status: 'draft', recipient_count: input.recipients.length,
        ready_count: input.recipients.filter((row) => row.readiness === 'ready').length,
        blocked_count: input.recipients.filter((row) => row.readiness !== 'ready').length,
        encryption_key_version: input.encryption_key_version,
      };
      saved = { campaign, recipients: input.recipients };
      return { ...saved, idempotentReplay: false };
    },
    async getCartesiaCampaign(id, businessId) { return saved?.campaign.campaign_id === id && saved.campaign.business_id === businessId ? saved : null; },
    async queueCartesiaCampaignDispatch(input) {
      if (!saved || saved.campaign.status !== 'approved' || saved.campaign.request_hash !== input.request_hash) return false;
      saved.campaign.dispatch_requested_at ||= input.requested_at;
      return true;
    },
    async transitionCartesiaCampaign(input) {
      if (!saved || saved.campaign.status !== input.expected_status) return false;
      saved.campaign.status = input.status;
      saved.campaign.approved_by = input.approved_by || saved.campaign.approved_by;
      saved.campaign.error_code = input.error_code || null;
      if (input.provider_batch_id) saved.campaign.provider_batch_id = input.provider_batch_id;
      if (input.provider_status) saved.campaign.provider_status = input.provider_status;
      return true;
    },
    async getCallEBusinessSafetyPolicy() { return { max_calls_per_day: 50, emergency_stop: false, timezone: 'UTC' }; },
    async claimCartesiaCampaignSubmission(input) {
      submissionClaim = input;
      saved.campaign.status = 'submitting';
      return { claimed: true };
    },
    async releaseCartesiaCampaignDailyReservations() {},
    async syncCartesiaCampaignBatch(input) {
      if (!saved || (saved.campaign.provider_batch_id && saved.campaign.provider_batch_id !== input.provider_batch_id)) return false;
      saved.campaign.provider_batch_id = input.provider_batch_id;
      saved.campaign.provider_status = input.provider_status;
      saved.campaign.provider_retry_count = Number(input.provider_retry_count) || 0;
      if (['unknown', 'submitting'].includes(saved.campaign.status)) saved.campaign.status = 'submitted';
      for (const update of input.recipients) Object.assign(saved.recipients.find((row) => row.position === update.position), {
        provider_status: update.provider_status, provider_call_id: update.provider_call_id,
      });

      it('queues approved campaigns above the synchronous threshold and rechecks every recipient in the worker', async () => {
        const harness = makeHarness({ eligible: true });
        const destinations = Array.from({ length: 101 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`);
        const draft = await harness.service.createDraft({ ...draftInput, destinations });
        const phrase = confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 101 });

        const queued = await harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id, confirmation_phrase: phrase });
        assert.equal(queued.queued_for_async_dispatch, true);
        assert.equal(queued.campaign.dispatch_queued, true);
        assert.equal(queued.campaign.status, 'approved');
        assert.equal(harness.providerSubmissions, 0);

        const dispatched = await harness.service.dispatchQueuedCampaign({
          campaign_id: draft.campaign.campaign_id, business_id: 'biz-1',
        });
        assert.equal(dispatched.campaign.status, 'submitted');
        assert.equal(harness.providerSubmissions, 1);
        assert.equal(harness.providerBatchInput.recipients.length, 101);
        assert.equal(harness.eligibilityChecks.length, 202);
      });

      it('blocks an asynchronously queued campaign if consent changes before worker dispatch', async () => {
        const harness = makeHarness({ eligible: true });
        const destinations = Array.from({ length: 101 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`);
        const draft = await harness.service.createDraft({ ...draftInput, destinations });
        await harness.service.submit({
          ...draftInput,
          campaign_id: draft.campaign.campaign_id,
          confirmation_phrase: confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 101 }),
        });
        harness.service.outboundSafety.contactPolicy.checkEligibility = async () => ({ eligible: false, reason: 'consent_expired' });

        await assert.rejects(harness.service.dispatchQueuedCampaign({
          campaign_id: draft.campaign.campaign_id, business_id: 'biz-1',
        }), { code: 'cartesia_campaign_dispatch_contact_blocked' });
        assert.equal(harness.saved.campaign.status, 'blocked');
        assert.equal(harness.providerSubmissions, 0);
      });

      it('allows exact-confirmation cancellation of a queued large campaign before provider submission', async () => {
        const harness = makeHarness({ eligible: true });
        const destinations = Array.from({ length: 101 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`);
        const draft = await harness.service.createDraft({ ...draftInput, destinations });
        await harness.service.submit({
          ...draftInput,
          campaign_id: draft.campaign.campaign_id,
          confirmation_phrase: confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 101 }),
        });
        const result = await harness.service.cancelBatch({
          ...draftInput,
          campaign_id: draft.campaign.campaign_id,
          confirmation_phrase: `CANCEL CARTESIA CAMPAIGN ${draft.campaign.campaign_id} BEFORE DISPATCH`,
        });
        assert.equal(result.status, 'blocked');
        assert.equal(result.error_code, 'cancelled_before_dispatch');
        await assert.rejects(harness.service.dispatchQueuedCampaign({
          campaign_id: draft.campaign.campaign_id, business_id: 'biz-1',
        }), { code: 'cartesia_campaign_dispatch_not_queued' });
        assert.equal(harness.providerSubmissions, 0);
      });
      return true;
    },
    async claimCartesiaCampaignRetry(input) {
      const key = `${input.campaign_id}:${input.retry_number}`;
      if (retryClaims.has(key)) return { claimed: false, reason: 'retry_already_attempted' };
      retryClaims.add(key);
      retryAttempts.set(key, { retry_number: input.retry_number, status: 'submitting', recipient_positions: input.recipient_positions });
      return { claimed: true };
    },
    async finishCartesiaCampaignRetry(campaignId, retryNumber, status) { const attempt = retryAttempts.get(`${campaignId}:${retryNumber}`); if (attempt) attempt.status = status; return true; },
    async getCartesiaCampaignRetryAttempts(campaignId) { return [...retryAttempts.entries()].filter(([key]) => key.startsWith(`${campaignId}:`)).map(([, attempt]) => attempt); },
    async resolveCartesiaCampaignRetry(campaignId, retryNumber) { const attempt = retryAttempts.get(`${campaignId}:${retryNumber}`); if (attempt) attempt.status = 'accepted'; return Boolean(attempt); },
  };
  const safety = {
    async authorizeActor() {},
    contactPolicy: { async checkEligibility(input) {
      eligibilityChecks.push(input);
      const scheduledBlocked = Boolean(input.at) && options.scheduledEligible === false;
      return { eligible: scheduledBlocked ? false : options.eligible !== false, reason: scheduledBlocked ? (options.scheduledReason || 'consent_expired') : options.reason || 'consent_missing' };
    } },
    async reserveDispatch(input) {
      if (options.dispatchError) throw options.dispatchError;
      const reservation = { destination: input.destination };
      reservations.push(reservation);
      return reservation;
    },
    async completeDispatch(reservation, status) { reservation.status = status; },
  };
  const client = {
    async listAgents() { return { summaries: [{ id: 'agent_1', phone_numbers: [{ id: 'number_1' }] }] }; },
    async createCallBatch(input) {
      providerSubmissions += 1;
      providerBatchInput = input;
      if (options.providerError) throw options.providerError;
      return { batchId: 'batch_1', status: 'queued' };
    },
    async listCallBatches() { return { data: options.batches || (batchDetails ? [batchDetails] : []), has_more: false }; },
    async getCallBatch() { return batchDetails; },
    async cancelCallBatch() { if (batchDetails) batchDetails.status = 'cancelled'; return batchDetails; },
    async retryCallBatch() { providerRetries += 1; if (options.providerRetryError) throw options.providerRetryError; return batchDetails; },
  };
  const service = new CartesiaCampaignService({
    client, db, outboundSafety: safety, enabled: options.enabled !== false, dispatchEnabled: options.dispatchEnabled !== false, idempotencySecret: 's'.repeat(40),
    encryptionKeys: { 1: 'e'.repeat(40) }, now: () => new Date(options.now || '2026-10-31T12:00:00Z'),
  });
  safety.completeDispatch = async (reservation, status) => { completionStatuses.push(status); reservation.status = status; };
  return { service, db, reservations, completionStatuses, eligibilityChecks, get saved() { return saved; }, get providerSubmissions() { return providerSubmissions; }, get providerBatchInput() { return providerBatchInput; }, get providerRetries() { return providerRetries; }, get submissionClaim() { return submissionClaim; }, set batch(value) { batchDetails = value; } };
}

const draftInput = {
  business_id: 'biz-1', actor_id: '7001', request_key: 'cartesia:request-0001',
  name: 'Renewal reminders', agent_id: 'agent_1', from_number_id: 'number_1',
  target_concurrency_limit: 1, destinations: ['+14155550123'],
};

describe('CartesiaCampaignService', () => {
  it('derives bounded campaign outcome totals and completion rate from saved recipient statuses', () => {
    const view = safeCampaign({ campaign_id: 'c1', business_id: 'biz-1', recipient_count: 5 }, [
      { readiness: 'ready', provider_status: 'completed' }, { readiness: 'ready', provider_status: 'failed' }, { readiness: 'ready', provider_status: 'unanswered' },
      { readiness: 'blocked', provider_status: null }, { readiness: 'ready', provider_status: 'provider_new_state' },
    ]);
    assert.deepEqual(view.outcome_summary, {
      total: 5, eligible: 4, blocked: 1, attempted: 4, completed: 1, failed: 1, unanswered: 1, canceled: 0, pending: 0, not_started: 0, unknown: 1,
      terminal: 3, completion_rate_percent: 25,
    });
  });

  it('stores an encrypted, masked draft and submits one batch only after exact approval', async () => {
    const harness = makeHarness({ eligible: true });
    const draft = await harness.service.createDraft(draftInput);
    assert.equal(draft.campaign.status, 'draft');
    assert.equal(draft.campaign.recipients[0].destination_masked, '+•••••••0123');
    assert.doesNotMatch(JSON.stringify(draft), /\+14155550123/);
    assert.match(harness.saved.recipients[0].encrypted_destination, /^v1\./);
    const phrase = confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 1 });
    const result = await harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id, confirmation_phrase: phrase });
    assert.equal(result.campaign.status, 'submitted');
    assert.equal(result.campaign.provider_batch_id, 'batch_1');
    assert.equal(harness.providerSubmissions, 1);
    assert.ok(harness.completionStatuses.includes('accepted'));
    const replay = await harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id, confirmation_phrase: phrase });
    assert.equal(replay.idempotent_replay, true);
    assert.equal(harness.providerSubmissions, 1);
  });

  it('supports the existing 100-recipient size within the synchronous campaign path', async () => {
    const harness = makeHarness({ eligible: true });
    const destinations = Array.from({ length: 100 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`);
    const draft = await harness.service.createDraft({ ...draftInput, destinations });
    assert.equal(draft.campaign.recipient_count, 100);
    assert.equal(draft.campaign.ready_count, 100);
    assert.equal(draft.campaign.recipients.length, 100);

  });

  it('accepts 1,000 recipients for queued dispatch and rejects larger campaigns', async () => {
    const harness = makeHarness({ eligible: true });
    const destinations = Array.from({ length: 1000 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`);
    const draft = await harness.service.createDraft({ ...draftInput, destinations });
    assert.equal(draft.campaign.recipient_count, 1000);
    assert.equal(draft.campaign.ready_count, 1000);

    await assert.rejects(harness.service.createDraft({
      ...draftInput,
      request_key: 'cartesia:request-1001',
      destinations: [...destinations, '+14155559999'],
    }), { code: 'cartesia_campaign_invalid', status: 400 });
  });

  it('holds a scheduled approval locally and rechecks current policy before immediate Cartesia dispatch', async () => {
    const harness = makeHarness({ eligible: true });
    const scheduledAt = '2026-11-01T11:00:00+00:00';
    const draft = await harness.service.createDraft({ ...draftInput, scheduled_at: scheduledAt });
    assert.equal(draft.campaign.scheduled_at, '2026-11-01T11:00:00.000Z');
    assert.ok(harness.eligibilityChecks.every((check) => !check.at));
    const phrase = confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 1, scheduled_at: draft.campaign.scheduled_at });
    assert.match(phrase, /AT 2026-11-01T11:00:00\.000Z$/);
    const result = await harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id, confirmation_phrase: phrase });
    assert.equal(result.campaign.status, 'approved');
    assert.equal(result.held_for_local_dispatch, true);
    assert.equal(harness.providerSubmissions, 0);
    const dueHarness = makeHarness({ eligible: true, now: '2026-11-01T10:59:00.000Z' });
    const dueDraft = await dueHarness.service.createDraft({ ...draftInput, scheduled_at: scheduledAt });
    dueHarness.service.now = () => new Date('2026-11-01T11:00:00.000Z');
    const duePhrase = confirmationPhrase({ campaign_id: dueDraft.campaign.campaign_id, ready_count: 1, scheduled_at: dueDraft.campaign.scheduled_at });
    await dueHarness.service.submit({ ...draftInput, campaign_id: dueDraft.campaign.campaign_id, confirmation_phrase: duePhrase });
    assert.equal(dueHarness.providerSubmissions, 1);
    assert.equal(Object.hasOwn(dueHarness.providerBatchInput, 'scheduledAt'), false);
    assert.equal(dueHarness.submissionClaim.scheduled_at, undefined);
    assert.equal(dueHarness.submissionClaim.usage_date, '2026-11-01');
    assert.ok(dueHarness.eligibilityChecks.length >= 2);
    await assert.rejects(harness.service.createDraft({ ...draftInput, scheduled_at: '2026-11-01T12:00:00Z' }), { code: 'cartesia_campaign_idempotency_conflict' });
  });

  it('keeps immediate campaign submission and retry default-off while allowing local scheduling', async () => {
    const disabled = makeHarness({ eligible: true, dispatchEnabled: false });
    const draft = await disabled.service.createDraft(draftInput);
    const phrase = confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 1 });
    await assert.rejects(disabled.service.submit({
      ...draftInput,
      campaign_id: draft.campaign.campaign_id,
      confirmation_phrase: phrase,
    }), { code: 'cartesia_batch_dispatch_disabled', status: 503 });
    assert.equal(disabled.saved.campaign.status, 'draft');
    assert.equal(disabled.providerSubmissions, 0);
    assert.equal(disabled.reservations.length, 0);

    const scheduled = makeHarness({ eligible: true, dispatchEnabled: false });
    const scheduledDraft = await scheduled.service.createDraft({
      ...draftInput,
      scheduled_at: '2026-11-01T11:00:00Z',
    });
    const scheduledPhrase = confirmationPhrase({
      campaign_id: scheduledDraft.campaign.campaign_id,
      ready_count: 1,
      scheduled_at: scheduledDraft.campaign.scheduled_at,
    });
    const held = await scheduled.service.submit({
      ...draftInput,
      campaign_id: scheduledDraft.campaign.campaign_id,
      confirmation_phrase: scheduledPhrase,
    });
    assert.equal(held.held_for_local_dispatch, true);
    assert.equal(scheduled.providerSubmissions, 0);

    const managedAgentsDisabled = makeHarness({ eligible: true, enabled: false });
    const disabledDraft = await managedAgentsDisabled.service.createDraft(draftInput);
    await assert.rejects(managedAgentsDisabled.service.submit({
      ...draftInput,
      campaign_id: disabledDraft.campaign.campaign_id,
      confirmation_phrase: confirmationPhrase({ campaign_id: disabledDraft.campaign.campaign_id, ready_count: 1 }),
    }), { code: 'cartesia_not_configured', status: 503 });
    assert.equal(managedAgentsDisabled.providerSubmissions, 0);
  });

  it('rejects unsafe timestamps and blocks a locally scheduled campaign if consent changes before dispatch', async () => {
    const expiredAtDial = makeHarness({ eligible: true });
    const draft = await expiredAtDial.service.createDraft({ ...draftInput, scheduled_at: '2026-11-01T11:00:00Z' });
    expiredAtDial.service.now = () => new Date('2026-11-01T11:00:00Z');
    expiredAtDial.service.outboundSafety.contactPolicy.checkEligibility = async () => ({ eligible: false, reason: 'consent_expired' });
    await assert.rejects(expiredAtDial.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id,
      confirmation_phrase: confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 1, scheduled_at: draft.campaign.scheduled_at }) }), { code: 'cartesia_campaign_dispatch_contact_blocked' });
    assert.equal(expiredAtDial.saved.campaign.status, 'blocked');
    assert.equal(expiredAtDial.providerSubmissions, 0);
    for (const scheduled_at of ['2026-10-31T13:00:00', '2026-10-31T11:00:00Z', '2026-02-30T13:00:00Z', '2026-11-02T12:00:00Z']) {
      await assert.rejects(makeHarness().service.createDraft({ ...draftInput, scheduled_at }), { code: 'cartesia_campaign_schedule_invalid' });
    }
  });

  it('cancels a locally held scheduled campaign without contacting Cartesia', async () => {
    const harness = makeHarness({ eligible: true });
    const draft = await harness.service.createDraft({ ...draftInput, scheduled_at: '2026-11-01T11:00:00Z' });
    const phrase = confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 1, scheduled_at: draft.campaign.scheduled_at });
    await harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id, confirmation_phrase: phrase });
    const cancelled = await harness.service.cancelBatch({
      ...draftInput, campaign_id: draft.campaign.campaign_id,
      confirmation_phrase: `CANCEL CARTESIA CAMPAIGN ${draft.campaign.campaign_id} BEFORE DISPATCH`,
    });
    assert.equal(cancelled.status, 'blocked');
    assert.equal(cancelled.error_code, 'cancelled_before_dispatch');
    assert.equal(harness.providerSubmissions, 0);
  });

  it('does not submit recipients without recorded consent', async () => {
    const harness = makeHarness({ eligible: false, reason: 'consent_missing' });
    const draft = await harness.service.createDraft(draftInput);
    assert.equal(draft.campaign.blocked_count, 1);
    await assert.rejects(harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id,
      confirmation_phrase: confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 0 }) }), { code: 'cartesia_campaign_preflight_blocked' });
    assert.equal(harness.providerSubmissions, 0);
  });

  it('encrypts per-recipient dynamic variables at rest and forwards them only in the matching provider batch rows', async () => {
    const harness = makeHarness({ eligible: true });
    const draft = await harness.service.createDraft({ ...draftInput,
      destinations: ['+14155550123', '+14155550124'],
      dynamic_variables_by_recipient: [{ first_name: 'Ada' }, { first_name: 'Lin' }],
    });
    assert.ok(harness.saved.recipients.every((row) => /^v1\./.test(row.encrypted_dynamic_variables)));
    assert.doesNotMatch(JSON.stringify(harness.saved), /Ada|Lin/);
    await harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id,
      confirmation_phrase: confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 2 }) });
    assert.deepEqual(harness.providerBatchInput.recipients.map((row) => row.dynamic_variables.first_name), ['Ada', 'Lin']);
    assert.ok(harness.providerBatchInput.recipients.every((row, index) => row.dynamic_variables.voicednut_recipient_position === String(index)));
  });

  it('leaves an uncertain provider outcome locked and will not retry the batch', async () => {
    const harness = makeHarness({ eligible: true, providerError: Object.assign(new Error('timeout'), { providerSubmissionState: 'unknown' }) });
    const draft = await harness.service.createDraft(draftInput);
    const phrase = confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 1 });
    await assert.rejects(harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id, confirmation_phrase: phrase }), { code: 'cartesia_campaign_outcome_unresolved' });
    assert.equal(harness.saved.campaign.status, 'unknown');
    await assert.rejects(harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id, confirmation_phrase: phrase }), { code: 'cartesia_campaign_outcome_unresolved' });
    assert.equal(harness.providerSubmissions, 1);
  });

  it('marks held contact reservations accepted after identity-confirmed reconciliation', async () => {
    const harness = makeHarness({ eligible: true, providerError: Object.assign(new Error('timeout'), { providerSubmissionState: 'unknown' }) });
    const draft = await harness.service.createDraft(draftInput);
    const phrase = confirmationPhrase({ campaign_id: draft.campaign.campaign_id, ready_count: 1 });
    await assert.rejects(harness.service.submit({ ...draftInput, campaign_id: draft.campaign.campaign_id, confirmation_phrase: phrase }), { code: 'cartesia_campaign_outcome_unresolved' });
    assert.equal(harness.reservations[0].status, undefined);
    harness.batch = { id: 'batch_1', name: harness.service._batchName(draft.campaign.campaign_id), agent_id: 'agent_1', from_number_id: 'number_1', status: 'in_progress', retry_count: 0,
      recipients: [{ id: 'r1', to_number: '+14155550123', status: 'queued', agent_call_id: null }] };
    await harness.service.reconcileCampaign({ campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001' });
    assert.ok(harness.completionStatuses.includes('accepted'));
  });

  it('reconciles an uncertain batch only when deterministic identity and every recipient match', async () => {
    const harness = makeHarness({ eligible: true });
    const draft = await harness.service.createDraft(draftInput);
    harness.saved.campaign.status = 'unknown';
    const expectedName = harness.service._batchName(draft.campaign.campaign_id);
    harness.batch = { id: 'batch_1', name: expectedName, agent_id: 'agent_1', from_number_id: 'number_1', status: 'completed', retry_count: 0,
      recipients: [{ id: 'recipient_1', to_number: '+14155550123', status: 'completed', agent_call_id: 'call_1', error_message: 'private +14155550123 details' }] };
    const result = await harness.service.reconcileCampaign({ campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001' });
    assert.equal(result.campaign.status, 'submitted');
    assert.equal(result.campaign.provider_batch_id, 'batch_1');
    assert.equal(result.campaign.recipients[0].provider_call_id, 'call_1');
    assert.doesNotMatch(JSON.stringify(result), /\+14155550123/);
  });

  it('retries only failed recipients after explicit approval and current contact safety checks', async () => {
    const harness = makeHarness({ eligible: true });
    const draft = await harness.service.createDraft(draftInput);
    harness.saved.campaign.status = 'submitted';
    harness.saved.campaign.provider_batch_id = 'batch_1';
    harness.saved.campaign.provider_status = 'completed';
    harness.batch = { id: 'batch_1', name: harness.service._batchName(draft.campaign.campaign_id), agent_id: 'agent_1', from_number_id: 'number_1',
      status: 'completed', retry_count: 0, recipients: [{ id: 'r1', to_number: '+14155550123', status: 'failed', agent_call_id: 'c1' }] };
    const phrase = `RETRY CARTESIA CAMPAIGN ${draft.campaign.campaign_id} BATCH batch_1 RETRY 1 FOR 1 RECIPIENTS`;
    const result = await harness.service.retryFailedRecipients({ campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001', confirmation_phrase: phrase });
    assert.equal(result.retried_recipient_count, 1);
    assert.equal(harness.providerRetries, 1);
    await assert.rejects(harness.service.retryFailedRecipients({ campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001', confirmation_phrase: phrase }), { code: 'cartesia_campaign_retry_already_attempted' });
    assert.equal(harness.providerRetries, 1);
  });

  it('blocks campaign retries before provider access while batch dispatch is disabled', async () => {
    const harness = makeHarness({ eligible: true, dispatchEnabled: false });
    const draft = await harness.service.createDraft(draftInput);
    harness.saved.campaign.status = 'submitted';
    harness.saved.campaign.provider_batch_id = 'batch_1';
    const phrase = `RETRY CARTESIA CAMPAIGN ${draft.campaign.campaign_id} BATCH batch_1 RETRY 1 FOR 1 RECIPIENTS`;
    await assert.rejects(harness.service.retryFailedRecipients({
      campaign_id: draft.campaign.campaign_id,
      business_id: 'biz-1',
      actor_id: '7001',
      confirmation_phrase: phrase,
    }), { code: 'cartesia_batch_dispatch_disabled', status: 503 });
    assert.equal(harness.providerRetries, 0);
  });

  it('blocks provider retry when fresh consent or suppression eligibility has changed', async () => {
    const safetyOptions = { eligible: true };
    const harness = makeHarness(safetyOptions);
    const draft = await harness.service.createDraft(draftInput);
    harness.saved.campaign.status = 'submitted';
    harness.saved.campaign.provider_batch_id = 'batch_1';
    harness.batch = { id: 'batch_1', name: harness.service._batchName(draft.campaign.campaign_id), agent_id: 'agent_1', from_number_id: 'number_1',
      status: 'completed', retry_count: 0, recipients: [{ id: 'r1', to_number: '+14155550123', status: 'failed' }] };
    safetyOptions.eligible = false;
    const phrase = `RETRY CARTESIA CAMPAIGN ${draft.campaign.campaign_id} BATCH batch_1 RETRY 1 FOR 1 RECIPIENTS`;
    await assert.rejects(harness.service.retryFailedRecipients({ campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001', confirmation_phrase: phrase }), { code: 'cartesia_campaign_retry_consent_blocked' });
    assert.equal(harness.providerRetries, 0);
  });

  it('cancels only a matching active batch after campaign-specific confirmation', async () => {
    const harness = makeHarness({ eligible: true });
    const draft = await harness.service.createDraft(draftInput);
    harness.saved.campaign.status = 'submitted';
    harness.saved.campaign.provider_batch_id = 'batch_1';
    harness.batch = { id: 'batch_1', name: harness.service._batchName(draft.campaign.campaign_id), agent_id: 'agent_1', from_number_id: 'number_1',
      status: 'in_progress', retry_count: 0, recipients: [{ id: 'r1', to_number: '+14155550123', status: 'queued' }] };
    const input = { campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001' };
    await assert.rejects(harness.service.cancelBatch({ ...input, confirmation_phrase: 'CANCEL BATCH' }), { code: 'cartesia_campaign_confirmation_required' });
    const phrase = `CANCEL CARTESIA CAMPAIGN ${draft.campaign.campaign_id} BATCH batch_1`;
    const result = await harness.service.cancelBatch({ ...input, confirmation_phrase: phrase });
    assert.equal(result.provider_status, 'cancelled');
  });

  it('locks an uncertain Cartesia retry and never submits that retry number twice', async () => {
    const harness = makeHarness({ eligible: true, providerRetryError: Object.assign(new Error('timeout'), { providerSubmissionState: 'unknown' }) });
    const draft = await harness.service.createDraft(draftInput);
    harness.saved.campaign.status = 'submitted';
    harness.saved.campaign.provider_batch_id = 'batch_1';
    harness.batch = { id: 'batch_1', name: harness.service._batchName(draft.campaign.campaign_id), agent_id: 'agent_1', from_number_id: 'number_1',
      status: 'completed', retry_count: 0, recipients: [{ id: 'r1', to_number: '+14155550123', status: 'failed' }] };
    const phrase = `RETRY CARTESIA CAMPAIGN ${draft.campaign.campaign_id} BATCH batch_1 RETRY 1 FOR 1 RECIPIENTS`;
    await assert.rejects(harness.service.retryFailedRecipients({ campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001', confirmation_phrase: phrase }), { code: 'cartesia_campaign_retry_outcome_unresolved' });
    await assert.rejects(harness.service.retryFailedRecipients({ campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001', confirmation_phrase: phrase }), { code: 'cartesia_campaign_retry_already_attempted' });
    assert.equal(harness.providerRetries, 1);
  });

  it('resolves an uncertain retry as accepted when provider retry_count advances', async () => {
    const harness = makeHarness({ eligible: true, providerRetryError: Object.assign(new Error('timeout'), { providerSubmissionState: 'unknown' }) });
    const draft = await harness.service.createDraft(draftInput);
    harness.saved.campaign.status = 'submitted';
    harness.saved.campaign.provider_batch_id = 'batch_1';
    harness.batch = { id: 'batch_1', name: harness.service._batchName(draft.campaign.campaign_id), agent_id: 'agent_1', from_number_id: 'number_1',
      status: 'completed', retry_count: 0, recipients: [{ id: 'r1', to_number: '+14155550123', status: 'failed' }] };
    const phrase = `RETRY CARTESIA CAMPAIGN ${draft.campaign.campaign_id} BATCH batch_1 RETRY 1 FOR 1 RECIPIENTS`;
    await assert.rejects(harness.service.retryFailedRecipients({ campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001', confirmation_phrase: phrase }), { code: 'cartesia_campaign_retry_outcome_unresolved' });
    harness.batch = { id: 'batch_1', name: harness.service._batchName(draft.campaign.campaign_id), agent_id: 'agent_1', from_number_id: 'number_1',
      status: 'in_progress', retry_count: 1, recipients: [{ id: 'r1', to_number: '+14155550123', status: 'queued' }] };
    await harness.service.reconcileCampaign({ campaign_id: draft.campaign.campaign_id, business_id: 'biz-1', actor_id: '7001' });
    assert.ok(harness.completionStatuses.includes('accepted'));
  });
});
