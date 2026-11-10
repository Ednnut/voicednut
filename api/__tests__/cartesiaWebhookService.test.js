const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');
const { createCartesiaWebhookHandler, normalizeCartesiaWebhookEvent } = require('../services/cartesiaWebhookService');

const WEBHOOK_SECRET = 'test-webhook-secret-with-sufficient-length';

function callEvent(overrides = {}) {
  return {
    type: 'call_completed',
    call_id: 'ac_test_01',
    agent_id: 'agent_test_01',
    webhook_id: 'webhook_test_01',
    webhook_request_id: 'webhook_req_test_01',
    timestamp: '2026-11-04T12:00:00.000Z',
    call: {
      id: 'ac_test_01',
      agent_id: 'agent_test_01',
      status: 'completed',
      start_time: '2026-11-04T11:59:00.000Z',
      end_time: '2026-11-04T12:00:00.000Z',
      end_reason: 'client_hangup',
      telephony_params: { from: '+15555550123', to: '+15555550001', direction: 'inbound' },
      telephony_account_type: 'cartesia',
      transcript: [{ role: 'user', text: 'private text that must not be persisted' }],
      summary: 'private summary that must not be persisted',
    },
    ...overrides,
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}

describe('Cartesia call lifecycle webhook', () => {
  it('validates Cartesia event envelope and produces metadata without transcript or summary content', () => {
    const event = normalizeCartesiaWebhookEvent(callEvent());
    assert.equal(event.type, 'call_completed');
    assert.equal(event.callRecord.direction, 'inbound');
    assert.equal(event.callRecord.phone_number, '+15555550123');
    assert.equal(event.callRecord.status, 'completed');
    assert.equal(JSON.stringify(event).includes('private text'), false);
    assert.equal(JSON.stringify(event).includes('private summary'), false);
    assert.throws(() => normalizeCartesiaWebhookEvent(callEvent({ timestamp: 'invalid' })), {
      code: 'cartesia_webhook_invalid',
    });
  });

  it('requires the configured shared secret and does not process unauthorized webhook events', async () => {
    let writes = 0;
    const handler = createCartesiaWebhookHandler({
      webhookSecret: WEBHOOK_SECRET,
      db: {
        async recordCartesiaWebhookReceipt() { writes += 1; },
        async upsertCartesiaCallRecord() { writes += 1; },
      },
    });
    const res = responseRecorder();
    await handler({ headers: { 'x-webhook-secret': 'wrong-secret' }, body: callEvent() }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'cartesia_webhook_unauthorized');
    assert.equal(writes, 0);

    const unconfigured = createCartesiaWebhookHandler({ db: {} });
    const unconfiguredResponse = responseRecorder();
    await unconfigured({ headers: {}, body: callEvent() }, unconfiguredResponse);
    assert.equal(unconfiguredResponse.statusCode, 503);
    assert.equal(unconfiguredResponse.body.code, 'cartesia_webhook_not_configured');
  });

  it('acknowledges valid and duplicate deliveries while applying call state idempotently', async () => {
    const receipts = new Map();
    const calls = [];
    const db = {
      async recordCartesiaWebhookReceipt(payload) {
        const existing = receipts.get(payload.webhook_request_id);
        if (existing) return {
          duplicate: existing.payload_hash === payload.payload_hash,
          conflict: existing.payload_hash !== payload.payload_hash,
        };
        receipts.set(payload.webhook_request_id, payload);
        return { inserted: true };
      },
      async upsertCartesiaCallRecord(payload) { calls.push(payload); },
    };
    const handler = createCartesiaWebhookHandler({ webhookSecret: WEBHOOK_SECRET, db });
    const req = { headers: { 'x-webhook-secret': WEBHOOK_SECRET }, body: callEvent() };
    const first = responseRecorder();
    await handler(req, first);
    const duplicate = responseRecorder();
    await handler(req, duplicate);

    assert.equal(first.statusCode, 204);
    assert.equal(duplicate.statusCode, 204);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].local_call_id, 'cartesia_ac_test_01');
    assert.equal(calls[0].business_id, undefined);
    assert.equal(Object.hasOwn(calls[0], 'transcript'), false);
  });

  it('rejects reuse of a webhook request ID with a different event payload', async () => {
    const receipts = new Map();
    const handler = createCartesiaWebhookHandler({
      webhookSecret: WEBHOOK_SECRET,
      db: {
        async recordCartesiaWebhookReceipt(payload) {
          const existing = receipts.get(payload.webhook_request_id);
          if (existing) return { conflict: existing !== payload.payload_hash };
          receipts.set(payload.webhook_request_id, payload.payload_hash);
          return { inserted: true };
        },
        async upsertCartesiaCallRecord() {},
      },
    });
    const original = responseRecorder();
    await handler({ headers: { 'x-webhook-secret': WEBHOOK_SECRET }, body: callEvent() }, original);
    const changedBody = callEvent({ timestamp: '2026-11-04T12:01:00.000Z' });
    const changed = responseRecorder();
    await handler({ headers: { 'x-webhook-secret': WEBHOOK_SECRET }, body: changedBody }, changed);
    assert.equal(original.statusCode, 204);
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.body.code, 'cartesia_webhook_event_conflict');
  });

  it('durably deduplicates event IDs and prevents out-of-order call status regression', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-webhook-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    try {
      const event = normalizeCartesiaWebhookEvent(callEvent());
      const receipt = {
        webhook_request_id: event.eventId,
        provider_call_id: event.providerCallId,
        event_type: event.type,
        event_timestamp: event.timestamp,
        payload_hash: event.payloadHash,
      };
      assert.deepEqual(await db.recordCartesiaWebhookReceipt(receipt), {
        inserted: true,
        duplicate: false,
        conflict: false,
      });
      await db.upsertCartesiaCallRecord(event.callRecord);
      assert.deepEqual(await db.recordCartesiaWebhookReceipt(receipt), {
        inserted: false,
        duplicate: true,
        conflict: false,
      });

      const oldStartedEvent = normalizeCartesiaWebhookEvent({
        type: 'call_started',
        call_id: 'ac_test_01',
        agent_id: 'agent_test_01',
        webhook_id: 'webhook_test_01',
        webhook_request_id: 'webhook_req_test_02',
        timestamp: '2026-11-04T11:58:00.000Z',
        call: {
          id: 'ac_test_01', agent_id: 'agent_test_01', status: 'started',
          start_time: '2026-11-04T11:59:00.000Z',
          telephony_params: { from: '+15555550123', to: '+15555550001', direction: 'inbound' },
        },
      });
      await db.upsertCartesiaCallRecord(oldStartedEvent.callRecord);
      const row = await new Promise((resolve, reject) => db.db.get(
        'SELECT status, phone_number, business_id FROM cartesia_calls WHERE provider_call_id = ?',
        ['ac_test_01'],
        (error, result) => error ? reject(error) : resolve(result),
      ));
      assert.deepEqual(row, { status: 'completed', phone_number: '+15555550123', business_id: null });
      const columns = await new Promise((resolve, reject) => db.db.all(
        'PRAGMA table_info(cartesia_calls)',
        (error, rows) => error ? reject(error) : resolve(rows.map((entry) => entry.name)),
      ));
      assert.equal(columns.includes('transcript_json'), false);
      assert.equal(columns.includes('summary'), false);
      assert.equal(receipt.payload_hash, crypto.createHash('sha256').update(JSON.stringify({
        eventId: event.eventId,
        type: event.type,
        providerCallId: event.providerCallId,
        agentId: 'agent_test_01',
        webhookId: 'webhook_test_01',
        timestamp: event.timestamp,
        status: 'completed',
        direction: 'inbound',
        from: '+15555550123',
        to: '+15555550001',
        endTime: '2026-11-04T12:00:00.000Z',
      })).digest('hex'));
    } finally {
      await new Promise((resolve) => db.db.close(resolve));
      [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
    }
  });
});
