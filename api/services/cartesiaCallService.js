const crypto = require('node:crypto');
const { CallEContactPolicyService } = require('./callEContactPolicyService');

const CARTESIA_CALL_STATUSES = new Set(['created', 'started', 'completed', 'failed']);
const MAX_DYNAMIC_VARIABLES = 50;
const MAX_DYNAMIC_VALUE_LENGTH = 1000;

function cartesiaCallError(code, message, status = 400) {
  const error = new Error(message);
  error.name = 'CartesiaCallError';
  error.code = code;
  error.status = status;
  return error;
}

function parseAllowedDestinations(value = process.env.CARTESIA_ALLOWED_DESTINATIONS) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  return new Set(entries.map((entry) => String(entry || '').trim())
    .filter((entry) => /^\+[1-9]\d{7,14}$/.test(entry)));
}

function normalizeDynamicVariables(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw cartesiaCallError('cartesia_dynamic_variables_invalid', 'Cartesia dynamic variables must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_DYNAMIC_VARIABLES) {
    throw cartesiaCallError('cartesia_dynamic_variables_invalid', 'Cartesia dynamic variables exceed the supported limit');
  }
  const normalized = {};
  for (const [rawName, rawValue] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const name = String(rawName || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
        /(password|secret|token|authorization|api[_-]?key|credential)/i.test(name)) {
      throw cartesiaCallError('cartesia_dynamic_variables_invalid', 'Cartesia dynamic variable name is invalid');
    }
    if (typeof rawValue === 'string') {
      if (rawValue.length > MAX_DYNAMIC_VALUE_LENGTH) {
        throw cartesiaCallError('cartesia_dynamic_variables_invalid', 'Cartesia dynamic variable value is too long');
      }
      normalized[name] = rawValue;
    } else if (typeof rawValue === 'boolean' || (typeof rawValue === 'number' && Number.isFinite(rawValue))) {
      normalized[name] = rawValue;
    } else {
      throw cartesiaCallError('cartesia_dynamic_variables_invalid', 'Cartesia dynamic variable values must be strings, finite numbers, or booleans');
    }
  }
  return normalized;
}

function normalizeOutboundCallInput(input = {}) {
  const businessId = String(input.businessId || input.business_id || '').trim();
  const destination = String(input.toNumber || input.to_number || input.phone || '').trim();
  const fromNumberId = String(input.fromNumberId || input.from_number_id || '').trim();
  const agentId = String(input.agentId || input.agent_id || '').trim();
  const ringingTimeout = input.ringingTimeoutSeconds ?? input.ringing_timeout_seconds;
  const maxDuration = input.maxCallDurationMinutes ?? input.max_call_duration_minutes;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) {
    throw cartesiaCallError('cartesia_business_scope_required', 'A valid business scope is required', 403);
  }
  if (!/^\+[1-9]\d{7,14}$/.test(destination)) {
    throw cartesiaCallError('cartesia_destination_invalid', 'A valid E.164 destination is required');
  }
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(fromNumberId) || !/^[A-Za-z0-9_-]{1,200}$/.test(agentId)) {
    throw cartesiaCallError('cartesia_agent_or_number_invalid', 'A valid Cartesia agent and phone number ID are required');
  }
  if (ringingTimeout !== undefined && (!Number.isInteger(Number(ringingTimeout)) || Number(ringingTimeout) < 5 || Number(ringingTimeout) > 80)) {
    throw cartesiaCallError('cartesia_ringing_timeout_invalid', 'Ringing timeout must be between 5 and 80 seconds');
  }
  if (maxDuration !== undefined && (!Number.isInteger(Number(maxDuration)) || Number(maxDuration) < 1 || Number(maxDuration) > 180)) {
    throw cartesiaCallError('cartesia_call_duration_invalid', 'Maximum call duration must be between 1 and 180 minutes');
  }
  const dynamicVariables = normalizeDynamicVariables(input.dynamicVariables ?? input.dynamic_variables);
  const request = {
    from_number_id: fromNumberId,
    agent_id: agentId,
    outbound_calls: [{ to_number: destination, dynamic_variables: dynamicVariables }],
    ...(ringingTimeout === undefined ? {} : { ringing_timeout_seconds: Number(ringingTimeout) }),
    ...(maxDuration === undefined ? {} : { max_call_duration_minutes: Number(maxDuration) }),
  };
  const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify({ businessId, request })).digest('hex');
  return Object.freeze({ businessId, destination, agentId, fromNumberId, request, requestFingerprint });
}

function parseStoredPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeCallDetails(payload, expectedCallId = null) {
  const providerCallId = String(payload?.id || '').trim();
  const agentId = String(payload?.agent_id || '').trim();
  const status = String(payload?.status || '').trim().toLowerCase();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(providerCallId) ||
      (expectedCallId && providerCallId !== expectedCallId) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(agentId) || !CARTESIA_CALL_STATUSES.has(status)) {
    throw cartesiaCallError('cartesia_invalid_response', 'Cartesia returned an invalid call record', 502);
  }
  const telephony = payload.telephony_params && typeof payload.telephony_params === 'object' && !Array.isArray(payload.telephony_params)
    ? payload.telephony_params
    : {};
  const transcript = Array.isArray(payload.transcript)
    ? payload.transcript.slice(0, 1000).map((turn) => ({
      role: ['assistant', 'user'].includes(String(turn?.role || '').toLowerCase()) ? String(turn.role).toLowerCase() : 'unknown',
      text: typeof turn?.text === 'string' ? turn.text.slice(0, 10000) : '',
      startTimestamp: Number.isFinite(Number(turn?.start_timestamp)) ? Number(turn.start_timestamp) : null,
      endTimestamp: Number.isFinite(Number(turn?.end_timestamp)) ? Number(turn.end_timestamp) : null,
    }))
    : null;
  return Object.freeze({
    provider: 'cartesia',
    providerCallId,
    agentId,
    status,
    startTime: typeof payload.start_time === 'string' ? payload.start_time : null,
    endTime: typeof payload.end_time === 'string' ? payload.end_time : null,
    direction: ['inbound', 'outbound'].includes(String(telephony.direction || '').toLowerCase())
      ? String(telephony.direction).toLowerCase()
      : null,
    from: typeof telephony.from === 'string' ? telephony.from : null,
    to: typeof telephony.to === 'string' ? telephony.to : null,
    telephonyAccountType: ['cartesia', 'twilio', 'sip_trunk'].includes(String(payload.telephony_account_type || '').toLowerCase())
      ? String(payload.telephony_account_type).toLowerCase()
      : null,
    summary: typeof payload.summary === 'string' ? payload.summary.slice(0, 4000) : null,
    transcript,
    endReason: typeof payload.end_reason === 'string' ? payload.end_reason.slice(0, 100) : null,
    zdrEnabled: payload.zdr_enabled === true,
  });
}

