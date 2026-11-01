'use strict';

const fetch = require('node-fetch');

const BASE_URL = 'https://api.cartesia.ai';
const API_VERSION = '2026-08-14';
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function providerError(code, message, status = null) {
  return Object.assign(new Error(message), { code, status: Number(status) || null });
}

function safeId(value) {
  const id = String(value || '').trim();
  if (!ID_PATTERN.test(id)) throw providerError('cartesia_provider_id_invalid', 'A valid Cartesia provider ID is required', 400);
  return encodeURIComponent(id);
}

class CartesiaSipProviderClient {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || '').trim();
    this.enabled = options.enabled === true;
    this.apiVersion = String(options.apiVersion || API_VERSION);
    this.apiBaseUrl = String(options.apiBaseUrl || BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 15000));
    this.fetch = options.fetch || fetch;
  }

  async request(method, path, body) {
    if (!this.enabled || !this.apiKey || this.apiVersion !== API_VERSION || typeof this.fetch !== 'function') {
      throw providerError('cartesia_provider_not_configured', 'Cartesia provider management is disabled or not configured', 503);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(`${this.apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Cartesia-Version': this.apiVersion,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (response.status === 204) return {};
      let payload;
      try { payload = await response.json(); }
      catch { throw providerError('cartesia_provider_response_invalid', 'Cartesia returned an invalid provider response', response.status); }
      if (!response.ok) throw providerError('cartesia_provider_request_failed', 'Cartesia rejected the provider operation', response.status);
      return payload;
    } catch (error) {
      if (String(error?.code || '').startsWith('cartesia_')) throw error;
      throw providerError(error?.name === 'AbortError' ? 'cartesia_provider_timeout' : 'cartesia_provider_transport_error', 'Cartesia provider management is temporarily unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  listProviders() { return this.request('GET', '/agents/phone-numbers/providers'); }
  createProvider(input) { return this.request('POST', '/agents/phone-numbers/providers', input); }
  updateProvider(id, input) { return this.request('PATCH', `/agents/phone-numbers/providers/${safeId(id)}`, input); }
  deleteProvider(id) { return this.request('DELETE', `/agents/phone-numbers/providers/${safeId(id)}`); }
}

module.exports = { CartesiaSipProviderClient, API_VERSION, providerError };
