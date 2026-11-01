'use strict';

const crypto = require('node:crypto');

const EVENT_TYPES = new Set(['call_started', 'call_completed', 'call_failed', 'call_turn', 'post_call_analysis']);
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function webhookError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeEvent(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !EVENT_TYPES.has(body.type)) {
    throw webhookError('cartesia_webhook_event_invalid', 'Cartesia webhook event is invalid', 400);
  }
  const callId = String(body.call_id || body.call?.id || '').trim();
  const agentId = String(body.agent_id || body.call?.agent_id || '').trim();
  const webhookId = String(body.webhook_id || '').trim();
  const requestId = String(body.webhook_request_id || '').trim();
  const timestamp = String(body.timestamp || '').trim();
  if (![callId, agentId, webhookId, requestId].every((value) => ID_PATTERN.test(value)) || !Number.isFinite(Date.parse(timestamp))) {
    throw webhookError('cartesia_webhook_event_invalid', 'Cartesia webhook event identifiers or timestamp are invalid', 400);
  }
  return { callId, agentId, webhookId, requestId, timestamp, type: body.type };
}

function createCartesiaWebhookHandler(options = {}) {
  return async (req, res) => {
    const expectedSecret = String(options.secret || '').trim();
    if (options.enabled !== true || expectedSecret.length < 32) {
      return res.status(503).json({ success: false, code: 'cartesia_webhook_not_configured' });
    }
    if (!safeEqual(req.headers?.['x-webhook-secret'], expectedSecret)) {
      return res.status(401).json({ success: false, code: 'cartesia_webhook_unauthorized' });
    }
    try {
      const event = normalizeEvent(req.body);
      if (typeof options.db?.recordCartesiaWebhookEvent !== 'function') {
        throw webhookError('cartesia_webhook_storage_unavailable', 'Cartesia webhook storage is unavailable', 503);
      }
      const raw = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body);
      const payloadHash = crypto.createHash('sha256').update(raw || '').digest('hex');
      const result = await options.db.recordCartesiaWebhookEvent({
        webhook_request_id: event.requestId, call_id: event.callId, agent_id: event.agentId,
        webhook_id: event.webhookId, event_type: event.type, event_timestamp: event.timestamp,
        payload_hash: payloadHash,
      });
      if (result?.conflict === true) return res.status(409).json({ success: false, code: 'cartesia_webhook_event_conflict' });
      return res.status(200).json({ success: true, received: true, duplicate: result?.duplicate === true });
    } catch (error) {
      const status = Number(error?.status) || 503;
      const code = String(error?.code || 'cartesia_webhook_processing_failed');
      console.warn('cartesia_webhook_rejected', { code, status });
      return res.status(status).json({ success: false, code });
    }
  };
}

function registerCartesiaWebhookRoutes(app, options = {}) {
  const limiter = typeof options.limiter === 'function' ? options.limiter : (_req, _res, next) => next();
  app.post('/webhook/cartesia', limiter, createCartesiaWebhookHandler(options));
}

module.exports = { EVENT_TYPES, createCartesiaWebhookHandler, normalizeEvent, registerCartesiaWebhookRoutes, safeEqual };
