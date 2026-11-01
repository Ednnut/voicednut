'use strict';

const DEFAULT_API_BASE_URL = 'https://api.cartesia.ai';

function normalizeCartesiaApiBaseUrl(value = DEFAULT_API_BASE_URL) {
  let parsed;
  try { parsed = new URL(String(value || DEFAULT_API_BASE_URL).trim()); }
  catch { throw Object.assign(new Error('Cartesia API base URL must be a valid HTTPS URL'), { code: 'cartesia_endpoint_invalid', status: 500 }); }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      !(hostname === 'cartesia.ai' || hostname.endsWith('.cartesia.ai'))) {
    throw Object.assign(new Error('Cartesia API base URL must be an HTTPS Cartesia-owned hostname without a path, port, credentials, or query'), { code: 'cartesia_endpoint_invalid', status: 500 });
  }
  return `https://${parsed.host}`;
}

function cartesiaWebSocketBaseUrl(apiBaseUrl = DEFAULT_API_BASE_URL) {
  const normalized = normalizeCartesiaApiBaseUrl(apiBaseUrl);
  return normalized.replace(/^https:/, 'wss:');
}

module.exports = { DEFAULT_API_BASE_URL, normalizeCartesiaApiBaseUrl, cartesiaWebSocketBaseUrl };
