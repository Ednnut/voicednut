const crypto = require('node:crypto');
const { normalizeDynamicVariables } = require('./cartesiaCallService');

const MAX_RECIPIENTS = 5000;
const MAX_RECIPIENT_ATTEMPTS = 10000;
const MAX_RECONCILE_ATTEMPTS = 8;
const MIN_RECONCILE_BACKOFF_MS = 15000;
const MAX_RECONCILE_BACKOFF_MS = 15 * 60 * 1000;
const BATCH_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled']);

function batchError(code, message, status = 400) {
  const error = new Error(message);
  error.name = 'CartesiaBatchError';
  error.code = code;
  error.status = status;
  return error;
}

function normalizeBatchInput(input = {}) {
  const businessId = String(input.businessId || input.business_id || '').trim();
  const name = String(input.name || '').trim();
  const agentId = String(input.agentId || input.agent_id || '').trim();
  const fromNumberId = String(input.fromNumberId || input.from_number_id || '').trim();
  const recipients = input.recipients;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) {
    throw batchError('cartesia_business_scope_required', 'A valid business scope is required', 403);
  }
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw batchError('cartesia_batch_invalid', 'Batch name must contain 1 to 120 printable characters');
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(agentId) || !/^[A-Za-z0-9_-]{1,200}$/.test(fromNumberId)) {
    throw batchError('cartesia_agent_or_number_invalid', 'A valid Cartesia agent and phone number ID are required');
  }
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > MAX_RECIPIENTS) {
    throw batchError('cartesia_batch_size_invalid', `A batch must contain 1 to ${MAX_RECIPIENTS} recipients`);
  }
  const seen = new Set();
  const normalizedRecipients = recipients.map((recipient) => {
    if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) {
      throw batchError('cartesia_batch_recipient_invalid', 'Each batch recipient must be an object');
    }
    const toNumber = String(recipient.to_number || recipient.toNumber || '').trim();
    if (!/^\+[1-9]\d{7,14}$/.test(toNumber)) {
      throw batchError('cartesia_destination_invalid', 'Every batch destination must be a valid E.164 number');
    }
    if (seen.has(toNumber)) {
      throw batchError('cartesia_batch_duplicate_recipient', 'Duplicate destinations are not allowed in a Cartesia batch');
    }
    seen.add(toNumber);
    return { to_number: toNumber, dynamic_variables: normalizeDynamicVariables(recipient.dynamic_variables ?? recipient.dynamicVariables) };
  });
  const providerRequest = { name, agent_id: agentId, from_number_id: fromNumberId, recipients: normalizedRecipients };
  if (input.target_concurrency_limit !== undefined) {
    const limit = Number(input.target_concurrency_limit);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw batchError('cartesia_batch_concurrency_invalid', 'Batch concurrency must be a positive integer');
    }
    providerRequest.target_concurrency_limit = limit;
  }
  if (input.ringing_timeout_seconds !== undefined) {
    const timeout = Number(input.ringing_timeout_seconds);
    if (!Number.isSafeInteger(timeout) || timeout < 5 || timeout > 80) {
      throw batchError('cartesia_ringing_timeout_invalid', 'Ringing timeout must be between 5 and 80 seconds');
    }
    providerRequest.ringing_timeout_seconds = timeout;
  }
  if (input.max_call_duration_minutes !== undefined) {
    const duration = Number(input.max_call_duration_minutes);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 480) {
      throw batchError('cartesia_call_duration_invalid', 'Maximum call duration must be between 1 and 480 minutes');
    }
    providerRequest.max_call_duration_minutes = duration;
  }
  const requestFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({ businessId, providerRequest })).digest('hex');
  return Object.freeze({ businessId, providerRequest, requestFingerprint, recipientCount: normalizedRecipients.length });
}

