const crypto = require('node:crypto');
const { CartesiaApiError } = require('./cartesiaClient');

const PHONE_NUMBER_TYPES = new Set(['cartesia', 'twilio', 'sip_trunk']);

function phoneNumberError(code, message, status = 400) {
  const error = new Error(message);
  error.name = 'CartesiaPhoneNumberError';
  error.code = code;
  error.status = status;
  return error;
}

function safeText(value, limit = 200) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text ? text.slice(0, limit) : null;
}

function normalizePhoneNumber(payload, expectedId = null) {
  const id = safeText(payload?.id);
  const number = safeText(payload?.number, 32);
  const provider = payload?.provider && typeof payload.provider === 'object' && !Array.isArray(payload.provider)
    ? payload.provider
    : null;
  const providerType = String(provider?.type || (payload.provider == null ? 'cartesia' : '')).trim().toLowerCase();
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || (expectedId && id !== expectedId) ||
      !number || !/^\+[1-9]\d{7,14}$/.test(number) || !PHONE_NUMBER_TYPES.has(providerType) ||
      (providerType !== 'cartesia' && !safeText(provider?.id))) {
    throw phoneNumberError('cartesia_invalid_phone_number_response', 'Cartesia returned an invalid phone number record', 502);
  }
  const agent = payload.agent && typeof payload.agent === 'object' && !Array.isArray(payload.agent)
    ? payload.agent
    : null;
  const agentId = agent ? safeText(agent.id) : null;
  if (agent && (!agentId || !/^[A-Za-z0-9_-]{1,200}$/.test(agentId))) {
    throw phoneNumberError('cartesia_invalid_phone_number_response', 'Cartesia returned an invalid phone number record', 502);
  }
  const ownership = {
    cartesia: 'cartesia_owned',
    twilio: 'twilio_imported',
    sip_trunk: 'external_sip',
  }[providerType];
  return Object.freeze({
    id,
    number,
    label: safeText(payload.label, 200),
    agent: agent ? { id: agentId, name: safeText(agent.name, 200) } : null,
    provider: {
      type: providerType,
      id: safeText(provider?.id),
      label: safeText(provider?.label, 200),
      region: safeText(provider?.region, 40),
    },
    ownership,
    createdAt: safeText(payload.created_at, 40),
    updatedAt: safeText(payload.updated_at, 40),
  });
}

