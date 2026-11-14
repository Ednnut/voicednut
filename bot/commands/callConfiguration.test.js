'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const botDb = require('../db/db');
const {
  resolveCallProviderDefaults,
  getCallProviderSelectionState,
  resolveCallVoiceModel,
  prepareCallSubmission,
  resolveCallSubmissionOutcome,
  isUncertainCallSubmissionError,
  getReconciliationInstruction,
  buildCartesiaConfirmationPhrase,
} = require('./call');

function providerStatus(overrides = {}) {
  return {
    provider: 'twilio',
    supported_providers: ['twilio', 'plivo', 'vonage', 'call_e'],
    tts_provider: 'deepgram',
    providers: {
      call: {
        provider: 'twilio',
        readiness: { twilio: true, plivo: true, vonage: true, call_e: true },
      },
    },
    voice_provider_capabilities: [
      { provider: 'twilio', operations: { 'outbound_call.create': true } },
      { provider: 'plivo', operations: { 'outbound_call.create': true } },
      { provider: 'vonage', operations: { 'outbound_call.create': true } },
      { provider: 'call_e', operations: { 'outbound_call.create': false } },
    ],
    ...overrides,
  };
}

test('call defaults keep telephony and AI voice selections independent', () => {
  const cartesia = resolveCallProviderDefaults(providerStatus({
    provider: 'plivo',
    tts_provider: 'cartesia',
    cartesia_tts_profile: {
      provider: 'cartesia',
      voice_id: 'voice-1',
      model_id: 'sonic-3.6',
    },
  }));
  const deepgram = resolveCallProviderDefaults(providerStatus({
    provider: 'plivo',
    tts_provider: 'deepgram',
  }));

  assert.equal(cartesia.telephonyProvider, 'plivo');
  assert.equal(cartesia.aiVoiceEngine, 'cartesia');
  assert.equal(cartesia.providerReady, true);
  assert.equal(deepgram.telephonyProvider, 'plivo');
  assert.equal(deepgram.aiVoiceEngine, 'deepgram');
});

test('default calls use the configured voice while Cartesia keeps its selected profile', () => {
  assert.equal(resolveCallVoiceModel({
    aiVoiceEngine: 'deepgram',
    configuredVoice: 'aura-2-andromeda-en',
  }), 'aura-2-andromeda-en');
  assert.equal(resolveCallVoiceModel({
    aiVoiceEngine: 'deepgram',
    scriptVoiceModel: 'aura-2-aries-en',
    configuredVoice: 'aura-2-andromeda-en',
  }), 'aura-2-aries-en');
  assert.equal(resolveCallVoiceModel({
    aiVoiceEngine: 'cartesia',
    scriptVoiceModel: 'aura-2-aries-en',
    configuredVoice: 'aura-2-andromeda-en',
  }), null);
});

test('call defaults reject unsupported direct-call providers and incomplete Cartesia profiles', () => {
  assert.throws(
    () => resolveCallProviderDefaults(providerStatus({ provider: 'call_e' })),
    { code: 'call_provider_operation_unsupported' }
  );
  assert.throws(
    () => resolveCallProviderDefaults(providerStatus({ provider: 'unknown' })),
    { code: 'call_provider_config_invalid' }
  );
  assert.throws(
    () => resolveCallProviderDefaults(providerStatus({
      tts_provider: 'cartesia',
      cartesia_tts_profile: { provider: 'cartesia', voice_id: 'voice-1' },
    })),
    { code: 'call_cartesia_profile_incomplete' }
  );
  assert.throws(
    () => resolveCallProviderDefaults(providerStatus({ tts_provider: 'unknown' })),
    { code: 'call_voice_engine_config_invalid' }
  );
});

test('call provider selection retains non-carrier call modes when the global carrier is unavailable', () => {
  const state = getCallProviderSelectionState(providerStatus({
    provider: 'twilio',
    providers: { call: { provider: 'twilio', supported_providers: ['twilio', 'plivo', 'vonage'], readiness: { twilio: false, plivo: true, vonage: false } } },
  }));
  assert.equal(state.telephonyProvider, 'twilio');
  assert.equal(state.readiness.twilio, false);
  assert.deepEqual(state.supportedProviders, ['twilio', 'plivo', 'vonage']);
});

