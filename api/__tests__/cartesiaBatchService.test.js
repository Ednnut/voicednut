const assert = require('node:assert/strict');
const { CartesiaBatchService, normalizeBatchInput, normalizeBatchRecord } = require('../services/cartesiaBatchService');

const fingerprint = 'a'.repeat(64);
const payload = {
  business_id: 'business_test', name: 'May follow up', agent_id: 'agent_test', from_number_id: 'number_test',
  recipients: [
    { to_number: '+15555550101', dynamic_variables: { first_name: 'Ada' } },
    { to_number: '+15555550102', dynamic_variables: {} },
  ],
};

function makeHarness(overrides = {}) {
  const calls = [];
  const idempotency = new Map();
  const client = {
    isConfigured: () => true,
    async createCallBatch(request) { calls.push(['create', request]); return batchRecord(); },
    async listCallBatches(query) { calls.push(['list', query]); return { data: [batchRecord()], has_more: false, next_page: null }; },
    async getCallBatch(id) { calls.push(['get', id]); return batchRecord({ id, recipients: [{ id: 'recipient_1', to_number: '+15555550101', status: 'completed', error_message: 'private provider detail' }] }); },
    async cancelCallBatch(id) { calls.push(['cancel', id]); return batchRecord({ id, status: 'cancelled' }); },
    ...overrides.client,
  };
  let persistFails = overrides.persistFails || 0;
  const claims = [...(overrides.claims || [])];
  const db = {
    async getOutboundCallIdempotency(key) { return idempotency.get(key) || null; },
    async reserveOutboundCallIdempotency(row) {
      if (idempotency.has(row.idempotency_key)) return { reserved: false };
      idempotency.set(row.idempotency_key, { ...row, status: 'pending' });
      return { reserved: true };
    },
    async completeOutboundCallIdempotency(row) {
      idempotency.set(row.idempotency_key, { ...row, response_payload: JSON.stringify(row.response_payload), status: row.status });
    },
    async upsertCartesiaCallBatchSnapshot() {
      calls.push(['persist']);
      if (persistFails > 0) { persistFails -= 1; throw new Error('temporary storage failure'); }
      return { saved: true };
    },
    async getCartesiaCallBatch(id) { return overrides.retention?.batch || { provider_batch_id: id, business_id: 'business_test', request_fingerprint: 'a'.repeat(64), status: 'in_progress', provider_updated_at: '2026-11-09T00:00:00.000Z' }; },
    async listCartesiaCallBatchRecipients() { return overrides.retention?.recipients || []; },
    async deleteExpiredCartesiaBatchRecipients(input) { calls.push(['retention-delete', input]); return { deletedCount: input.expected_recipient_count }; },
    async listExpiredCartesiaBatchRetentionCandidates(input) { calls.push(['retention-candidates', input]); return overrides.retentionCandidates || []; },
    async recordCartesiaBatchRetentionWorkerAudit(input) {
      calls.push(['retention-worker-audit', input]);
      if (overrides.retentionAuditFails === true) throw new Error('audit storage unavailable');
      return { saved: true };
    },
    async claimCartesiaBatchReconciliation(input) { calls.push(['reconcile-claim', input]); return claims.shift() || null; },
    async renewCartesiaBatchReconciliationLease(...input) { calls.push(['reconcile-renew', ...input]); return { updated: true }; },
    async completeCartesiaBatchReconciliation(...input) { calls.push(['reconcile-complete', ...input]); return { updated: true }; },
    async failCartesiaBatchReconciliation(input) { calls.push(['reconcile-fail', input]); return { updated: true }; },
  };
  const callService = {
    async prepareOutboundCall(input) {
      calls.push(['eligibility', input.to_number]);
      if (overrides.rejectDestination === input.to_number) throw Object.assign(new Error('not eligible'), { code: 'cartesia_consent_required', status: 403 });
      return { persisted: false };
    },
  };
  return { service: new CartesiaBatchService({
    client, callService, db, enabled: true, dispatchEnabled: overrides.dispatchEnabled === true,
    retentionEnabled: overrides.retentionEnabled === true, retentionDays: overrides.retentionDays || 0,
    retentionAutoEnabled: overrides.retentionAutoEnabled === true,
    reconciliationEnabled: overrides.reconciliationEnabled === true,
    reconciliationIntervalMs: overrides.reconciliationIntervalMs || 60000,
    reconciliationBatchSize: overrides.reconciliationBatchSize || 5,
    clock: overrides.clock,
  }), calls, idempotency, db };
}

