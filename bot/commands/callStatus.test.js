'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { formatCallAcceptedMessage } = require('./call');

test('accepted call confirmation masks the destination and identifies provider and AI voice', () => {
  const message = formatCallAcceptedMessage({
    call_sid: 'CA1234567890',
    to: '+15555550123',
    status: 'queued',
    provider: 'twilio',
    ai_voice_engine: 'cartesia',
  });

  assert.match(message, /Status: 🟡 Queued/);
  assert.match(message, /Destination: ••••0123/);
  assert.match(message, /Telephony: Twilio/);
  assert.match(message, /AI Voice: Cartesia/);
  assert.match(message, /Call ID: VN-34567890/);
  assert.doesNotMatch(message, /\+15555550123/);
});

test('accepted call confirmation does not echo unrecognized provider or status values', () => {
  const message = formatCallAcceptedMessage({
    call_sid: 'call-test-01',
    to: 'not-a-number',
    status: 'provider-private-status',
    provider: 'private-provider',
    ai_voice_engine: 'unlisted-engine',
  });

  assert.match(message, /Status: 🟡 Submitted/);
  assert.match(message, /Destination: ••••/);
  assert.equal(/Telephony:/.test(message), false);
  assert.equal(/AI Voice:/.test(message), false);
  assert.match(message, /Call ID: VN-lltest01/);
  assert.doesNotMatch(message, /private-provider|provider-private-status|unlisted-engine/);
});