test('call preflight blocks a configured telephony provider that is not ready', () => {
  assert.throws(
    () => resolveCallProviderDefaults(providerStatus({
      providers: {
        call: {
          provider: 'twilio',
          readiness: { twilio: false },
        },
      },
    })),
    { code: 'call_provider_not_ready' },
  );
});

test('call submissions reuse their key after uncertain outcomes and block changed requests', () => {
  const session = {};
  const payload = { number: '+14155550123', script_id: 'script-1' };
  const first = prepareCallSubmission(session, payload, () => 'call-key-0001');
  assert.equal(first.reused, false);
  assert.equal(session.outboundCallSubmission.outcomeUncertain, true);
  assert.equal(prepareCallSubmission(session, payload, () => 'unexpected-new-key').idempotencyKey, 'call-key-0001');
  assert.deepEqual(prepareCallSubmission(session, { ...payload, number: '+14155550124' }), {
    blocked: true,
    reason: 'previous_submission_uncertain',
  });
});

test('call submission keys clear on definite rejection and error outcomes are classified safely', () => {
  const session = {};
  const { idempotencyKey } = prepareCallSubmission(session, { number: '+14155550123' }, () => 'call-key-0002');
  assert.equal(isUncertainCallSubmissionError({ response: { status: 400 } }), false);
  assert.equal(isUncertainCallSubmissionError({ response: { status: 503 } }), true);
  assert.equal(isUncertainCallSubmissionError({ request: {} }), true);
  assert.equal(resolveCallSubmissionOutcome(session, idempotencyKey, false), true);
  assert.equal(session.outboundCallSubmission, undefined);
});

test('accepted call submissions remain replayable and persist across session reloads', async () => {
  const telegramId = '90000000000000000001';
  const session = {};
  const payload = { number: '+14155550123', script_id: 'script-accepted' };
  try {
    const { idempotencyKey } = prepareCallSubmission(session, payload, () => 'accepted-call-key-01');
    resolveCallSubmissionOutcome(session, idempotencyKey, false, {
      call_sid: 'call-accepted-01',
      status: 'queued',
      provider: 'twilio',
    });
    await botDb.saveOutboundCallSubmission(telegramId, session.outboundCallSubmission);

    const recovered = await botDb.getOutboundCallSubmission(telegramId);
    assert.equal(recovered.idempotencyKey, idempotencyKey);
    assert.equal(recovered.outcomeUncertain, false);
    assert.deepEqual(recovered.acceptedResult, {
      call_sid: 'call-accepted-01',
      status: 'queued',
      provider: 'twilio',
    });
    const nextSession = { outboundCallSubmission: recovered };
    assert.equal(prepareCallSubmission(nextSession, payload, () => 'new-call-key-02').idempotencyKey, idempotencyKey);
    assert.equal(prepareCallSubmission(nextSession, { ...payload, number: '+14155550124' }, () => 'new-call-key-02').idempotencyKey, 'new-call-key-02');
  } finally {
    await botDb.clearOutboundCallSubmission(telegramId, 'accepted-call-key-01');
  }
});

test('call preflight carries process-observed provider degradation separately from readiness', () => {
  const resolved = resolveCallProviderDefaults(providerStatus({
    providers: {
      call: {
        provider: 'twilio',
        readiness: { twilio: true },
      },
    },
    provider_health: {
      twilio: { degraded: true, circuit_state: 'open' },
    },
  }));
  assert.equal(resolved.providerReady, true);
  assert.deepEqual(resolved.providerHealth, { degraded: true, circuit_state: 'open' });
});

test('uncertain submissions point to the matching provider reconciliation flow', () => {
  assert.match(getReconciliationInstruction('vapi'), /\/vapi.*reconcile/i);
  assert.match(getReconciliationInstruction('cartesia'), /\/cartesia.*reconciliation/i);
  assert.match(getReconciliationInstruction('twilio'), /\/callmonitor.*provider/i);
});

test('Cartesia approval phrase binds dynamic script variables', () => {
  assert.equal(
    buildCartesiaConfirmationPhrase({
      number: '+14155550123', from_number_id: 'number_1', agent_id: 'agent_1',
      dynamic_variables: { name: 'Jordan' },
    }),
    'PLACE CARTESIA CALL TO +14155550123 FROM number_1 WITH AGENT agent_1 WITH VARIABLES 46581fa740e4',
  );
});
