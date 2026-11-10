const crypto = require('node:crypto');

const EVENT_TYPES = new Set([
  'call_started',
  'call_completed',
  'call_failed',
  'call_turn',
  'post_call_analysis',
]);
const CALL_EVENT_STATUS = Object.freeze({
  call_started: 'started',
  call_completed: 'completed',
  call_failed: 'failed',
});

function webhookError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function safeCompareSecret(provided, expected) {
  const providedBuffer = Buffer.from(String(provided || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  if (!providedBuffer.length || providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function normalizeTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeProviderText(value, maxLength = 100) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function normalizeCartesiaWebhookEvent(body) {
  const type = String(body?.type || '').trim();
  const eventId = String(body?.webhook_request_id || '').trim();
  const providerCallId = String(body?.call_id || '').trim();
  const agentId = String(body?.agent_id || '').trim();
  const webhookId = String(body?.webhook_id || '').trim();
  const timestamp = normalizeTimestamp(body?.timestamp);
  if (!EVENT_TYPES.has(type) || !/^[A-Za-z0-9_-]{1,200}$/.test(eventId) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(providerCallId) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(agentId) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(webhookId) || !timestamp) {
    throw webhookError('cartesia_webhook_invalid', 'Cartesia webhook envelope is invalid', 400);
  }

  let callRecord = null;
  if (Object.hasOwn(CALL_EVENT_STATUS, type)) {
    const call = body.call;
    if (!call || typeof call !== 'object' || Array.isArray(call) ||
        String(call.id || '') !== providerCallId || String(call.agent_id || '') !== agentId ||
        String(call.status || '').toLowerCase() !== CALL_EVENT_STATUS[type]) {
      throw webhookError('cartesia_webhook_invalid', 'Cartesia webhook call data is invalid', 400);
    }
    const telephony = call.telephony_params && typeof call.telephony_params === 'object' && !Array.isArray(call.telephony_params)
      ? call.telephony_params
      : {};
    const direction = ['inbound', 'outbound'].includes(String(telephony.direction || '').toLowerCase())
      ? String(telephony.direction).toLowerCase()
      : null;
    const from = safeProviderText(telephony.from, 64);
    const to = safeProviderText(telephony.to, 64);
    const accountType = ['cartesia', 'twilio', 'sip_trunk'].includes(String(call.telephony_account_type || '').toLowerCase())
      ? String(call.telephony_account_type).toLowerCase()
      : null;
    const startTime = call.start_time == null ? null : normalizeTimestamp(call.start_time);
    const endTime = call.end_time == null ? null : normalizeTimestamp(call.end_time);
    if ((call.start_time != null && !startTime) || (call.end_time != null && !endTime)) {
      throw webhookError('cartesia_webhook_invalid', 'Cartesia webhook timestamps are invalid', 400);
    }
    callRecord = Object.freeze({
      local_call_id: `cartesia_${providerCallId}`,
      provider_call_id: providerCallId,
      agent_id: agentId,
      phone_number: direction === 'inbound' ? from : direction === 'outbound' ? to : (to || from),
      direction,
      status: CALL_EVENT_STATUS[type],
      start_time: startTime,
      end_time: endTime,
      end_reason: safeProviderText(call.end_reason, 100),
      telephony_account_type: accountType,
      event_timestamp: timestamp,
    });
  } else {
    const eventPayloadKey = type === 'call_turn' ? 'turn' : 'analysis';
    if (!body[eventPayloadKey] || typeof body[eventPayloadKey] !== 'object' || Array.isArray(body[eventPayloadKey])) {
      throw webhookError('cartesia_webhook_invalid', 'Cartesia webhook event data is invalid', 400);
    }
  }

  const payloadFingerprint = {
    eventId,
    type,
    providerCallId,
    agentId,
    webhookId,
    timestamp,
    ...(callRecord ? {
      status: callRecord.status,
      direction: callRecord.direction,
      from: safeProviderText(body.call?.telephony_params?.from, 64),
      to: safeProviderText(body.call?.telephony_params?.to, 64),
      endTime: callRecord.end_time,
    } : {}),
  };
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payloadFingerprint)).digest('hex');
  return Object.freeze({
    eventId,
    type,
    providerCallId,
    timestamp,
    payloadHash,
    callRecord,
  });
}

function createCartesiaWebhookHandler(options = {}) {
  return async (req, res) => {
    const expectedSecret = String(options.webhookSecret || '').trim();
    if (!expectedSecret) {
      return res.status(503).json({ success: false, code: 'cartesia_webhook_not_configured' });
    }
    if (!safeCompareSecret(req.headers?.['x-webhook-secret'], expectedSecret)) {
      return res.status(401).json({ success: false, code: 'cartesia_webhook_unauthorized' });
    }

    let event;
    try {
      event = normalizeCartesiaWebhookEvent(req.body);
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, code: 'cartesia_webhook_invalid' });
    }
    const db = options.db;
    if (typeof db?.recordCartesiaWebhookReceipt !== 'function' ||
        (event.callRecord && typeof db?.upsertCartesiaCallRecord !== 'function')) {
      return res.status(503).json({ success: false, code: 'cartesia_webhook_storage_unavailable' });
    }
    try {
      const receipt = await db.recordCartesiaWebhookReceipt({
        webhook_request_id: event.eventId,
        provider_call_id: event.providerCallId,
        event_type: event.type,
        event_timestamp: event.timestamp,
        payload_hash: event.payloadHash,
      });
      if (receipt?.conflict) {
        return res.status(409).json({ success: false, code: 'cartesia_webhook_event_conflict' });
      }
      // Reapply idempotently on duplicate delivery so a prior partial DB failure
      // cannot permanently lose a call state update.
      if (event.callRecord) await db.upsertCartesiaCallRecord(event.callRecord);
      return res.status(204).end();
    } catch {
      return res.status(503).json({ success: false, code: 'cartesia_webhook_processing_failed' });
    }
  };
}

module.exports = {
  CALL_EVENT_STATUS,
  createCartesiaWebhookHandler,
  normalizeCartesiaWebhookEvent,
  safeCompareSecret,
};
