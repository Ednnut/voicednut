'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_TELEGRAM_ID ||= '1';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'test-admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= 'test-token';
process.env.API_SECRET ||= 'test-api-secret';

const {
  formatCallTimeline,
  parseRecentFilter,
  buildCallActivityListKeyboard,
  buildCallActivityDetailKeyboard,
} = require('./calllog');

test('recent-call filters support exact dates and reject malformed dates', () => {
  assert.deepEqual(parseRecentFilter('date:2026-11-14'), {
    date_from: '2026-11-14',
    date_to: '2026-11-14',
  });
  assert.deepEqual(parseRecentFilter('date:2026-02-30'), { invalid: true });
  assert.deepEqual(parseRecentFilter('date:November 14'), { invalid: true });
  assert.deepEqual(parseRecentFilter('+14155550123'), { phone: '+14155550123' });
  assert.deepEqual(parseRecentFilter('completed'), { status: 'completed' });
});

test('call timeline orders lifecycle states and shows only safe provider correlation', () => {
  const message = formatCallTimeline([
    { state: 'provider_submission_accepted', sequence_number: 3, timestamp: '2026-11-14T12:02:00.000Z', data: { status: 'queued' } },
    { state: 'call_created', sequence_number: 2, timestamp: '2026-11-14T12:01:00.000Z', data: { status: 'queued', provider_metadata: { secret: 'hidden' } } },
    { state: 'outbound_submission_pending', sequence_number: 1, timestamp: '2026-11-14T12:00:00.000Z' },
  ], {
    status: 'unknown',
    telephony_provider: 'twilio',
    provider_call_id: 'CA_test_01',
  });

  assert.ok(message.indexOf('outbound\\_submission\\_pending') < message.indexOf('call\\_created'));
  assert.ok(message.indexOf('call\\_created') < message.indexOf('provider\\_submission\\_accepted'));
  assert.match(message, /Provider call ID.*CA\\_test\\_01/);
  assert.match(message, /Reconcile or verify provider state before any retry/);
  assert.doesNotMatch(message, /hidden/);
});

test('activity call buttons carry a short session index instead of provider call IDs', () => {
  const keyboard = buildCallActivityListKeyboard({
    from: { id: 7001 },
    session: { currentOp: { token: 'activity1' } },
  }, [{ call_sid: 'cartesia_provider_call_id', provider: 'cartesia', status: 'started', phone_number: '••••0123' }]);
  const callback = keyboard.inline_keyboard.flat().map((button) => button.callback_data).find(Boolean);
  assert.match(callback, /CALLLOG_ITEM:0/);
  assert.doesNotMatch(callback, /cartesia_provider_call_id/);
});

test('uncertain calls expose a reconciliation action separate from ordinary status refresh', () => {
  const keyboard = buildCallActivityDetailKeyboard({
    from: { id: 7001 },
    session: { currentOp: { token: 'activity1' } },
  }, true, true);
  const callbacks = keyboard.inline_keyboard.flat().map((button) => button.callback_data).filter(Boolean);
  assert.ok(callbacks.some((callback) => /CALLLOG_RECONCILE/.test(callback)));
  assert.ok(callbacks.some((callback) => /CALLLOG_REFRESH/.test(callback)));
});
