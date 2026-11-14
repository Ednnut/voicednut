'use strict';

const assert = require('node:assert/strict');
const { __testables } = require('../services/statusRoutes');

describe('call status ownership', () => {
  it('denies a Telegram user access to another user call status', async () => {
    let responseStatus = 200;
    let responseBody;
    let stateLookupCalled = false;
    const handler = __testables.createGetCallStatusHandler({
      isSafeId: () => true,
      normalizeCallRecordForApi: (call) => call,
      buildDigitSummary: () => ({ summary: '', count: 0 }),
      webhookService: { getCallStatusStats: () => ({}) },
      getDb: () => ({
        getCall: async () => ({
          call_sid: 'CA123',
          user_chat_id: 'owner-1',
        }),
        getLatestCallState: async () => {
          stateLookupCalled = true;
          return null;
        },
      }),
    });

    await handler(
      { params: { callSid: 'CA123' }, headers: { 'x-telegram-chat-id': 'owner-2' } },
      {
        status(value) {
          responseStatus = value;
          return this;
        },
        json(value) {
          responseBody = value;
          return value;
        },
      },
    );

    assert.equal(responseStatus, 403);
    assert.equal(responseBody.error, 'Not authorized for this call');
    assert.equal(stateLookupCalled, false);
  });
});
