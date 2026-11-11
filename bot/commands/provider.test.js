'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_TELEGRAM_ID ||= '1';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'test-admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= 'test-token';
process.env.API_SECRET ||= 'test-api-secret';

const { getCapabilityForAction } = require('../utils/capabilities');
const { SUPPORTED_PROVIDERS, buildProviderKeyboard } = require('./provider');

test('provider selection lists telephony providers and keeps Cartesia AI actions separate', () => {
  assert.deepEqual(SUPPORTED_PROVIDERS, ['twilio', 'plivo', 'vonage']);
  const keyboard = buildProviderKeyboard({ session: {} }, 'twilio', ['twilio', 'cartesia']);
  const buttons = keyboard.inline_keyboard.flat();
  assert.equal(buttons.some((button) => /cartesia/i.test(button.text)), false);
  assert.equal(getCapabilityForAction('CARTESIA_CALL'), 'call');
});