function normalizeBatchRecord(payload = {}, expectedId = null, includeRecipients = false) {
  const id = String(payload.id || '').trim();
  const status = String(payload.status || '').trim().toLowerCase();
  const agentId = String(payload.agent_id || '').trim();
  const fromNumberId = String(payload.from_number_id || '').trim();
  const region = String(payload.region || '').trim().toUpperCase();
  const updatedAt = typeof payload.last_updated_at === 'string' ? payload.last_updated_at : '';
  const counters = ['total_calls_scheduled', 'total_calls_dispatched', 'total_calls_finished', 'retry_count'];
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || (expectedId && expectedId !== id) || !BATCH_STATUSES.has(status) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(agentId) || !/^[A-Za-z0-9_-]{1,200}$/.test(fromNumberId) ||
      !['US', 'EU', 'APAC'].includes(region) || !Number.isSafeInteger(Number(payload.target_concurrency_limit)) ||
      Number(payload.target_concurrency_limit) < 1 || !Number.isFinite(Date.parse(updatedAt)) ||
      typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 120 ||
      counters.some((key) => !Number.isSafeInteger(Number(payload[key])) || Number(payload[key]) < 0)) {
    throw batchError('cartesia_invalid_response', 'Cartesia returned an invalid call batch record', 502);
  }
  if (typeof payload.recipients !== 'undefined' && !Array.isArray(payload.recipients)) {
    throw batchError('cartesia_invalid_response', 'Cartesia returned an invalid batch recipient list', 502);
  }
  if (includeRecipients && (payload.recipients || []).length > MAX_RECIPIENT_ATTEMPTS) {
    throw batchError('cartesia_invalid_response', 'Cartesia returned too many recipient attempts to reconcile safely', 502);
  }
  const normalizeOptionalTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : null;
  const result = {
    id,
    name: payload.name.trim(),
    agentId,
    fromNumberId,
    region,
    targetConcurrencyLimit: Number.isSafeInteger(Number(payload.target_concurrency_limit)) ? Number(payload.target_concurrency_limit) : null,
    status,
    totalCallsScheduled: Number(payload.total_calls_scheduled),
    totalCallsDispatched: Number(payload.total_calls_dispatched),
    totalCallsFinished: Number(payload.total_calls_finished),
    retryCount: Number(payload.retry_count),
    createdAt: normalizeOptionalTime(payload.created_at),
    updatedAt: new Date(Date.parse(updatedAt)).toISOString(),
    scheduledAt: normalizeOptionalTime(payload.scheduled_at),
    admittedAt: normalizeOptionalTime(payload.admitted_at),
  };
  if (includeRecipients) {
    result.recipients = (Array.isArray(payload.recipients) ? payload.recipients : []).map((recipient) => {
      const id = typeof recipient?.id === 'string' ? recipient.id.trim() : '';
      const toNumber = typeof recipient?.to_number === 'string' ? recipient.to_number.trim() : '';
      const providerStatus = typeof recipient?.status === 'string' ? recipient.status.trim() : '';
      const agentCallId = typeof recipient?.agent_call_id === 'string' ? recipient.agent_call_id.trim() : '';
      const endReason = typeof recipient?.end_reason === 'string' ? recipient.end_reason.trim() : '';
      const createdAt = typeof recipient?.created_at === 'string' ? recipient.created_at : null;
      if ((id && !/^[A-Za-z0-9_-]{1,200}$/.test(id)) || !/^\+[1-9]\d{7,14}$/.test(toNumber) ||
          !/^[A-Za-z0-9_-]{1,80}$/.test(providerStatus) ||
          (agentCallId && !/^[A-Za-z0-9_-]{1,200}$/.test(agentCallId)) ||
          (endReason && !/^[A-Za-z0-9_-]{1,100}$/.test(endReason)) ||
          (createdAt && !Number.isFinite(Date.parse(createdAt))) ||
          (recipient?.error_message != null && typeof recipient.error_message !== 'string')) {
        throw batchError('cartesia_invalid_response', 'Cartesia returned an invalid batch recipient', 502);
      }
      return {
        id: id || null,
        toNumber,
        status: providerStatus,
        agentCallId: agentCallId || null,
        endReason: endReason || null,
        hasProviderError: typeof recipient.error_message === 'string' && recipient.error_message.length > 0,
        createdAt,
      };
    });
  }
  return Object.freeze(result);
}

