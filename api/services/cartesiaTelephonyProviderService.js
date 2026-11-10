const crypto = require('node:crypto');
const net = require('node:net');
const { domainToASCII } = require('node:url');
const { CartesiaApiError } = require('./cartesiaClient');

const SIP_MEDIA_ENCRYPTION = new Set(['allowed', 'required', 'disabled']);

function providerError(code, message, status = 400) {
  const error = new Error(message);
  error.name = 'CartesiaTelephonyProviderError';
  error.code = code;
  error.status = status;
  return error;
}

function safeText(value, limit = 200) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, limit) : null;
}

function normalizeProvider(value) {
  const id = safeText(value?.id);
  const type = String(value?.type || '').trim().toLowerCase();
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id) || !['twilio', 'sip_trunk'].includes(type)) {
    throw providerError('cartesia_invalid_provider_response', 'Cartesia returned an invalid telephony provider', 502);
  }
  return Object.freeze({
    id,
    type,
    label: safeText(value.label, 200),
    region: type === 'twilio' ? safeText(value.region, 40) : null,
    inboundConfigured: type === 'sip_trunk' ? Boolean(value.inbound && typeof value.inbound === 'object') : null,
    outboundConfigured: type === 'sip_trunk' ? Boolean(value.outbound && typeof value.outbound === 'object') : null,
  });
}

function normalizeCredential(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw providerError('cartesia_sip_configuration_invalid', `${fieldName} authentication credentials are required`);
  }
  if (Object.keys(value).some((key) => !['username', 'password'].includes(key))) {
    throw providerError('cartesia_sip_configuration_invalid', `${fieldName} authentication fields are invalid`);
  }
  const username = typeof value.username === 'string' ? value.username.trim() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (!username || username.length > 128 || /[\r\n\u0000]/.test(username) ||
      !password || password.length > 256 || /[\r\n\u0000]/.test(password)) {
    throw providerError('cartesia_sip_configuration_invalid', `${fieldName} authentication credentials are invalid`);
  }
  return { username, password };
}

function normalizeSIPHost(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input || /[\/@?#\\]/.test(input)) {
    throw providerError('cartesia_sip_configuration_invalid', 'SIP outbound address must be a carrier hostname with an optional port and no sip: prefix');
  }
  const colon = input.lastIndexOf(':');
  const hostInput = colon > -1 ? input.slice(0, colon) : input;
  const portInput = colon > -1 ? input.slice(colon + 1) : '';
  if (colon > -1 && (!/^\d{1,5}$/.test(portInput) || Number(portInput) < 1 || Number(portInput) > 65535)) {
    throw providerError('cartesia_sip_configuration_invalid', 'SIP outbound port must be between 1 and 65535');
  }
  const ascii = domainToASCII(hostInput.toLowerCase());
  if (!ascii || ascii.length > 253 || /[:/@?#\\]/.test(ascii) || net.isIP(ascii) ||
      ascii === 'localhost' || /\.(?:localhost|local|internal|test)$/.test(ascii)) {
    throw providerError('cartesia_sip_configuration_invalid', 'SIP outbound address must be a carrier hostname with an optional port and no sip: prefix');
  }
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw providerError('cartesia_sip_configuration_invalid', 'SIP outbound address must be a carrier hostname with an optional port and no sip: prefix');
  }
  return `${ascii}${portInput ? `:${Number(portInput)}` : ''}`;
}

function normalizeAllowedAddresses(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw providerError('cartesia_sip_configuration_invalid', 'Inbound allowed_addresses must be an array of at most 32 CIDR ranges');
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() !== entry || entry.length > 100) {
      throw providerError('cartesia_sip_configuration_invalid', 'Inbound allowed_addresses contains an invalid CIDR range');
    }
    const [address, prefixText, extra] = entry.split('/');
    const family = net.isIP(address);
    const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
    const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
    if (extra !== undefined || maxPrefix < 0 || !Number.isInteger(prefix) || prefix < 1 || prefix > maxPrefix) {
      throw providerError('cartesia_sip_configuration_invalid', 'Inbound allowed_addresses must contain valid non-wildcard IPv4 or IPv6 CIDR ranges');
    }
    return `${address.toLowerCase()}${prefixText === undefined ? '' : `/${prefix}`}`;
  });
}

function normalizeAllowedNumbers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw providerError('cartesia_sip_configuration_invalid', 'Inbound allowed_numbers must be an array of at most 100 E.164 numbers');
  }
  return value.map((number) => {
    if (typeof number !== 'string' || !/^\+[1-9]\d{1,14}$/.test(number)) {
      throw providerError('cartesia_sip_configuration_invalid', 'Inbound allowed_numbers must contain valid E.164 numbers');
    }
    return number;
  });
}