function normalizeListQuery(query = {}) {
  const scalar = (value) => value === undefined || value === null || typeof value === 'string' || typeof value === 'number';
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const q = query.q === undefined ? '' : (typeof query.q === 'string' ? query.q.trim() : null);
  const startingAfter = query.starting_after === undefined ? '' : query.starting_after;
  const endingBefore = query.ending_before === undefined ? '' : query.ending_before;
  const agentId = query.agent_id === undefined ? '' : query.agent_id;
  const providerId = query.provider_id === undefined ? '' : query.provider_id;
  const type = query.type === undefined ? '' : query.type;
  if (!scalar(query.limit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      q === null || q.length > 100 ||
      typeof startingAfter !== 'string' || startingAfter.length > 200 ||
      typeof endingBefore !== 'string' || endingBefore.length > 200 ||
      typeof agentId !== 'string' || agentId.length > 200 ||
      typeof providerId !== 'string' || providerId.length > 200 ||
      typeof type !== 'string' || (type && !PHONE_NUMBER_TYPES.has(type))) {
    throw phoneNumberError('cartesia_phone_number_query_invalid', 'Cartesia phone number query is invalid');
  }
  for (const id of [startingAfter, endingBefore, agentId, providerId]) {
    if (id && !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw phoneNumberError('cartesia_phone_number_query_invalid', 'Cartesia phone number query is invalid');
    }
  }
  if (startingAfter && endingBefore) {
    throw phoneNumberError('cartesia_phone_number_query_invalid', 'Choose only one Cartesia pagination cursor');
  }
  return {
    limit,
    ...(q ? { q } : {}),
    ...(startingAfter ? { starting_after: startingAfter } : {}),
    ...(endingBefore ? { ending_before: endingBefore } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(providerId ? { provider_id: providerId } : {}),
    ...(type ? { type } : {}),
  };
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

class CartesiaPhoneNumberService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.enabled = options.enabled === true;
    this.mutationsEnabled = options.mutationsEnabled === true;
    this.provisioningEnabled = options.provisioningEnabled === true;
  }

  ensureEnabled() {
    const clientConfigured = this.client?.isReadConfigured?.() ?? this.client?.isConfigured?.();
    if (!this.enabled || !clientConfigured) {
      throw phoneNumberError('cartesia_not_configured', 'Cartesia Managed Agents is disabled or not configured', 503);
    }
  }

  async list(query = {}) {
    this.ensureEnabled();
    const normalizedQuery = normalizeListQuery(query);
    const payload = await this.client.listPhoneNumbers(normalizedQuery);
    if (!payload || !Array.isArray(payload.data) || typeof payload.has_more !== 'boolean') {
      throw phoneNumberError('cartesia_invalid_phone_number_list', 'Cartesia returned an invalid phone number list', 502);
    }
    const phoneNumbers = payload.data.slice(0, normalizedQuery.limit).map((item) => normalizePhoneNumber(item));
    return {
      phoneNumbers,
      pagination: {
        hasMore: payload.has_more,
        nextCursor: payload.has_more && phoneNumbers.length ? phoneNumbers[phoneNumbers.length - 1].id : null,
      },
    };
  }

  async get(phoneNumberId) {
    this.ensureEnabled();
    const id = this.normalizeId(phoneNumberId);
    return normalizePhoneNumber(await this.client.getPhoneNumber(id), id);
  }

  normalizeId(value) {
    const id = String(value || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw phoneNumberError('cartesia_invalid_phone_number_id', 'Cartesia phone number ID is invalid');
    }
    return id;
  }

  normalizeAgentId(value) {
    if (value === null) return null;
    const id = String(value || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw phoneNumberError('cartesia_invalid_agent_id', 'A valid Cartesia agent ID or null is required');
    }
    return id;
  }

  normalizeLabel(value) {
    const label = typeof value === 'string' ? value.trim() : '';
    if (!label || label.length > 80 || /[\r\n\u0000]/.test(label)) {
      throw phoneNumberError('cartesia_phone_number_label_invalid', 'A phone number label of 1 to 80 characters is required');
    }
    return label;
  }

  normalizeIdempotencyKey(value) {
    const key = String(value || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
      throw phoneNumberError('cartesia_idempotency_key_required', 'A valid Cartesia operation idempotency key is required');
    }
    return key;
  }

  async findExactNumber(number) {
    const payload = await this.client.listPhoneNumbers({ q: number, limit: 100 });
    if (!payload || !Array.isArray(payload.data) || typeof payload.has_more !== 'boolean' || payload.has_more) {
      throw phoneNumberError('cartesia_phone_number_reconciliation_incomplete', 'Cartesia phone number inventory is incomplete for safe duplicate checking', 503);
    }
    return payload.data.map((item) => normalizePhoneNumber(item)).filter((item) => item.number === number);
  }

  async prepareImport(input = {}) {
    this.ensureEnabled();
    const label = this.normalizeLabel(input.label);
    const number = String(input.number || '').trim();
    const providerId = this.normalizeId(input.provider_id || input.providerId);
    const agentId = input.agent_id === undefined ? null : this.normalizeAgentId(input.agent_id);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotency_key || input.idempotencyKey);
    if (!/^\+[1-9]\d{7,14}$/.test(number)) {
      throw phoneNumberError('cartesia_phone_number_invalid', 'The imported number must be in E.164 format');
    }
    const providers = await this.client.listTelephonyProviders();
    if (!Array.isArray(providers) || !providers.some((provider) =>
      provider?.id === providerId && ['twilio', 'sip_trunk'].includes(String(provider.type || '').toLowerCase()))) {
      throw phoneNumberError('cartesia_phone_provider_invalid', 'The selected Cartesia provider is not an eligible Twilio or SIP provider');
    }
    const existing = await this.findExactNumber(number);
    const request = { label, number, provider: { id: providerId }, ...(agentId ? { agent_id: agentId } : {}) };
    const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return Object.freeze({
      operation: 'import', label, number, providerId, agentId, idempotencyKey,
      requestFingerprint,
      numberAlreadyPresent: existing.length > 0,
      ownership: String(providers.find((provider) => provider.id === providerId).type).toLowerCase() === 'twilio' ? 'twilio_imported' : 'external_sip',
      request,
    });
  }

  async importNumber(input = {}) {
    this.ensureEnabled();
    if (!this.mutationsEnabled) {
      throw phoneNumberError('cartesia_phone_number_mutations_disabled', 'Cartesia phone number changes are disabled', 503);
    }
    const approved = input.approved === true;
    const confirmation = String(input.confirmed_fingerprint || input.confirmedFingerprint || '').trim().toLowerCase();
    const preview = await this.prepareImport(input);
    if (!approved || confirmation !== preview.requestFingerprint) {
      throw phoneNumberError('cartesia_phone_number_confirmation_mismatch', 'Explicit approval must match the phone import preview', 409);
    }
    return this.executeNumberCreation({
      kind: 'phone_import',
      idempotencyKey: preview.idempotencyKey,
      requestFingerprint: preview.requestFingerprint,
      preflightConflict: preview.numberAlreadyPresent,
      create: async () => {
        const imported = normalizePhoneNumber(await this.client.importPhoneNumber(preview.request));
        if (imported.number !== preview.number || imported.provider.id !== preview.providerId) {
          throw phoneNumberError('cartesia_phone_import_unconfirmed', 'Cartesia did not confirm the expected imported number and provider', 502);
        }
        return imported;
      },
      reconcile: async () => {
        const matches = await this.findExactNumber(preview.number);
        if (matches.length !== 1 || matches[0].provider.id !== preview.providerId) return null;
        return matches[0];
      },
    });
  }

  async prepareProvision(input = {}) {
    this.ensureEnabled();
    const label = this.normalizeLabel(input.label);
    const agentId = input.agent_id === undefined ? null : this.normalizeAgentId(input.agent_id);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotency_key || input.idempotencyKey);
    const operationMarker = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16);
    const providerLabel = `${label} [VOICEDNUT-${operationMarker}]`;
    const query = await this.client.listPhoneNumbers({ q: providerLabel, limit: 100 });
    if (!query || !Array.isArray(query.data) || typeof query.has_more !== 'boolean' || query.has_more) {
      throw phoneNumberError('cartesia_phone_number_reconciliation_incomplete', 'Cartesia phone number inventory is incomplete for safe provisioning checks', 503);
    }
    const labelAlreadyUsed = query.data.some((item) => safeText(item?.label, 200) === providerLabel);
    const request = { label: providerLabel, ...(agentId ? { agent_id: agentId } : {}) };
    const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return Object.freeze({
      operation: 'provision', label: providerLabel, agentId, idempotencyKey, requestFingerprint,
      ownership: 'cartesia_owned', potentialCharge: true, labelAlreadyUsed, request,
    });
  }

  async provisionNumber(input = {}) {
    this.ensureEnabled();
    if (!this.provisioningEnabled) {
      throw phoneNumberError('cartesia_phone_number_provisioning_disabled', 'Cartesia phone number provisioning is disabled', 503);
    }
    const confirmation = String(input.confirmed_fingerprint || input.confirmedFingerprint || '').trim().toLowerCase();
    const preview = await this.prepareProvision(input);
    if (input.approved !== true || confirmation !== preview.requestFingerprint || input.confirm_label !== preview.label) {
      throw phoneNumberError('cartesia_phone_number_confirmation_mismatch', 'Explicit approval, exact preview fingerprint, and typed label confirmation are required for number provisioning', 409);
    }
    return this.executeNumberCreation({
      kind: 'phone_provision',
      idempotencyKey: preview.idempotencyKey,
      requestFingerprint: preview.requestFingerprint,
      preflightConflict: preview.labelAlreadyUsed,
      create: async () => {
        const provisioned = normalizePhoneNumber(await this.client.provisionPhoneNumber(preview.request));
        if (provisioned.ownership !== 'cartesia_owned' || provisioned.label !== preview.label) {
          throw phoneNumberError('cartesia_phone_provision_unconfirmed', 'Cartesia did not confirm the expected provisioned number', 502);
        }
        return provisioned;
      },
      reconcile: async () => {
        const payload = await this.client.listPhoneNumbers({ q: preview.label, limit: 100 });
        if (!payload || !Array.isArray(payload.data) || typeof payload.has_more !== 'boolean' || payload.has_more) return null;
        const matches = payload.data.map((item) => normalizePhoneNumber(item)).filter((item) => item.label === preview.label && item.ownership === 'cartesia_owned');
        return matches.length === 1 ? matches[0] : null;
      },
    });
  }

  async executeNumberCreation({ kind, idempotencyKey, requestFingerprint, create, reconcile, preflightConflict = false }) {
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const operationKey = `voicednut:cartesia:${kind}:${idempotencyKey}`;
    let existing;
    try {
      existing = await this.db.getOutboundCallIdempotency(operationKey);
    } catch {
      throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    if (existing) {
      if (existing.provider !== 'cartesia' || existing.request_hash !== requestFingerprint) {
        throw phoneNumberError('cartesia_idempotency_conflict', 'Cartesia idempotency key was already used for a different phone number operation', 409);
      }
      if (existing.status === 'completed') {
        const stored = parseStoredPayload(existing.response_payload);
        if (!stored.phoneNumber?.id) throw phoneNumberError('cartesia_idempotency_state_invalid', 'Cartesia phone number idempotency state is invalid', 409);
        return { ...stored, idempotentReplay: true };
      }
      if (existing.status === 'pending') {
        const found = await reconcile().catch(() => null);
        if (found) return this.completeNumberCreation(operationKey, requestFingerprint, found, true);
        throw phoneNumberError('cartesia_phone_number_outcome_unknown', 'Phone number creation may have succeeded; inspect Cartesia inventory before retrying', 409);
      }
      throw phoneNumberError('cartesia_phone_number_operation_failed', 'This phone number operation key has already been consumed', 409);
    }
    if (preflightConflict) {
      throw phoneNumberError('cartesia_phone_number_conflict', 'Cartesia inventory already contains this number or operation label; no new resource was created', 409);
    }
    let reserved;
    try {
      reserved = await this.db.reserveOutboundCallIdempotency({
        idempotency_key: operationKey, provider: 'cartesia', request_hash: requestFingerprint,
      });
    } catch {
      throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    if (!reserved?.reserved) {
      throw phoneNumberError('cartesia_phone_number_outcome_unknown', 'Phone number operation is already reserved; inspect Cartesia inventory before retrying', 409);
    }
    try {
      const phoneNumber = normalizePhoneNumber(await create());
      return this.completeNumberCreation(operationKey, requestFingerprint, phoneNumber, false);
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey, provider: 'cartesia', request_hash: requestFingerprint,
          status: 'failed', error_message: 'cartesia_phone_number_operation_rejected',
        }).catch(() => {});
        throw phoneNumberError('cartesia_phone_number_operation_rejected', 'Cartesia rejected the phone number operation', error.status);
      }
      const found = await reconcile().catch(() => null);
      if (found) return this.completeNumberCreation(operationKey, requestFingerprint, found, false);
      throw phoneNumberError('cartesia_phone_number_outcome_unknown', 'Phone number operation outcome is unknown; inspect Cartesia inventory before retrying', 409);
    }
  }

  async completeNumberCreation(operationKey, requestFingerprint, phoneNumber, idempotentReplay) {
    const result = { phoneNumber, requestFingerprint, idempotentReplay };
    try {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: operationKey, provider: 'cartesia', request_hash: requestFingerprint,
        status: 'completed', response_payload: result,
      });
    } catch {
      throw phoneNumberError('cartesia_phone_number_persistence_failed', 'Cartesia created the phone number but local confirmation could not be saved; inspect inventory before retrying', 503);
    }
    return result;
  }

  async prepareAssignment(phoneNumberId, agentId) {
    this.ensureEnabled();
    const id = this.normalizeId(phoneNumberId);
    const targetAgentId = this.normalizeAgentId(agentId);
    const phoneNumber = await this.get(id);
    const currentAgentId = phoneNumber.agent?.id || null;
    const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      phoneNumberId: id,
      currentAgentId,
      targetAgentId,
    })).digest('hex');
    return Object.freeze({
      phoneNumberId: id,
      number: phoneNumber.number,
      ownership: phoneNumber.ownership,
      providerType: phoneNumber.provider.type,
      currentAgentId,
      targetAgentId,
      requestFingerprint,
      requiresChange: currentAgentId !== targetAgentId,
    });
  }

  async prepareRelease(phoneNumberId) {
    this.ensureEnabled();
    const id = this.normalizeId(phoneNumberId);
    const phoneNumber = await this.get(id);
    if (phoneNumber.agent && ['cartesia_owned', 'external_sip'].includes(phoneNumber.ownership)) {
      throw phoneNumberError('cartesia_phone_number_must_be_unassigned', 'Unassign Cartesia-managed and SIP phone numbers before release', 409);
    }
    const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      phoneNumberId: id,
      number: phoneNumber.number,
      ownership: phoneNumber.ownership,
      providerId: phoneNumber.provider.id,
      currentAgentId: phoneNumber.agent?.id || null,
      operation: 'release',
    })).digest('hex');
    return Object.freeze({
      phoneNumberId: id,
      number: phoneNumber.number,
      label: phoneNumber.label,
      ownership: phoneNumber.ownership,
      providerType: phoneNumber.provider.type,
      currentAgentId: phoneNumber.agent?.id || null,
      permanentlyReleasesNumber: phoneNumber.ownership === 'cartesia_owned',
      requestFingerprint,
    });
  }

  async releaseNumber(input = {}) {
    this.ensureEnabled();
    if (!this.mutationsEnabled) {
      throw phoneNumberError('cartesia_phone_number_mutations_disabled', 'Cartesia phone number changes are disabled', 503);
    }
    const phoneNumberId = this.normalizeId(input.phoneNumberId || input.phone_number_id);
    const idempotencyKey = this.normalizeIdempotencyKey(input.idempotency_key || input.idempotencyKey);
    const confirmation = String(input.confirmed_fingerprint || input.confirmedFingerprint || '').trim().toLowerCase();
    const confirmedNumber = String(input.confirm_number || input.confirmNumber || '').trim();
    if (input.approved !== true || !/^[a-f0-9]{64}$/.test(confirmation)) {
      throw phoneNumberError('cartesia_phone_number_confirmation_mismatch', 'Explicit approval and the release preview fingerprint are required', 409);
    }
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const operationKey = `voicednut:cartesia:phone_release:${idempotencyKey}`;
    let existing;
    try {
      existing = await this.db.getOutboundCallIdempotency(operationKey);
    } catch {
      throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    if (existing) {
      if (existing.provider !== 'cartesia' || existing.request_hash !== confirmation) {
        throw phoneNumberError('cartesia_idempotency_conflict', 'Cartesia idempotency key was already used for a different number release', 409);
      }
      if (existing.status === 'completed') {
        const stored = parseStoredPayload(existing.response_payload);
        if (!stored.phoneNumberId || stored.deleted !== true) {
          throw phoneNumberError('cartesia_idempotency_state_invalid', 'Cartesia phone release idempotency state is invalid', 409);
        }
        return { ...stored, idempotentReplay: true };
      }
      if (existing.status === 'pending') {
        try {
          await this.get(phoneNumberId);
          throw phoneNumberError('cartesia_phone_number_release_outcome_unknown', 'Phone number still exists after an ambiguous release; inspect Cartesia before taking further action', 409);
        } catch (error) {
          if (error instanceof CartesiaApiError && error.status === 404) {
            const stored = parseStoredPayload(existing.response_payload);
            return this.completeRelease(operationKey, confirmation, stored.phoneNumberId ? stored : {
              phoneNumberId, number: confirmedNumber, ownership: null, permanentlyReleasesNumber: false,
            }, true);
          }
          if (error.code === 'cartesia_phone_number_release_outcome_unknown') throw error;
          throw phoneNumberError('cartesia_phone_number_release_outcome_unknown', 'Phone number release outcome is unknown; inspect Cartesia before retrying', 409);
        }
      }
      throw phoneNumberError('cartesia_phone_number_operation_failed', 'This phone release operation key has already been consumed', 409);
    }

    const preview = await this.prepareRelease(phoneNumberId);
    if (confirmation !== preview.requestFingerprint || confirmedNumber !== preview.number) {
      throw phoneNumberError('cartesia_phone_number_confirmation_mismatch', 'Approval must match the current number release preview and typed E.164 number', 409);
    }
    const reservation = await this.db.reserveOutboundCallIdempotency({
      idempotency_key: operationKey, provider: 'cartesia', request_hash: preview.requestFingerprint,
    }).catch(() => { throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503); });
    if (!reservation?.reserved) {
      throw phoneNumberError('cartesia_phone_number_release_outcome_unknown', 'Phone release is already reserved; inspect Cartesia before retrying', 409);
    }
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: preview.requestFingerprint,
      status: 'pending',
      response_payload: {
        phoneNumberId,
        number: preview.number,
        ownership: preview.ownership,
        permanentlyReleasesNumber: preview.permanentlyReleasesNumber,
        deleted: false,
      },
    }).catch(() => {
      throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia release intent could not be stored; no release was submitted', 503);
    });
    try {
      await this.client.deletePhoneNumber(phoneNumberId);
      return await this.completeRelease(operationKey, preview.requestFingerprint, {
        phoneNumberId,
        number: preview.number,
        ownership: preview.ownership,
        permanentlyReleasesNumber: preview.permanentlyReleasesNumber,
        deleted: true,
      }, false);
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey, provider: 'cartesia', request_hash: preview.requestFingerprint,
          status: 'failed', error_message: 'cartesia_phone_number_release_rejected',
        }).catch(() => {});
        throw phoneNumberError('cartesia_phone_number_release_rejected', 'Cartesia rejected the phone number release', error.status);
      }
      try {
        await this.get(phoneNumberId);
      } catch (readError) {
        if (readError instanceof CartesiaApiError && readError.status === 404) {
          return this.completeRelease(operationKey, preview.requestFingerprint, {
            phoneNumberId, number: preview.number, ownership: preview.ownership,
            permanentlyReleasesNumber: preview.permanentlyReleasesNumber, deleted: true,
          }, false);
        }
      }
      throw phoneNumberError('cartesia_phone_number_release_outcome_unknown', 'Cartesia number release outcome is unknown; inspect the number before retrying', 409);
    }
  }

  async completeRelease(operationKey, requestFingerprint, result, idempotentReplay) {
    const completed = { ...result, requestFingerprint, idempotentReplay, deleted: true };
    try {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: operationKey, provider: 'cartesia', request_hash: requestFingerprint,
        status: 'completed', response_payload: completed,
      });
    } catch {
      throw phoneNumberError('cartesia_phone_number_release_persistence_failed', 'Cartesia released the number but local confirmation could not be saved; inspect inventory before retrying', 503);
    }
    return completed;
  }

  async assignAgent(input = {}) {
    this.ensureEnabled();
    if (!this.mutationsEnabled) {
      throw phoneNumberError('cartesia_phone_number_mutations_disabled', 'Cartesia phone number changes are disabled', 503);
    }
    const phoneNumberId = this.normalizeId(input.phoneNumberId || input.phone_number_id);
    const agentId = this.normalizeAgentId(input.agentId !== undefined ? input.agentId : input.agent_id);
    const idempotencyKey = String(input.idempotencyKey || input.idempotency_key || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
      throw phoneNumberError('cartesia_idempotency_key_required', 'A valid Cartesia operation idempotency key is required');
    }
    const confirmedFingerprint = String(input.confirmedFingerprint || input.confirmed_fingerprint || '').trim().toLowerCase();
    if (input.approved !== true || !/^[a-f0-9]{64}$/.test(confirmedFingerprint)) {
      throw phoneNumberError('cartesia_phone_number_confirmation_mismatch', 'Explicit approval and the assignment preview fingerprint are required', 409);
    }
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const operationKey = `voicednut:cartesia:phone_assignment:${idempotencyKey}`;
    let existing;
    try {
      existing = await this.db.getOutboundCallIdempotency(operationKey);
    } catch {
      throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const replay = this.resolveIdempotency(existing, confirmedFingerprint);
    if (replay) return replay;

    const preview = await this.prepareAssignment(phoneNumberId, agentId);
    if (confirmedFingerprint !== preview.requestFingerprint) {
      throw phoneNumberError('cartesia_phone_number_confirmation_mismatch', 'Explicit approval must match the current assignment preview', 409);
    }
    if (!preview.requiresChange) return { ...preview, changed: false, idempotentReplay: false };

    if (!existing) {
      let reserved;
      try {
        reserved = await this.db.reserveOutboundCallIdempotency({
          idempotency_key: operationKey,
          provider: 'cartesia',
          request_hash: preview.requestFingerprint,
        });
      } catch {
        throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
      }
      if (!reserved?.reserved) {
        let raced;
        try {
          raced = await this.db.getOutboundCallIdempotency(operationKey);
        } catch {
          throw phoneNumberError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
        }
        const racedReplay = this.resolveIdempotency(raced, confirmedFingerprint);
        if (racedReplay) return racedReplay;
        throw phoneNumberError('cartesia_phone_assignment_in_progress', 'A prior phone number assignment is unresolved; inspect Cartesia before retrying', 409);
      }
    }

    let providerPayload;
    try {
      providerPayload = await this.client.updatePhoneNumber(phoneNumberId, { agent_id: agentId });
      const assigned = normalizePhoneNumber(providerPayload, phoneNumberId);
      if ((assigned.agent?.id || null) !== agentId) {
        throw phoneNumberError('cartesia_phone_assignment_unconfirmed', 'Cartesia did not confirm the requested phone number assignment', 502);
      }
      return await this.completeAssignment(operationKey, preview, assigned, false);
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey,
          provider: 'cartesia',
          request_hash: preview.requestFingerprint,
          status: 'failed',
          error_message: 'cartesia_phone_assignment_rejected',
        }).catch(() => {});
        throw phoneNumberError('cartesia_phone_assignment_rejected', 'Cartesia rejected the phone number assignment', error.status);
      }
      // A network error after PATCH has an ambiguous outcome. Read the number
      // once to reconcile; never submit the same external change again here.
      try {
        const current = await this.get(phoneNumberId);
        if ((current.agent?.id || null) === agentId) {
          return await this.completeAssignment(operationKey, preview, current, false);
        }
      } catch { /* Preserve the unresolved reservation for operator reconciliation. */ }
      throw phoneNumberError('cartesia_phone_assignment_outcome_unknown', 'Cartesia assignment outcome is unknown; inspect the current number before retrying', 409);
    }
  }

  resolveIdempotency(existing, requestFingerprint) {
    if (!existing) return null;
    if (existing.provider !== 'cartesia' || existing.request_hash !== requestFingerprint) {
      throw phoneNumberError('cartesia_idempotency_conflict', 'Cartesia idempotency key was already used for a different assignment', 409);
    }
    if (existing.status !== 'completed') {
      throw phoneNumberError('cartesia_phone_assignment_outcome_unknown', 'A prior assignment may have been applied; inspect the current number before retrying', 409);
    }
    const stored = parseStoredPayload(existing.response_payload);
    if (!stored.phoneNumberId || !stored.requestFingerprint) {
      throw phoneNumberError('cartesia_idempotency_state_invalid', 'Cartesia assignment idempotency state is invalid', 409);
    }
    return { ...stored, idempotentReplay: true };
  }

  async completeAssignment(operationKey, preview, assigned, idempotentReplay) {
    const result = {
      phoneNumberId: assigned.id,
      number: assigned.number,
      ownership: assigned.ownership,
      providerType: assigned.provider.type,
      previousAgentId: preview.currentAgentId,
      agentId: assigned.agent?.id || null,
      changed: true,
      requestFingerprint: preview.requestFingerprint,
      idempotentReplay,
    };
    try {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: operationKey,
        provider: 'cartesia',
        request_hash: preview.requestFingerprint,
        status: 'completed',
        response_payload: result,
      });
    } catch {
      throw phoneNumberError('cartesia_phone_assignment_persistence_failed', 'Cartesia changed the assignment but local confirmation could not be saved; inspect the number before retrying', 503);
    }
    return result;
  }
}

module.exports = {
  CartesiaPhoneNumberService,
  normalizePhoneNumber,
  normalizeListQuery,
};
