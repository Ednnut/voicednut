'use strict';

const crypto = require('node:crypto');

const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? 'null' : stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizeBody(req) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return '';
  if (Buffer.isBuffer(req?.body)) return `binary-sha256:${crypto.createHash('sha256').update(req.body).digest('hex')}`;
  const contentLength = Number(req?.headers?.['content-length'] || 0);
  const hasBody = Number.isFinite(contentLength) && contentLength > 0;
  if (!req?.body || Object.keys(req.body).length === 0) return hasBody ? stableStringify(req.body || {}) : '';
  return stableStringify(req.body);
}

function canonicalTarget(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '/'), 'http://localhost'); }
  catch (_) { return ''; }
  const pairs = [...parsed.searchParams.entries()].sort((left, right) =>
    left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : (left[0] < right[0] ? -1 : 1));
  return `${parsed.pathname}${pairs.length ? `?${stableStringify(pairs)}` : ''}`;
}

function signedPayload({ timestamp, actorId, method, path, body }) {
  return `${timestamp}.${String(method || 'GET').toUpperCase()}.${path}.${body}.${actorId}`;
}

function safeEqualHex(expected, provided) {
  if (!/^[a-f0-9]{64}$/i.test(String(provided || ''))) return false;
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(String(provided), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyCallEActorAssertion(req, options = {}) {
  const secret = String(options.secret || '');
  if (secret.length < 32) return { ok: false, status: 503, code: 'call_e_actor_assertion_unavailable' };
  const actorId = String(req?.headers?.['x-call-e-actor'] || '').trim();
  const timestamp = String(req?.headers?.['x-call-e-actor-timestamp'] || '').trim();
  const signature = String(req?.headers?.['x-call-e-actor-signature'] || '').trim();
  const suppliedActorId = String(req?.method === 'GET' || req?.method === 'HEAD'
    ? req?.query?.actor_id
    : (req?.body?.actor_id || req?.body?.user_chat_id || req?.query?.actor_id)).trim();
  if (!ACTOR_ID_PATTERN.test(actorId) || suppliedActorId !== actorId || !/^\d{13}$/.test(timestamp)) {
    return { ok: false, status: 401, code: 'call_e_actor_assertion_invalid' };
  }
  const timestampMs = Number(timestamp);
  const maxClockSkewMs = Math.min(MAX_CLOCK_SKEW_MS, Math.max(1000, Number(options.maxClockSkewMs) || MAX_CLOCK_SKEW_MS));
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > maxClockSkewMs) {
    return { ok: false, status: 401, code: 'call_e_actor_assertion_expired' };
  }
  const path = canonicalTarget(req?.originalUrl || req?.url || '/');
  const body = normalizeBody(req);
  const expected = crypto.createHmac('sha256', secret)
    .update(signedPayload({ timestamp, actorId, method: req?.method, path, body }))
    .digest('hex');
  if (!safeEqualHex(expected, signature)) return { ok: false, status: 401, code: 'call_e_actor_assertion_invalid' };
  return { ok: true, actorId };
}

function createCallEActorAssertionMiddleware(options = {}) {
  return function requireCallEActorAssertion(req, res, next) {
    const result = verifyCallEActorAssertion(req, options);
    if (!result.ok) {
      const message = result.status === 503
        ? 'CALL-E actor assertion is not configured'
        : 'A verified Telegram actor assertion is required';
      return res.status(result.status).json({ success: false, error: result.code, message, request_id: req.requestId || null });
    }
    req.callEActorId = result.actorId;
    return next();
  };
}

module.exports = { createCallEActorAssertionMiddleware, verifyCallEActorAssertion };