function normalizeSIPInput(input = {}, fingerprintSecret) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => ![
        'label', 'inbound', 'outbound', 'idempotencyKey', 'idempotency_key',
        'approved', 'confirmedFingerprint', 'confirmed_fingerprint',
      ].includes(key))) {
    throw providerError('cartesia_sip_configuration_invalid', 'SIP provider configuration fields are invalid');
  }
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const idempotencyKey = String(input.idempotencyKey || input.idempotency_key || '').trim();
  if (!label || label.length > 80 || /[\r\n\u0000]/.test(label)) {
    throw providerError('cartesia_sip_configuration_invalid', 'A SIP provider label of 1 to 80 characters is required');
  }
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
    throw providerError('cartesia_idempotency_key_required', 'A valid SIP provider idempotency key is required');
  }
  if (typeof fingerprintSecret !== 'string' || fingerprintSecret.length < 16) {
    throw providerError('cartesia_not_configured', 'Cartesia server credentials are not configured', 503);
  }
  const inbound = input.inbound && typeof input.inbound === 'object' && !Array.isArray(input.inbound)
    ? input.inbound
    : {};
  const outbound = input.outbound && typeof input.outbound === 'object' && !Array.isArray(input.outbound)
    ? input.outbound
    : {};
  if (Object.keys(inbound).some((key) => !['credentials', 'media_encryption', 'allowed_addresses', 'allowed_numbers'].includes(key)) ||
      Object.keys(outbound).some((key) => !['credentials', 'address', 'transport', 'destination_country', 'media_encryption'].includes(key))) {
    throw providerError('cartesia_sip_configuration_invalid', 'SIP inbound or outbound configuration fields are invalid');
  }
  const inboundCredentials = inbound.credentials === undefined ? null : normalizeCredential(inbound.credentials, 'Inbound SIP');
  const outboundCredentials = outbound.credentials === undefined ? null : normalizeCredential(outbound.credentials, 'Outbound SIP');
  const allowedAddresses = normalizeAllowedAddresses(inbound.allowed_addresses);
  const allowedNumbers = normalizeAllowedNumbers(inbound.allowed_numbers);
  if (!inboundCredentials && allowedAddresses.length === 0 && allowedNumbers.length === 0) {
    throw providerError('cartesia_sip_configuration_invalid', 'Inbound SIP requires digest credentials, a source IP allowlist, or an allowed-number list');
  }
  const inboundMediaEncryption = String(inbound.media_encryption || '').trim().toLowerCase();
  const outboundMediaEncryption = String(outbound.media_encryption || '').trim().toLowerCase();
  if (!SIP_MEDIA_ENCRYPTION.has(inboundMediaEncryption) || !SIP_MEDIA_ENCRYPTION.has(outboundMediaEncryption)) {
    throw providerError('cartesia_sip_configuration_invalid', 'Inbound and outbound media_encryption must be allowed, required, or disabled');
  }
  const transport = String(outbound.transport || '').trim().toLowerCase();
  if (!['tls', 'tcp'].includes(transport)) {
    throw providerError('cartesia_sip_configuration_invalid', 'SIP outbound transport must be tls or tcp');
  }
  const destinationCountry = String(outbound.destination_country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(destinationCountry)) {
    throw providerError('cartesia_sip_configuration_invalid', 'SIP destination_country must be a two-letter country code');
  }
  const operationMarker = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16);
  const providerLabel = `${label} [VOICEDNUT-${operationMarker}]`;
  const request = {
    type: 'sip_trunk',
    label: providerLabel,
    inbound: {
      ...(inboundCredentials ? { credentials: inboundCredentials } : {}),
      ...(allowedAddresses.length ? { allowed_addresses: allowedAddresses } : {}),
      ...(allowedNumbers.length ? { allowed_numbers: allowedNumbers } : {}),
      media_encryption: inboundMediaEncryption,
    },
    outbound: {
      address: normalizeSIPHost(outbound.address),
      transport,
      destination_country: destinationCountry,
      media_encryption: outboundMediaEncryption,
      ...(outboundCredentials ? { credentials: outboundCredentials } : {}),
    },
  };
  const requestFingerprint = crypto.createHmac('sha256', fingerprintSecret)
    .update(JSON.stringify(request))
    .digest('hex');
  return Object.freeze({
    request,
    requestFingerprint,
    idempotencyKey,
    preview: Object.freeze({
      type: 'sip_trunk',
      label: providerLabel,
      inboundAccessControl: inboundCredentials
        ? (allowedAddresses.length ? 'digest_credentials_and_source_ip_allowlist' : 'digest_credentials')
        : (allowedAddresses.length ? 'source_ip_allowlist' : 'allowed_numbers'),
      inboundAllowedAddressCount: allowedAddresses.length,
      inboundAllowedNumberCount: allowedNumbers.length,
      inboundCredentialsConfigured: Boolean(inboundCredentials),
      outboundCredentialsConfigured: Boolean(outboundCredentials),
      inboundMediaEncryption,
      outboundAddress: request.outbound.address,
      outboundTransport: transport,
      outboundDestinationCountry: destinationCountry,
      outboundMediaEncryption,
      operationReference: operationMarker,
      requestFingerprint,
    }),
  });
}

