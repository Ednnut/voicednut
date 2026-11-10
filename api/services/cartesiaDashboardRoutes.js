'use strict';

const { VOICE_PROVIDER_CAPABILITY_REGISTRY } = require('../adapters/voiceProviderCapabilityRegistry');

const CARTESIA_BUSINESS_CALL_ROLES = new Set(['policy_manager', 'call_operator']);

function safeCode(value) {
  const code = String(value || '').trim();
  return /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'cartesia_read_failed';
}

function maskPhoneNumber(value) {
  const phone = String(value || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return null;
  return `+${'•'.repeat(Math.max(0, phone.length - 5))}${phone.slice(-4)}`;
}

function normalizeCallRecord(record = {}) {
  return {
    localCallId: String(record.local_call_id || '').slice(0, 220),
    providerCallId: String(record.provider_call_id || '').slice(0, 200),
    agentId: String(record.agent_id || '').slice(0, 200),
    fromNumberId: record.from_number_id ? String(record.from_number_id).slice(0, 200) : null,
    phoneNumberMasked: maskPhoneNumber(record.phone_number),
    direction: ['inbound', 'outbound'].includes(String(record.direction || '').toLowerCase())
      ? String(record.direction).toLowerCase()
      : 'unknown',
    status: ['created', 'started', 'completed', 'failed'].includes(String(record.status || '').toLowerCase())
      ? String(record.status).toLowerCase()
      : 'unknown',
    startTime: record.start_time || null,
    endTime: record.end_time || null,
    endReason: record.end_reason ? String(record.end_reason).slice(0, 100) : null,
    telephonyAccountType: ['cartesia', 'twilio', 'sip_trunk'].includes(String(record.telephony_account_type || '').toLowerCase())
      ? String(record.telephony_account_type).toLowerCase()
      : null,
    createdAt: record.created_at || null,
    updatedAt: record.updated_at || null,
  };
}

function normalizeInventoryItem(item = {}) {
  return {
    id: String(item.id || '').slice(0, 200),
    label: item.label ? String(item.label).slice(0, 200) : null,
    number: /^\+[1-9]\d{7,14}$/.test(String(item.number || '')) ? item.number : null,
    ownership: ['cartesia_owned', 'twilio_imported', 'external_sip'].includes(item.ownership)
      ? item.ownership
      : 'unknown',
    agent: item.agent && typeof item.agent === 'object'
      ? { id: String(item.agent.id || '').slice(0, 200), name: item.agent.name ? String(item.agent.name).slice(0, 200) : null }
      : null,
    provider: item.provider && typeof item.provider === 'object'
      ? {
        id: item.provider.id ? String(item.provider.id).slice(0, 200) : null,
        type: String(item.provider.type || '').slice(0, 40),
        label: item.provider.label ? String(item.provider.label).slice(0, 200) : null,
      }
      : null,
  };
}

function normalizeTelephonyProvider(item = {}) {
  return {
    id: String(item.id || '').slice(0, 200),
    type: ['twilio', 'sip_trunk'].includes(String(item.type || '').toLowerCase()) ? item.type : 'unknown',
    label: item.label ? String(item.label).slice(0, 200) : null,
    region: item.region ? String(item.region).slice(0, 40) : null,
    inboundConfigured: typeof item.inboundConfigured === 'boolean' ? item.inboundConfigured : null,
    outboundConfigured: typeof item.outboundConfigured === 'boolean' ? item.outboundConfigured : null,
  };
}

function normalizeCallReviewAudit(record = {}) {
  return {
    id: Number(record.id) || null,
    actorTelegramId: String(record.actor_telegram_id || '').slice(0, 20),
    businessId: record.business_id ? String(record.business_id).slice(0, 120) : null,
    providerCallId: String(record.provider_call_id || '').slice(0, 200),
    outcome: ['allowed', 'denied', 'failed'].includes(String(record.outcome || '').toLowerCase())
      ? String(record.outcome).toLowerCase()
      : 'unknown',
    reasonCode: /^[a-z][a-z0-9_]{0,79}$/.test(String(record.reason_code || '')) ? record.reason_code : null,
    createdAt: typeof record.created_at === 'string' ? record.created_at : null,
  };
}

function normalizeAdminActionAudit(record = {}) {
  return {
    id: Number(record.id) || null,
    actorTelegramId: String(record.actor_telegram_id || '').slice(0, 20),
    action: record.action === 'phone_agent_assignment' ? record.action : 'unknown',
    resourceType: record.resource_type === 'phone_number' ? record.resource_type : 'unknown',
    resourceId: String(record.resource_id || '').slice(0, 200),
    outcome: ['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(String(record.outcome || '').toLowerCase())
      ? String(record.outcome).toLowerCase()
      : 'unknown',
    previousAgentId: record.previous_agent_id ? String(record.previous_agent_id).slice(0, 200) : null,
    targetAgentId: record.target_agent_id ? String(record.target_agent_id).slice(0, 200) : null,
    reasonCode: /^[a-z][a-z0-9_]{0,79}$/.test(String(record.reason_code || '')) ? record.reason_code : null,
    createdAt: typeof record.created_at === 'string' ? record.created_at : null,
  };
}

function normalizePhoneNumberOperationAudit(record = {}) {
  return {
    id: Number(record.id) || null,
    actorType: ['admin_api', 'miniapp_user'].includes(String(record.actor_type || '').toLowerCase())
      ? String(record.actor_type).toLowerCase()
      : 'unknown',
    actorId: String(record.actor_id || '').slice(0, 100),
    action: ['phone_agent_assignment', 'phone_number_import', 'phone_number_provision', 'phone_number_release'].includes(record.action)
      ? record.action
      : 'unknown',
    resourceId: String(record.resource_id || '').slice(0, 220),
    outcome: ['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(String(record.outcome || '').toLowerCase())
      ? String(record.outcome).toLowerCase()
      : 'unknown',
    targetAgentId: record.target_agent_id ? String(record.target_agent_id).slice(0, 200) : null,
    reasonCode: /^[a-z][a-z0-9_]{0,79}$/.test(String(record.reason_code || '')) ? record.reason_code : null,
    createdAt: typeof record.created_at === 'string' ? record.created_at : null,
  };
}

function normalizeProviderOperationAudit(record = {}) {
  return {
    id: Number(record.id) || null,
    actorType: record.actor_type === 'admin_api' ? 'admin_api' : 'unknown',
    actorId: record.actor_id === 'shared_admin_token' ? 'shared_admin_token' : 'unknown',
    action: ['twilio_provider_create', 'twilio_provider_update', 'sip_provider_create', 'sip_provider_update', 'telephony_provider_delete', 'agent_webhook_assignment', 'webhook_create'].includes(record.action)
      ? record.action
      : 'unknown',
    resourceId: String(record.resource_id || '').slice(0, 220),
    outcome: ['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(String(record.outcome || '').toLowerCase())
      ? String(record.outcome).toLowerCase()
      : 'unknown',
    reasonCode: /^[a-z][a-z0-9_]{0,79}$/.test(String(record.reason_code || '')) ? record.reason_code : null,
    createdAt: typeof record.created_at === 'string' ? record.created_at : null,
  };
}

function normalizeCallOperationAudit(record = {}) {
  return {
    id: Number(record.id) || null,
    actorType: record.actor_type === 'admin_api' ? 'admin_api' : 'unknown',
    actorId: record.actor_id === 'shared_admin_token' ? 'shared_admin_token' : 'unknown',
    action: ['outbound_call_dispatch', 'outbound_call_cancel'].includes(record.action) ? record.action : 'unknown',
    resourceId: String(record.resource_id || '').slice(0, 220),
    outcome: ['requested', 'succeeded', 'failed', 'outcome_unknown'].includes(String(record.outcome || '').toLowerCase())
      ? String(record.outcome).toLowerCase()
      : 'unknown',
    reasonCode: /^[a-z][a-z0-9_]{0,79}$/.test(String(record.reason_code || '')) ? record.reason_code : null,
    createdAt: typeof record.created_at === 'string' ? record.created_at : null,
  };
}

async function recordCallReviewAudit(options, req, { providerCallId, businessId = null, outcome, reasonCode = null }) {
  if (typeof options.db?.recordCartesiaCallReviewAudit !== 'function') {
    throw new Error('Cartesia call-review audit storage is unavailable');
  }
  return options.db.recordCartesiaCallReviewAudit({
    actor_telegram_id: String(req.miniAppSession?.telegram_id || '').trim(),
    business_id: businessId,
    provider_call_id: providerCallId,
    outcome,
    reason_code: reasonCode,
  });
}

function normalizePrivateCallReview(call = {}) {
  const rawTurns = Array.isArray(call.transcript) ? call.transcript : [];
  const maxTurns = 200;
  const maxTurnLength = 2000;
  const maxTranscriptCharacters = 30000;
  let transcriptCharacters = 0;
  let transcriptTruncated = rawTurns.length > maxTurns;
  const transcript = [];
  for (const turn of rawTurns.slice(0, maxTurns)) {
    const text = typeof turn?.text === 'string' ? turn.text : '';
    const remaining = maxTranscriptCharacters - transcriptCharacters;
    if (remaining <= 0) {
      transcriptTruncated = true;
      break;
    }
    const boundedText = text.slice(0, Math.min(maxTurnLength, remaining));
    if (boundedText.length < text.length) transcriptTruncated = true;
    transcriptCharacters += boundedText.length;
    transcript.push({
      role: ['assistant', 'user'].includes(String(turn?.role || '').toLowerCase())
        ? String(turn.role).toLowerCase()
        : 'unknown',
      text: boundedText,
      startTimestamp: Number.isFinite(Number(turn?.startTimestamp)) ? Number(turn.startTimestamp) : null,
      endTimestamp: Number.isFinite(Number(turn?.endTimestamp)) ? Number(turn.endTimestamp) : null,
    });
  }

  const zdrEnabled = call.zdrEnabled === true;
  return {
    provider: 'cartesia',
    providerCallId: String(call.providerCallId || '').slice(0, 200),
    agentId: String(call.agentId || '').slice(0, 200),
    status: ['created', 'started', 'completed', 'failed'].includes(String(call.status || '').toLowerCase())
      ? String(call.status).toLowerCase()
      : 'unknown',
    startTime: typeof call.startTime === 'string' ? call.startTime : null,
    endTime: typeof call.endTime === 'string' ? call.endTime : null,
    direction: ['inbound', 'outbound'].includes(String(call.direction || '').toLowerCase())
      ? String(call.direction).toLowerCase()
      : null,
    fromNumberMasked: maskPhoneNumber(call.from),
    toNumberMasked: maskPhoneNumber(call.to),
    telephonyAccountType: ['cartesia', 'twilio', 'sip_trunk'].includes(String(call.telephonyAccountType || '').toLowerCase())
      ? String(call.telephonyAccountType).toLowerCase()
      : null,
    summary: zdrEnabled ? null : (typeof call.summary === 'string' ? call.summary.slice(0, 4000) : null),
    transcript: zdrEnabled ? [] : transcript,
    transcriptTruncated: !zdrEnabled && transcriptTruncated,
    zdrEnabled,
    endReason: typeof call.endReason === 'string' ? call.endReason.slice(0, 100) : null,
  };
}

function getCapabilitySummary() {
  const cartesia = VOICE_PROVIDER_CAPABILITY_REGISTRY.cartesia || {};
  return Object.entries(cartesia).flatMap(([layer, entry]) => (
    Object.entries(entry?.capabilities || {}).map(([name, capability]) => ({
      layer,
      name,
      providerContract: capability.providerContract,
      platform: capability.platform,
      note: capability.note || null,
    }))
  ));
}

function registerCartesiaDashboardRoutes(app, options = {}) {
  const requireMiniAppSession = options.requireMiniAppSession || ((_req, _res, next) => next());
  const requireMiniAppCapability = options.requireMiniAppCapability || (() => true);
  const limiter = options.limiter || ((_req, _res, next) => next());

  app.get('/miniapp/cartesia/overview', requireMiniAppSession, limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!requireMiniAppCapability(req, res, 'provider_manage')) return;
    const query = req.query || {};
    if (Object.keys(query).some((key) => !['limit', 'business_id'].includes(key))) {
      return res.status(400).json({ success: false, code: 'cartesia_overview_query_invalid', error: 'Unsupported Cartesia overview query fields' });
    }
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return res.status(400).json({ success: false, code: 'cartesia_overview_query_invalid', error: 'limit must be between 1 and 50' });
    }
    const businessId = query.business_id === undefined ? '' : query.business_id;
    if (typeof businessId !== 'string' || (businessId && !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId))) {
      return res.status(400).json({ success: false, code: 'cartesia_overview_query_invalid', error: 'business_id is invalid' });
    }

    const warnings = [];
    let calls = [];
    let phoneNumbers = [];
    let telephonyProviders = [];
    const isGlobalCallHistoryAdmin = Array.isArray(req.miniAppSession?.caps) &&
      req.miniAppSession.caps.includes('users_manage');
    let businessCallHistoryAvailable = false;
    if (businessId) {
      const telegramId = String(req.miniAppSession?.telegram_id || '').trim();
      try {
        if (!/^\d{1,20}$/.test(telegramId) ||
            typeof options.db?.getCallEBusinessOperator !== 'function' ||
            typeof options.db?.listCartesiaCallRecordsForBusiness !== 'function') {
          return res.status(503).json({ success: false, code: 'cartesia_business_history_unavailable', error: 'Business call history is unavailable' });
        }
        const membership = await options.db.getCallEBusinessOperator(businessId, telegramId);
        if (!CARTESIA_BUSINESS_CALL_ROLES.has(membership?.role)) {
          return res.status(403).json({ success: false, code: 'cartesia_business_access_denied', error: 'Business call-history access is denied' });
        }
        businessCallHistoryAvailable = true;
        calls = (await options.db.listCartesiaCallRecordsForBusiness(businessId, limit)).map(normalizeCallRecord);
      } catch {
        return res.status(503).json({ success: false, code: 'cartesia_business_history_unavailable', error: 'Business call history is unavailable' });
      }
    } else if (isGlobalCallHistoryAdmin) {
      try {
        if (typeof options.db?.listCartesiaCallRecords === 'function') {
          calls = (await options.db.listCartesiaCallRecords(limit)).map(normalizeCallRecord);
        }
      } catch (error) {
        warnings.push({ source: 'calls', code: safeCode(error?.code) });
      }
    }
    const callHistoryAvailable = businessId ? businessCallHistoryAvailable : isGlobalCallHistoryAdmin;
    const reviewAuditAvailable = isGlobalCallHistoryAdmin && !businessId && typeof options.db?.listCartesiaCallReviewAudit === 'function';
    let reviewAudit = [];
    if (reviewAuditAvailable) {
      try {
        reviewAudit = (await options.db.listCartesiaCallReviewAudit(25)).map(normalizeCallReviewAudit);
      } catch (error) {
        warnings.push({ source: 'review_audit', code: safeCode(error?.code) });
      }
    }
    const adminActionAuditAvailable = isGlobalCallHistoryAdmin && !businessId &&
      typeof options.db?.listCartesiaAdminActionAudit === 'function';
    let adminActionAudit = [];
    if (adminActionAuditAvailable) {
      try {
        adminActionAudit = (await options.db.listCartesiaAdminActionAudit(25)).map(normalizeAdminActionAudit);
      } catch (error) {
        warnings.push({ source: 'admin_action_audit', code: safeCode(error?.code) });
      }
    }
    const phoneNumberOperationAuditAvailable = isGlobalCallHistoryAdmin && !businessId &&
      typeof options.db?.listCartesiaPhoneNumberOperationAudit === 'function';
    let phoneNumberOperationAudit = [];
    if (phoneNumberOperationAuditAvailable) {
      try {
        phoneNumberOperationAudit = (await options.db.listCartesiaPhoneNumberOperationAudit(25)).map(normalizePhoneNumberOperationAudit);
      } catch (error) {
        warnings.push({ source: 'phone_number_operation_audit', code: safeCode(error?.code) });
      }
    }
    const providerOperationAuditAvailable = isGlobalCallHistoryAdmin && !businessId &&
      typeof options.db?.listCartesiaProviderOperationAudit === 'function';
    let providerOperationAudit = [];
    if (providerOperationAuditAvailable) {
      try {
        providerOperationAudit = (await options.db.listCartesiaProviderOperationAudit(25)).map(normalizeProviderOperationAudit);
      } catch (error) {
        warnings.push({ source: 'provider_operation_audit', code: safeCode(error?.code) });
      }
    }
    const callOperationAuditAvailable = isGlobalCallHistoryAdmin && !businessId &&
      typeof options.db?.listCartesiaCallOperationAudit === 'function';
    let callOperationAudit = [];
    if (callOperationAuditAvailable) {
      try {
        callOperationAudit = (await options.db.listCartesiaCallOperationAudit(25)).map(normalizeCallOperationAudit);
      } catch (error) {
        warnings.push({ source: 'call_operation_audit', code: safeCode(error?.code) });
      }
    }

    const providerStatus = options.client?.getConfigurationStatus?.() || {
      enabled: false,
      configured: false,
      apiVersion: null,
    };
    const phoneAssignmentAvailable = isGlobalCallHistoryAdmin &&
      options.phoneNumberService?.mutationsEnabled === true &&
      providerStatus.enabled === true && providerStatus.configured === true;
    if (providerStatus.enabled === true && providerStatus.configured === true) {
      const reads = await Promise.allSettled([
        options.phoneNumberService?.list?.({ limit: Math.min(limit, 25) }) || Promise.resolve({ phoneNumbers: [] }),
        options.telephonyProviderService?.listProviders?.() || Promise.resolve([]),
      ]);
      if (reads[0].status === 'fulfilled') {
        phoneNumbers = (reads[0].value?.phoneNumbers || []).map(normalizeInventoryItem);
      } else {
        warnings.push({ source: 'phone_numbers', code: safeCode(reads[0].reason?.code) });
      }
      if (reads[1].status === 'fulfilled') {
        telephonyProviders = (reads[1].value || []).map(normalizeTelephonyProvider);
      } else {
        warnings.push({ source: 'telephony_providers', code: safeCode(reads[1].reason?.code) });
      }
    }

    return res.json({
      success: true,
      status: {
        enabled: providerStatus.enabled === true,
        configured: providerStatus.configured === true,
        apiVersion: typeof providerStatus.apiVersion === 'string' ? providerStatus.apiVersion : null,
        dispatchEnabled: options.callService?.dispatchEnabled === true,
        lineRuntimeEnabled: options.lineAgentEnabled === true,
        lineDataHandlingReviewed: options.lineDataHandlingReviewed === true,
        ttsProvider: options.ttsProvider === 'cartesia' ? 'cartesia' : 'other',
        sttProvider: options.sttProvider === 'cartesia' ? 'cartesia' : 'other',
        callHistoryAvailable,
        phoneAssignmentAvailable,
        reviewAuditAvailable,
        adminActionAuditAvailable,
        phoneNumberOperationAuditAvailable,
        providerOperationAuditAvailable,
        callOperationAuditAvailable,
      },
      business_id: businessId || null,
      capabilities: getCapabilitySummary(),
      phoneNumbers,
      telephonyProviders,
      calls,
      reviewAudit,
      adminActionAudit,
      phoneNumberOperationAudit,
      providerOperationAudit,
      callOperationAudit,
      warnings,
      request_id: req.requestId || null,
    });
  });

  app.get('/miniapp/cartesia/voices', requireMiniAppSession, limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!requireMiniAppCapability(req, res, 'provider_manage')) return;
    if (!options.speechService || typeof options.speechService.listVoices !== 'function') {
      return res.status(503).json({ success: false, code: 'cartesia_voice_catalog_unavailable', error: 'Cartesia voice catalog is unavailable' });
    }
    try {
      const voices = await options.speechService.listVoices(req.query || {});
      return res.json({ success: true, ...voices });
    } catch (error) {
      const status = Number(error?.statusCode);
      return res.status(Number.isInteger(status) && status >= 400 && status < 500 ? status : 502).json({
        success: false,
        code: 'cartesia_voice_catalog_unavailable',
        error: status >= 400 && status < 500 ? error.message : 'Cartesia voice catalog is temporarily unavailable',
      });
    }
  });

  const requirePhoneAssignmentAdmin = (req, res) => {
    if (!requireMiniAppCapability(req, res, 'provider_manage')) return false;
    if (!requireMiniAppCapability(req, res, 'users_manage')) return false;
    if (options.phoneNumberService?.mutationsEnabled !== true) {
      res.status(503).json({ success: false, code: 'cartesia_phone_number_mutations_disabled', error: 'Cartesia phone number changes are disabled' });
      return false;
    }
    return true;
  };

  app.post('/miniapp/cartesia/phone-numbers/:phoneNumberId/assignment/preview', requireMiniAppSession, limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!requirePhoneAssignmentAdmin(req, res)) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'agent_id') ||
        (body.agent_id !== null && (typeof body.agent_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.agent_id)))) {
      return res.status(400).json({ success: false, code: 'cartesia_phone_assignment_invalid', error: 'agent_id must be a Cartesia agent ID or null' });
    }
    try {
      const preview = await options.phoneNumberService.prepareAssignment(req.params.phoneNumberId, body.agent_id);
      return res.json({ success: true, preview });
    } catch (error) {
      return res.status(Number.isInteger(error?.status) ? error.status : 502).json({
        success: false,
        code: safeCode(error?.code),
        error: 'Cartesia phone assignment preview is unavailable',
        request_id: req.requestId || null,
      });
    }
  });

  app.put('/miniapp/cartesia/phone-numbers/:phoneNumberId/assignment', requireMiniAppSession, limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!requirePhoneAssignmentAdmin(req, res)) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const allowedKeys = new Set(['agent_id', 'approved', 'confirmed_fingerprint', 'idempotency_key']);
    if (Object.keys(body).some((key) => !allowedKeys.has(key)) ||
        Object.keys(body).length !== allowedKeys.size ||
        !Object.hasOwn(body, 'agent_id') ||
        (body.agent_id !== null && (typeof body.agent_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.agent_id))) ||
        body.approved !== true ||
        typeof body.confirmed_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.confirmed_fingerprint) ||
        typeof body.idempotency_key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(body.idempotency_key)) {
      return res.status(400).json({ success: false, code: 'cartesia_phone_assignment_invalid', error: 'A confirmed assignment preview and idempotency key are required' });
    }
    if (typeof options.db?.recordCartesiaAdminActionAudit !== 'function') {
      return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia phone assignment is unavailable' });
    }
    const actorTelegramId = String(req.miniAppSession?.telegram_id || '').trim();
    if (!/^\d{1,20}$/.test(actorTelegramId)) {
      return res.status(403).json({ success: false, code: 'miniapp_auth_required', error: 'An authenticated administrator is required' });
    }
    const auditBase = {
      actor_telegram_id: actorTelegramId,
      action: 'phone_agent_assignment',
      resource_type: 'phone_number',
      resource_id: req.params.phoneNumberId,
      previous_agent_id: null,
      target_agent_id: body.agent_id,
      request_fingerprint: body.confirmed_fingerprint,
    };
    try {
      await options.db.recordCartesiaAdminActionAudit({ ...auditBase, outcome: 'requested' });
    } catch {
      return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia phone assignment is unavailable' });
    }
    try {
      const assignment = await options.phoneNumberService.assignAgent({
        phoneNumberId: req.params.phoneNumberId,
        agent_id: body.agent_id,
        approved: body.approved,
        confirmed_fingerprint: body.confirmed_fingerprint,
        idempotency_key: body.idempotency_key,
      });
      try {
        await options.db.recordCartesiaAdminActionAudit({
          ...auditBase,
          outcome: 'succeeded',
          previous_agent_id: assignment.previousAgentId || null,
          target_agent_id: assignment.agentId || null,
        });
      } catch {
        return res.status(503).json({ success: false, code: 'cartesia_admin_action_audit_unavailable', error: 'Cartesia applied the assignment but its audit result could not be saved; refresh inventory before retrying' });
      }
      return res.json({ success: true, assignment });
    } catch (error) {
      const code = safeCode(error?.code);
      const outcome = /outcome_unknown|persistence_failed/.test(code) ? 'outcome_unknown' : 'failed';
      await options.db.recordCartesiaAdminActionAudit({
        ...auditBase,
        outcome,
        reason_code: code,
      }).catch(() => {});
      return res.status(Number.isInteger(error?.status) ? error.status : 502).json({
        success: false,
        code,
        error: 'Cartesia phone assignment is unavailable',
        request_id: req.requestId || null,
      });
    }
  });

  app.post('/miniapp/cartesia/calls/:providerCallId/review', requireMiniAppSession, limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!requireMiniAppCapability(req, res, 'provider_manage')) return;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const bodyKeys = Object.keys(body);
    if (body.confirm_private_data_review !== true ||
        bodyKeys.some((key) => !['confirm_private_data_review', 'business_id'].includes(key)) ||
        bodyKeys.length !== (Object.hasOwn(body, 'business_id') ? 2 : 1)) {
      return res.status(400).json({ success: false, code: 'cartesia_review_confirmation_required', error: 'Explicit private-data review confirmation is required' });
    }
    const businessId = body.business_id === undefined ? '' : body.business_id;
    if (typeof businessId !== 'string' || (businessId && !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId))) {
      return res.status(400).json({ success: false, code: 'cartesia_invalid_business_id', error: 'Cartesia business ID is invalid' });
    }
    const providerCallId = String(req.params?.providerCallId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(providerCallId)) {
      return res.status(400).json({ success: false, code: 'cartesia_invalid_call_id', error: 'Cartesia call ID is invalid' });
    }
    if (typeof options.db?.getCartesiaCallRecordByProviderId !== 'function' ||
        typeof options.db?.recordCartesiaCallReviewAudit !== 'function' ||
        typeof options.callService?.getCall !== 'function') {
      return res.status(503).json({ success: false, code: 'cartesia_call_review_unavailable', error: 'Cartesia call review is unavailable' });
    }
    let localCall;
    try {
      if (businessId) {
        const telegramId = String(req.miniAppSession?.telegram_id || '').trim();
        if (!/^\d{1,20}$/.test(telegramId) || typeof options.db?.getCallEBusinessOperator !== 'function') {
          await recordCallReviewAudit(options, req, { providerCallId, businessId, outcome: 'failed', reasonCode: 'cartesia_business_history_unavailable' });
          return res.status(503).json({ success: false, code: 'cartesia_business_history_unavailable', error: 'Business call history is unavailable' });
        }
        const membership = await options.db.getCallEBusinessOperator(businessId, telegramId);
        if (!CARTESIA_BUSINESS_CALL_ROLES.has(membership?.role)) {
          await recordCallReviewAudit(options, req, { providerCallId, businessId, outcome: 'denied', reasonCode: 'cartesia_business_access_denied' });
          return res.status(404).json({ success: false, code: 'cartesia_call_not_found', error: 'Stored Cartesia call was not found' });
        }
        localCall = await options.db.getCartesiaCallRecordByProviderId(providerCallId, businessId);
      } else {
        if (!Array.isArray(req.miniAppSession?.caps) || !req.miniAppSession.caps.includes('users_manage')) {
          await recordCallReviewAudit(options, req, { providerCallId, outcome: 'denied', reasonCode: 'miniapp_capability_denied' });
          return res.status(403).json({ success: false, code: 'miniapp_capability_denied', error: 'Call-history access is required' });
        }
        localCall = await options.db.getCartesiaCallRecordByProviderId(providerCallId);
      }
    } catch {
      try {
        await recordCallReviewAudit(options, req, { providerCallId, businessId: businessId || null, outcome: 'failed', reasonCode: 'cartesia_call_review_unavailable' });
      } catch {
        // Deny the review if audit storage is unavailable; no private payload is returned.
      }
      return res.status(503).json({ success: false, code: businessId ? 'cartesia_business_history_unavailable' : 'cartesia_call_review_unavailable', error: 'Cartesia call review is unavailable' });
    }
    if (!localCall) {
      try {
        await recordCallReviewAudit(options, req, { providerCallId, businessId: businessId || null, outcome: 'denied', reasonCode: 'cartesia_call_not_found' });
      } catch {
        return res.status(503).json({ success: false, code: 'cartesia_review_audit_unavailable', error: 'Cartesia call review is unavailable' });
      }
      return res.status(404).json({ success: false, code: 'cartesia_call_not_found', error: 'Stored Cartesia call was not found' });
    }
    let call;
    try {
      call = await options.callService.getCall(providerCallId);
    } catch (error) {
      try {
        await recordCallReviewAudit(options, req, {
          providerCallId,
          businessId: businessId || localCall.business_id || null,
          outcome: 'failed',
          reasonCode: safeCode(error?.code),
        });
      } catch {
        return res.status(503).json({ success: false, code: 'cartesia_review_audit_unavailable', error: 'Cartesia call review is unavailable', request_id: req.requestId || null });
      }
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      return res.status(status).json({
        success: false,
        code: safeCode(error?.code),
        error: 'Cartesia call review is unavailable',
        request_id: req.requestId || null,
      });
    }
    try {
      await recordCallReviewAudit(options, req, { providerCallId, businessId: businessId || localCall.business_id || null, outcome: 'allowed' });
    } catch {
      return res.status(503).json({ success: false, code: 'cartesia_review_audit_unavailable', error: 'Cartesia call review is unavailable', request_id: req.requestId || null });
    }
    return res.json({ success: true, call: normalizePrivateCallReview(call), request_id: req.requestId || null });
  });
}

module.exports = { registerCartesiaDashboardRoutes };
