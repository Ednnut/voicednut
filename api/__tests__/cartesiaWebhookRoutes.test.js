'use strict';

const assert = require('node:assert/strict');
const {
  createCartesiaWebhookHandler,
  normalizeEvent,
  registerCartesiaWebhookRoutes,
} = require('../services/cartesiaWebhookRoutes');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}

const event = {
  type: 'call_completed', call_id: 'call_1', agent_id: 'agent_1', webhook_id: 'agent_webhook_1',
  webhook_request_id: 'webhook_req_1', timestamp: '2026-11-01T12:00:00.000Z',
  call: {
    id: 'call_1', agent_id: 'agent_1', status: 'completed',
    start_time: '2026-11-01T11:59:00.000Z', end_time: '2026-11-01T12:00:00.000Z',
    telephony_params: { direction: 'outbound', from: '+15555550001', to: '+15555550123' },
    transcript: [{ role: 'user', text: 'sensitive transcript' }],
  },
};

describe('Cartesia lifecycle webhook receiver', () => {
  it('uses the shared call lifecycle handler and deduplicates retries without storing transcript content', async () => {
    const receipts = [];
    const calls = [];
    const handler = createCartesiaWebhookHandler({ enabled: true, secret: 'test-cartesia-webhook-secret-is-at-least-32', db: {
      async recordCartesiaWebhookReceipt(value) {
        receipts.push(value);
        return { inserted: receipts.length === 1, duplicate: receipts.length > 1, conflict: false };
      },
      async upsertCartesiaCallRecord(value) { calls.push(value); },
    } });
    const req = { headers: { 'x-webhook-secret': 'test-cartesia-webhook-secret-is-at-least-32' }, body: event };
    const first = response();
    await handler(req, first);
    const retry = response();
    await handler(req, retry);
    assert.equal(first.statusCode, 204);
    assert.equal(retry.statusCode, 204);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].event_type, 'call_completed');
    assert.match(receipts[0].payload_hash, /^[a-f0-9]{64}$/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].status, 'completed');
    assert.doesNotMatch(JSON.stringify(receipts), /sensitive transcript|transcript/);
    assert.doesNotMatch(JSON.stringify(calls), /sensitive transcript|transcript/);
  });

  it('ignores unsupported future Cartesia event types, rejects invalid secrets and malformed bodies, and refuses unavailable storage', async () => {
    const handler = createCartesiaWebhookHandler({ enabled: true, secret: 'test-cartesia-webhook-secret-is-at-least-32', db: {} });
    const unauthorized = response();
    await handler({ headers: { 'x-webhook-secret': 'wrong' }, body: event }, unauthorized);
    assert.equal(unauthorized.statusCode, 401);
    const ignored = response();
    await handler({ headers: { 'x-webhook-secret': 'test-cartesia-webhook-secret-is-at-least-32' }, body: { ...event, type: 'future_unknown_event' } }, ignored);
    assert.equal(ignored.statusCode, 204);
    assert.equal(normalizeEvent({ ...event, type: 'future_unknown_event' }).ignored, true);
    const unavailable = response();
    await handler({ headers: { 'x-webhook-secret': 'test-cartesia-webhook-secret-is-at-least-32' }, body: event }, unavailable);
    assert.equal(unavailable.statusCode, 503);
    assert.throws(() => normalizeEvent({ ...event, timestamp: 'yesterday' }), { code: 'cartesia_webhook_invalid' });
  });

  it('registers the shared lifecycle handler for the legacy callback path', () => {
    const registered = [];
    const handler = async () => {};
    const limiter = () => {};
    registerCartesiaWebhookRoutes({ post(...args) { registered.push(args); } }, {
      handler,
      limiter,
    });
    assert.deepEqual(registered, [['/webhook/cartesia', limiter, handler]]);
  });
});
