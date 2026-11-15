'use strict';

const assert = require('node:assert/strict');
const { recommendVoiceProvider } = require('../services/callRoutingPolicy');

const descriptors = [
  {
    provider: 'twilio',
    capabilities: ['outbound_voice', 'voice_stream'],
    operations: { 'outbound_call.create': true },
  },
  {
    provider: 'plivo',
    capabilities: ['outbound_voice'],
    operations: { 'outbound_call.create': true },
  },
  {
    provider: 'call_e',
    capabilities: ['outbound_task'],
    operations: { 'outbound_task.create': true },
  },
];

const baseOptions = {
  descriptors,
  readiness: { twilio: true, plivo: true, call_e: true },
  configuredOrder: ['plivo', 'twilio', 'call_e'],
  health: {
    twilio: { circuit_state: 'closed', observation_scope: 'api_process_memory' },
    plivo: { circuit_state: 'closed', observation_scope: 'api_process_memory' },
    call_e: { circuit_state: 'closed', observation_scope: 'api_process_memory' },
  },
};

describe('capability-based voice provider recommendations', () => {
  it('ranks only configured providers that implement the requested operation and capabilities', () => {
    const result = recommendVoiceProvider({
      ...baseOptions,
      operation: 'outbound_call.create',
      requiredCapabilities: ['voice_stream'],
    });

    assert.equal(result.recommendation.provider, 'twilio');
    assert.equal(result.recommendation.reason, 'configured_order');
    assert.deepEqual(result.alternatives, []);
    assert.equal(result.providers.find((provider) => provider.provider === 'plivo').eligible, false);
    assert.deepEqual(result.providers.find((provider) => provider.provider === 'plivo').unsupported_capabilities, ['voice_stream']);
    assert.equal(result.providers.find((provider) => provider.provider === 'twilio').operational_state, 'unverified');
    assert.equal(result.providers.find((provider) => provider.provider === 'twilio').reasons.includes('provider_health_not_verified'), true);
  });

  it('honors an explicit provider and does not silently recommend a fallback when it is ineligible', () => {
    const result = recommendVoiceProvider({
      ...baseOptions,
      operation: 'outbound_call.create',
      preferredProvider: 'twilio',
      readiness: { twilio: false, plivo: true, call_e: true },
    });

    assert.equal(result.recommendation.provider, null);
    assert.equal(result.recommendation.reason, 'explicit_preference_ineligible');
    assert.deepEqual(result.alternatives.map((provider) => provider.provider), ['plivo']);
    assert.equal(result.providers.find((provider) => provider.provider === 'twilio').blockers.includes('provider_not_configured'), true);
  });

  it('excludes open circuits and does not claim closed circuits prove live availability', () => {
    const result = recommendVoiceProvider({
      ...baseOptions,
      operation: 'outbound_call.create',
      health: {
        ...baseOptions.health,
        plivo: { circuit_state: 'open', degraded: true, observation_scope: 'api_process_memory' },
      },
    });

    assert.equal(result.recommendation.provider, 'twilio');
    assert.equal(result.providers.find((provider) => provider.provider === 'plivo').operational_state, 'temporarily_unavailable');
    assert.equal(result.providers.find((provider) => provider.provider === 'twilio').operational_state, 'unverified');
  });

  it('rejects unknown operations and capabilities instead of guessing', () => {
    assert.throws(
      () => recommendVoiceProvider({ ...baseOptions, operation: 'outbound_call.whatever' }),
      { code: 'provider_operation_unknown' },
    );
    assert.throws(
      () => recommendVoiceProvider({ ...baseOptions, operation: 'call.read' }),
      { code: 'provider_operation_not_recommendable' },
    );
    assert.throws(
      () => recommendVoiceProvider({ ...baseOptions, requiredCapabilities: ['unknown_feature'] }),
      { code: 'provider_capability_unknown' },
    );
  });
});
