'use strict';

const assert = require('node:assert/strict');
const { CartesiaSipProviderClient, API_VERSION } = require('../services/cartesiaSipProviderClient');
const { CartesiaSipProviderService, normalizeProviderInput } = require('../services/cartesiaSipProviderService');
const { registerCartesiaSipProviderRoutes } = require('../services/cartesiaSipProviderRoutes');

describe('Cartesia SIP/provider management', () => {
  it('uses the documented provider endpoints and keeps credentials in the request only', async () => {
    const calls = [];
    const secret = 'test-secret-never-returned';
    const client = new CartesiaSipProviderClient({
      apiKey: 'mock-api-key', enabled: true,
      fetch: async (url, options) => {
        calls.push({ url, options });
        return { status: 200, ok: true, json: async () => ({ id: 'provider_1', type: 'sip_trunk', label: 'Primary trunk', inbound: { credentials: { password: secret } } }) };
      },
    });
    const service = new CartesiaSipProviderService({ client });
    const created = await service.createProvider({
      type: 'sip_trunk', label: 'Primary trunk',
      inbound: { credentials: { username: 'inbound', password: secret } },
      outbound: { address: 'sip.carrier.example', transport: 'tls', media_encryption: 'required' },
    });
    assert.equal(calls[0].url, 'https://api.cartesia.ai/agents/phone-numbers/providers');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Cartesia-Version'], API_VERSION);
    assert.equal(JSON.parse(calls[0].options.body).inbound.credentials.password, secret);
    assert.equal(JSON.stringify(created).includes(secret), false);
    assert.deepEqual(created.provider, { id: 'provider_1', type: 'sip_trunk', label: 'Primary trunk', region: null, phone_number_count: 0 });
  });

  it('requires an inbound SIP access control mechanism and rejects unsupported fields', () => {
    assert.throws(() => normalizeProviderInput({ type: 'sip_trunk', label: 'Carrier', inbound: { media_encryption: 'allowed' } }), (error) => error.code === 'cartesia_provider_inbound_access_control_required');
    assert.throws(() => normalizeProviderInput({ type: 'sip_trunk', label: 'Carrier', inbound: { allowed_addresses: ['10.0.0.1'] }, extra: true }), /unsupported/);
  });

  it('uses Twilio-only documented provider updates, and safe summaries omit secrets', async () => {
    const calls = [];
    const client = new CartesiaSipProviderClient({ apiKey: 'mock', enabled: true, fetch: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, ok: true, json: async () => ({ id: 'provider_2', type: 'twilio', label: 'PBX', api_key_secret: 'provider-secret' }) };
    } });
    const service = new CartesiaSipProviderService({ client });
    const result = await service.updateProvider('provider_2', { api_key_secret: 'new-secret' });
    assert.equal(calls[0].options.method, 'PATCH');
    assert.equal(calls[0].url, 'https://api.cartesia.ai/agents/phone-numbers/providers/provider_2');
    assert.deepEqual(JSON.parse(calls[0].options.body), { type: 'twilio', api_key_secret: 'new-secret' });
    assert.equal(JSON.stringify(result).includes('provider-secret'), false);
    await assert.rejects(() => service.updateProvider('provider_2', { label: 'New label' }), /unsupported/);
  });

  it('requires middleware, administrator identity, and exact phrase before provider mutations', async () => {
    const routes = new Map();
    const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map((verb) => [verb, (path, ...handlers) => routes.set(`${verb.toUpperCase()} ${path}`, handlers)]));
    const limiter = () => {};
    const authorize = () => {};
    const actor = () => {};
    let writes = 0;
    const service = {
      async listProviders() { return { providers: [] }; },
      async createProvider() { writes += 1; return { provider: { id: 'provider_1' } }; },
      async updateProvider() { writes += 1; return { provider: { id: 'provider_1' } }; },
      async deleteProvider() { writes += 1; return { deleted: true }; },
    };
    registerCartesiaSipProviderRoutes(app, {
      cartesiaApprovalLimiter: limiter, requireOutboundAuthorization: authorize, requireCallEActorAssertion: actor,
      async isCartesiaAdminActor(id) { return id === '42'; },
      createCartesiaSipProviderService() { return service; },
      sendApiError(res, status, code, error) { return res.status(status).json({ success: false, code, error }); },
    });
    const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
    const postHandlers = routes.get('POST /api/cartesia/providers');
    assert.deepEqual(postHandlers.slice(0, 3), [limiter, authorize, actor]);
    const deniedAdmin = response();
    await postHandlers.at(-1)({ callEActorId: '41', body: { type: 'sip_trunk', label: 'Primary', confirmation_phrase: 'CREATE CARTESIA SIP_TRUNK PROVIDER PRIMARY' } }, deniedAdmin);
    assert.equal(deniedAdmin.statusCode, 403);
    const missingPhrase = response();
    await postHandlers.at(-1)({ callEActorId: '42', body: { type: 'sip_trunk', label: 'Primary', inbound: { credentials: { username: 'u', password: 'secret' } } } }, missingPhrase);
    assert.equal(missingPhrase.statusCode, 400);
    assert.equal(writes, 0);
    const success = response();
    await postHandlers.at(-1)({ callEActorId: '42', body: { type: 'sip_trunk', label: 'Primary', confirmation_phrase: 'CREATE CARTESIA SIP_TRUNK PROVIDER PRIMARY' } }, success);
    assert.equal(success.statusCode, 201);
    assert.equal(writes, 1);
  });
});
