const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { registerCartesiaCallRoutes } = require('../services/cartesiaCallRoutes');

function setup() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const calls = [];
  const audits = [];
  let storedRecipients = [];
  const batch = { id: 'batch_test_01', status: 'pending', totalCallsScheduled: 2, totalCallsDispatched: 0, totalCallsFinished: 0, retryCount: 0 };
  const batchService = {
    dispatchEnabled: false,
    retentionEnabled: true,
    retentionDays: 30,
    async prepareBatch(body) { calls.push(['preview', body]); return { requestFingerprint: 'a'.repeat(64), recipientCount: body.recipients?.length || 0 }; },
    async createBatch(body) { calls.push(['create', body]); return { ...batch, idempotentReplay: false }; },
    async listBatches(query) { calls.push(['list', query]); return { batches: [batch], hasMore: false, nextPage: null }; },
    async getBatch(id) { calls.push(['get', id]); return { ...batch, id }; },
    async reconcileBatch(id) { calls.push(['reconcile', id]); return { ...batch, id, reconciliation: { persisted: true, recipientCount: 1 } }; },
    async getStoredBatch(id) { calls.push(['records', id]); return { ...batch, id, businessId: 'business_test', recipients: storedRecipients }; },
    async cancelBatch(id, approved) { calls.push(['cancel', id, approved]); return { ...batch, id, status: 'cancelled' }; },
    async prepareRetentionPurge(id) { calls.push(['retention-preview', id]); return { batchId: id, eligible: true, retentionDays: 30, recipientCount: 1, fingerprint: 'b'.repeat(64) }; },
    async purgeExpiredRecipients(id, fingerprint) { calls.push(['retention-purge', id, fingerprint]); return { batchId: id, deletedCount: 1 }; },
  };
  const requireAdminToken = (req, res, next) => req.get('x-admin-token') === 'ok' ? next() : res.status(403).json({ success: false });
  registerCartesiaCallRoutes(app, {
    batchService,
    service: {},
    db: {
      async recordCartesiaCallOperationAudit(event) { audits.push(event); },
      async recordCartesiaBatchRetentionAudit(event) { audits.push({ retention: true, ...event }); },
    },
    requireAdminToken,
  });
  return { app, calls, audits, setStoredRecipients(recipients) { storedRecipients = recipients; } };
}

