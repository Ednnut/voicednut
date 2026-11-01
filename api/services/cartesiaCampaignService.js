'use strict';

const crypto = require('node:crypto');
const { encryptDestination, decryptDestination } = require('./callECampaignMissionService');
const { normalizeDynamicVariables } = require('./cartesiaOutboundCallService');
const { localDateTime, normalizePolicy } = require('./callECampaignSafetyService');

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const BUSINESS_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTOR_PATTERN = /^\d{1,20}$/;
const REQUEST_PATTERN = /^[A-Za-z0-9._:-]{8,180}$/;
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const SCHEDULE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;
const MAX_SCHEDULE_AHEAD_MS = 24 * 60 * 60 * 1000;
const REASONS = new Set(['ready', 'invalid_destination', 'duplicate_destination', 'consent_missing', 'consent_expired', 'consent_not_effective', 'opted_out', 'cooldown_active', 'policy_storage_unavailable']);

function campaignError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function normalizeScheduledAt(value, now) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw campaignError('cartesia_campaign_schedule_invalid', 'Provide a future RFC3339 schedule with an explicit timezone offset', 400);
  const match = SCHEDULE_PATTERN.exec(value.trim());
  if (!match) throw campaignError('cartesia_campaign_schedule_invalid', 'Provide a future RFC3339 schedule with an explicit timezone offset', 400);
  const calendarDate = `${match[1]}-${match[2]}-${match[3]}`;
  const dateCheck = new Date(`${calendarDate}T00:00:00.000Z`);
  const parsed = Date.parse(value.trim());
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const validCalendarDate = Number.isFinite(dateCheck.getTime()) && dateCheck.toISOString().slice(0, 10) === calendarDate;
  if (!Number.isFinite(parsed) || !Number.isFinite(nowMs) || !validCalendarDate ||
      parsed <= nowMs || parsed - nowMs > MAX_SCHEDULE_AHEAD_MS) {
    throw campaignError('cartesia_campaign_schedule_invalid', 'Campaign schedule must be a valid future RFC3339 date and time', 400);
  }
  return new Date(parsed).toISOString();
}

