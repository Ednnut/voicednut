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
      destination_phone_number: direction === 'inbound' ? to : null,
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
      callRecord: {
        status: callRecord.status,
        direction: callRecord.direction,
        phoneNumber: callRecord.phone_number,
        destinationPhoneNumber: callRecord.destination_phone_number,
        startTime: callRecord.start_time,
        endTime: callRecord.end_time,
        endReason: callRecord.end_reason,
        telephonyAccountType: callRecord.telephony_account_type,
      },
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

function getCommonCallStatusUpdate(callRecord) {
  if (!callRecord) return null;
  if (callRecord.status === 'started') {
    return {
      status: 'in-progress',
      notificationType: 'call_in_progress',
      additionalData: { started_at: callRecord.start_time || undefined },
    };
  }
  if (callRecord.status === 'completed') {
    const startTime = Date.parse(callRecord.start_time || '');
    const endTime = Date.parse(callRecord.end_time || '');
    return {
      status: 'completed',
      notificationType: 'call_completed',
      additionalData: {
        started_at: callRecord.start_time || undefined,
        ended_at: callRecord.end_time || undefined,
        duration: Number.isFinite(startTime) && Number.isFinite(endTime)
          ? Math.max(0, Math.floor((endTime - startTime) / 1000))
          : undefined,
      },
    };
  }
  if (callRecord.status === 'failed') {
    return {
      status: 'failed',
      notificationType: 'call_failed',
      additionalData: {
        started_at: callRecord.start_time || undefined,
        ended_at: callRecord.end_time || undefined,
        error_code: 'cartesia_call_failed',
      },
    };
  }
  return null;
}

async function syncCommonOutboundCall(db, callRecord, businessScope) {
  const update = getCommonCallStatusUpdate(callRecord);
  if (!update || callRecord.direction !== 'outbound' ||
      typeof db?.getCall !== 'function' ||
      typeof db?.getLatestCallState !== 'function' ||
      typeof db?.updateCallStatus !== 'function' ||
      typeof db?.updateCallState !== 'function') {
    return;
  }
  const callId = callRecord.provider_call_id;
  const call = await db.getCall(callId);
  if (!call) return;
  const createdState = await db.getLatestCallState(callId, 'call_created');
  if (createdState?.provider !== 'cartesia' ||
      String(createdState.business_id || '') !== String(call.business_id || '') ||
      (businessScope?.business_id && String(businessScope.business_id) !== String(call.business_id || ''))) {
    return;
  }

  await db.updateCallStatus(callId, update.status, update.additionalData);
  await db.updateCallState(callId, `cartesia_${callRecord.status}`, {
    provider: 'cartesia',
    provider_call_id: callId,
    provider_status: callRecord.status,
    end_reason: callRecord.end_reason || null,
    event_timestamp: callRecord.event_timestamp,
  });
  const latestCall = await db.getCall(callId);
  if (String(latestCall?.status || '').toLowerCase().replace(/_/g, '-') !== update.status) return;

  const chatId = String(call.user_chat_id || '').trim();
  if (!chatId) return;
  if (typeof db.createEnhancedWebhookNotificationOnce === 'function') {
    await db.createEnhancedWebhookNotificationOnce(callId, update.notificationType, chatId);
  } else if (typeof db.createEnhancedWebhookNotification === 'function') {
    await db.createEnhancedWebhookNotification(callId, update.notificationType, chatId);
  }
}

function createCartesiaWebhookHandler(options = {}) {
  return async (req, res) => {
    const expectedSecret = String(options.webhookSecret || '').trim();
    if (options.enabled === false || !expectedSecret) {
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
      if (event.callRecord) {
        let scope = null;
        let businessScopeResolved = false;
        if (event.callRecord.direction === 'inbound') {
          if (typeof db.resolveCartesiaInboundCallScope === 'function') {
            scope = await db.resolveCartesiaInboundCallScope({
              agent_id: event.callRecord.agent_id,
              phone_number: event.callRecord.destination_phone_number,
              call_start_time: event.callRecord.start_time,
            });
          }
          businessScopeResolved = Boolean(scope?.business_id && scope?.phone_number_id);
        } else if (event.callRecord.direction === 'outbound' && typeof db.getCartesiaCallBusinessScope === 'function') {
          const businessId = await db.getCartesiaCallBusinessScope(event.callRecord.provider_call_id);
          if (businessId) {
            scope = { business_id: businessId };
            businessScopeResolved = true;
          }
        }
        await db.upsertCartesiaCallRecord({
          ...event.callRecord,
          business_id: scope?.business_id || null,
          from_number_id: scope?.phone_number_id || null,
          business_scope_resolved: businessScopeResolved,
        });
        await syncCommonOutboundCall(db, {
          ...event.callRecord,
          event_timestamp: event.timestamp,
        }, scope);
      }
      return res.status(204).end();
    } catch {
      return res.status(503).json({ success: false, code: 'cartesia_webhook_processing_failed' });
    }
  };
}

module.exports = {
  CALL_EVENT_STATUS,
  createCartesiaWebhookHandler,
  getCommonCallStatusUpdate,
  normalizeCartesiaWebhookEvent,
  safeCompareSecret,
};