function normalizeTwilioInput(input = {}, fingerprintSecret) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => ![
        'label', 'account_sid', 'api_key_sid', 'api_key_secret', 'region', 'idempotency_key',
        'approved', 'confirmed_fingerprint', 'confirm_account_sid',
      ].includes(key))) {
    throw providerError('cartesia_twilio_provider_configuration_invalid', 'Twilio provider fields are invalid');
  }
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const accountSid = String(input.account_sid || '').trim();
  const apiKeySid = String(input.api_key_sid || '').trim();
  const apiKeySecret = typeof input.api_key_secret === 'string' ? input.api_key_secret : '';
  const region = String(input.region || 'us1').trim().toLowerCase();
  const idempotencyKey = String(input.idempotency_key || '').trim();
  if (!label || label.length > 80 || /[\r\n\u0000]/.test(label) ||
      !/^AC[0-9a-fA-F]{32}$/.test(accountSid) || !/^SK[0-9a-fA-F]{32}$/.test(apiKeySid) ||
      apiKeySecret.length < 16 || apiKeySecret.length > 128 || /[\r\n\u0000]/.test(apiKeySecret) ||
      !['us1', 'ie1', 'au1'].includes(region) || !/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
    throw providerError('cartesia_twilio_provider_configuration_invalid', 'Twilio provider credentials, region, label, or idempotency key are invalid');
  }
  if (typeof fingerprintSecret !== 'string' || fingerprintSecret.length < 16) {
    throw providerError('cartesia_not_configured', 'Cartesia server credentials are not configured', 503);
  }
  const request = {
    type: 'twilio',
    account_sid: accountSid,
    api_key_sid: apiKeySid,
    api_key_secret: apiKeySecret,
    region,
    label,
  };
  const requestFingerprint = crypto.createHmac('sha256', fingerprintSecret)
    .update(JSON.stringify(request))
    .digest('hex');
  return Object.freeze({
    request,
    requestFingerprint,
    idempotencyKey,
    preview: Object.freeze({
      type: 'twilio',
      label,
      accountSid,
      apiKeySidSuffix: apiKeySid.slice(-6),
      region,
      requestFingerprint,
    }),
  });
}

function normalizeTwilioUpdateInput(input = {}, fingerprintSecret) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => ![
        'provider_id', 'api_key_sid', 'api_key_secret', 'region', 'idempotency_key',
        'approved', 'confirmed_fingerprint', 'confirm_provider_id',
      ].includes(key))) {
    throw providerError('cartesia_twilio_provider_update_invalid', 'Twilio provider update fields are invalid');
  }
  const providerId = String(input.provider_id || '').trim();
  const apiKeySid = String(input.api_key_sid || '').trim();
  const apiKeySecret = typeof input.api_key_secret === 'string' ? input.api_key_secret : '';
  const region = String(input.region || 'us1').trim().toLowerCase();
  const idempotencyKey = String(input.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(providerId) || !/^SK[0-9a-fA-F]{32}$/.test(apiKeySid) ||
      apiKeySecret.length < 16 || apiKeySecret.length > 128 || /[\r\n\u0000]/.test(apiKeySecret) ||
      !['us1', 'ie1', 'au1'].includes(region) || !/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
    throw providerError('cartesia_twilio_provider_update_invalid', 'A provider ID, valid Twilio API key, region, and idempotency key are required');
  }
  if (typeof fingerprintSecret !== 'string' || fingerprintSecret.length < 16) {
    throw providerError('cartesia_not_configured', 'Cartesia server credentials are not configured', 503);
  }
  const request = { type: 'twilio', api_key_sid: apiKeySid, api_key_secret: apiKeySecret, region };
  const requestFingerprint = crypto.createHmac('sha256', fingerprintSecret)
    .update(JSON.stringify({ providerId, request }))
    .digest('hex');
  return Object.freeze({
    providerId,
    request,
    requestFingerprint,
    idempotencyKey,
    preview: Object.freeze({
      operation: 'twilio_provider_credential_update',
      providerId,
      apiKeySidSuffix: apiKeySid.slice(-4),
      region,
      requestFingerprint,
    }),
  });
}

function normalizeSIPUpdateInput(input = {}, fingerprintSecret) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => ![
        'provider_id', 'inbound', 'outbound', 'idempotency_key', 'approved',
        'confirmed_fingerprint', 'confirm_provider_id', 'confirm_linked_number_count',
      ].includes(key))) {
    throw providerError('cartesia_sip_provider_update_invalid', 'SIP provider update fields are invalid');
  }
  const providerId = normalizeProviderId(input.provider_id);
  const idempotencyKey = String(input.idempotency_key || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
    throw providerError('cartesia_idempotency_key_required', 'A valid SIP provider update idempotency key is required');
  }
  const normalized = normalizeSIPInput({
    label: 'VOICEDNUT SIP update preview',
    inbound: input.inbound,
    outbound: input.outbound,
    idempotency_key: idempotencyKey,
  }, fingerprintSecret);
  const { label: _ignoredLabel, ...requestBody } = normalized.request;
  const request = { ...requestBody };
  const requestFingerprint = crypto.createHmac('sha256', fingerprintSecret)
    .update(JSON.stringify({ providerId, request }))
    .digest('hex');
  return Object.freeze({
    providerId,
    request,
    requestFingerprint,
    idempotencyKey,
    preview: Object.freeze({
      operation: 'sip_provider_update',
      providerId,
      inboundAccessControl: normalized.preview.inboundAccessControl,
      inboundAllowedAddressCount: normalized.preview.inboundAllowedAddressCount,
      inboundAllowedNumberCount: normalized.preview.inboundAllowedNumberCount,
      inboundCredentialsConfigured: normalized.preview.inboundCredentialsConfigured,
      outboundCredentialsConfigured: normalized.preview.outboundCredentialsConfigured,
      inboundMediaEncryption: normalized.preview.inboundMediaEncryption,
      outboundAddress: normalized.preview.outboundAddress,
      outboundTransport: normalized.preview.outboundTransport,
      outboundDestinationCountry: normalized.preview.outboundDestinationCountry,
      outboundMediaEncryption: normalized.preview.outboundMediaEncryption,
      requestFingerprint,
    }),
  });
}

function normalizeProviderId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw providerError('cartesia_invalid_provider_id', 'Cartesia telephony provider ID is invalid');
  }
  return id;
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

