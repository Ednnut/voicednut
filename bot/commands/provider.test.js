'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_TELEGRAM_ID ||= '1';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'test-admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= 'test-token';
process.env.API_SECRET ||= 'test-api-secret';

const { getCapabilityForAction } = require('../utils/capabilities');
const {
  SUPPORTED_PROVIDERS,
  SUPPORTED_AI_VOICE_ENGINES,
  buildProviderKeyboard,
  formatProviderStatus,
  buildProviderRecommendationUrl,
  formatProviderRecommendation,
  normalizeProviders,
} = require('./provider');

test('provider selection separates direct telephony providers from Cartesia AI voice', () => {
  assert.deepEqual(SUPPORTED_PROVIDERS, ['twilio', 'plivo', 'vonage']);
  assert.deepEqual(SUPPORTED_AI_VOICE_ENGINES, ['cartesia', 'deepgram']);
  const keyboard = buildProviderKeyboard({ session: {} }, 'twilio', ['twilio', 'plivo', 'vonage', 'call_e', 'cartesia']);
  const buttons = keyboard.inline_keyboard.flat();
  assert.equal(buttons.some((button) => button.callback_data.includes('PROVIDER_CONFIRM:cartesia')), false);
  assert.equal(buttons.some((button) => button.callback_data.includes('PROVIDER_CONFIRM:call_e')), false);
  assert.ok(buttons.some((button) => /cartesia/i.test(button.text)));
  assert.ok(buttons.some((button) => button.callback_data.includes('CARTESIA_CENTER')));
  assert.ok(buttons.some((button) => button.callback_data.includes('CARTESIA_CALL') && /Managed Agent/i.test(button.text)));
  const aiVoiceButton = buttons.find((button) => button.callback_data.includes('CARTESIA_VOICE_SETTINGS'));
  assert.ok(aiVoiceButton);
  assert.match(aiVoiceButton.text, /AI Voice: Cartesia \/ Deepgram/);
  assert.equal(aiVoiceButton.callback_data.includes('PROVIDER_CONFIRM:'), false);
  const status = normalizeProviders({
    supported_providers: ['twilio', 'plivo', 'vonage', 'call_e'],
    voice_provider_capabilities: [
      { provider: 'twilio', operations: { 'outbound_call.create': true } },
      { provider: 'plivo', operations: { 'outbound_call.create': true } },
      { provider: 'vonage', operations: { 'outbound_call.create': true } },
      { provider: 'call_e', operations: { 'outbound_task.create': true } },
    ],
  });
  assert.deepEqual(status.supported, ['twilio', 'plivo', 'vonage']);
  assert.equal(getCapabilityForAction('CARTESIA_CALL'), 'call');
  assert.equal(getCapabilityForAction('CARTESIA_DASHBOARD'), 'cartesia_speech_manage');
  assert.equal(getCapabilityForAction('CARTESIA_PROFILE_SCOPE'), 'cartesia_speech_manage');
  assert.equal(getCapabilityForAction('CARTESIA_REVIEW_RULES'), 'cartesia_manage');
});

test('provider status reports the selected AI TTS engine separately from telephony', () => {
  const message = formatProviderStatus({
    provider: 'twilio',
    tts_provider: 'cartesia',
    cartesia_tts_profile: { voice_id: 'voice-1', model_id: 'sonic-3.6' },
    supported_providers: ['twilio', 'cartesia'],
  });
  assert.match(message, /Current Telephony Provider.*TWILIO/);
  assert.match(message, /Global AI Voice Default.*CARTESIA/);
  assert.match(message, /Cartesia Voice.*voice-1/);
  assert.match(message, /Cartesia Model.*sonic-3\.6/);
  assert.doesNotMatch(message, /Supported Backbones.*CARTESIA/);
});

test('provider status separates configuration from process-observed provider activity', () => {
  const message = formatProviderStatus({
    provider: 'twilio',
    twilio_ready: true,
    provider_health: {
      twilio: {
        circuit_state: 'open',
        degraded: true,
        consecutive_errors: 3,
        last_error_at: '2026-11-14T11:55:00.000Z',
        last_success_at: '2026-11-14T11:50:00.000Z',
        observation_scope: 'api_process_memory',
      },
    },
  });
  assert.match(message, /Configuration.*Ready/);
  assert.match(message, /Last API-observed success.*2026-11-14/);
  assert.match(message, /Last API-observed error.*2026-11-14/);
  assert.match(message, /Provider circuit.*open/);
  assert.match(message, /Provider is degraded or circuit-open/);
  assert.match(message, /not a live connectivity probe/);
});

test('provider recommendation URL encodes bounded, read-only capability inputs', () => {
  const url = new URL(buildProviderRecommendationUrl({
    operation: 'outbound_call.create',
    requiredCapabilities: ['voice_stream', 'outbound_voice'],
    preferredProvider: 'twilio',
  }));
  assert.equal(url.pathname, '/admin/provider/recommendation');
  assert.equal(url.searchParams.get('operation'), 'outbound_call.create');
  assert.equal(url.searchParams.get('required_capabilities'), 'voice_stream,outbound_voice');
  assert.equal(url.searchParams.get('preferred_provider'), 'twilio');
});

test('provider recommendation clearly separates alternatives from provider health certainty', () => {
  const message = formatProviderRecommendation({
    recommendation: { provider: 'twilio', reason: 'configured_order' },
    alternatives: [{ provider: 'plivo', reasons: ['operation_supported', 'provider_configured'] }],
    providers: [
      { provider: 'twilio', eligible: true, operational_state: 'unverified' },
      { provider: 'plivo', eligible: true, operational_state: 'unverified' },
      { provider: 'vonage', eligible: false, blockers: ['provider_not_configured'] },
    ],
  });

  assert.match(message, /Recommended provider.*TWILIO/);
  assert.match(message, /reachability is not verified/);
  assert.match(message, /Alternatives:[\s\S]*PLIVO/);
  assert.match(message, /Not eligible:[\s\S]*VONAGE.*provider\\_not\\_configured/);
  assert.match(message, /read-only recommendation/);
});