class CartesiaBatchService {
  constructor(options = {}) {
    this.client = options.client;
    this.callService = options.callService;
    this.db = options.db;
    this.enabled = options.enabled === true;
    this.dispatchEnabled = options.dispatchEnabled === true;
    this.retentionEnabled = options.retentionEnabled === true;
    this.retentionAutoEnabled = options.retentionAutoEnabled === true;
    this.retentionDays = Number.isSafeInteger(options.retentionDays) && options.retentionDays >= 1 && options.retentionDays <= 3650
      ? options.retentionDays
      : 0;
    this.reconciliationEnabled = options.reconciliationEnabled === true;
    this.reconciliationIntervalMs = Number.isSafeInteger(options.reconciliationIntervalMs) && options.reconciliationIntervalMs >= 15000
      ? Math.min(options.reconciliationIntervalMs, MAX_RECONCILE_BACKOFF_MS)
      : 60000;
    this.reconciliationBatchSize = Number.isSafeInteger(options.reconciliationBatchSize)
      ? Math.max(1, Math.min(options.reconciliationBatchSize, 10))
      : 5;
    this.reconciliationLeaseMs = 90000;
    this.reconciliationLeaseRenewMs = 30000;
    this.reconciliationWorkerRunning = false;
    this.retentionWorkerRunning = false;
    this.clock = options.clock || (() => new Date());
  }

  ensureEnabled() {
    const clientConfigured = this.client?.isReadConfigured?.() ?? this.client?.isConfigured?.();
    if (!this.enabled || !clientConfigured) {
      throw batchError('cartesia_not_configured', 'Cartesia Managed Agents is disabled or not configured', 503);
    }
  }

  async prepareBatch(input = {}) {
    this.ensureEnabled();
    const prepared = normalizeBatchInput(input);
    for (const recipient of prepared.providerRequest.recipients) {
      await this.callService.prepareOutboundCall({
        business_id: prepared.businessId,
        to_number: recipient.to_number,
        from_number_id: prepared.providerRequest.from_number_id,
        agent_id: prepared.providerRequest.agent_id,
        dynamic_variables: recipient.dynamic_variables,
      });
    }
    return Object.freeze({
      provider: 'cartesia',
      operation: 'batch_outbound',
      recipientCount: prepared.recipientCount,
      requestFingerprint: prepared.requestFingerprint,
      dispatchEnabled: this.dispatchEnabled,
      scheduledExecution: false,
      persisted: false,
    });
  }

