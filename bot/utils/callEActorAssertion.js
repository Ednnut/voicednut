'use strict';

const crypto = require('node:crypto');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? 'null' : stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function requestPath(url, params = {}) {
  const parsed = new URL(url);
  const search = new URLSearchParams(parsed.search);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((entry) => { if (entry !== undefined && entry !== null) search.append(key, String(entry)); });
    else search.append(key, String(value));
  }
  const pairs = [...search.entries()].sort((left, right) =>
    left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : (left[0] < right[0] ? -1 : 1));
  return `${parsed.pathname}${pairs.length ? `?${stableStringify(pairs)}` : ''}`;
}

function createCallEActorAssertionHeaders({ actorId, method, url, params, body, secret, timestamp = Date.now() }) {
  const normalizedActorId = String(actorId || '').trim();
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const path = requestPath(url, params);
  const normalizedBody = ['GET', 'HEAD'].includes(normalizedMethod) || body === undefined || body === null
    ? ''
    : Buffer.isBuffer(body) ? `binary-sha256:${crypto.createHash('sha256').update(body).digest('hex')}`
      : typeof body === 'string' ? body : stableStringify(body);
  if (!/^\d{1,20}$/.test(normalizedActorId) || String(secret || '').length < 32) return {};
  const timestampText = String(timestamp);
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestampText}.${normalizedMethod}.${path}.${normalizedBody}.${normalizedActorId}`)
    .digest('hex');
  return {
    'x-call-e-actor': normalizedActorId,
    'x-call-e-actor-timestamp': timestampText,
    'x-call-e-actor-signature': signature,
  };
}

module.exports = { createCallEActorAssertionHeaders };
