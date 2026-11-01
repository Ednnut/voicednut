'use strict';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;
const REGION_PATTERN = /^[a-z0-9-]{2,24}$/;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::\d{1,5})?$/;

function providerError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function cleanString(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw providerError('cartesia_provider_input_invalid', `A valid ${field} is required`, 400);
  }
  return value.trim();
}

function safeProvider(provider = {}) {
  const id = String(provider.id || '').trim();
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    type: ['twilio', 'sip_trunk'].includes(String(provider.type)) ? String(provider.type) : 'unknown',
    label: typeof provider.label === 'string' ? provider.label.slice(0, 80) : '',
    region: typeof provider.region === 'string' ? provider.region.slice(0, 24) : null,
    phone_number_count: Array.isArray(provider.phone_numbers) ? provider.phone_numbers.length : 0,
    // Never copy provider config, credentials, or arbitrary response fields.
  };
}

function safeProviderList(result) {
  const rows = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : Array.isArray(result?.providers) ? result.providers : []);
  return rows.slice(0, 100).map(safeProvider).filter(Boolean);
}

function normalizeSipConfig(input = {}) {
  const output = {};
  if (input.inbound !== undefined) {
    const inbound = input.inbound;
    if (!inbound || typeof inbound !== 'object' || Array.isArray(inbound)) throw providerError('cartesia_provider_input_invalid', 'Inbound SIP configuration must be an object', 400);
    const normalized = {};
    if (inbound.credentials !== undefined) {
      const credentials = inbound.credentials;
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw providerError('cartesia_provider_input_invalid', 'Inbound SIP credentials must be an object', 400);
      normalized.credentials = {
        username: cleanString(credentials.username, 120, 'inbound username'),
        password: cleanString(credentials.password, 512, 'inbound password'),
      };
    }
    if (inbound.allowed_addresses !== undefined) {
      if (!Array.isArray(inbound.allowed_addresses) || inbound.allowed_addresses.length < 1 || inbound.allowed_addresses.length > 100) throw providerError('cartesia_provider_input_invalid', 'Inbound allowed_addresses must contain 1–100 entries', 400);
      normalized.allowed_addresses = inbound.allowed_addresses.map((value) => cleanString(value, 100, 'allowed address'));
    }
    if (inbound.allowed_numbers !== undefined) {
      if (!Array.isArray(inbound.allowed_numbers) || inbound.allowed_numbers.length < 1 || inbound.allowed_numbers.length > 100) throw providerError('cartesia_provider_input_invalid', 'Inbound allowed_numbers must contain 1–100 entries', 400);
      normalized.allowed_numbers = inbound.allowed_numbers.map((value) => cleanString(value, 32, 'allowed number'));
    }
    if (!normalized.credentials && !normalized.allowed_addresses?.length && !normalized.allowed_numbers?.length) {
      throw providerError('cartesia_provider_inbound_access_control_required', 'Inbound SIP requires credentials, allowed addresses, or allowed numbers', 400);
    }
    if (inbound.media_encryption !== undefined) {
      if (!['disabled', 'allowed', 'required'].includes(inbound.media_encryption)) throw providerError('cartesia_provider_input_invalid', 'Inbound media_encryption must be disabled, allowed, or required', 400);
      normalized.media_encryption = inbound.media_encryption;
    }
    output.inbound = normalized;
  }
  if (input.outbound !== undefined) {
    const outbound = input.outbound;
    if (!outbound || typeof outbound !== 'object' || Array.isArray(outbound)) throw providerError('cartesia_provider_input_invalid', 'Outbound SIP configuration must be an object', 400);
    const address = cleanString(outbound.address, 253, 'outbound SIP address');
    if (!HOST_PATTERN.test(address)) throw providerError('cartesia_provider_input_invalid', 'Outbound SIP address must be a host name with an optional port', 400);
    const normalized = { address };
    if (outbound.transport !== undefined) {
      if (!['tcp', 'tls'].includes(outbound.transport)) throw providerError('cartesia_provider_input_invalid', 'Outbound SIP transport must be tcp or tls', 400);
      normalized.transport = outbound.transport;
    }
    if (outbound.destination_country !== undefined) normalized.destination_country = cleanString(outbound.destination_country, 2, 'destination country').toUpperCase();
    if (outbound.destination_country && !/^[A-Z]{2}$/.test(normalized.destination_country)) throw providerError('cartesia_provider_input_invalid', 'Destination country must be a two-letter country code', 400);
    if (outbound.media_encryption !== undefined) {
      if (!['disabled', 'allowed', 'required'].includes(outbound.media_encryption)) throw providerError('cartesia_provider_input_invalid', 'Outbound media_encryption must be disabled, allowed, or required', 400);
      normalized.media_encryption = outbound.media_encryption;
    }
    if (outbound.credentials !== undefined) {
      if (!outbound.credentials || typeof outbound.credentials !== 'object' || Array.isArray(outbound.credentials)) throw providerError('cartesia_provider_input_invalid', 'Outbound SIP credentials must be an object', 400);
      normalized.credentials = {
        username: cleanString(outbound.credentials.username, 120, 'outbound username'),
        password: cleanString(outbound.credentials.password, 512, 'outbound password'),
      };
    }
    output.outbound = normalized;
  }
  if (!output.inbound && !output.outbound) throw providerError('cartesia_provider_input_invalid', 'At least one SIP direction must be configured', 400);
  return output;
}

function normalizeProviderInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw providerError('cartesia_provider_input_invalid', 'A provider object is required', 400);
  const type = String(input.type || '').trim();
  const label = cleanString(input.label, 80, 'provider label');
  if (!LABEL_PATTERN.test(label)) throw providerError('cartesia_provider_input_invalid', 'Provider label contains unsupported characters', 400);
  if (type === 'twilio') {
    if (Object.keys(input).some((key) => !['type', 'label', 'account_sid', 'api_key_sid', 'api_key_secret', 'region', 'confirmation_phrase'].includes(key))) {
      throw providerError('cartesia_provider_input_invalid', 'Provider creation contains unsupported fields', 400);
    }
    const region = cleanString(input.region || '', 24, 'Twilio region');
    if (!REGION_PATTERN.test(region)) throw providerError('cartesia_provider_input_invalid', 'A valid Twilio region is required', 400);
    return {
      type,
      label,
      account_sid: cleanString(input.account_sid, 64, 'Twilio account SID'),
      api_key_sid: cleanString(input.api_key_sid, 64, 'Twilio API key SID'),
      api_key_secret: cleanString(input.api_key_secret, 256, 'Twilio API key secret'),
      region,
    };
  }
  if (type === 'sip_trunk') {
    if (Object.keys(input).some((key) => !['type', 'label', 'inbound', 'outbound', 'confirmation_phrase'].includes(key))) {
      throw providerError('cartesia_provider_input_invalid', 'Provider creation contains unsupported fields', 400);
    }
    return { type, label, ...normalizeSipConfig(input) };
  }
  throw providerError('cartesia_provider_type_invalid', 'Provider type must be twilio or sip_trunk', 400);
}

function normalizeProviderUpdate(id, input = {}) {
  if (!ID_PATTERN.test(String(id || ''))) throw providerError('cartesia_provider_id_invalid', 'A valid Cartesia provider ID is required', 400);
  // The documented PATCH contract currently covers Twilio provider credentials.
  if (Object.keys(input).some((key) => !['api_key_sid', 'api_key_secret', 'region', 'confirmation_phrase'].includes(key))) {
    throw providerError('cartesia_provider_input_invalid', 'Provider update contains unsupported fields', 400);
  }
  const normalized = { type: 'twilio' };
  for (const [field, max] of [['api_key_sid', 64], ['api_key_secret', 256]]) {
    if (input[field] !== undefined) normalized[field] = cleanString(input[field], max, field);
  }
  if (input.region !== undefined) {
    normalized.region = cleanString(input.region, 24, 'Twilio region');
    if (!REGION_PATTERN.test(normalized.region)) throw providerError('cartesia_provider_input_invalid', 'A valid Twilio region is required', 400);
  }
  if (Object.keys(normalized).length === 1) throw providerError('cartesia_provider_input_invalid', 'At least one Twilio provider field must be updated', 400);
  return normalized;
}

class CartesiaSipProviderService {
  constructor(options = {}) { this.client = options.client; }

  async listProviders() {
    const result = await this.client.listProviders();
    return { providers: safeProviderList(result) };
  }

  async createProvider(input = {}) {
    const payload = normalizeProviderInput(input);
    const result = await this.client.createProvider(payload);
    const provider = safeProvider(result?.provider || result);
    if (!provider) throw providerError('cartesia_provider_response_invalid', 'Cartesia returned an invalid provider record', 502);
    return { provider };
  }

  async updateProvider(id, input = {}) {
    const payload = normalizeProviderUpdate(id, input);
    const result = await this.client.updateProvider(id, payload);
    const provider = safeProvider(result?.provider || result);
    if (!provider) throw providerError('cartesia_provider_response_invalid', 'Cartesia returned an invalid provider record', 502);
    return { provider };
  }

  async deleteProvider(id) {
    if (!ID_PATTERN.test(String(id || ''))) throw providerError('cartesia_provider_id_invalid', 'A valid Cartesia provider ID is required', 400);
    await this.client.deleteProvider(id);
    return { deleted: true, provider_id: id };
  }
}

module.exports = {
  CartesiaSipProviderService,
  normalizeProviderInput,
  normalizeProviderUpdate,
  safeProvider,
  safeProviderList,
  providerError,
};