class CartesiaTelephonyProviderService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.enabled = options.enabled === true;
    this.sipMutationsEnabled = options.sipMutationsEnabled === true;
    this.providerMutationsEnabled = options.providerMutationsEnabled === true;
    this.fingerprintSecret = String(options.fingerprintSecret || '');
  }

  ensureEnabled() {
    const clientConfigured = this.client?.isReadConfigured?.() ?? this.client?.isConfigured?.();
    if (!this.enabled || !clientConfigured) {
      throw providerError('cartesia_not_configured', 'Cartesia Managed Agents is disabled or not configured', 503);
    }
  }

  async listProviders() {
    this.ensureEnabled();
    const payload = await this.client.listTelephonyProviders();
    if (!Array.isArray(payload) || payload.length > 500) {
      throw providerError('cartesia_invalid_provider_list', 'Cartesia returned an invalid telephony provider list', 502);
    }
    return payload.map(normalizeProvider);
  }

  async getProvider(providerId) {
    this.ensureEnabled();
    const id = normalizeProviderId(providerId);
    const payload = await this.client.getTelephonyProvider(id);
    const provider = normalizeProvider(payload);
    if (provider.id !== id) {
      throw providerError('cartesia_invalid_provider_response', 'Cartesia returned a different telephony provider than requested', 502);
    }
    return provider;
  }

  async countLinkedPhoneNumbers(providerId) {
    let cursor;
    let total = 0;
    for (let page = 0; page < 100; page += 1) {
      const payload = await this.client.listPhoneNumbers({ limit: 100, provider_id: providerId, ...(cursor ? { starting_after: cursor } : {}) });
      if (!payload || !Array.isArray(payload.data) || typeof payload.has_more !== 'boolean' || payload.data.length > 100) {
        throw providerError('cartesia_invalid_phone_number_list', 'Cartesia returned an invalid phone number list while checking provider usage', 502);
      }
      for (const item of payload.data) {
        const id = String(item?.id || '').trim();
        const linkedProviderId = String(item?.provider?.id || '').trim();
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || linkedProviderId !== providerId) {
          throw providerError('cartesia_invalid_phone_number_list', 'Cartesia returned an inconsistent phone number provider association', 502);
        }
      }
      total += payload.data.length;
      if (!payload.has_more) return total;
      const nextCursor = String(payload.data.at(-1)?.id || '').trim();
      if (!nextCursor || nextCursor === cursor) {
        throw providerError('cartesia_invalid_phone_number_list', 'Cartesia phone number pagination could not be safely completed', 502);
      }
      cursor = nextCursor;
    }
    throw providerError('cartesia_provider_phone_number_limit_exceeded', 'Cartesia returned more than 10,000 linked numbers; provider deletion is blocked until inventory can be fully checked', 409);
  }

  async prepareProviderDeletion(providerId) {
    this.ensureEnabled();
    const id = normalizeProviderId(providerId);
    const provider = await this.getProvider(id);
    const linkedPhoneNumberCount = await this.countLinkedPhoneNumbers(id);
    const details = { providerId: id, type: provider.type, label: provider.label, linkedPhoneNumberCount };
    const requestFingerprint = crypto.createHmac('sha256', this.fingerprintSecret)
      .update(JSON.stringify(details))
      .digest('hex');
    return Object.freeze({
      operation: 'telephony_provider_delete',
      ...details,
      requestFingerprint,
      irreversible: true,
      canDelete: linkedPhoneNumberCount === 0 && Boolean(details.label),
    });
  }

  async deleteProvider(input = {}) {
    this.ensureEnabled();
    if (!this.providerMutationsEnabled) {
      throw providerError('cartesia_telephony_provider_mutations_disabled', 'Cartesia telephony provider changes are disabled', 503);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => !['provider_id', 'idempotency_key', 'approved', 'confirmed_fingerprint', 'confirm_label'].includes(key))) {
      throw providerError('cartesia_provider_delete_invalid', 'Telephony provider deletion fields are invalid');
    }
    const providerId = normalizeProviderId(input.provider_id);
    const idempotencyKey = String(input.idempotency_key || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
      throw providerError('cartesia_idempotency_key_required', 'A valid telephony provider deletion idempotency key is required');
    }
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const operationKey = `voicednut:cartesia:provider_delete:${idempotencyKey}`;
    const existing = await this.db.getOutboundCallIdempotency(operationKey).catch(() => {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    });
    if (existing) {
      if (existing.provider !== 'cartesia') throw providerError('cartesia_idempotency_conflict', 'Provider deletion idempotency key was already used for a different operation', 409);
      if (existing.status === 'completed') {
        const stored = parseStoredPayload(existing.response_payload);
        if (stored.providerId !== providerId) throw providerError('cartesia_idempotency_conflict', 'Provider deletion idempotency key was already used for a different provider', 409);
        return { ...stored, idempotentReplay: true };
      }
      if (existing.status === 'pending') {
        const remaining = await this.findProviderById(providerId).catch(() => null);
        if (!remaining) {
          return this.completeProviderDeletion(operationKey, existing.request_hash, { providerId, type: null }, true);
        }
        throw providerError('cartesia_provider_delete_outcome_unknown', 'Provider deletion may have succeeded; inspect Cartesia provider inventory before retrying', 409);
      }
      throw providerError('cartesia_provider_delete_operation_failed', 'This provider deletion operation key has already been consumed', 409);
    }

    const preview = await this.prepareProviderDeletion(providerId);
    const requestFingerprint = preview.requestFingerprint;
    if (input.approved !== true || String(input.confirmed_fingerprint || '').trim().toLowerCase() !== requestFingerprint ||
        input.confirm_label !== preview.label || !preview.label || preview.linkedPhoneNumberCount !== 0) {
      throw providerError('cartesia_provider_delete_confirmation_mismatch', 'Deletion requires a current preview, zero linked numbers, explicit approval, and the exact provider label', 409);
    }

    const linkedCount = await this.countLinkedPhoneNumbers(preview.providerId);
    if (linkedCount !== 0) {
      throw providerError('cartesia_provider_has_linked_numbers', 'Delete or import elsewhere all phone numbers linked to this provider before deleting it', 409);
    }
    const reservation = await this.db.reserveOutboundCallIdempotency({
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: requestFingerprint,
    }).catch(() => { throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503); });
    if (!reservation?.reserved) {
      throw providerError('cartesia_provider_delete_outcome_unknown', 'Provider deletion is already reserved; inspect Cartesia provider inventory before retrying', 409);
    }

    try {
      await this.client.deleteTelephonyProvider(preview.providerId);
      return await this.completeProviderDeletion(operationKey, requestFingerprint, preview, false);
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey, provider: 'cartesia', request_hash: requestFingerprint,
          status: 'failed', error_message: 'cartesia_provider_delete_rejected',
        }).catch(() => {});
        throw providerError('cartesia_provider_delete_rejected', 'Cartesia rejected the telephony provider deletion', error.status);
      }
      const remaining = await this.findProviderById(preview.providerId).catch(() => null);
      if (!remaining) return this.completeProviderDeletion(operationKey, requestFingerprint, preview, false);
      throw providerError('cartesia_provider_delete_outcome_unknown', 'Provider deletion outcome is unknown; inspect Cartesia provider inventory before retrying', 409);
    }
  }

  async findProviderById(providerId) {
    const providers = await this.listProviders();
    const matches = providers.filter((provider) => provider.id === providerId);
    if (matches.length > 1) throw providerError('cartesia_provider_ambiguous', 'Cartesia returned duplicate telephony provider IDs', 502);
    return matches[0] || null;
  }

  async completeProviderDeletion(operationKey, requestFingerprint, preview, idempotentReplay) {
    const result = {
      deleted: true,
      providerId: preview.providerId,
      providerType: preview.type,
      requestFingerprint,
      idempotentReplay,
    };
    try {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: operationKey,
        provider: 'cartesia',
        request_hash: requestFingerprint,
        status: 'completed',
        response_payload: result,
      });
    } catch {
      throw providerError('cartesia_provider_persistence_failed', 'Cartesia deleted the provider but local confirmation could not be saved; inspect provider inventory before retrying', 503);
    }
    return result;
  }

  normalizeInput(input) {
    return normalizeSIPInput(input, this.fingerprintSecret);
  }

  async previewSIPProvider(input = {}) {
    this.ensureEnabled();
    return this.normalizeInput(input).preview;
  }

  normalizeTwilioInput(input) {
    return normalizeTwilioInput(input, this.fingerprintSecret);
  }

  async previewTwilioProvider(input = {}) {
    this.ensureEnabled();
    const normalized = this.normalizeTwilioInput(input);
    const existing = await this.findTwilioProvider(normalized.request.account_sid, normalized.request.region);
    if (existing) {
      throw providerError('cartesia_twilio_provider_already_linked', 'This Twilio account and region are already linked to Cartesia', 409);
    }
    return normalized.preview;
  }

  async previewSIPProviderUpdate(input = {}) {
    this.ensureEnabled();
    const normalized = normalizeSIPUpdateInput(input, this.fingerprintSecret);
    const provider = await this.getProvider(normalized.providerId);
    if (provider.type !== 'sip_trunk') {
      throw providerError('cartesia_sip_provider_not_found', 'The selected Cartesia provider is not a SIP trunk', 404);
    }
    const linkedPhoneNumberCount = await this.countLinkedPhoneNumbers(normalized.providerId);
    return Object.freeze({
      ...normalized.preview,
      currentLabel: provider.label,
      linkedPhoneNumberCount,
      mayAffectLinkedNumbers: linkedPhoneNumberCount > 0,
    });
  }

  async updateSIPProvider(input = {}) {
    this.ensureEnabled();
    if (!this.sipMutationsEnabled) {
      throw providerError('cartesia_sip_provider_mutations_disabled', 'Cartesia SIP provider changes are disabled', 503);
    }
    const normalized = normalizeSIPUpdateInput(input, this.fingerprintSecret);
    const preview = await this.previewSIPProviderUpdate(input);
    if (input.approved !== true ||
        String(input.confirmed_fingerprint || '').trim().toLowerCase() !== normalized.requestFingerprint ||
        input.confirm_provider_id !== normalized.providerId ||
        typeof input.confirm_linked_number_count !== 'number' || !Number.isSafeInteger(input.confirm_linked_number_count) ||
        input.confirm_linked_number_count !== preview.linkedPhoneNumberCount) {
      throw providerError('cartesia_sip_provider_update_confirmation_mismatch', 'Approval, preview fingerprint, typed provider ID, and linked-number count must match', 409);
    }
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const operationKey = `voicednut:cartesia:sip_provider_update:${normalized.idempotencyKey}`;
    const existing = await this.db.getOutboundCallIdempotency(operationKey).catch(() => {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    });
    if (existing) {
      if (existing.provider !== 'cartesia' || existing.request_hash !== normalized.requestFingerprint) {
        throw providerError('cartesia_idempotency_conflict', 'SIP provider update idempotency key was already used for a different request', 409);
      }
      if (existing.status === 'completed') return { ...parseStoredPayload(existing.response_payload), idempotentReplay: true };
      if (existing.status === 'pending') {
        throw providerError('cartesia_sip_provider_update_outcome_unknown', 'SIP provider update may have succeeded; inspect Cartesia provider details before retrying', 409);
      }
      throw providerError('cartesia_sip_provider_update_failed', 'This SIP provider update key has already been consumed', 409);
    }
    const currentLinkedCount = await this.countLinkedPhoneNumbers(normalized.providerId);
    if (currentLinkedCount !== preview.linkedPhoneNumberCount) {
      throw providerError('cartesia_sip_provider_update_preview_stale', 'The SIP provider linked-number count changed after preview; create a new preview before updating', 409);
    }
    const reservation = await this.db.reserveOutboundCallIdempotency({
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: normalized.requestFingerprint,
    }).catch(() => { throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503); });
    if (!reservation?.reserved) {
      throw providerError('cartesia_sip_provider_update_outcome_unknown', 'SIP provider update is already reserved; inspect Cartesia provider details before retrying', 409);
    }
    try {
      const payload = await this.client.updateSipProvider(normalized.providerId, normalized.request);
      const provider = normalizeProvider(payload);
      if (provider.id !== normalized.providerId || provider.type !== 'sip_trunk') {
        throw providerError('cartesia_sip_provider_update_unconfirmed', 'Cartesia did not confirm the expected SIP provider update', 502);
      }
      return await this.completeProvider(operationKey, normalized.requestFingerprint, provider, false);
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey, provider: 'cartesia', request_hash: normalized.requestFingerprint,
          status: 'failed', error_message: 'cartesia_sip_provider_update_rejected',
        }).catch(() => {});
        throw providerError('cartesia_sip_provider_update_rejected', 'Cartesia rejected the SIP provider update', error.status);
      }
      throw providerError('cartesia_sip_provider_update_outcome_unknown', 'SIP provider update outcome is unknown; inspect Cartesia provider details before retrying', 409);
    }
  }

  async previewTwilioProviderUpdate(input = {}) {
    this.ensureEnabled();
    const normalized = normalizeTwilioUpdateInput(input, this.fingerprintSecret);
    const provider = await this.findProviderById(normalized.providerId);
    if (!provider || provider.type !== 'twilio') {
      throw providerError('cartesia_twilio_provider_not_found', 'The selected Cartesia provider is not a linked Twilio provider', 404);
    }
    return Object.freeze({ ...normalized.preview, currentLabel: provider.label });
  }

  async updateTwilioProvider(input = {}) {
    this.ensureEnabled();
    if (!this.providerMutationsEnabled) {
      throw providerError('cartesia_telephony_provider_mutations_disabled', 'Cartesia telephony provider changes are disabled', 503);
    }
    const normalized = normalizeTwilioUpdateInput(input, this.fingerprintSecret);
    const confirmed = String(input.confirmed_fingerprint || '').trim().toLowerCase();
    if (input.approved !== true || confirmed !== normalized.requestFingerprint || input.confirm_provider_id !== normalized.providerId) {
      throw providerError('cartesia_twilio_provider_update_confirmation_mismatch', 'Approval, preview fingerprint, and typed provider ID must match', 409);
    }
    const currentProvider = await this.findProviderById(normalized.providerId).catch(() => {
      throw providerError('cartesia_provider_list_unavailable', 'Cartesia providers could not be checked before updating Twilio credentials', 503);
    });
    if (!currentProvider || currentProvider.type !== 'twilio') {
      throw providerError('cartesia_twilio_provider_not_found', 'The selected Cartesia provider is not a linked Twilio provider', 404);
    }
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const operationKey = `voicednut:cartesia:twilio_provider_update:${normalized.idempotencyKey}`;
    const existing = await this.db.getOutboundCallIdempotency(operationKey).catch(() => {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    });
    if (existing) {
      if (existing.provider !== 'cartesia' || existing.request_hash !== normalized.requestFingerprint) {
        throw providerError('cartesia_idempotency_conflict', 'Twilio credential update idempotency key was already used for a different request', 409);
      }
      if (existing.status === 'completed') return { ...parseStoredPayload(existing.response_payload), idempotentReplay: true };
      if (existing.status === 'pending') {
        throw providerError('cartesia_twilio_provider_update_outcome_unknown', 'Twilio credential update may have succeeded; inspect Cartesia provider details before retrying', 409);
      }
      throw providerError('cartesia_twilio_provider_update_failed', 'This Twilio credential update key has already been consumed', 409);
    }
    const reservation = await this.db.reserveOutboundCallIdempotency({
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: normalized.requestFingerprint,
    }).catch(() => { throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503); });
    if (!reservation?.reserved) {
      throw providerError('cartesia_twilio_provider_update_outcome_unknown', 'Twilio credential update is already reserved; inspect Cartesia provider details before retrying', 409);
    }
    try {
      const payload = await this.client.updateTwilioProvider(normalized.providerId, normalized.request);
      const provider = normalizeProvider(payload);
      if (provider.id !== normalized.providerId || provider.type !== 'twilio' || provider.region !== normalized.request.region) {
        throw providerError('cartesia_twilio_provider_update_unconfirmed', 'Cartesia did not confirm the expected Twilio provider update', 502);
      }
      return await this.completeProvider(operationKey, normalized.requestFingerprint, provider, false);
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey, provider: 'cartesia', request_hash: normalized.requestFingerprint,
          status: 'failed', error_message: 'cartesia_twilio_provider_update_rejected',
        }).catch(() => {});
        throw providerError('cartesia_twilio_provider_update_rejected', 'Cartesia rejected the Twilio credential update; assigned-number reachability may be affected', error.status);
      }
      throw providerError('cartesia_twilio_provider_update_outcome_unknown', 'Twilio credential update outcome is unknown; inspect Cartesia provider details before retrying', 409);
    }
  }

  async createTwilioProvider(input = {}) {
    this.ensureEnabled();
    if (!this.providerMutationsEnabled) {
      throw providerError('cartesia_telephony_provider_mutations_disabled', 'Cartesia telephony provider linking is disabled', 503);
    }
    const normalized = this.normalizeTwilioInput(input);
    const confirmed = String(input.confirmed_fingerprint || '').trim().toLowerCase();
    if (input.approved !== true || confirmed !== normalized.requestFingerprint ||
        input.confirm_account_sid !== normalized.request.account_sid) {
      throw providerError('cartesia_twilio_provider_confirmation_mismatch', 'Approval, preview fingerprint, and typed Twilio account SID must match', 409);
    }
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const operationKey = `voicednut:cartesia:twilio_provider:${normalized.idempotencyKey}`;
    let existing;
    try {
      existing = await this.db.getOutboundCallIdempotency(operationKey);
    } catch {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    if (existing) {
      if (existing.provider !== 'cartesia' || existing.request_hash !== normalized.requestFingerprint) {
        throw providerError('cartesia_idempotency_conflict', 'Twilio provider idempotency key was already used for a different configuration', 409);
      }
      if (existing.status === 'completed') {
        const stored = parseStoredPayload(existing.response_payload);
        if (stored.provider?.type !== 'twilio' || !stored.provider.id) {
          throw providerError('cartesia_idempotency_state_invalid', 'Cartesia Twilio provider idempotency state is invalid', 409);
        }
        return { ...stored, idempotentReplay: true };
      }
      if (existing.status === 'pending') {
        const reconciled = await this.reconcileTwilioProvider(normalized.request.account_sid, normalized.request.region).catch(() => null);
        if (reconciled) return this.completeProvider(operationKey, normalized.requestFingerprint, reconciled, true);
        throw providerError('cartesia_twilio_provider_outcome_unknown', 'Twilio provider linking may have succeeded; inspect Cartesia provider inventory before retrying', 409);
      }
      throw providerError('cartesia_twilio_provider_operation_failed', 'This Twilio provider operation key has already been consumed', 409);
    }
    let existingProvider;
    try {
      existingProvider = await this.findTwilioProvider(normalized.request.account_sid, normalized.request.region);
    } catch {
      throw providerError('cartesia_provider_list_unavailable', 'Cartesia providers could not be checked before linking Twilio', 503);
    }
    if (existingProvider) {
      throw providerError('cartesia_twilio_provider_already_linked', 'This Twilio account and region are already linked to Cartesia', 409);
    }
    const reservation = await this.db.reserveOutboundCallIdempotency({
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: normalized.requestFingerprint,
    }).catch(() => { throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503); });
    if (!reservation?.reserved) {
      throw providerError('cartesia_twilio_provider_outcome_unknown', 'Twilio provider linking is already reserved; inspect Cartesia provider inventory before retrying', 409);
    }
    try {
      const provider = normalizeProvider(await this.client.createTwilioProvider(normalized.request));
      if (provider.type !== 'twilio' || provider.label !== normalized.request.label || provider.region !== normalized.request.region) {
        throw providerError('cartesia_twilio_provider_unconfirmed', 'Cartesia did not confirm the expected Twilio provider record', 502);
      }
      return await this.completeProvider(operationKey, normalized.requestFingerprint, provider, false);
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey, provider: 'cartesia', request_hash: normalized.requestFingerprint,
          status: 'failed', error_message: 'cartesia_twilio_provider_rejected',
        }).catch(() => {});
        throw providerError('cartesia_twilio_provider_rejected', 'Cartesia rejected the Twilio provider configuration', error.status);
      }
      const reconciled = await this.reconcileTwilioProvider(normalized.request.account_sid, normalized.request.region).catch(() => null);
      if (reconciled) return this.completeProvider(operationKey, normalized.requestFingerprint, reconciled, false);
      throw providerError('cartesia_twilio_provider_outcome_unknown', 'Twilio provider linking outcome is unknown; inspect Cartesia provider inventory before retrying', 409);
    }
  }

  async findTwilioProvider(accountSid, region) {
    const payload = await this.client.listTelephonyProviders();
    if (!Array.isArray(payload) || payload.length > 500) {
      throw providerError('cartesia_invalid_provider_list', 'Cartesia returned an invalid telephony provider list', 502);
    }
    const matches = payload.filter((provider) => provider?.type === 'twilio' &&
      provider.account_sid === accountSid && String(provider.region || 'us1').toLowerCase() === region);
    if (matches.length > 1) throw providerError('cartesia_twilio_provider_ambiguous', 'Cartesia returned duplicate Twilio account links', 502);
    return matches.length ? normalizeProvider(matches[0]) : null;
  }

  async reconcileTwilioProvider(accountSid, region) {
    return this.findTwilioProvider(accountSid, region);
  }

  async completeProvider(operationKey, requestFingerprint, provider, idempotentReplay) {
    const result = { provider, requestFingerprint, idempotentReplay };
    try {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: operationKey,
        provider: 'cartesia',
        request_hash: requestFingerprint,
        status: 'completed',
        response_payload: result,
      });
    } catch {
      throw providerError('cartesia_provider_persistence_failed', 'Cartesia linked the provider but local confirmation could not be saved; inspect provider inventory before retrying', 503);
    }
    return result;
  }

  async createSIPProvider(input = {}) {
    this.ensureEnabled();
    if (!this.sipMutationsEnabled) {
      throw providerError('cartesia_sip_provider_mutations_disabled', 'Cartesia SIP provider changes are disabled', 503);
    }
    const normalized = this.normalizeInput(input);
    const confirmed = String(input.confirmedFingerprint || input.confirmed_fingerprint || '').trim().toLowerCase();
    if (input.approved !== true || confirmed !== normalized.requestFingerprint) {
      throw providerError('cartesia_sip_provider_confirmation_mismatch', 'Explicit approval must match the SIP provider preview', 409);
    }
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    const operationKey = `voicednut:cartesia:sip_provider:${normalized.idempotencyKey}`;
    let existing;
    try {
      existing = await this.db.getOutboundCallIdempotency(operationKey);
    } catch {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    if (existing) {
      if (existing.provider !== 'cartesia' || existing.request_hash !== normalized.requestFingerprint) {
        throw providerError('cartesia_idempotency_conflict', 'SIP provider idempotency key was already used for a different configuration', 409);
      }
      if (existing.status === 'completed') {
        const stored = parseStoredPayload(existing.response_payload);
        if (stored.provider?.type !== 'sip_trunk' || !stored.provider.id) {
          throw providerError('cartesia_idempotency_state_invalid', 'Cartesia SIP provider idempotency state is invalid', 409);
        }
        return { ...stored, idempotentReplay: true };
      }
      if (existing.status === 'pending') {
        const reconciled = await this.reconcileProvider(normalized.preview.label);
        if (reconciled) return this.complete(operationKey, normalized, reconciled, true);
        throw providerError('cartesia_sip_provider_outcome_unknown', 'SIP provider creation may have succeeded; inspect the provider list before retrying', 409);
      }
      throw providerError('cartesia_sip_provider_operation_failed', 'This SIP provider operation key has already been consumed', 409);
    }

    let providers;
    try {
      providers = await this.listProviders();
    } catch {
      throw providerError('cartesia_provider_list_unavailable', 'Cartesia providers could not be checked before creating a SIP trunk', 503);
    }
    if (providers.some((provider) => provider.label === normalized.preview.label)) {
      throw providerError('cartesia_sip_provider_label_conflict', 'A Cartesia provider already uses this operation label', 409);
    }

    let reservation;
    try {
      reservation = await this.db.reserveOutboundCallIdempotency({
        idempotency_key: operationKey,
        provider: 'cartesia',
        request_hash: normalized.requestFingerprint,
      });
    } catch {
      throw providerError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    if (!reservation?.reserved) {
      throw providerError('cartesia_sip_provider_outcome_unknown', 'SIP provider creation is already reserved; inspect the provider list before retrying', 409);
    }

    try {
      const payload = await this.client.createSipProvider(normalized.request);
      const provider = normalizeProvider(payload);
      if (provider.type !== 'sip_trunk' || provider.label !== normalized.preview.label) {
        throw providerError('cartesia_sip_provider_unconfirmed', 'Cartesia did not confirm the expected SIP provider record', 502);
      }
      return await this.complete(operationKey, normalized, provider, false);
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey,
          provider: 'cartesia',
          request_hash: normalized.requestFingerprint,
          status: 'failed',
          error_message: 'cartesia_sip_provider_rejected',
        }).catch(() => {});
        throw providerError('cartesia_sip_provider_rejected', 'Cartesia rejected the SIP provider configuration', error.status);
      }
      const reconciled = await this.reconcileProvider(normalized.preview.label).catch(() => null);
      if (reconciled) return this.complete(operationKey, normalized, reconciled, false);
      throw providerError('cartesia_sip_provider_outcome_unknown', 'SIP provider creation outcome is unknown; inspect the provider list before retrying', 409);
    }
  }

  async reconcileProvider(expectedLabel) {
    const providers = await this.listProviders();
    const matches = providers.filter((provider) => provider.label === expectedLabel);
    if (matches.length !== 1 || matches[0].type !== 'sip_trunk') return null;
    return matches[0];
  }

  async complete(operationKey, normalized, provider, idempotentReplay) {
    const result = {
      provider,
      operationReference: normalized.preview.operationReference,
      requestFingerprint: normalized.requestFingerprint,
      idempotentReplay,
    };
    try {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: operationKey,
        provider: 'cartesia',
        request_hash: normalized.requestFingerprint,
        status: 'completed',
        response_payload: result,
      });
    } catch {
      throw providerError('cartesia_sip_provider_persistence_failed', 'Cartesia created the SIP provider but local confirmation could not be saved; inspect the provider list before retrying', 503);
    }
    return result;
  }
}

module.exports = {
  CartesiaTelephonyProviderService,
  normalizeProvider,
  normalizeSIPHost,
  normalizeSIPInput,
};
