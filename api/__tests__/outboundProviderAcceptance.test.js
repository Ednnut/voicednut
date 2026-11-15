'use strict';

const assert = require('node:assert/strict');
const { __testables } = require('../services/callRoutes');

describe('offline outbound provider acceptance matrix', () => {
  const directProviders = ['twilio', 'plivo', 'vonage'];

  for (const provider of directProviders) {
    it(`accepts a ${provider} call through the shared outbound contract`, async () => {
      let response;
      let dispatched;
      const handler = __testables.createOutboundCallHandler({
        resolveHost: () => 'api.example.test',
        config: { server: { hostname: 'api.example.test' } },
        placeOutboundCall: async (payload) => {
          dispatched = payload;
          return { callId: `${provider}_local_1`, callStatus: 'queued', provider, functionSystem: { context: {}, functions: [] } };
        },
        sendApiError: (_res, status, code) => ({ status, code }),
      });
      await handler({ body: { provider, number: '+14155550123', script_id: 1, prompt: 'Test prompt', first_message: 'Hello', user_chat_id: '7001' }, headers: {}, callEActorId: '7001' }, {
        json(value) { response = value; return value; },
      });
      assert.equal(dispatched.preferred_provider, provider);
      assert.equal(response.success, true);
      assert.equal(response.provider, provider);
      assert.equal(response.status, 'queued');
    });
  }

  it('accepts a Vapi call and forwards the validated assistant overrides', async () => {
    let response;
    let dispatched;
    const handler = __testables.createOutboundCallHandler({
      placeVapiOutboundCall: async (input) => { dispatched = input; return { providerCallId: 'vapi_call_1', status: 'queued' }; },
      sendApiError: (_res, status, code) => ({ status, code }),
    });
    await handler({ body: {
      provider: 'vapi', number: '+14155550123', script_id: 5, script_version: 2,
      mapping_id: 7, phone_number_id: 'phone_1', idempotency_key: 'vapi-acceptance-001',
      first_message_override: 'Hello Jordan', variable_values: { name: 'Jordan' },
    }, headers: {}, callEActorId: '7001' }, { json(value) { response = value; return value; } });
    assert.equal(dispatched.firstMessage, 'Hello Jordan');
    assert.deepEqual(dispatched.variableValues, { name: 'Jordan' });
    assert.equal(response.provider, 'vapi');
    assert.equal(response.status, 'queued');
  });

  it('accepts a Cartesia call with approved dynamic variables', async () => {
    let response;
    let dispatched;
    const handler = __testables.createOutboundCallHandler({
      placeCartesiaOutboundCall: async (input) => { dispatched = input; return { providerCallId: 'cartesia_call_1', status: 'created' }; },
      sendApiError: (_res, status, code) => ({ status, code }),
    });
    await handler({ body: {
      provider: 'cartesia', number: '+14155550123', business_id: 'business_1', agent_id: 'agent_1',
      from_number_id: 'number_1', idempotency_key: 'cartesia-acceptance-001', approval_token: 'offline-token',
      dynamic_variables: { name: 'Jordan' },
    }, headers: {}, callEActorId: '7001' }, { json(value) { response = value; return value; } });
    assert.deepEqual(dispatched.dynamic_variables, { name: 'Jordan' });
    assert.equal(response.provider, 'cartesia');
    assert.equal(response.status, 'created');
  });
});