class CartesiaCallService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.contactPolicy = options.contactPolicy || new CallEContactPolicyService({ db: this.db });
    this.enabled = options.enabled === true;
    this.dispatchEnabled = options.dispatchEnabled === true;
    this.allowedDestinations = parseAllowedDestinations(options.allowedDestinations);
  }

  ensureEnabled() {
    if (!this.enabled || !this.client?.isConfigured?.()) {
      throw cartesiaCallError('cartesia_not_configured', 'Cartesia Managed Agents is disabled or not configured', 503);
    }
  }

  async prepareOutboundCall(input = {}) {
    this.ensureEnabled();
    const prepared = normalizeOutboundCallInput(input);
    if (!this.allowedDestinations.has(prepared.destination)) {
      throw cartesiaCallError('cartesia_destination_not_allowlisted', 'Cartesia destination is not allowlisted', 403);
    }
    const eligibility = await this.contactPolicy.checkEligibility({
      businessId: prepared.businessId,
      destination: prepared.destination,
    });
    if (eligibility?.eligible !== true) {
      const errors = {
        opted_out: ['cartesia_contact_opted_out', 'Cartesia destination has opted out'],
        consent_expired: ['cartesia_consent_expired', 'Cartesia consent evidence has expired'],
        consent_not_effective: ['cartesia_consent_not_effective', 'Cartesia consent evidence is not effective yet'],
        policy_storage_unavailable: ['cartesia_contact_policy_unavailable', 'Cartesia consent policy storage is unavailable'],
      };
      const [code, message] = errors[eligibility?.reason] || [
        'cartesia_consent_required',
        'Current consent evidence is required for this business and destination',
      ];
      throw cartesiaCallError(code, message, code === 'cartesia_contact_policy_unavailable' ? 503 : 403);
    }
    return Object.freeze({
      provider: 'cartesia',
      direction: 'outbound',
      businessId: prepared.businessId,
      destination: prepared.destination,
      agentId: prepared.agentId,
      fromNumberId: prepared.fromNumberId,
      ringingTimeoutSeconds: prepared.request.ringing_timeout_seconds || null,
      maxCallDurationMinutes: prepared.request.max_call_duration_minutes || null,
      requestFingerprint: prepared.requestFingerprint,
      persisted: false,
    });
  }

  async createOutboundCall(input = {}) {
    const preview = await this.prepareOutboundCall(input);
    if (!this.dispatchEnabled) {
      throw cartesiaCallError('cartesia_dispatch_disabled', 'Cartesia outbound dispatch is disabled', 503);
    }
    if (input.approved !== true || String(input.confirmedFingerprint || '').trim().toLowerCase() !== preview.requestFingerprint) {
      throw cartesiaCallError('cartesia_confirmation_mismatch', 'Explicit approval must match the current call preview', 409);
    }
    const idempotencyKey = String(input.idempotencyKey || input.idempotency_key || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
      throw cartesiaCallError('cartesia_idempotency_key_required', 'A valid Cartesia idempotency key is required');
    }
    if (!this.db || typeof this.db.getOutboundCallIdempotency !== 'function' ||
        typeof this.db.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db.completeOutboundCallIdempotency !== 'function') {
      throw cartesiaCallError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const namespacedKey = `voicednut:cartesia:${preview.businessId}:${idempotencyKey}`;
    const existing = await this.db.getOutboundCallIdempotency(namespacedKey);
    const replay = this.resolveIdempotency(existing, preview.requestFingerprint);
    if (replay) {
      await this.persistOutboundRecord(replay, preview);
      return replay;
    }
    if (!existing) {
      const reserved = await this.db.reserveOutboundCallIdempotency({
        idempotency_key: namespacedKey,
        provider: 'cartesia',
        request_hash: preview.requestFingerprint,
      });
      if (!reserved?.reserved) {
        const raced = await this.db.getOutboundCallIdempotency(namespacedKey);
        const racedReplay = this.resolveIdempotency(raced, preview.requestFingerprint);
        if (racedReplay) {
          await this.persistOutboundRecord(racedReplay, preview);
          return racedReplay;
        }
        throw cartesiaCallError('cartesia_idempotency_in_progress', 'Cartesia request reservation is unresolved; inspect provider state before retrying', 409);
      }
    }

    const request = normalizeOutboundCallInput(input).request;
    let providerResponse;
    try {
      providerResponse = await this.client.createOutboundCall(request);
    } catch (error) {
      // The Cartesia create-call contract has no documented idempotency key. Once
      // submitted, a transport failure has an ambiguous outcome and stays pending.
      if (error instanceof Error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: namespacedKey,
          provider: 'cartesia',
          request_hash: preview.requestFingerprint,
          status: 'failed',
          error_message: 'cartesia_request_rejected',
        }).catch(() => {});
        throw cartesiaCallError('cartesia_request_rejected', 'Cartesia rejected the outbound call request', error.status);
      }
      throw cartesiaCallError('cartesia_outcome_unknown', 'Cartesia call submission outcome is unknown; inspect provider state before retrying', 409);
    }

    const outcomes = Array.isArray(providerResponse?.calls) ? providerResponse.calls : null;
    if (!outcomes || outcomes.length !== 1) {
      throw cartesiaCallError('cartesia_outcome_unknown', 'Cartesia returned an unresolved outbound call response; inspect provider state before retrying', 409);
    }
    const outcome = outcomes[0];
    if (outcome?.error) {
      const providerCallId = String(outcome.agent_call_id || '').trim();
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: namespacedKey,
        provider: 'cartesia',
        request_hash: preview.requestFingerprint,
        call_sid: /^[A-Za-z0-9_-]{1,200}$/.test(providerCallId) ? providerCallId : null,
        status: 'failed',
        response_payload: { providerCallId: providerCallId || null, status: 'failed' },
        error_message: 'cartesia_recipient_rejected',
      });
      throw cartesiaCallError('cartesia_recipient_rejected', 'Cartesia could not start the requested call', 422);
    }
    const providerCallId = String(outcome?.agent_call_id || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(providerCallId) || outcome.number !== preview.destination) {
      throw cartesiaCallError('cartesia_outcome_unknown', 'Cartesia returned an unresolved outbound call response; inspect provider state before retrying', 409);
    }
    const result = {
      provider: 'cartesia',
      providerCallId,
      callId: providerCallId,
      localCallId: `cartesia_${crypto.randomUUID()}`,
      status: 'created',
      requestFingerprint: preview.requestFingerprint,
      idempotentReplay: false,
    };
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: namespacedKey,
      provider: 'cartesia',
      request_hash: preview.requestFingerprint,
      call_sid: providerCallId,
      status: 'completed',
      response_payload: result,
    });
    await this.persistOutboundRecord(result, preview);
    return result;
  }

  async persistOutboundRecord(result, preview) {
    if (typeof this.db?.upsertCartesiaCallRecord !== 'function') {
      throw cartesiaCallError('cartesia_call_storage_unavailable', 'Cartesia call record storage is unavailable', 503);
    }
    await this.db.upsertCartesiaCallRecord({
      local_call_id: result.localCallId,
      provider_call_id: result.providerCallId,
      business_id: preview.businessId,
      agent_id: preview.agentId,
      from_number_id: preview.fromNumberId,
      phone_number: preview.destination,
      direction: 'outbound',
      status: result.status,
      event_timestamp: new Date().toISOString(),
    });
  }

  resolveIdempotency(existing, requestFingerprint) {
    if (!existing) return null;
    if (existing.provider !== 'cartesia' || existing.request_hash !== requestFingerprint) {
      throw cartesiaCallError('cartesia_idempotency_conflict', 'Cartesia idempotency key was already used for a different request', 409);
    }
    if (existing.status === 'completed') {
      const stored = parseStoredPayload(existing.response_payload);
      if (!stored.providerCallId || !CARTESIA_CALL_STATUSES.has(stored.status)) {
        throw cartesiaCallError('cartesia_idempotency_state_invalid', 'Cartesia idempotency state is invalid', 409);
      }
      return { ...stored, idempotentReplay: true };
    }
    throw cartesiaCallError('cartesia_outcome_unknown', 'A prior Cartesia submission may have started; inspect provider state before retrying', 409);
  }

  async getCall(providerCallId) {
    this.ensureEnabled();
    const callId = String(providerCallId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(callId)) {
      throw cartesiaCallError('cartesia_invalid_call_id', 'Cartesia call ID is invalid');
    }
    try {
      return normalizeCallDetails(await this.client.getCall(callId), callId);
    } catch (error) {
      if (error?.code) throw error;
      throw cartesiaCallError('cartesia_call_read_failed', 'Unable to retrieve the Cartesia call', 502);
    }
  }

  async cancelCall(providerCallId, approved) {
    if (approved !== true) {
      throw cartesiaCallError('cartesia_cancel_confirmation_required', 'Explicit confirmation is required to cancel a Cartesia call', 409);
    }
    const call = await this.getCall(providerCallId);
    if (call.status !== 'started') {
      throw cartesiaCallError('cartesia_call_not_active', 'Only a started Cartesia call can be cancelled', 409);
    }
    let response;
    try {
      response = await this.client.cancelCall(call.providerCallId);
    } catch (error) {
      if (error?.retryable === true || (Number.isInteger(error?.status) && error.status >= 500)) {
        throw cartesiaCallError('cartesia_cancel_outcome_unknown', 'Cartesia cancellation outcome is unknown; refresh call status before retrying', 409);
      }
      throw error;
    }
    if (response?.cancelled !== true) {
      throw cartesiaCallError('cartesia_cancel_outcome_unknown', 'Cartesia cancellation outcome is unknown; refresh call status before retrying', 409);
    }
    return { providerCallId: call.providerCallId, cancelled: true };
  }
}

module.exports = {
  CARTESIA_CALL_STATUSES,
  CartesiaCallService,
  normalizeDynamicVariables,
  normalizeCallDetails,
  normalizeOutboundCallInput,
  parseAllowedDestinations,
};
