'use strict';

const assert = require('node:assert/strict');
const { createCartesiaWebhookHandler, normalizeEvent } = require('../services/cartesiaWebhookRoutes');

function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

const event = {
  type: 'call_completed', call_id: 'call_1', agent_id: 'agent_1', webhook_id: 'agent_webhook_1',
  webhook_request_id: 'webhook_req_1', timestamp: '2026-11-01T12:00:00.000Z',
  call: { id: 'call_1', transcript: [{ role: 'user', text: 'sensitive transcript' }] },
};

describe('Cartesia lifecycle webhook receiver', () => {
  it('verifies the configured secret and durably deduplicates provider retries without storing transcript content', async () => {
    const writes = [];
    const handler = createCartesiaWebhookHandler({ enabled: true, secret: 'test-cartesia-webhook-secret-is-at-least-32', db: {
      async recordCartesiaWebhookEvent(value) { writes.push(value); return { inserted: writes.length === 1, duplicate: writes.length > 1 }; },
    } });
    const req = { headers: { 'x-webhook-secret': 'test-cartesia-webhook-secret-is-at-least-32' }, body: event, rawBody: JSON.stringify(event) };
    const first = response();
    await handler(req, first);
    const retry = response();
    await handler(req, retry);
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.duplicate, false);
    assert.equal(retry.body.duplicate, true);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].event_type, 'call_completed');
    assert.match(writes[0].payload_hash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(writes[0]), /sensitive transcript|transcript/);
  });

  it('rejects invalid secrets, malformed events, and unavailable storage without acknowledging them', async () => {
    const handler = createCartesiaWebhookHandler({ enabled: true, secret: 'test-cartesia-webhook-secret-is-at-least-32', db: {} });
    const unauthorized = response();
    await handler({ headers: { 'x-webhook-secret': 'wrong' }, body: event }, unauthorized);
    assert.equal(unauthorized.statusCode, 401);
    const invalid = response();
    await handler({ headers: { 'x-webhook-secret': 'test-cartesia-webhook-secret-is-at-least-32' }, body: { ...event, type: 'unknown' } }, invalid);
    assert.equal(invalid.statusCode, 400);
    const unavailable = response();
    await handler({ headers: { 'x-webhook-secret': 'test-cartesia-webhook-secret-is-at-least-32' }, body: event }, unavailable);
    assert.equal(unavailable.statusCode, 503);
    assert.throws(() => normalizeEvent({ ...event, timestamp: 'yesterday' }), { code: 'cartesia_webhook_event_invalid' });
  });
});
