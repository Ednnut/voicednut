'use strict';

const assert = require('node:assert/strict');
const { cartesiaWebSocketBaseUrl, normalizeCartesiaApiBaseUrl } = require('../services/cartesiaEndpoints');

describe('Cartesia endpoint configuration', () => {
  it('normalizes the default and provisioned regional Cartesia hosts for HTTP and WebSocket clients', () => {
    assert.equal(normalizeCartesiaApiBaseUrl(), 'https://api.cartesia.ai');
    assert.equal(normalizeCartesiaApiBaseUrl('https://api.eu.cartesia.ai/'), 'https://api.eu.cartesia.ai');
    assert.equal(cartesiaWebSocketBaseUrl('https://api.eu.cartesia.ai'), 'wss://api.eu.cartesia.ai');
  });

  it('rejects non-HTTPS, non-Cartesia, credential-bearing, and path-based endpoints', () => {
    for (const endpoint of [
      'http://api.cartesia.ai', 'https://api.attacker.example', 'https://user:pass@api.cartesia.ai',
      'https://api.cartesia.ai/v1', 'https://api.cartesia.ai:8443',
    ]) assert.throws(() => normalizeCartesiaApiBaseUrl(endpoint), { code: 'cartesia_endpoint_invalid' });
  });
});