function batchRecord(overrides = {}) {
  return {
    id: 'batch_test_01', name: 'May follow up', agent_id: 'agent_test', from_number_id: 'number_test', region: 'US',
    target_concurrency_limit: 2, status: 'pending', total_calls_scheduled: 2, total_calls_dispatched: 0,
    total_calls_finished: 0, retry_count: 0, created_at: '2026-11-09T00:00:00Z', last_updated_at: '2026-11-09T00:00:00Z',
    ...overrides,
  };
}

describe('Cartesia batch service', () => {
  it('normalizes supported recipients and rejects duplicates or oversized batches', () => {
    const normalized = normalizeBatchInput(payload);
    assert.equal(normalized.recipientCount, 2);
    assert.equal(normalized.providerRequest.recipients[0].to_number, '+15555550101');
    assert.notEqual(normalized.requestFingerprint, fingerprint);
    assert.throws(() => normalizeBatchInput({ ...payload, recipients: [payload.recipients[0], payload.recipients[0]] }), { code: 'cartesia_batch_duplicate_recipient' });
    assert.throws(() => normalizeBatchInput({ ...payload, recipients: Array(5001).fill(payload.recipients[0]) }), { code: 'cartesia_batch_size_invalid' });
  });

  it('preflights each destination and does not persist or call the batch endpoint', async () => {
    const { service, calls } = makeHarness();
    const preview = await service.prepareBatch(payload);
    assert.equal(preview.recipientCount, 2);
    assert.equal(preview.persisted, false);
    assert.equal(preview.scheduledExecution, false);
    assert.deepEqual(calls.map((call) => call[0]), ['eligibility', 'eligibility']);
  });

  it('does not dispatch when one destination fails the existing consent/allowlist policy', async () => {
    const { service, calls } = makeHarness({ rejectDestination: '+15555550102', dispatchEnabled: true });
    await assert.rejects(service.prepareBatch(payload), { code: 'cartesia_consent_required' });
    assert.equal(calls.some((call) => call[0] === 'create'), false);
  });

  it('requires dispatch flag, explicit matching approval and durable idempotency before create', async () => {
    const disabled = makeHarness();
    await assert.rejects(disabled.service.createBatch({ ...payload, approved: true, confirmed_fingerprint: fingerprint }), { code: 'cartesia_batch_dispatch_disabled' });

    const { service, calls } = makeHarness({ dispatchEnabled: true });
    const preview = await service.prepareBatch(payload);
    await assert.rejects(service.createBatch({ ...payload, approved: true, confirmed_fingerprint: fingerprint, idempotency_key: 'batch-key-test-01' }), { code: 'cartesia_confirmation_mismatch' });
    const created = await service.createBatch({
      ...payload, approved: true, confirmed_fingerprint: preview.requestFingerprint, idempotency_key: 'batch-key-test-01',
    });
    assert.equal(created.id, 'batch_test_01');
    assert.equal(created.idempotentReplay, false);
    assert.equal(calls.filter((call) => call[0] === 'create').length, 1);
    const replay = await service.createBatch({
      ...payload, approved: true, confirmed_fingerprint: preview.requestFingerprint, idempotency_key: 'batch-key-test-01',
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(calls.filter((call) => call[0] === 'create').length, 1);
  });

  it('does not automatically retry an ambiguous submission', async () => {
    const { service } = makeHarness({ dispatchEnabled: true, client: { async createCallBatch() { throw new Error('network'); } } });
    const preview = await service.prepareBatch(payload);
    const approved = { ...payload, approved: true, confirmed_fingerprint: preview.requestFingerprint, idempotency_key: 'batch-key-test-02' };
    await assert.rejects(service.createBatch(approved), { code: 'cartesia_outcome_unknown' });
    await assert.rejects(service.createBatch(approved), { code: 'cartesia_outcome_unknown' });
  });

  it('keeps the provider batch idempotency result recoverable when local persistence fails', async () => {
    const { service, calls } = makeHarness({ dispatchEnabled: true, persistFails: 1 });
    const preview = await service.prepareBatch(payload);
    const approved = { ...payload, approved: true, confirmed_fingerprint: preview.requestFingerprint, idempotency_key: 'batch-key-recover-01' };
    await assert.rejects(service.createBatch(approved), { code: 'cartesia_batch_persistence_failed' });
    const recovered = await service.createBatch(approved);
    assert.equal(recovered.id, 'batch_test_01');
    assert.equal(recovered.idempotentReplay, true);
    assert.equal(calls.filter((call) => call[0] === 'create').length, 1);
    assert.equal(calls.filter((call) => call[0] === 'persist').length, 2);
  });

  it('reads sanitized batch status and confirms that provider cancellation leaves active calls to the provider', async () => {
    const { service, calls } = makeHarness();
    const detail = await service.getBatch('batch_test_01');
    assert.equal(detail.recipients[0].hasProviderError, true);
    assert.equal(Object.hasOwn(detail.recipients[0], 'errorMessage'), false);
    const cancelled = await service.cancelBatch('batch_test_01', true);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(calls.filter((call) => ['get', 'cancel'].includes(call[0])).map((call) => call[0]), ['get', 'get', 'cancel']);
    assert.throws(() => normalizeBatchRecord(batchRecord({ status: 'unknown' })), { code: 'cartesia_invalid_response' });
  });

  it('explicitly reconciles provider data into the stored business record', async () => {
    const { service, calls } = makeHarness();
    const result = await service.reconcileBatch('batch_test_01');
    assert.equal(result.reconciliation.persisted, true);
    assert.equal(result.reconciliation.recipientCount, 0);
    assert.equal(calls.some((call) => call[0] === 'persist'), true);
  });

  it('passes validated Cartesia batch cursors through without inventing pagination', async () => {
    const { service, calls } = makeHarness();
    const listed = await service.listBatches({ limit: '10', starting_after: 'batch_test_01' });
    assert.equal(listed.batches.length, 1);
    assert.equal(listed.hasMore, false);
    assert.equal(listed.nextPage, null);
    assert.deepEqual(calls.find((call) => call[0] === 'list')[1], { limit: 10, starting_after: 'batch_test_01' });
    await assert.rejects(service.listBatches({ unexpected: 'value' }), { code: 'cartesia_batch_query_invalid' });
  });

  it('requires a configured age policy and eligible terminal local records for retention', async () => {
    const disabled = makeHarness();
    const disabledPreview = await disabled.service.prepareRetentionPurge('batch_test_01', new Date('2026-12-01T00:00:00.000Z'));
    assert.equal(disabledPreview.eligible, false);
    assert.equal(disabledPreview.reason, 'retention_disabled');

    const batch = {
      provider_batch_id: 'batch_test_01', business_id: 'business_test', status: 'completed',
      provider_updated_at: '2026-01-01T00:00:00.000Z',
    };
    const harness = makeHarness({ retentionEnabled: true, retentionDays: 30, retention: { batch, recipients: [{}, {}] } });
    const preview = await harness.service.prepareRetentionPurge('batch_test_01', new Date('2026-02-01T00:00:00.000Z'));
    assert.equal(preview.eligible, true);
    assert.equal(preview.recipientCount, 2);
    assert.equal(preview.expiresAt, '2026-01-31T00:00:00.000Z');
    const purged = await harness.service.purgeExpiredRecipients('batch_test_01', preview.fingerprint);
    assert.equal(purged.deletedCount, 2);
    assert.equal(harness.calls.find((call) => call[0] === 'retention-delete')[1].business_id, 'business_test');
    await assert.rejects(harness.service.purgeExpiredRecipients('batch_test_01', 'c'.repeat(64)), { code: 'cartesia_batch_retention_confirmation_mismatch' });
  });

  it('never makes active or too-recent batches eligible for recipient deletion', async () => {
    const harness = makeHarness({ retentionEnabled: true, retentionDays: 30, retention: {
      batch: { provider_batch_id: 'batch_test_01', business_id: 'business_test', status: 'in_progress', provider_updated_at: '2026-01-01T00:00:00.000Z' },
      recipients: [{}],
    } });
    const preview = await harness.service.prepareRetentionPurge('batch_test_01', new Date('2026-02-01T00:00:00.000Z'));
    assert.equal(preview.eligible, false);
    assert.equal(preview.reason, 'batch_not_terminal');
    assert.equal(harness.calls.some((call) => call[0] === 'retention-delete'), false);
  });

  it('automatically purges only expired terminal batches with a separate opt-in and audit trail', async () => {
    const now = new Date('2026-02-01T00:00:00.000Z');
    const harness = makeHarness({
      retentionEnabled: true,
      retentionAutoEnabled: true,
      retentionDays: 30,
      clock: () => now,
      retentionCandidates: [{ provider_batch_id: 'batch_test_01' }],
      retention: {
        batch: {
          provider_batch_id: 'batch_test_01',
          business_id: 'business_test',
          status: 'completed',
          provider_updated_at: '2026-01-01T00:00:00.000Z',
        },
        recipients: [{}, {}],
      },
    });
    const result = await harness.service.runRetentionWorker();
    assert.deepEqual(result, { enabled: true, skipped: false, scanned: 1, purged: 1, deletedRecipients: 2, failed: 0 });
    assert.deepEqual(harness.calls.filter((call) => call[0] === 'retention-worker-audit').map((call) => call[1].outcome), ['requested', 'succeeded']);
    assert.equal(harness.calls.find((call) => call[0] === 'retention-candidates')[1].limit, 10);
    assert.equal(harness.calls.some((call) => call[0] === 'create'), false);
  });

  it('does not purge automatically when the pre-purge audit cannot be recorded', async () => {
    const harness = makeHarness({
      retentionEnabled: true,
      retentionAutoEnabled: true,
      retentionDays: 30,
      clock: () => new Date('2026-02-01T00:00:00.000Z'),
      retentionCandidates: [{ provider_batch_id: 'batch_test_01' }],
      retentionAuditFails: true,
      retention: {
        batch: {
          provider_batch_id: 'batch_test_01',
          business_id: 'business_test',
          status: 'completed',
          provider_updated_at: '2026-01-01T00:00:00.000Z',
        },
        recipients: [{}],
      },
    });
    await assert.rejects(harness.service.runRetentionWorker(), /audit storage unavailable/);
    assert.equal(harness.calls.some((call) => call[0] === 'retention-delete'), false);
  });

  it('reconciles claimed batches sequentially and schedules the next bounded poll', async () => {
    const harness = makeHarness({
      reconciliationEnabled: true,
      clock: () => new Date('2026-11-09T12:00:00.000Z'),
      claims: [{ provider_batch_id: 'batch_test_01', business_id: 'business_test', reconcile_attempt_count: 0 }],
    });
    harness.service.reconcileBatch = async (id) => ({ id, status: 'in_progress' });
    const result = await harness.service.runReconciliationWorker();
    assert.deepEqual(result, { enabled: true, skipped: false, scanned: 1, reconciled: 1, failed: 0, exhausted: 0 });
    const completion = harness.calls.find((call) => call[0] === 'reconcile-complete');
    assert.equal(completion[1], 'batch_test_01');
    assert.equal(completion[3], false);
    assert.equal(completion[4], '2026-11-09T12:01:00.000Z');
  });

  it('stops polling a terminal provider batch and stays dormant when the worker gate is off', async () => {
    const terminal = makeHarness({
      reconciliationEnabled: true,
      claims: [{ provider_batch_id: 'batch_test_01', business_id: 'business_test', reconcile_attempt_count: 0 }],
    });
    terminal.service.reconcileBatch = async () => ({ status: 'completed' });
    const terminalResult = await terminal.service.runReconciliationWorker();
    assert.equal(terminalResult.reconciled, 1);
    const completion = terminal.calls.find((call) => call[0] === 'reconcile-complete');
    assert.equal(completion[3], true);
    assert.equal(completion[4], null);

    const disabled = makeHarness();
    const disabledResult = await disabled.service.runReconciliationWorker();
    assert.equal(disabledResult.enabled, false);
    assert.equal(disabled.calls.some((call) => call[0] === 'reconcile-claim'), false);
  });

  it('backs off transient reconciliation failures and stops after the bounded attempt limit', async () => {
    const harness = makeHarness({
      reconciliationEnabled: true,
      clock: () => new Date('2026-11-09T12:00:00.000Z'),
      claims: [{ provider_batch_id: 'batch_test_01', business_id: 'business_test', reconcile_attempt_count: 0 }],
    });
    harness.service.reconcileBatch = async () => { throw Object.assign(new Error('do not log provider details'), { code: 'cartesia_timeout', retryable: true }); };
    const first = await harness.service.runReconciliationWorker();
    assert.equal(first.failed, 1);
    assert.equal(first.exhausted, 0);
    const failure = harness.calls.find((call) => call[0] === 'reconcile-fail')[1];
    assert.equal(failure.error_code, 'cartesia_timeout');
    assert.equal(failure.next_attempt_at, '2026-11-09T12:00:15.000Z');

    const exhausted = makeHarness({
      reconciliationEnabled: true,
      clock: () => new Date('2026-11-09T12:00:00.000Z'),
      claims: [{ provider_batch_id: 'batch_test_01', business_id: 'business_test', reconcile_attempt_count: 7 }],
    });
    exhausted.service.reconcileBatch = async () => { throw Object.assign(new Error('provider detail'), { code: 'cartesia_timeout' }); };
    const final = await exhausted.service.runReconciliationWorker();
    assert.equal(final.exhausted, 1);
    assert.equal(exhausted.calls.find((call) => call[0] === 'reconcile-fail')[1].next_attempt_at, null);
  });
});