describe('Cartesia batch routes', () => {
  it('requires admin authorization for batch read and preview routes', async () => {
    const { app } = setup();
    assert.equal((await request(app).get('/api/cartesia/call-batches')).status, 403);
    assert.equal((await request(app).post('/api/cartesia/call-batches/preview').send({})).status, 403);
  });

  it('allows batch preview but rejects direct Cartesia batch dispatch without provider side effects', async () => {
    const { app, calls, audits } = setup();
    const admin = { 'x-admin-token': 'ok' };
    const payload = { business_id: 'business_test', name: 'Batch', agent_id: 'agent_test', from_number_id: 'number_test', recipients: [{ to_number: '+15555550123' }] };
    const preview = await request(app).post('/api/cartesia/call-batches/preview').set(admin).send(payload);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.requestFingerprint, 'a'.repeat(64));
    const invalid = await request(app).post('/api/cartesia/call-batches').set(admin).send({ ...payload, unknown: true });
    assert.equal(invalid.status, 409);
    assert.equal(invalid.body.code, 'cartesia_is_ai_capability');
    const create = await request(app).post('/api/cartesia/call-batches').set(admin).send({
      ...payload, approved: true, confirmed_fingerprint: 'a'.repeat(64), idempotency_key: 'batch-key-test-01',
    });
    assert.equal(create.status, 409);
    assert.equal(create.body.code, 'cartesia_is_ai_capability');
    assert.equal(calls.filter((call) => call[0] === 'create').length, 0);
    assert.deepEqual(audits, []);
  });

  it('supports read-only batch inventory and requires explicit cancellation approval', async () => {
    const { app, calls, audits } = setup();
    const admin = { 'x-admin-token': 'ok' };
    assert.equal((await request(app).get('/api/cartesia/call-batches').set(admin)).status, 200);
    assert.equal((await request(app).get('/api/cartesia/call-batches/batch_test_01').set(admin)).status, 200);
    assert.equal((await request(app).post('/api/cartesia/call-batches/batch_test_01/cancel').set(admin).send({})).status, 400);
    const cancelled = await request(app).post('/api/cartesia/call-batches/batch_test_01/cancel').set(admin).send({ approved: true });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.batch.status, 'cancelled');
    assert.deepEqual(calls.map((call) => call[0]), ['list', 'get', 'cancel']);
    assert.deepEqual(audits.map((event) => event.action), ['outbound_call_cancel', 'outbound_call_cancel']);
    assert.equal(audits[0].resource_id, 'batch:batch_test_01');
  });

  it('requires admin authorization for reconciliation and exposes local recipient records', async () => {
    const { app, calls } = setup();
    const admin = { 'x-admin-token': 'ok' };
    assert.equal((await request(app).post('/api/cartesia/call-batches/batch_test_01/reconcile').send({})).status, 403);
    const reconciled = await request(app).post('/api/cartesia/call-batches/batch_test_01/reconcile').set(admin).send({});
    const records = await request(app).get('/api/cartesia/call-batches/batch_test_01/records').set(admin);
    const invalid = await request(app).post('/api/cartesia/call-batches/batch_test_01/reconcile').set(admin).send({ unexpected: true });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.batch.reconciliation.recipientCount, 1);
    assert.equal(records.status, 200);
    assert.equal(records.body.batch.businessId, 'business_test');
    assert.equal(invalid.status, 400);
    assert.deepEqual(calls.map((call) => call[0]), ['reconcile', 'records']);
  });

  it('exports a bounded fixed-column CSV with spreadsheet formula neutralization and no-store headers', async () => {
    const { app, calls, setStoredRecipients } = setup();
    setStoredRecipients([{
      id: '=cmd|payload', toNumber: '+15555550123', status: 'completed',
      agentCallId: '+SUM(1,1)', endReason: '@provider', hasProviderError: true,
      localState: 'provider_snapshot', createdAt: '2026-06-01T00:00:00.000Z',
      dynamicVariables: { private: 'must not export' }, errorMessage: 'must not export',
    }]);
    const admin = { 'x-admin-token': 'ok' };
    assert.equal((await request(app).get('/api/cartesia/call-batches/batch_test_01/records.csv')).status, 403);
    const response = await request(app).get('/api/cartesia/call-batches/batch_test_01/records.csv').set(admin);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /text\/csv/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['content-disposition'], 'attachment; filename="cartesia-batch-batch_test_01.csv"');
    assert.match(response.text, /"'\=cmd\|payload"/);
    assert.match(response.text, /"'\+SUM\(1,1\)"/);
    assert.match(response.text, /"'\@provider"/);
    assert.equal(response.text.includes('private'), false);
    assert.equal(response.text.includes('must not export'), false);
    assert.deepEqual(calls.map((call) => call[0]), ['records']);
  });

  it('rejects malformed batch IDs before querying local results', async () => {
    const { app, calls } = setup();
    const response = await request(app).get('/api/cartesia/call-batches/%2F/records.csv').set({ 'x-admin-token': 'ok' });
    assert.equal(response.status, 400);
    assert.deepEqual(calls, []);
  });

  it('requires admin authorization, preview-bound approval, and audit records for retention deletion', async () => {
    const { app, calls, audits } = setup();
    const admin = { 'x-admin-token': 'ok' };
    assert.equal((await request(app).post('/api/cartesia/call-batches/batch_test_01/retention/preview').send({})).status, 403);
    const preview = await request(app).post('/api/cartesia/call-batches/batch_test_01/retention/preview').set(admin).send({});
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.fingerprint, 'b'.repeat(64));
    assert.equal(Object.hasOwn(preview.body.preview, 'businessId'), false);
    assert.equal(Object.hasOwn(preview.body.preview, 'providerUpdatedAt'), false);
    const purge = await request(app).post('/api/cartesia/call-batches/batch_test_01/retention').set(admin).send({ approved: true, confirmed_fingerprint: 'b'.repeat(64) });
    assert.equal(purge.status, 200);
    assert.deepEqual(calls.map((call) => call[0]), ['retention-preview', 'retention-purge']);
    assert.deepEqual(audits.filter((event) => event.retention).map((event) => event.outcome), ['requested', 'succeeded']);
    assert.equal(audits.filter((event) => event.retention).some((event) => JSON.stringify(event).includes('+15555550123')), false);
  });

  it('fails closed if retention audit storage is unavailable', async () => {
    const isolated = express();
    isolated.use(express.json());
    registerCartesiaCallRoutes(isolated, {
      batchService: {
        async prepareRetentionPurge(id) { return { batchId: id, eligible: true, fingerprint: 'b'.repeat(64) }; },
        async purgeExpiredRecipients() { throw new Error('must not reach purge'); },
      },
      db: {},
      requireAdminToken: (req, res, next) => req.get('x-admin-token') === 'ok' ? next() : res.sendStatus(403),
    });
    const response = await request(isolated).post('/api/cartesia/call-batches/batch_test_01/retention').set({ 'x-admin-token': 'ok' }).send({ approved: true, confirmed_fingerprint: 'b'.repeat(64) });
    assert.equal(response.status, 503);
  });
});