function digest(secret, value) {
  if (String(secret || '').length < 32) throw campaignError('cartesia_campaign_unavailable', 'Campaign idempotency protection is unavailable', 503);
  return crypto.createHmac('sha256', secret).update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function campaignVariablesKey(encryptionKeys, version) {
  const secret = typeof encryptionKeys === 'string' ? (Number(version) === 1 ? encryptionKeys : '') : String(encryptionKeys?.[Number(version)] || '');
  if (secret.length < 32) throw campaignError('cartesia_campaign_encryption_unavailable', 'Campaign variable encryption is unavailable', 503);
  return crypto.createHash('sha256').update(`voicednut:cartesia:campaign:variables:v${version}:`).update(secret).digest();
}

function encryptCampaignVariables(value, encryptionKeys, campaignId, position, version) {
  const normalized = normalizeDynamicVariables(value);
  if (!Object.keys(normalized).length) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', campaignVariablesKey(encryptionKeys, version), iv);
  cipher.setAAD(Buffer.from(`${campaignId}:${position}:cartesia_dynamic_variables:v${version}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(normalized), 'utf8'), cipher.final()]);
  return `v${version}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptCampaignVariables(payload, encryptionKeys, campaignId, position, version) {
  if (!payload) return {};
  const [payloadVersion, ivText, tagText, dataText, extra] = String(payload).split('.');
  if (payloadVersion !== `v${version}` || !ivText || !tagText || !dataText || extra !== undefined) throw campaignError('cartesia_campaign_dynamic_variables_invalid', 'Campaign variable recovery data is invalid', 409);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', campaignVariablesKey(encryptionKeys, version), Buffer.from(ivText, 'base64url'));
    decipher.setAAD(Buffer.from(`${campaignId}:${position}:cartesia_dynamic_variables:v${version}`));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const json = Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
    return normalizeDynamicVariables(JSON.parse(json));
  } catch (error) {
    if (error?.code === 'cartesia_campaign_encryption_unavailable') throw error;
    throw campaignError('cartesia_campaign_dynamic_variables_invalid', 'Campaign variables could not be decrypted', 409);
  }
}

function maskDestination(destination) {
  const digits = String(destination || '').replace(/\D/g, '');
  return `${'+'.repeat(String(destination || '').startsWith('+') ? 1 : 0)}${'•'.repeat(Math.max(4, Math.min(14, digits.length - 4)))}${digits.slice(-4).padStart(4, '0')}`;
}

function safeCampaign(campaign, recipients = []) {
  if (!campaign) return null;
  const outcomes = { total: recipients.length, eligible: 0, blocked: 0, attempted: 0, completed: 0, failed: 0, unanswered: 0, canceled: 0, pending: 0, not_started: 0, unknown: 0 };
  for (const row of recipients) {
    const ready = String(row.readiness || 'ready') === 'ready';
    if (ready) outcomes.eligible += 1;
    else outcomes.blocked += 1;
    const status = String(row.provider_status || '').trim().toLowerCase().replace(/[ -]+/g, '_');
    if (status) outcomes.attempted += 1;
    if (status === 'completed') outcomes.completed += 1;
    else if (status === 'failed') outcomes.failed += 1;
    else if (status === 'unanswered' || status === 'no_answer') outcomes.unanswered += 1;
    else if (status === 'cancelled' || status === 'canceled') outcomes.canceled += 1;
    else if (!status && ready) outcomes.not_started += 1;
    else if (status && ['pending', 'queued', 'in_progress', 'created', 'started'].includes(status)) outcomes.pending += 1;
    else if (status) outcomes.unknown += 1;
  }
  outcomes.terminal = outcomes.completed + outcomes.failed + outcomes.unanswered + outcomes.canceled;
  outcomes.completion_rate_percent = outcomes.eligible ? Math.round((outcomes.completed / outcomes.eligible) * 1000) / 10 : 0;
  return {
    campaign_id: String(campaign.campaign_id), business_id: String(campaign.business_id),
    name: String(campaign.campaign_name || ''), status: String(campaign.status || 'draft'),
    agent_id: String(campaign.agent_id), from_number_id: String(campaign.from_number_id),
    target_concurrency_limit: Number(campaign.target_concurrency_limit) || 1,
    scheduled_at: campaign.scheduled_at || null,
    recipient_count: Number(campaign.recipient_count) || 0,
    ready_count: Number(campaign.ready_count) || 0,
    blocked_count: Number(campaign.blocked_count) || 0,
    outcome_summary: outcomes,
    provider_batch_id: campaign.provider_batch_id || null,
    provider_status: campaign.provider_status || null,
    provider_retry_count: Number(campaign.provider_retry_count) || 0,
    error_code: campaign.error_code || null,
    created_at: campaign.created_at || null,
    updated_at: campaign.updated_at || null,
    recipients: recipients.map((row) => ({
      position: Number(row.position), destination_masked: String(row.destination_masked || '••••0000'),
      status: row.readiness === 'ready' ? 'ready' : 'blocked',
      reason_code: REASONS.has(String(row.reason_code)) ? String(row.reason_code) : 'policy_storage_unavailable',
      provider_status: row.provider_status || null,
      provider_call_id: row.provider_call_id || null,
      provider_end_reason: row.provider_end_reason || null,
    })),
  };
}

function confirmationPhrase(campaign) {
  const scheduled = campaign.scheduled_at ? ` AT ${campaign.scheduled_at}` : '';
  return `SUBMIT CARTESIA CAMPAIGN ${campaign.campaign_id} WITH ${Number(campaign.ready_count)} RECIPIENTS${scheduled}`;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

class CartesiaCampaignService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.outboundSafety = options.outboundSafety;
    this.idempotencySecret = String(options.idempotencySecret || '');
    this.encryptionKeys = options.encryptionKeys || {};
    this.encryptionKeyVersion = Number(options.encryptionKeyVersion || 1);
    this.now = options.now || (() => new Date());
  }

  async createDraft(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const requestKey = String(input.request_key || '').trim();
    const agentId = String(input.agent_id || '').trim();
    const fromNumberId = String(input.from_number_id || '').trim();
    const destinations = Array.isArray(input.destinations) ? input.destinations.map((item) => String(item || '').trim()) : [];
    const campaignId = `cartesia_campaign_${digest(this.idempotencySecret, `${businessId}:${requestKey}`)}`;
    let variablesByRecipient;
    if (Array.isArray(input.dynamic_variables_by_recipient)) {
      if (input.dynamic_variables_by_recipient.length !== destinations.length) throw campaignError('cartesia_dynamic_variables_invalid', 'Provide one dynamic-variable object per recipient', 400);
      variablesByRecipient = input.dynamic_variables_by_recipient.map(normalizeDynamicVariables);
    } else {
      const sharedVariables = normalizeDynamicVariables(input.dynamic_variables);
      variablesByRecipient = destinations.map(() => sharedVariables);
    }
    const name = String(input.name || '').trim();
    const concurrency = Number(input.target_concurrency_limit || 1);
    const scheduledAt = normalizeScheduledAt(input.scheduled_at, this.now());
    if (!BUSINESS_PATTERN.test(businessId) || !ACTOR_PATTERN.test(actorId) || !REQUEST_PATTERN.test(requestKey) ||
        !ID_PATTERN.test(agentId) || !ID_PATTERN.test(fromNumberId) || destinations.length < 1 || destinations.length > 25 ||
        destinations.some((number) => number.length > 80) || !name || name.length > 120 ||
        !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) {
      throw campaignError('cartesia_campaign_invalid', 'A valid business, request key, agent, source number, campaign name, concurrency, and 1–25 destinations are required', 400);
    }
    if (!this.db?.createCartesiaCampaignDraft || !this.db?.getCartesiaCampaign) {
      throw campaignError('cartesia_campaign_unavailable', 'Cartesia campaign storage is unavailable', 503);
    }
    if (typeof this.outboundSafety?.authorizeActor !== 'function') {
      throw campaignError('cartesia_campaign_unavailable', 'Campaign operator checks are unavailable', 503);
    }
    await this.outboundSafety.authorizeActor({ business_id: businessId, actor_id: actorId });
    await this._assertAgentSource(agentId, fromNumberId);
    const seen = new Set();
    const recipients = [];
    for (const [position, destination] of destinations.entries()) {
      let reason = 'ready';
      if (!PHONE_PATTERN.test(destination)) reason = 'invalid_destination';
      else if (seen.has(destination)) reason = 'duplicate_destination';
      else {
        seen.add(destination);
        try {
          const currentEligibility = await this.outboundSafety?.contactPolicy?.checkEligibility?.({ businessId, destination });
          if (currentEligibility?.eligible !== true) reason = REASONS.has(String(currentEligibility?.reason)) ? currentEligibility.reason : 'policy_storage_unavailable';
        } catch (_) { reason = 'policy_storage_unavailable'; }
      }
      recipients.push({
        position,
        encrypted_destination: encryptDestination(destination, this.encryptionKeys, `cartesia_campaign_${digest(this.idempotencySecret, `${businessId}:${requestKey}`)}`, position, this.encryptionKeyVersion),
        encrypted_dynamic_variables: encryptCampaignVariables(variablesByRecipient[position], this.encryptionKeys, campaignId, position, this.encryptionKeyVersion),
        destination_masked: maskDestination(destination),
        readiness: reason === 'ready' ? 'ready' : 'blocked', reason_code: reason,
      });
    }
    const requestFingerprint = { businessId, agentId, fromNumberId, name, concurrency, destinations, scheduledAt };
    if (variablesByRecipient.some((variables) => Object.keys(variables).length)) requestFingerprint.variablesByRecipient = variablesByRecipient;
    const requestHash = digest(this.idempotencySecret, requestFingerprint);
    const saved = await this.db.createCartesiaCampaignDraft({
      campaign_id: campaignId, business_id: businessId, created_by: actorId, request_key: requestKey, request_hash: requestHash,
      name, agent_id: agentId, from_number_id: fromNumberId, target_concurrency_limit: concurrency,
      scheduled_at: scheduledAt, encryption_key_version: this.encryptionKeyVersion, recipients,
    });
    if (saved.campaign.request_hash !== requestHash || saved.campaign.created_by !== actorId) {
      throw campaignError('cartesia_campaign_idempotency_conflict', 'Campaign request key was already used with different details', 409);
    }
    return { campaign: safeCampaign(saved.campaign, saved.recipients), idempotent_replay: saved.idempotentReplay === true };
  }

  async _assertAgentSource(agentId, fromNumberId) {
    const inventory = await this.client?.listAgents?.();
    const agent = (Array.isArray(inventory?.summaries) ? inventory.summaries : []).find((item) =>
      String(item?.id || '') === agentId && !item?.deleted_at &&
      (Array.isArray(item?.phone_numbers) ? item.phone_numbers : []).some((phone) => String(phone?.id || '') === fromNumberId));
    if (!agent) throw campaignError('cartesia_agent_source_not_ready', 'The selected active Cartesia agent and attached source number are no longer ready', 409);
  }

  async getCampaign(input = {}) {
    const campaignId = String(input.campaign_id || '').trim();
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    if (!/^cartesia_campaign_[a-f0-9]{64}$/.test(campaignId) || !BUSINESS_PATTERN.test(businessId) || !ACTOR_PATTERN.test(actorId)) {
      throw campaignError('cartesia_campaign_invalid', 'A valid campaign, business, and actor are required', 400);
    }
    if (typeof this.outboundSafety?.authorizeActor !== 'function') {
      throw campaignError('cartesia_campaign_unavailable', 'Campaign operator checks are unavailable', 503);
    }
    await this.outboundSafety.authorizeActor({ business_id: businessId, actor_id: actorId });
    const stored = await this.db?.getCartesiaCampaign?.(campaignId, businessId);
    if (!stored) throw campaignError('cartesia_campaign_not_found', 'Cartesia campaign was not found in this business scope', 404);
    return { campaign: safeCampaign(stored.campaign, stored.recipients) };
  }

  async reconcileCampaign(input = {}) {
    const stored = await this._authorizedCampaign(input);
    return { campaign: await this._reconcileStored(stored) };
  }

  _batchName(campaignId) { return `vn-${digest(this.idempotencySecret, campaignId).slice(0, 24)}`; }

  _outboundReservationKey(idempotencyKey) {
    return `cartesia:${crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex')}`;
  }

  _batchListIdentityMatches(campaign, batch) {
    return Boolean(batch && String(batch.name || '') === this._batchName(campaign.campaign_id) &&
      String(batch.agent_id || '') === String(campaign.agent_id) && String(batch.from_number_id || '') === String(campaign.from_number_id));
  }

  _batchMatches(campaign, recipients, batch) {
    if (!batch || String(batch.name || '') !== this._batchName(campaign.campaign_id) ||
        String(batch.agent_id || '') !== String(campaign.agent_id) || String(batch.from_number_id || '') !== String(campaign.from_number_id)) return false;
    const numbers = Array.isArray(batch.recipients) ? batch.recipients.map((row) => String(row?.to_number || '')) : [];
    const expected = recipients.map((row) => decryptDestination(row.encrypted_destination, this.encryptionKeys,
      campaign.campaign_id, Number(row.position), Number(campaign.encryption_key_version)));
    return numbers.length === expected.length && [...numbers].sort().every((number, i) => number === [...expected].sort()[i]);
  }

  async _findUncertainBatch(campaign, recipients) {
    let cursor = '';
    const matches = [];
    let complete = false;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.client.listCallBatches({ agentId: campaign.agent_id, limit: 100, ...(cursor ? { startingAfter: cursor } : {}) });
      const rows = Array.isArray(result?.data) ? result.data : [];
      matches.push(...rows.filter((batch) => this._batchListIdentityMatches(campaign, batch)));
      if (result?.has_more !== true) { complete = true; break; }
      cursor = String(result?.next_page || '');
      if (!cursor) break;
    }
    if (!complete || matches.length !== 1) throw campaignError('cartesia_campaign_outcome_unresolved', 'Cartesia batch identity is not uniquely confirmed; leave the campaign unchanged and reconcile again', 409);
    return this.client.getCallBatch(matches[0].id);
  }

  async _reconcileStored(stored) {
    const { campaign, recipients } = stored;
    let batch;
    if (campaign.provider_batch_id) batch = await this.client.getCallBatch(campaign.provider_batch_id);
    else batch = await this._findUncertainBatch(campaign, recipients);
    if (String(batch?.id || '') !== String(campaign.provider_batch_id || batch?.id || '') || !this._batchMatches(campaign, recipients, batch)) {
      throw campaignError('cartesia_campaign_outcome_unresolved', 'Cartesia returned a batch that does not match the saved campaign; no state was changed', 409);
    }
    const providerRecipients = Array.isArray(batch.recipients) ? batch.recipients : [];
    if (providerRecipients.length !== recipients.length) throw campaignError('cartesia_campaign_outcome_unresolved', 'Cartesia recipient progress is incomplete; no state was changed', 409);
    const byNumber = new Map(providerRecipients.map((row) => [String(row.to_number || ''), row]));
    const synced = recipients.map((row) => {
      const number = decryptDestination(row.encrypted_destination, this.encryptionKeys, campaign.campaign_id,
        Number(row.position), Number(campaign.encryption_key_version));
      const providerRow = byNumber.get(number);
      if (!providerRow) throw campaignError('cartesia_campaign_outcome_unresolved', 'Cartesia recipient mapping is incomplete; no state was changed', 409);
      return { position: Number(row.position), provider_recipient_id: providerRow.id, provider_call_id: providerRow.agent_call_id,
        provider_status: providerRow.status, provider_end_reason: providerRow.end_reason };
    });
    const saved = await this.db.syncCartesiaCampaignBatch({ campaign_id: campaign.campaign_id, business_id: campaign.business_id,
      provider_batch_id: batch.id, provider_status: batch.status, provider_retry_count: batch.retry_count, recipients: synced });
    if (!saved) throw campaignError('cartesia_campaign_outcome_unresolved', 'Campaign state changed during provider reconciliation; refresh before acting', 409);
    await Promise.all(recipients.filter((row) => row.readiness === 'ready').map((row) => {
      const idempotencyKey = `cartesia-campaign-${digest(this.idempotencySecret, `${campaign.campaign_id}:${Number(row.position)}`).slice(0, 48)}`;
      const reservationKey = this._outboundReservationKey(idempotencyKey);
      return this.outboundSafety.completeDispatch({ reservationKey }, 'accepted');
    }));
    const attempts = await this.db.getCartesiaCampaignRetryAttempts?.(campaign.campaign_id) || [];
    for (const attempt of attempts) {
      if (attempt.retry_number >= Number(batch.retry_count || 0) || !['submitting', 'unknown'].includes(String(attempt.status))) continue;
      await this.db.resolveCartesiaCampaignRetry?.(campaign.campaign_id, attempt.retry_number);
      await Promise.all(attempt.recipient_positions.map((position) => {
        const idempotencyKey = `cartesia-retry-${digest(this.idempotencySecret, `${campaign.campaign_id}:${attempt.retry_number}:${position}`).slice(0, 48)}`;
        return this.outboundSafety.completeDispatch({ reservationKey: this._outboundReservationKey(idempotencyKey) }, 'accepted');
      }));
    }
    const refreshed = await this.db.getCartesiaCampaign(campaign.campaign_id, campaign.business_id);
    return safeCampaign(refreshed.campaign, refreshed.recipients);
  }

  async cancelBatch(input = {}) {
    const stored = await this._authorizedCampaign(input);
    const campaign = stored.campaign;
    const batchId = String(campaign.provider_batch_id || '');
    if (!batchId && campaign.status === 'approved' && campaign.scheduled_at) {
      const expectedLocalCancel = `CANCEL CARTESIA CAMPAIGN ${campaign.campaign_id} BEFORE DISPATCH`;
      if (!constantTimeEqual(input.confirmation_phrase, expectedLocalCancel)) throw campaignError('cartesia_campaign_confirmation_required', 'The exact local campaign cancellation phrase is required', 400);
      const cancelled = await this.db.transitionCartesiaCampaign({ campaign_id: campaign.campaign_id, business_id: campaign.business_id,
        expected_status: 'approved', status: 'blocked', error_code: 'cancelled_before_dispatch' });
      if (!cancelled) throw campaignError('cartesia_campaign_state_changed', 'Campaign state changed before cancellation; refresh its status', 409);
      const refreshed = await this.db.getCartesiaCampaign(campaign.campaign_id, campaign.business_id);
      return safeCampaign(refreshed.campaign, refreshed.recipients);
    }
    const expected = `CANCEL CARTESIA CAMPAIGN ${campaign.campaign_id} BATCH ${batchId}`;
    if (!batchId || !constantTimeEqual(input.confirmation_phrase, expected)) throw campaignError('cartesia_campaign_confirmation_required', 'The exact campaign and batch cancellation phrase is required', 400);
    const current = await this.client.getCallBatch(batchId);
    if (!this._batchMatches(campaign, stored.recipients, current)) throw campaignError('cartesia_campaign_batch_mismatch', 'Current Cartesia batch does not match this campaign', 409);
    if (current.status === 'cancelled') return this._reconcileStored(stored);
    if (!['pending', 'in_progress'].includes(String(current.status))) throw campaignError('cartesia_campaign_batch_not_cancellable', 'Only pending or in-progress batches can be canceled', 409);
    await this.client.cancelCallBatch(batchId);
    return this._reconcileStored(stored);
  }

  async retryFailedRecipients(input = {}) {
    const stored = await this._authorizedCampaign(input);
    const { campaign, recipients } = stored;
    const batchId = String(campaign.provider_batch_id || '');
    if (!batchId) throw campaignError('cartesia_campaign_batch_unresolved', 'Reconcile this campaign before retrying recipients', 409);
    const current = await this.client.getCallBatch(batchId);
    if (!this._batchMatches(campaign, recipients, current)) throw campaignError('cartesia_campaign_batch_mismatch', 'Current Cartesia batch does not match this campaign', 409);
    if (!['completed', 'failed'].includes(String(current.status))) throw campaignError('cartesia_campaign_retry_not_ready', 'Only completed or failed batches can be retried', 409);
    const providerRows = Array.isArray(current.recipients) ? current.recipients : [];
    if (providerRows.length !== recipients.length) throw campaignError('cartesia_campaign_retry_status_unknown', 'Cartesia recipient statuses are incomplete; retry was blocked', 409);
    const byNumber = new Map(providerRows.map((row) => [String(row.to_number || ''), row]));
    const retryable = [];
    for (const row of recipients) {
      const destination = decryptDestination(row.encrypted_destination, this.encryptionKeys, campaign.campaign_id,
        Number(row.position), Number(campaign.encryption_key_version));
      const providerRow = byNumber.get(destination);
      const status = String(providerRow?.status || '').toLowerCase();
      if (!providerRow || !['completed', 'failed', 'unanswered'].includes(status)) {
        throw campaignError('cartesia_campaign_retry_status_unknown', 'Cartesia returned an unsupported recipient status; retry was blocked', 409);
      }
      if (['failed', 'unanswered'].includes(status)) retryable.push({ row, destination, providerRow });
    }
    if (!retryable.length) throw campaignError('cartesia_campaign_retry_empty', 'Cartesia has no failed or unanswered recipients to retry', 409);
    const retryNumber = Number(current.retry_count || 0);
    if (!Number.isSafeInteger(retryNumber) || retryNumber < 0 || retryNumber >= 100) throw campaignError('cartesia_campaign_retry_limit', 'Cartesia retry count is invalid or exhausted', 409);
    const expectedPhrase = `RETRY CARTESIA CAMPAIGN ${campaign.campaign_id} BATCH ${batchId} RETRY ${retryNumber + 1} FOR ${retryable.length} RECIPIENTS`;
    if (!constantTimeEqual(input.confirmation_phrase, expectedPhrase)) throw campaignError('cartesia_campaign_confirmation_required', 'The exact retry approval phrase is required', 400);
    const now = this.now();
    const policy = normalizePolicy(await this.db.getCallEBusinessSafetyPolicy(campaign.business_id));
    const local = localDateTime(now, policy.timezone);
    const attemptClaim = await this.db.claimCartesiaCampaignRetry({ campaign_id: campaign.campaign_id, business_id: campaign.business_id,
      retry_number: retryNumber, recipient_positions: retryable.map((candidate) => Number(candidate.row.position)), actor_id: String(input.actor_id),
      usage_date: local.date, now_iso: now instanceof Date ? now.toISOString() : new Date(now).toISOString() });
    if (attemptClaim?.claimed !== true) throw campaignError(`cartesia_campaign_${attemptClaim?.reason || 'retry_already_attempted'}`,
      'Current business safety limits or retry state do not permit another attempt', 409);
    const reservations = [];
    try {
      for (const candidate of retryable) {
        const eligibility = await this.outboundSafety.contactPolicy.checkEligibility({ businessId: campaign.business_id, destination: candidate.destination });
        if (eligibility?.eligible !== true) throw campaignError('cartesia_campaign_retry_consent_blocked', 'A retry recipient no longer has valid contact eligibility', 409);
        const reservation = await this.outboundSafety.reserveDispatch({ business_id: campaign.business_id, actor_id: String(input.actor_id),
          destination: candidate.destination, provider: 'cartesia',
          idempotency_key: `cartesia-retry-${digest(this.idempotencySecret, `${campaign.campaign_id}:${retryNumber}:${candidate.row.position}`).slice(0, 48)}` });
        reservations.push(reservation);
      }
    } catch (error) {
      await Promise.all(reservations.map((reservation) => this.outboundSafety.completeDispatch(reservation, 'released')));
      await this.db.finishCartesiaCampaignRetry(campaign.campaign_id, retryNumber, 'rejected');
      throw error;
    }
    let latest;
    try {
      latest = await this.client.getCallBatch(batchId);
      const latestRetryable = (Array.isArray(latest?.recipients) ? latest.recipients : [])
        .filter((row) => ['failed', 'unanswered'].includes(String(row?.status || '').toLowerCase()))
        .map((row) => String(row?.to_number || '')).sort();
      if (!this._batchMatches(campaign, recipients, latest) || Number(latest.retry_count || 0) !== retryNumber ||
          JSON.stringify(latestRetryable) !== JSON.stringify(retryable.map((candidate) => candidate.destination).sort())) {
        throw campaignError('cartesia_campaign_retry_state_changed', 'Cartesia batch retry state changed during preflight; no retry was sent', 409);
      }
    } catch (error) {
      await Promise.all(reservations.map((reservation) => this.outboundSafety.completeDispatch(reservation, 'released')));
      await this.db.finishCartesiaCampaignRetry(campaign.campaign_id, retryNumber, 'rejected');
      throw error;
    }
    try {
      await this.client.retryCallBatch(batchId);
    } catch (error) {
      const uncertain = !['rejected', 'not_submitted'].includes(error?.providerSubmissionState);
      await this.db.finishCartesiaCampaignRetry(campaign.campaign_id, retryNumber, uncertain ? 'unknown' : 'rejected');
      if (!uncertain) await Promise.all(reservations.map((reservation) => this.outboundSafety.completeDispatch(reservation, 'released')));
      throw uncertain ? campaignError('cartesia_campaign_retry_outcome_unresolved', 'Retry outcome is unknown; reconcile the saved batch before any further retry', 502) : error;
    }
    await this.db.finishCartesiaCampaignRetry(campaign.campaign_id, retryNumber, 'accepted');
    await Promise.all(reservations.map((reservation) => this.outboundSafety.completeDispatch(reservation, 'accepted')));
    return { campaign: await this._reconcileStored(stored), retried_recipient_count: retryable.length };
  }

  async _authorizedCampaign(input) {
    const campaignId = String(input.campaign_id || '').trim();
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    if (!/^cartesia_campaign_[a-f0-9]{64}$/.test(campaignId) || !BUSINESS_PATTERN.test(businessId) || !ACTOR_PATTERN.test(actorId)) throw campaignError('cartesia_campaign_invalid', 'A valid campaign, business, and actor are required', 400);
    await this.outboundSafety.authorizeActor({ business_id: businessId, actor_id: actorId });
    const stored = await this.db.getCartesiaCampaign(campaignId, businessId);
    if (!stored) throw campaignError('cartesia_campaign_not_found', 'Cartesia campaign was not found in this business scope', 404);
    return stored;
  }

  async submit(input = {}) {
    const campaignId = String(input.campaign_id || '').trim();
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    if (!/^cartesia_campaign_[a-f0-9]{64}$/.test(campaignId) || !BUSINESS_PATTERN.test(businessId) || !ACTOR_PATTERN.test(actorId)) {
      throw campaignError('cartesia_campaign_invalid', 'A valid campaign, business, and actor are required', 400);
    }
    if (typeof this.outboundSafety?.authorizeActor !== 'function') {
      throw campaignError('cartesia_campaign_unavailable', 'Campaign operator checks are unavailable', 503);
    }
    await this.outboundSafety.authorizeActor({ business_id: businessId, actor_id: actorId });
    const stored = await this.db?.getCartesiaCampaign?.(campaignId, businessId);
    if (!stored) throw campaignError('cartesia_campaign_not_found', 'Cartesia campaign was not found in this business scope', 404);
    const { campaign, recipients } = stored;
    if (!constantTimeEqual(input.confirmation_phrase, confirmationPhrase(campaign))) {
      throw campaignError('cartesia_campaign_confirmation_required', 'The exact campaign-specific approval phrase is required', 400);
    }
    if (campaign.status === 'submitted') return { campaign: safeCampaign(campaign, recipients), idempotent_replay: true };
    if (['submitting', 'unknown'].includes(campaign.status)) {
      throw campaignError('cartesia_campaign_outcome_unresolved', 'This campaign may already have been submitted; reconcile it before any retry', 409);
    }
    if (!['draft', 'approved'].includes(campaign.status) || Number(campaign.ready_count) !== Number(campaign.recipient_count) || recipients.length !== Number(campaign.recipient_count)) {
      throw campaignError('cartesia_campaign_preflight_blocked', 'Every campaign recipient must pass consent and suppression checks before submission', 409);
    }
    if (campaign.status === 'draft') {
      const approved = await this.db.transitionCartesiaCampaign({
        campaign_id: campaignId, business_id: businessId, expected_status: 'draft', status: 'approved', approved_by: actorId, error_code: null,
      });
      if (!approved) {
        const current = await this.db.getCartesiaCampaign(campaignId, businessId);
        if (current?.campaign?.status !== 'approved') {
          throw campaignError('cartesia_campaign_state_changed', 'Campaign state changed before approval; review its current status', 409);
        }
      }
    }
    const now = this.now();
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const scheduledAt = campaign.scheduled_at ? new Date(campaign.scheduled_at).toISOString() : null;
    if (scheduledAt && Date.parse(scheduledAt) > nowMs) {
      if (campaign.status === 'draft') {
        const approved = await this.db.transitionCartesiaCampaign({ campaign_id: campaignId, business_id: businessId,
          expected_status: 'draft', status: 'approved', approved_by: actorId, error_code: null });
        if (!approved) {
          const current = await this.db.getCartesiaCampaign(campaignId, businessId);
          if (current?.campaign?.status !== 'approved') throw campaignError('cartesia_campaign_state_changed', 'Campaign state changed before approval; review its current status', 409);
        }
      }
      const held = await this.db.getCartesiaCampaign(campaignId, businessId);
      return { campaign: safeCampaign(held.campaign, held.recipients), idempotent_replay: false, held_for_local_dispatch: true };
    }
    const keyVersion = Number(campaign.encryption_key_version);
    const destinations = recipients.map((row) => decryptDestination(row.encrypted_destination, this.encryptionKeys, campaignId, Number(row.position), keyVersion));
    if (scheduledAt) {
      for (const destination of destinations) {
        let eligibility;
        try { eligibility = await this.outboundSafety?.contactPolicy?.checkEligibility?.({ businessId, destination }); }
        catch (_) { eligibility = null; }
        if (eligibility?.eligible !== true) {
          await this.db.transitionCartesiaCampaign({ campaign_id: campaignId, business_id: businessId,
            expected_status: 'approved', status: 'blocked', error_code: String(eligibility?.reason || 'dispatch_consent_blocked').slice(0, 80) });
          throw campaignError('cartesia_campaign_dispatch_contact_blocked', 'A recipient no longer has current consent or contact eligibility; the scheduled campaign was blocked', 409);
        }
      }
    }
    await this._assertAgentSource(campaign.agent_id, campaign.from_number_id);
    const policy = normalizePolicy(await this.db.getCallEBusinessSafetyPolicy(businessId));
    const local = localDateTime(now, policy.timezone);
    const claimed = await this.db.claimCartesiaCampaignSubmission({
      campaign_id: campaignId, business_id: businessId, request_hash: campaign.request_hash,
      usage_date: local.date, now_iso: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    });
    if (!claimed.claimed) {
      throw campaignError(`cartesia_campaign_${claimed.reason}`, 'Current business safety limits do not permit this campaign', 409);
    }
    const reservations = [];
    try {
      for (let position = 0; position < destinations.length; position += 1) {
        const reservation = await this.outboundSafety.reserveDispatch({
          business_id: businessId, actor_id: actorId, destination: destinations[position], provider: 'cartesia',
          idempotency_key: `cartesia-campaign-${digest(this.idempotencySecret, `${campaignId}:${position}`).slice(0, 48)}`,
        });
        reservations.push(reservation);
      }
    } catch (error) {
      await Promise.all(reservations.map((reservation) => this.outboundSafety.completeDispatch(reservation, 'released')));
      await this.db.releaseCartesiaCampaignDailyReservations(campaignId);
      await this.db.transitionCartesiaCampaign({ campaign_id: campaignId, business_id: businessId,
        expected_status: 'submitting', status: 'blocked', error_code: String(error?.code || 'cartesia_policy_blocked').slice(0, 80) });
      throw error;
    }
    const batchName = `vn-${digest(this.idempotencySecret, campaignId).slice(0, 24)}`;
    try {
      const result = await this.client.createCallBatch({
        name: batchName, agentId: campaign.agent_id, fromNumberId: campaign.from_number_id,
        targetConcurrencyLimit: Number(campaign.target_concurrency_limit),
        recipients: destinations.map((toNumber, position) => ({
          to_number: toNumber,
          dynamic_variables: {
            ...decryptCampaignVariables(recipients[position]?.encrypted_dynamic_variables, this.encryptionKeys, campaignId, position, keyVersion),
            voicednut_campaign_id: campaignId, voicednut_recipient_position: String(position),
          },
        })),
      });
      await this.db.transitionCartesiaCampaign({ campaign_id: campaignId, business_id: businessId,
        expected_status: 'submitting', status: 'submitted', provider_batch_id: result.batchId, provider_status: result.status, error_code: null });
      await Promise.all(reservations.map((reservation) => this.outboundSafety.completeDispatch(reservation, 'accepted')));
      const updated = await this.db.getCartesiaCampaign(campaignId, businessId);
      return { campaign: safeCampaign(updated.campaign, updated.recipients), idempotent_replay: false };
    } catch (error) {
      const uncertain = !['rejected', 'not_submitted'].includes(error?.providerSubmissionState);
      await this.db.transitionCartesiaCampaign({ campaign_id: campaignId, business_id: businessId,
        expected_status: 'submitting', status: uncertain ? 'unknown' : 'blocked', error_code: String(error?.code || 'cartesia_batch_failed').slice(0, 80) });
      if (!uncertain) {
        await this.db.releaseCartesiaCampaignDailyReservations(campaignId);
        await Promise.all(reservations.map((reservation) => this.outboundSafety.completeDispatch(reservation, 'released')));
      }
      throw uncertain
        ? campaignError('cartesia_campaign_outcome_unresolved', 'Cartesia batch outcome is unknown; reconcile this campaign before retrying', 502)
        : error;
    }
  }
}

module.exports = { CartesiaCampaignService, safeCampaign, confirmationPhrase, maskDestination, normalizeScheduledAt };
