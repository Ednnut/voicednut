'use strict';

const assert = require('node:assert/strict');
const { registerStatusRoutes } = require('../services/statusRoutes');

describe('provider recommendation API', () => {
  it('registers the read-only endpoint behind admin-token authorization', async () => {
    const routes = [];
    const requireAdminToken = () => {};
    let recommendationInput;
    registerStatusRoutes({ get: (path, ...handlers) => routes.push({ path, handlers }) }, {
      requireAdminToken,
      getProviderRecommendation: (input) => {
        recommendationInput = input;
        return { operation: input.operation, recommendation: { provider: 'twilio' } };
      },
    });

    const route = routes.find((item) => item.path === '/admin/provider/recommendation');
    assert.ok(route);
    assert.equal(route.handlers[0], requireAdminToken);

    let body;
    await route.handlers[1]({
      requestId: 'request-1',
      query: { operation: 'outbound_call.create', preferred_provider: 'twilio', required_capabilities: 'outbound_voice,voice_stream' },
    }, {
      json(value) { body = value; return value; },
      status(code) { this.statusCode = code; return this; },
    });

    assert.deepEqual(recommendationInput, {
      operation: 'outbound_call.create',
      preferredProvider: 'twilio',
      requiredCapabilities: ['outbound_voice', 'voice_stream'],
    });
    assert.equal(body.request_id, 'request-1');
    assert.equal(body.recommendation.provider, 'twilio');
  });

  it('bounds input and returns a consistent error envelope for unknown capabilities', async () => {
    const routes = [];
    registerStatusRoutes({ get: (path, ...handlers) => routes.push({ path, handlers }) }, {
      requireAdminToken: (_req, _res, next) => next(),
      getProviderRecommendation: () => { throw Object.assign(new Error('One or more requested capabilities are not registered'), { code: 'provider_capability_unknown' }); },
    });
    const handler = routes.find((item) => item.path === '/admin/provider/recommendation').handlers[1];
    let statusCode;
    let body;
    const res = {
      json(value) { body = value; return value; },
      status(code) { statusCode = code; return this; },
    };

    await handler({ requestId: 'request-2', query: { required_capabilities: 'made_up' } }, res);
    assert.equal(statusCode, 400);
    assert.equal(body.error.code, 'provider_capability_unknown');
    assert.equal(body.request_id, 'request-2');

    await handler({ query: { required_capabilities: Array(9).fill('outbound_voice') } }, res);
    assert.equal(statusCode, 400);
    assert.equal(body.error.code, 'provider_recommendation_input_invalid');
  });

  it('rejects operations whose readiness is not measured by the outbound configuration check', async () => {
    const routes = [];
    registerStatusRoutes({ get: (path, ...handlers) => routes.push({ path, handlers }) }, {
      requireAdminToken: (_req, _res, next) => next(),
      getProviderRecommendation: () => { throw Object.assign(new Error('Provider readiness is only defined for outbound call and task creation'), { code: 'provider_operation_not_recommendable' }); },
    });
    const handler = routes.find((item) => item.path === '/admin/provider/recommendation').handlers[1];
    let statusCode;
    let body;
    await handler({ requestId: 'request-3', query: { operation: 'call.read' } }, {
      json(value) { body = value; return value; },
      status(code) { statusCode = code; return this; },
    });

    assert.equal(statusCode, 400);
    assert.equal(body.error.code, 'provider_operation_not_recommendable');
    assert.equal(body.request_id, 'request-3');
  });
});
