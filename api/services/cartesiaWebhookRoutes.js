'use strict';

const {
  createCartesiaWebhookHandler: createLifecycleWebhookHandler,
  normalizeCartesiaWebhookEvent,
  safeCompareSecret,
} = require('./cartesiaWebhookService');

const EVENT_TYPES = new Set(['call_started', 'call_completed', 'call_failed', 'call_turn', 'post_call_analysis']);

function webhookError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

const safeEqual = safeCompareSecret;

function normalizeEvent(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !EVENT_TYPES.has(body.type)) {
    throw webhookError('cartesia_webhook_invalid', 'Cartesia webhook event is invalid', 400);
  }
  const event = normalizeCartesiaWebhookEvent(body);
  return {
    callId: event.providerCallId,
    agentId: String(body.agent_id || '').trim(),
    webhookId: String(body.webhook_id || '').trim(),
    requestId: event.eventId,
    timestamp: event.timestamp,
    type: event.type,
  };
}

function createCartesiaWebhookHandler(options = {}) {
  return createLifecycleWebhookHandler({
    db: options.db,
    webhookSecret: options.secret,
    enabled: options.enabled === true,
  });
}

function registerCartesiaWebhookRoutes(app, options = {}) {
  const limiter = typeof options.limiter === 'function' ? options.limiter : (_req, _res, next) => next();
  const handler = typeof options.handler === 'function'
    ? options.handler
    : createCartesiaWebhookHandler(options);
  app.post('/webhook/cartesia', limiter, handler);
}

module.exports = { EVENT_TYPES, createCartesiaWebhookHandler, normalizeEvent, registerCartesiaWebhookRoutes, safeEqual };