  async createBatch(input = {}) {
    const preview = await this.prepareBatch(input);
    if (!this.dispatchEnabled) throw batchError('cartesia_batch_dispatch_disabled', 'Cartesia batch dispatch is disabled', 503);
    if (input.approved !== true || String(input.confirmedFingerprint || input.confirmed_fingerprint || '').trim().toLowerCase() !== preview.requestFingerprint) {
      throw batchError('cartesia_confirmation_mismatch', 'Explicit approval must match the current batch preview', 409);
    }
    const key = String(input.idempotencyKey || input.idempotency_key || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw batchError('cartesia_idempotency_key_required', 'A valid Cartesia batch idempotency key is required');
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' || typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw batchError('cartesia_idempotency_storage_unavailable', 'Cartesia batch idempotency storage is unavailable', 503);
    }
    const namespacedKey = `voicednut:cartesia:batch:${normalizeBatchInput(input).businessId}:${key}`;
    const existing = await this.db.getOutboundCallIdempotency(namespacedKey);
    if (existing) {
      if (existing.provider !== 'cartesia' || existing.request_hash !== preview.requestFingerprint) {
        throw batchError('cartesia_idempotency_conflict', 'Cartesia batch idempotency key was already used for a different request', 409);
      }
      if (existing.status === 'completed') {
        let stored;
        try { stored = JSON.parse(existing.response_payload || '{}'); } catch { stored = null; }
        if (!stored?.batch?.id) throw batchError('cartesia_idempotency_state_invalid', 'Cartesia batch idempotency state is invalid', 409);
        await this.persistLocalBatch(stored.batch, normalizeBatchInput(input), true);
        return { ...stored.batch, idempotentReplay: true };
      }
      throw batchError('cartesia_outcome_unknown', 'A prior Cartesia batch submission may have started; inspect batch state before retrying', 409);
    }
    const reservation = await this.db.reserveOutboundCallIdempotency({ idempotency_key: namespacedKey, provider: 'cartesia', request_hash: preview.requestFingerprint });
    if (!reservation?.reserved) throw batchError('cartesia_idempotency_in_progress', 'Cartesia batch submission is unresolved; inspect provider state before retrying', 409);
    let response;
    try {
      const createBatch = this.client.createCallBatchRaw || this.client.createCallBatch;
      response = await createBatch.call(this.client, normalizeBatchInput(input).providerRequest);
    } catch (error) {
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({ idempotency_key: namespacedKey, provider: 'cartesia', request_hash: preview.requestFingerprint, status: 'failed', error_message: 'cartesia_batch_rejected' }).catch(() => {});
        throw batchError('cartesia_batch_rejected', 'Cartesia rejected the batch request', error.status);
      }
      throw batchError('cartesia_outcome_unknown', 'Cartesia batch submission outcome is unknown; inspect provider state before retrying', 409);
    }
    let batch;
    try { batch = normalizeBatchRecord(response, null, true); } catch (error) {
      throw batchError('cartesia_outcome_unknown', 'Cartesia returned an unresolved batch response; inspect provider state before retrying', 409);
    }
    const result = { ...batch, idempotentReplay: false };
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: namespacedKey,
      provider: 'cartesia',
      request_hash: preview.requestFingerprint,
      call_sid: batch.id,
      status: 'completed',
      response_payload: { batch: result },
    });
    await this.persistLocalBatch(result, normalizeBatchInput(input), true);
    return result;
  }

  async persistLocalBatch(batch, prepared, includeProviderRecipients) {
    if (typeof this.db?.upsertCartesiaCallBatchSnapshot !== 'function') {
      throw batchError('cartesia_batch_storage_unavailable', 'Cartesia batch result storage is unavailable', 503);
    }
    const recipients = includeProviderRecipients && Array.isArray(batch.recipients)
      ? batch.recipients.map((recipient) => ({
        id: recipient.id,
        to_number: recipient.toNumber,
        status: recipient.status,
        created_at: recipient.createdAt,
        agent_call_id: recipient.agentCallId,
        end_reason: recipient.endReason,
        has_provider_error: recipient.hasProviderError,
      }))
      : [];
    try {
      await this.db.upsertCartesiaCallBatchSnapshot({
        provider_batch_id: batch.id,
        business_id: prepared.businessId,
        name: batch.name,
        agent_id: batch.agentId,
        from_number_id: batch.fromNumberId,
        region: batch.region,
        target_concurrency_limit: batch.targetConcurrencyLimit,
        status: batch.status,
        total_calls_scheduled: batch.totalCallsScheduled,
        total_calls_dispatched: batch.totalCallsDispatched,
        total_calls_finished: batch.totalCallsFinished,
        retry_count: batch.retryCount,
        provider_created_at: batch.createdAt,
        scheduled_at: batch.scheduledAt,
        admitted_at: batch.admittedAt,
        provider_updated_at: batch.updatedAt || new Date().toISOString(),
        request_fingerprint: prepared.requestFingerprint,
        expected_recipients: prepared.providerRequest.recipients,
        recipients,
      });
    } catch {
      throw batchError('cartesia_batch_persistence_failed', 'Cartesia accepted the batch, but its local result could not be stored. Reconcile the batch before any retry.', 503);
    }
  }

  async listBatches(query = {}) {
    this.ensureEnabled();
    const allowed = new Set(['limit', 'starting_after', 'ending_before', 'agent_id']);
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some((key) => !allowed.has(key))) {
      throw batchError('cartesia_batch_query_invalid', 'Cartesia batch query is invalid');
    }
    const normalizedQuery = {};
    if (query.limit !== undefined && query.limit !== '') {
      const limit = Number(query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw batchError('cartesia_batch_query_invalid', 'Cartesia batch page limit must be between 1 and 100');
      normalizedQuery.limit = limit;
    }
    for (const key of ['starting_after', 'ending_before', 'agent_id']) {
      if (query[key] === undefined || query[key] === '') continue;
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(query[key]))) throw batchError('cartesia_batch_query_invalid', 'Cartesia batch cursor or agent ID is invalid');
      normalizedQuery[key] = String(query[key]);
    }
    const response = await this.client.listCallBatches(normalizedQuery);
    if (!Array.isArray(response?.data) || typeof response.has_more !== 'boolean' ||
        (response.next_page !== null && typeof response.next_page !== 'string')) {
      throw batchError('cartesia_invalid_response', 'Cartesia returned an invalid batch list', 502);
    }
    return {
      batches: response.data.map((batch) => normalizeBatchRecord(batch)),
      hasMore: response.has_more,
      nextPage: response.next_page,
    };
  }

  async getBatch(batchId) {
    this.ensureEnabled();
    const id = String(batchId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw batchError('cartesia_invalid_batch_id', 'Cartesia batch ID is invalid');
    return normalizeBatchRecord(await this.client.getCallBatch(id), id, true);
  }

  async reconcileBatch(batchId) {
    const batch = await this.getBatch(batchId);
    const local = await this.db?.getCartesiaCallBatch?.(batch.id);
    if (!local) return { ...batch, reconciliation: { persisted: false, recipientCount: 0 } };
    if (typeof this.db?.upsertCartesiaCallBatchSnapshot !== 'function' ||
        typeof this.db?.listCartesiaCallBatchRecipients !== 'function') {
      throw batchError('cartesia_batch_storage_unavailable', 'Cartesia batch result storage is unavailable', 503);
    }
    try {
      await this.db.upsertCartesiaCallBatchSnapshot({
        provider_batch_id: batch.id,
        business_id: local.business_id,
        name: batch.name,
        agent_id: batch.agentId,
        from_number_id: batch.fromNumberId,
        region: batch.region,
        target_concurrency_limit: batch.targetConcurrencyLimit,
        status: batch.status,
        total_calls_scheduled: batch.totalCallsScheduled,
        total_calls_dispatched: batch.totalCallsDispatched,
        total_calls_finished: batch.totalCallsFinished,
        retry_count: batch.retryCount,
        provider_created_at: batch.createdAt,
        scheduled_at: batch.scheduledAt,
        admitted_at: batch.admittedAt,
        provider_updated_at: batch.updatedAt || new Date().toISOString(),
        request_fingerprint: local.request_fingerprint,
        recipients: batch.recipients.map((recipient) => ({
          id: recipient.id,
          to_number: recipient.toNumber,
          status: recipient.status,
          created_at: recipient.createdAt,
          agent_call_id: recipient.agentCallId,
          end_reason: recipient.endReason,
          has_provider_error: recipient.hasProviderError,
        })),
      });
      const localRecipients = await this.db.listCartesiaCallBatchRecipients(batch.id, local.business_id);
      return { ...batch, localRecipients, reconciliation: { persisted: true, recipientCount: localRecipients.length } };
    } catch {
      throw batchError('cartesia_batch_persistence_failed', 'Cartesia status was retrieved but could not be reconciled locally', 503);
    }
  }

  async runReconciliationWorker(options = {}) {
    if (!this.reconciliationEnabled || !this.enabled || !this.client?.isConfigured?.()) {
      return { enabled: false, scanned: 0, reconciled: 0, failed: 0, exhausted: 0 };
    }
    if (this.reconciliationWorkerRunning) {
      return { enabled: true, skipped: true, reason: 'already_running', scanned: 0, reconciled: 0, failed: 0, exhausted: 0 };
    }
    const requiredMethods = ['claimCartesiaBatchReconciliation', 'renewCartesiaBatchReconciliationLease', 'completeCartesiaBatchReconciliation', 'failCartesiaBatchReconciliation'];
    if (requiredMethods.some((method) => typeof this.db?.[method] !== 'function')) {
      throw batchError('cartesia_batch_reconciliation_unavailable', 'Cartesia batch reconciliation storage is unavailable', 503);
    }
    const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(options.limit, this.reconciliationBatchSize)) : this.reconciliationBatchSize;
    const nowDate = this.clock();
    const nowMs = Date.parse(nowDate);
    if (!Number.isFinite(nowMs)) throw batchError('cartesia_batch_reconciliation_clock_invalid', 'Cartesia batch reconciliation clock is invalid', 503);
    this.reconciliationWorkerRunning = true;
    const results = { enabled: true, skipped: false, scanned: 0, reconciled: 0, failed: 0, exhausted: 0 };
    try {
      for (let index = 0; index < limit; index += 1) {
        const claimedAt = new Date(Date.parse(this.clock())).toISOString();
        const leaseToken = crypto.randomUUID();
        const leaseUntil = new Date(Date.parse(claimedAt) + this.reconciliationLeaseMs).toISOString();
        const claim = await this.db.claimCartesiaBatchReconciliation({ lease_token: leaseToken, now: claimedAt, lease_until: leaseUntil });
        if (!claim) break;
        results.scanned += 1;
        let leaseLost = false;
        let renewalPromise = null;
        const renewalTimer = setInterval(() => {
          if (renewalPromise) return;
          renewalPromise = (async () => {
            try {
              const renewAt = Date.parse(this.clock());
              const renewUntil = new Date(renewAt + this.reconciliationLeaseMs).toISOString();
              const renewed = await this.db.renewCartesiaBatchReconciliationLease(claim.provider_batch_id, leaseToken, renewUntil);
              if (!renewed?.updated) leaseLost = true;
            } catch {
              leaseLost = true;
            } finally {
              renewalPromise = null;
            }
          })();
        }, this.reconciliationLeaseRenewMs);
        if (typeof renewalTimer.unref === 'function') renewalTimer.unref();
        try {
          const batch = await this.reconcileBatch(claim.provider_batch_id);
          clearInterval(renewalTimer);
          if (renewalPromise) await renewalPromise;
          if (leaseLost) throw batchError('cartesia_batch_reconciliation_lease_lost', 'Cartesia batch reconciliation lease renewal failed', 409);
          const terminal = ['completed', 'failed', 'cancelled'].includes(batch.status);
          const nextAttemptAt = terminal
            ? null
            : new Date(Date.parse(this.clock()) + this.reconciliationIntervalMs).toISOString();
          const completed = await this.db.completeCartesiaBatchReconciliation(
            claim.provider_batch_id, leaseToken, terminal, nextAttemptAt,
          );
          if (!completed?.updated) throw batchError('cartesia_batch_reconciliation_lease_lost', 'Cartesia batch reconciliation lease expired before completion', 409);
          results.reconciled += 1;
        } catch (error) {
          clearInterval(renewalTimer);
          if (renewalPromise) await renewalPromise;
          const attempt = Number(claim.reconcile_attempt_count || 0) + 1;
          const exhausted = attempt >= MAX_RECONCILE_ATTEMPTS;
          const backoff = Math.min(MAX_RECONCILE_BACKOFF_MS, MIN_RECONCILE_BACKOFF_MS * (2 ** Math.max(0, attempt - 1)));
          const nextAttemptAt = exhausted
            ? null
            : new Date(Date.parse(this.clock()) + backoff).toISOString();
          const errorCode = /^[a-z][a-z0-9_]{0,79}$/.test(String(error?.code || ''))
            ? String(error.code)
            : 'cartesia_reconcile_failed';
          const recorded = await this.db.failCartesiaBatchReconciliation({
            provider_batch_id: claim.provider_batch_id,
            lease_token: leaseToken,
            next_attempt_at: nextAttemptAt,
            max_attempts: MAX_RECONCILE_ATTEMPTS,
            error_code: errorCode,
          });
          if (recorded?.updated) {
            results.failed += 1;
            if (exhausted) results.exhausted += 1;
          }
        }
      }
      return results;
    } finally {
      this.reconciliationWorkerRunning = false;
    }
  }

  async getStoredBatch(batchId, businessId = undefined) {
    if (typeof this.db?.getCartesiaCallBatch !== 'function' || typeof this.db?.listCartesiaCallBatchRecipients !== 'function') {
      throw batchError('cartesia_batch_storage_unavailable', 'Cartesia batch result storage is unavailable', 503);
    }
    const batch = await this.db.getCartesiaCallBatch(batchId, businessId);
    if (!batch) throw batchError('cartesia_batch_not_found', 'Cartesia batch has no locally stored record', 404);
    const recipients = await this.db.listCartesiaCallBatchRecipients(batch.provider_batch_id, batch.business_id);
    return {
      id: batch.provider_batch_id,
      businessId: batch.business_id,
      name: batch.name,
      agentId: batch.agent_id,
      fromNumberId: batch.from_number_id,
      region: batch.region,
      targetConcurrencyLimit: batch.target_concurrency_limit,
      status: batch.status,
      totalCallsScheduled: batch.total_calls_scheduled,
      totalCallsDispatched: batch.total_calls_dispatched,
      totalCallsFinished: batch.total_calls_finished,
      retryCount: batch.retry_count,
      createdAt: batch.provider_created_at,
      updatedAt: batch.provider_updated_at,
      scheduledAt: batch.scheduled_at,
      admittedAt: batch.admitted_at,
      lastSyncedAt: batch.last_synced_at,
      requestFingerprint: batch.request_fingerprint,
      recipients: recipients.map((recipient) => ({
        id: recipient.provider_recipient_id,
        toNumber: recipient.phone_number,
        status: recipient.provider_status,
        agentCallId: recipient.provider_call_id,
        endReason: recipient.end_reason,
        hasProviderError: recipient.has_provider_error === 1,
        localState: recipient.local_state,
        createdAt: recipient.provider_created_at,
      })),
    };
  }

  async prepareRetentionPurge(batchId, now = new Date()) {
    const id = String(batchId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw batchError('cartesia_invalid_batch_id', 'Cartesia batch ID is invalid');
    if (typeof this.db?.getCartesiaCallBatch !== 'function' || typeof this.db?.listCartesiaCallBatchRecipients !== 'function') {
      throw batchError('cartesia_batch_storage_unavailable', 'Cartesia batch retention storage is unavailable', 503);
    }
    const batch = await this.db.getCartesiaCallBatch(id);
    if (!batch) throw batchError('cartesia_batch_not_found', 'Cartesia batch has no locally stored record', 404);
    const common = {
      batchId: id,
      businessId: batch.business_id,
      enabled: this.retentionEnabled && this.retentionDays > 0,
      retentionDays: this.retentionDays,
      status: batch.status,
      providerUpdatedAt: batch.provider_updated_at,
    };
    if (!common.enabled) return { ...common, eligible: false, recipientCount: 0, expiresAt: null, fingerprint: null, reason: 'retention_disabled' };
    if (!['completed', 'failed', 'cancelled'].includes(batch.status) || !Number.isFinite(Date.parse(batch.provider_updated_at || ''))) {
      return { ...common, eligible: false, recipientCount: 0, expiresAt: null, fingerprint: null, reason: 'batch_not_terminal' };
    }
    const recipients = await this.db.listCartesiaCallBatchRecipients(id, batch.business_id);
    const recipientCount = recipients.length;
    const expiresAt = new Date(Date.parse(batch.provider_updated_at) + this.retentionDays * 86400000).toISOString();
    if (!recipientCount) return { ...common, eligible: false, recipientCount, expiresAt, fingerprint: null, reason: 'no_recipient_records' };
    if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(expiresAt)) {
      return { ...common, eligible: false, recipientCount, expiresAt, fingerprint: null, reason: 'retention_period_not_elapsed' };
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      batchId: id,
      businessId: batch.business_id,
      status: batch.status,
      providerUpdatedAt: batch.provider_updated_at,
      expiresAt,
      recipientCount,
    })).digest('hex');
    return { ...common, eligible: true, recipientCount, expiresAt, fingerprint, reason: null };
  }

  async purgeExpiredRecipients(batchId, confirmedFingerprint, now = new Date()) {
    if (!this.retentionEnabled || this.retentionDays < 1) {
      throw batchError('cartesia_batch_retention_disabled', 'Cartesia batch recipient retention deletion is disabled', 403);
    }
    const preview = await this.prepareRetentionPurge(batchId, now);
    if (!preview.eligible || !/^[a-f0-9]{64}$/.test(String(confirmedFingerprint || '')) ||
        confirmedFingerprint !== preview.fingerprint) {
      throw batchError('cartesia_batch_retention_confirmation_mismatch', 'A current eligible retention preview fingerprint is required', 409);
    }
    if (typeof this.db?.deleteExpiredCartesiaBatchRecipients !== 'function') {
      throw batchError('cartesia_batch_storage_unavailable', 'Cartesia batch retention deletion is unavailable', 503);
    }
    try {
      const result = await this.db.deleteExpiredCartesiaBatchRecipients({
        provider_batch_id: preview.batchId,
        business_id: preview.businessId,
        status: preview.status,
        provider_updated_at: preview.providerUpdatedAt,
        expected_recipient_count: preview.recipientCount,
      });
      return { batchId: preview.batchId, deletedCount: result.deletedCount, expiresAt: preview.expiresAt };
    } catch (error) {
      if (error?.code === 'cartesia_batch_retention_stale') throw batchError(error.code, 'Cartesia batch results changed after preview; create a new retention preview', 409);
      throw batchError('cartesia_batch_retention_failed', 'Cartesia batch recipient records could not be deleted', 503);
    }
  }

  async runRetentionWorker() {
    if (!this.retentionAutoEnabled || !this.retentionEnabled || this.retentionDays < 1) {
      return { enabled: false, skipped: true, scanned: 0, purged: 0, deletedRecipients: 0, failed: 0 };
    }
    if (this.retentionWorkerRunning) {
      return { enabled: true, skipped: true, scanned: 0, purged: 0, deletedRecipients: 0, failed: 0 };
    }
    if (typeof this.db?.listExpiredCartesiaBatchRetentionCandidates !== 'function' ||
        typeof this.db?.recordCartesiaBatchRetentionWorkerAudit !== 'function') {
      throw batchError('cartesia_batch_storage_unavailable', 'Cartesia automated retention storage is unavailable', 503);
    }
    const now = this.clock();
    if (!Number.isFinite(Date.parse(now))) {
      throw batchError('cartesia_batch_retention_clock_invalid', 'Cartesia retention worker clock is invalid', 500);
    }
    const cutoff = new Date(Date.parse(now) - this.retentionDays * 86400000).toISOString();
    this.retentionWorkerRunning = true;
    try {
      const candidates = await this.db.listExpiredCartesiaBatchRetentionCandidates({ cutoff, limit: 10 });
      const result = { enabled: true, skipped: false, scanned: 0, purged: 0, deletedRecipients: 0, failed: 0 };
      for (const candidate of candidates) {
        const batchId = String(candidate?.provider_batch_id || '').trim();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(batchId)) continue;
        result.scanned += 1;
        const preview = await this.prepareRetentionPurge(batchId, now);
        if (!preview.eligible) continue;

        await this.db.recordCartesiaBatchRetentionWorkerAudit({
          provider_batch_id: preview.batchId,
          outcome: 'requested',
          recipient_count: preview.recipientCount,
          request_fingerprint: preview.fingerprint,
        });
        let purge;
        try {
          purge = await this.purgeExpiredRecipients(preview.batchId, preview.fingerprint, now);
        } catch (error) {
          await this.db.recordCartesiaBatchRetentionWorkerAudit({
            provider_batch_id: preview.batchId,
            outcome: 'failed',
            recipient_count: preview.recipientCount,
            request_fingerprint: preview.fingerprint,
            reason_code: error?.code || 'retention_failed',
          });
          result.failed += 1;
          continue;
        }
        await this.db.recordCartesiaBatchRetentionWorkerAudit({
          provider_batch_id: preview.batchId,
          outcome: 'succeeded',
          recipient_count: purge.deletedCount,
          request_fingerprint: preview.fingerprint,
        });
        result.purged += 1;
        result.deletedRecipients += purge.deletedCount;
      }
      return result;
    } finally {
      this.retentionWorkerRunning = false;
    }
  }

  async cancelBatch(batchId, approved) {
    if (approved !== true) throw batchError('cartesia_batch_cancel_confirmation_required', 'Explicit confirmation is required to cancel a Cartesia batch', 409);
    const current = await this.getBatch(batchId);
    if (['completed', 'failed', 'cancelled'].includes(current.status)) throw batchError('cartesia_batch_not_active', 'Only an active Cartesia batch can be cancelled', 409);
    try {
      const updated = normalizeBatchRecord(await this.client.cancelCallBatch(current.id), current.id);
      const local = await this.db?.getCartesiaCallBatch?.(current.id);
      if (local) await this.persistLocalBatch(updated, {
        businessId: local.business_id,
        requestFingerprint: local.request_fingerprint,
        providerRequest: { recipients: [] },
      }, false);
      return updated;
    } catch (error) {
      if (error?.retryable === true || (Number.isInteger(error?.status) && error.status >= 500)) {
        throw batchError('cartesia_batch_cancel_outcome_unknown', 'Cartesia cancellation outcome is unknown; refresh batch status before retrying', 409);
      }
      throw error;
    }
  }
}

module.exports = { BATCH_STATUSES, MAX_RECIPIENTS, MAX_RECIPIENT_ATTEMPTS, CartesiaBatchService, normalizeBatchInput, normalizeBatchRecord };
