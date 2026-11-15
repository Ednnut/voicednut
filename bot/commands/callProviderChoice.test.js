'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_TELEGRAM_ID ||= '1';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= 'test-token';
process.env.API_SECRET ||= 'test-api-secret';

const { offerManagedAgentCall } = require('./call').__testables;

test('call provider choice preserves carrier path and limits Managed Agent entry to private admins', async () => {
  for (const [access, chat] of [[{}, 'private'], [{ isAdmin: true }, 'group']]) {
    assert.equal(await offerManagedAgentCall({}, { chat: { type: chat } }, access, () => {}, {
      choose() { assert.fail('must not offer Managed Agent dialing'); },
    }), false);
  }
  assert.equal(await offerManagedAgentCall({}, { chat: { type: 'private' } }, { isAdmin: true }, () => {}, {
    choose: async () => ({ id: 'carrier' }), run() { assert.fail('carrier must not invoke Cartesia'); },
  }), false);
});

test('call provider choice invokes guarded flow only for explicit Cartesia selection', async () => {
  for (const id of ['cartesia', 'cancel', 'unknown']) {
    let calls = 0;
    assert.equal(await offerManagedAgentCall({}, { chat: { type: 'private' } }, { isAdmin: true }, () => {}, {
      choose: async (_conversation, _ctx, _prompt, _choices, options) => {
        assert.equal(options.prefix, 'call-config');
        return { id };
      },
      run: async () => { calls++; },
    }), true);
    assert.equal(calls, id === 'cartesia' ? 1 : 0);
  }
});