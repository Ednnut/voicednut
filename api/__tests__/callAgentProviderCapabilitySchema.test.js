const assert = require('node:assert/strict');
const {
  CALL_AGENT_PROVIDER_CAPABILITY_SCHEMA_VERSION,
  buildCallAgentProviderCapabilitySchema,
  validateCallAgentProviderCapabilitySchema,
} = require('../services/callAgentDefinition');

describe('call agent provider capability schema', () => {
  it('builds a versioned capability catalog from the current call provider registry', () => {
    const schema = buildCallAgentProviderCapabilitySchema({
      vonageDtmfWebhookEnabled: false,
    });

    assert.equal(schema.schema_version, CALL_AGENT_PROVIDER_CAPABILITY_SCHEMA_VERSION);
    assert.equal(schema.channel, 'call');
    assert.deepEqual(schema.providers.map(({ provider }) => provider), [
      'twilio', 'vonage', 'plivo', 'call_e',
    ]);
    assert.deepEqual(schema.providers.find(({ provider }) => provider === 'twilio').flows, [
      'outbound_voice', 'inbound_voice', 'status_webhooks', 'voice_stream',
      'digit_capture', 'payment_native',
    ]);
    assert.deepEqual(schema.providers.find(({ provider }) => provider === 'call_e').flows, [
      'outbound_task',
    ]);
    assert.equal(schema.providers.find(({ provider }) => provider === 'vonage').flows.includes('digit_capture'), false);
    assert.equal(validateCallAgentProviderCapabilitySchema(schema).valid, true);
  });

  it('includes Vonage DTMF capture only when its existing configuration gate is enabled', () => {
    const schema = buildCallAgentProviderCapabilitySchema({
      vonageDtmfWebhookEnabled: true,
    });
    const vonage = schema.providers.find(({ provider }) => provider === 'vonage');

    assert.equal(vonage.flows.includes('digit_capture'), true);
    assert.equal(validateCallAgentProviderCapabilitySchema(schema).valid, false);
    assert.equal(validateCallAgentProviderCapabilitySchema(schema, {
      vonageDtmfWebhookEnabled: true,
    }).valid, true);
  });

  it('rejects unknown providers, flows, duplicate entries, and malformed schemas', () => {
    const invalid = {
      schema_version: CALL_AGENT_PROVIDER_CAPABILITY_SCHEMA_VERSION,
      channel: 'call',
      model: 'unsupported-by-this-schema',
      providers: [
        { provider: 'unknown', flows: ['outbound_voice'] },
        { provider: 'call_e', flows: ['voice_stream', 'voice_stream'] },
        { provider: 'twilio', flows: ['OUTBOUND_VOICE'] },
      ],
    };

    const result = validateCallAgentProviderCapabilitySchema(invalid);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('provider')));
    assert.ok(result.errors.some((error) => error.includes('flow')));
  });
});
