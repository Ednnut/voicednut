'use strict';

const assert = require('node:assert/strict');
const { CallEMissionAlertWorker } = require('../services/callEMissionAlertWorker');

describe('CALL-E mission alert worker', () => {
  it('does not send or query while disabled', async () => {
    let queries = 0;
    const worker = new CallEMissionAlertWorker({ botToken: 'test-token-that-is-long-enough', db: { async listCallEMissionAlertSubscriptions() { queries += 1; } } });
    assert.equal(worker.start(), false);
    assert.deepEqual(await worker.drain(), { state: 'disabled', delivered: 0 });
    assert.equal(queries, 0);
  });

  it('delivers masked status-only attention notifications and advances each opted-in cursor', async () => {
    const cursors = [];
    const requests = [];
    const worker = new CallEMissionAlertWorker({ enabled: true, botToken: 'fake-token-for-mocked-notifications', db: {
      async listCallEMissionAlertSubscriptions() { return [{ business_id: 'biz-a', actor_id: '222', last_notified_event_id: 0 }]; },
      async listCallEMissionAlertsForSubscription(input) {
        assert.equal(input.business_id, 'biz-a');
        return [
          { event_id: 1, mission_id: `mission_${'a'.repeat(64)}`, event_type: 'recipient_transition', recipient_position: 0, state: 'needs_review', error_code: 'call_e_result_unavailable' },
          { event_id: 2, mission_id: `mission_${'a'.repeat(64)}`, event_type: 'recipient_transition', recipient_position: 1, state: 'completed' },
        ];
      },
      async advanceCallEMissionAlertCursor(input) { cursors.push(input.event_id); },
    }, fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true }; } });
    assert.deepEqual(await worker.drain(), { state: 'completed', delivered: 1 });
    assert.deepEqual(cursors, [1, 2]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.chat_id, '222');
    assert.equal(requests[0].body.text.includes('needs_review'), true);
    assert.equal(requests[0].body.text.includes('recipient 1'), true);
    assert.equal(requests[0].body.text.includes('destination'), false);
  });

  it('continues to later subscribers after one Telegram delivery fails', async () => {
    const sentChats = [];
    const touched = [];
    const worker = new CallEMissionAlertWorker({ enabled: true, botToken: 'mock-token-without-a-real-credential', db: {
      async listCallEMissionAlertSubscriptions() { return [
        { business_id: 'biz-a', actor_id: '222', last_notified_event_id: 0 },
        { business_id: 'biz-b', actor_id: '333', last_notified_event_id: 0 },
      ]; },
      async listCallEMissionAlertsForSubscription(input) { return [{
        event_id: input.business_id === 'biz-a' ? 1 : 2,
        mission_id: `mission_${'a'.repeat(64)}`, event_type: 'mission_created', state: 'pending_approval',
      }]; },
      async advanceCallEMissionAlertCursor() {},
      async touchCallEMissionAlertSubscription(input) { touched.push(input.business_id); },
    }, fetch: async (_url, options) => {
      const chat = JSON.parse(options.body).chat_id;
      if (chat === '222') throw Object.assign(new Error('network failure'), { code: 'ETIMEDOUT' });
      sentChats.push(chat);
      return { ok: true };
    } });
    const result = await worker.drain();
    assert.deepEqual(result, { state: 'completed', delivered: 1 });
    assert.deepEqual(touched, ['biz-a']);
    assert.deepEqual(sentChats, ['333']);
  });
});
