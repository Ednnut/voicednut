const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');
const { CartesiaTelephonyProviderService } = require('../services/cartesiaTelephonyProviderService');

const API_KEY = 'sk_car_test_server_key';
const SIP_INPUT = Object.freeze({
  label: 'Primary carrier',
  idempotency_key: 'sip-provider-test-001',
  inbound: {
    credentials: { username: 'carrier-inbound', password: 'inbound-secret' },
    media_encryption: 'allowed',
  },
  outbound: {
    address: 'sip.carrier.example',
    transport: 'tls',
    destination_country: 'US',
    media_encryption: 'required',
    credentials: { username: 'cartesia-outbound', password: 'outbound-secret' },
  },
});
const TWILIO_INPUT = Object.freeze({
  label: 'Primary Twilio account',
  account_sid: `AC${'a'.repeat(32)}`,
  api_key_sid: `SK${'b'.repeat(32)}`,
  api_key_secret: 'test-twilio-api-secret',
  region: 'us1',
  idempotency_key: 'twilio-provider-test-01',
});

function createHarness(overrides = {}) {
  const rows = new Map();
  const calls = [];
  const providers = structuredClone(overrides.providers || []);
  const phoneNumbers = structuredClone(overrides.phoneNumbers || []);
  const db = {
    async getOutboundCallIdempotency(key) { return rows.get(key) || null; },
    async reserveOutboundCallIdempotency(payload) {
      if (rows.has(payload.idempotency_key)) return { reserved: false };
      rows.set(payload.idempotency_key, { ...payload, status: 'pending' });
      return { reserved: true };
    },
    async completeOutboundCallIdempotency(payload) {
      const prior = rows.get(payload.idempotency_key) || {};
      rows.set(payload.idempotency_key, {
        ...prior,
        ...payload,
        response_payload: payload.response_payload ? JSON.stringify(payload.response_payload) : null,
      });
      return 1;
    },
  };
  const client = {
    isConfigured: () => true,
    async listTelephonyProviders() {
      calls.push(['list']);
      return structuredClone(providers);
    },
    async getTelephonyProvider(id) {
      calls.push(['get_provider', id]);
      const provider = providers.find((item) => item.id === id);
      if (!provider) throw Object.assign(new Error('not found'), { status: 404, code: 'cartesia_not_found' });
      return structuredClone(provider);
    },
    async listPhoneNumbers(query) {
      calls.push(['list_phone_numbers', structuredClone(query)]);
      const data = phoneNumbers.filter((item) => item.provider?.id === query.provider_id);
      return { data: data.slice(0, query.limit), has_more: data.length > query.limit };
    },
    async createSipProvider(payload) {
      calls.push(['create', structuredClone(payload)]);
      const created = { id: 'provider_sip_01', type: 'sip_trunk', label: payload.label, inbound: {}, outbound: {} };
      providers.push(created);
      return structuredClone(created);
    },
    async updateTwilioProvider(id, payload) {
      calls.push(['update_twilio', id, structuredClone(payload)]);
      const provider = providers.find((item) => item.id === id);
      if (!provider) throw Object.assign(new Error('not found'), { status: 404 });
      provider.region = payload.region;
      provider.api_key_sid = `${payload.api_key_sid.slice(0, 8)}...`;
      return structuredClone(provider);
    },
    async updateSipProvider(id, payload) {
      calls.push(['update_sip', id, structuredClone(payload)]);
      const provider = providers.find((item) => item.id === id);
      if (!provider) throw Object.assign(new Error('not found'), { status: 404 });
      provider.inbound = payload.inbound;
      provider.outbound = payload.outbound;
      return structuredClone(provider);
    },
    async deleteTelephonyProvider(id) {
      calls.push(['delete_provider', id]);
      const index = providers.findIndex((item) => item.id === id);
      if (index >= 0) providers.splice(index, 1);
      return { success: true };
    },
    ...overrides.client,
  };
  const service = new CartesiaTelephonyProviderService({
    client,
    db,
    enabled: true,
    sipMutationsEnabled: true,
    fingerprintSecret: API_KEY,
    ...overrides.service,
  });
  return { service, calls, rows, providers, phoneNumbers, db, client };
}

describe('Cartesia telephony provider service', () => {
  it('lists provider inventory without returning provider credentials', async () => {
    const { service } = createHarness({
      client: {
        async listTelephonyProviders() {
          return [{
            id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier',
            inbound: { credentials: { username: 'private-user', password: 'private-pass' } },
            outbound: { credentials: { username: 'other-user', password: 'other-pass' } },
          }];
        },
      },
    });
    const providers = await service.listProviders();
    assert.deepEqual(providers, [{
      id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier',
      region: null,
      inboundConfigured: true, outboundConfigured: true,
    }]);
    assert.equal(JSON.stringify(providers).includes('private-pass'), false);
  });

  it('previews a documented SIP trunk configuration without returning credentials', async () => {
    const { service, calls } = createHarness();
    const preview = await service.previewSIPProvider(SIP_INPUT);
    assert.equal(preview.type, 'sip_trunk');
    assert.equal(preview.outboundAddress, 'sip.carrier.example');
    assert.equal(preview.outboundTransport, 'tls');
    assert.equal(preview.inboundAccessControl, 'digest_credentials');
    assert.equal(JSON.stringify(preview).includes('inbound-secret'), false);
    assert.equal(JSON.stringify(preview).includes('outbound-secret'), false);
    assert.equal(calls.length, 0);
  });

  it('rejects unsafe or incomplete SIP configuration before provider I/O', async () => {
    const { service, calls } = createHarness();
    await assert.rejects(service.previewSIPProvider({
      ...SIP_INPUT,
      outbound: { ...SIP_INPUT.outbound, address: 'sip:sip.carrier.example' },
    }), { code: 'cartesia_sip_configuration_invalid' });
    await assert.rejects(service.previewSIPProvider({
      ...SIP_INPUT,
      inbound: { media_encryption: 'allowed' },
    }), { code: 'cartesia_sip_configuration_invalid' });
    await assert.rejects(service.previewSIPProvider({ ...SIP_INPUT, api_key: 'unexpected' }), {
      code: 'cartesia_sip_configuration_invalid',
    });
    assert.equal(calls.length, 0);
  });

  it('supports Twilio Elastic SIP ingress through a validated source IP allowlist', async () => {
    const { service } = createHarness();
    const preview = await service.previewSIPProvider({
      ...SIP_INPUT,
      inbound: {
        allowed_addresses: ['54.172.60.0/23', '54.244.51.0/24'],
        allowed_numbers: ['+15555550123'],
        media_encryption: 'allowed',
      },
      outbound: { ...SIP_INPUT.outbound, address: 'sip.carrier.example:5067' },
    });
    assert.equal(preview.inboundAccessControl, 'source_ip_allowlist');
    assert.equal(preview.inboundAllowedAddressCount, 2);
    assert.equal(preview.inboundAllowedNumberCount, 1);
    assert.equal(preview.outboundAddress, 'sip.carrier.example:5067');
    const numberAllowlistPreview = await service.previewSIPProvider({
      ...SIP_INPUT,
      inbound: { allowed_numbers: ['+15555550123'], media_encryption: 'allowed' },
    });
    assert.equal(numberAllowlistPreview.inboundAccessControl, 'allowed_numbers');
    assert.equal(numberAllowlistPreview.inboundCredentialsConfigured, false);
    await assert.rejects(service.previewSIPProvider({
      ...SIP_INPUT,
      inbound: { allowed_addresses: ['0.0.0.0/0'], media_encryption: 'allowed' },
    }), { code: 'cartesia_sip_configuration_invalid' });
    await assert.rejects(service.previewSIPProvider({
      ...SIP_INPUT,
      inbound: { allowed_addresses: ['not-an-ip'], media_encryption: 'allowed' },
    }), { code: 'cartesia_sip_configuration_invalid' });
  });

  it('requires the independent mutation gate and exact approval before creating a provider', async () => {
    const disabled = createHarness({ service: { sipMutationsEnabled: false } });
    const preview = await disabled.service.previewSIPProvider(SIP_INPUT);
    await assert.rejects(disabled.service.createSIPProvider({
      ...SIP_INPUT, approved: true, confirmed_fingerprint: preview.requestFingerprint,
    }), { code: 'cartesia_sip_provider_mutations_disabled' });
    assert.equal(disabled.calls.some(([name]) => name === 'create'), false);

    const mismatch = createHarness();
    await assert.rejects(mismatch.service.createSIPProvider({
      ...SIP_INPUT, approved: true, confirmed_fingerprint: '0'.repeat(64),
    }), { code: 'cartesia_sip_provider_confirmation_mismatch' });
    assert.equal(mismatch.calls.some(([name]) => name === 'create'), false);
  });

  it('creates the exact documented provider payload once and replays the redacted result', async () => {
    const { service, calls, rows } = createHarness();
    const preview = await service.previewSIPProvider(SIP_INPUT);
    const confirmed = {
      ...SIP_INPUT,
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
    };
    const first = await service.createSIPProvider(confirmed);
    const replay = await service.createSIPProvider(confirmed);
    const createCalls = calls.filter(([name]) => name === 'create');

    assert.equal(first.provider.type, 'sip_trunk');
    assert.equal(first.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0][1], {
      type: 'sip_trunk',
      label: preview.label,
      inbound: {
        credentials: { username: 'carrier-inbound', password: 'inbound-secret' },
        media_encryption: 'allowed',
      },
      outbound: {
        address: 'sip.carrier.example',
        transport: 'tls',
        destination_country: 'US',
        media_encryption: 'required',
        credentials: { username: 'cartesia-outbound', password: 'outbound-secret' },
      },
    });
    const row = [...rows.values()][0];
    assert.equal(row.status, 'completed');
    assert.equal(JSON.stringify(row).includes('inbound-secret'), false);
    assert.equal(JSON.stringify(row).includes('outbound-secret'), false);
  });

  it('updates SIP configuration with a fresh inventory preview and preserves credential secrecy', async () => {
    const provider = { id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier', inbound: {}, outbound: {} };
    const { service, calls, rows } = createHarness({
      providers: [provider],
      service: { sipMutationsEnabled: true },
    });
    const update = {
      provider_id: provider.id,
      inbound: { credentials: { username: 'inbound-user', password: 'rotated-inbound-secret' }, media_encryption: 'required' },
      outbound: {
        address: 'sip.updated-carrier.example', transport: 'tls', destination_country: 'US',
        media_encryption: 'required', credentials: { username: 'outbound-user', password: 'rotated-outbound-secret' },
      },
      idempotency_key: 'sip-update-test-0001',
    };
    const preview = await service.previewSIPProviderUpdate(update);
    assert.equal(preview.providerId, provider.id);
    assert.equal(preview.linkedPhoneNumberCount, 0);
    assert.equal(JSON.stringify(preview).includes('rotated-inbound-secret'), false);
    await assert.rejects(service.updateSIPProvider({
      ...update, approved: true, confirmed_fingerprint: preview.requestFingerprint,
      confirm_provider_id: provider.id, confirm_linked_number_count: 1,
    }), { code: 'cartesia_sip_provider_update_confirmation_mismatch' });
    const input = {
      ...update, approved: true, confirmed_fingerprint: preview.requestFingerprint,
      confirm_provider_id: provider.id, confirm_linked_number_count: 0,
    };
    const first = await service.updateSIPProvider(input);
    const replay = await service.updateSIPProvider(input);
    assert.equal(first.provider.type, 'sip_trunk');
    assert.equal(replay.idempotentReplay, true);
    assert.equal(calls.filter(([name]) => name === 'update_sip').length, 1);
    assert.equal(JSON.stringify([...rows.values()]).includes('rotated-inbound-secret'), false);
    assert.equal(JSON.stringify([...rows.values()]).includes('rotated-outbound-secret'), false);
  });

  it('keeps SIP provider updates behind the SIP-specific mutation gate', async () => {
    const provider = { id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier', inbound: {}, outbound: {} };
    const { service, calls } = createHarness({ providers: [provider], service: { sipMutationsEnabled: false } });
    const preview = await service.previewSIPProviderUpdate({
      provider_id: provider.id,
      inbound: { credentials: { username: 'inbound', password: 'test-inbound-secret' }, media_encryption: 'allowed' },
      outbound: { address: 'sip.carrier.example', transport: 'tls', destination_country: 'US', media_encryption: 'required' },
      idempotency_key: 'sip-update-test-0002',
    });
    await assert.rejects(service.updateSIPProvider({
      provider_id: provider.id,
      inbound: { credentials: { username: 'inbound', password: 'test-inbound-secret' }, media_encryption: 'allowed' },
      outbound: { address: 'sip.carrier.example', transport: 'tls', destination_country: 'US', media_encryption: 'required' },
      idempotency_key: 'sip-update-test-0002',
      approved: true, confirmed_fingerprint: preview.requestFingerprint,
      confirm_provider_id: provider.id, confirm_linked_number_count: 0,
    }), { code: 'cartesia_sip_provider_mutations_disabled' });
    assert.equal(calls.some(([name]) => name === 'update_sip'), false);
  });

  it('reconciles an ambiguous create using the deterministic label and does not retry the write', async () => {
    let createCount = 0;
    const provider = { id: 'provider_sip_02', type: 'sip_trunk', label: '' };
    const { service, calls } = createHarness({
      client: {
        async createSipProvider(payload) {
          createCount += 1;
          provider.label = payload.label;
          throw Object.assign(new Error('network outcome unknown'), { code: 'cartesia_network_error', retryable: true });
        },
        async listTelephonyProviders() {
          calls.push(['list']);
          return provider.label ? [structuredClone(provider)] : [];
        },
      },
    });
    const preview = await service.previewSIPProvider(SIP_INPUT);
    const input = { ...SIP_INPUT, approved: true, confirmed_fingerprint: preview.requestFingerprint };
    const result = await service.createSIPProvider(input);
    const replay = await service.createSIPProvider(input);
    assert.equal(result.provider.id, 'provider_sip_02');
    assert.equal(replay.idempotentReplay, true);
    assert.equal(createCount, 1);
  });

  it('does not repeat a create when a pending operation cannot be reconciled', async () => {
    const { service, rows, calls } = createHarness({
      client: { async listTelephonyProviders() { calls.push(['list']); return []; } },
    });
    const preview = await service.previewSIPProvider(SIP_INPUT);
    const operationKey = 'voicednut:cartesia:sip_provider:sip-provider-test-001';
    rows.set(operationKey, {
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: preview.requestFingerprint,
      status: 'pending',
    });
    await assert.rejects(service.createSIPProvider({
      ...SIP_INPUT, approved: true, confirmed_fingerprint: preview.requestFingerprint,
    }), { code: 'cartesia_sip_provider_outcome_unknown' });
    assert.equal(calls.some(([name]) => name === 'create'), false);
  });

  it('links Twilio credentials only after exact preview, account confirmation, and durable idempotency', async () => {
    const twilioProviders = [];
    let createCount = 0;
    const { service } = createHarness({
      service: { providerMutationsEnabled: true },
      client: {
        async listTelephonyProviders() { return structuredClone(twilioProviders); },
        async createTwilioProvider(payload) {
          createCount += 1;
          const provider = {
            id: 'provider_twilio_01', type: 'twilio', label: payload.label,
            account_sid: payload.account_sid, region: payload.region,
            api_key_sid: `${payload.api_key_sid.slice(0, 8)}...`,
          };
          twilioProviders.push(provider);
          return structuredClone(provider);
        },
      },
    });
    const preview = await service.previewTwilioProvider(TWILIO_INPUT);
    assert.equal(preview.accountSid, TWILIO_INPUT.account_sid);
    assert.equal(preview.apiKeySidSuffix, TWILIO_INPUT.api_key_sid.slice(-6));
    assert.equal(JSON.stringify(preview).includes(TWILIO_INPUT.api_key_secret), false);
    await assert.rejects(service.createTwilioProvider({
      ...TWILIO_INPUT, approved: true, confirmed_fingerprint: preview.requestFingerprint,
      confirm_account_sid: `AC${'c'.repeat(32)}`,
    }), { code: 'cartesia_twilio_provider_confirmation_mismatch' });
    const input = {
      ...TWILIO_INPUT, approved: true, confirmed_fingerprint: preview.requestFingerprint,
      confirm_account_sid: TWILIO_INPUT.account_sid,
    };
    const first = await service.createTwilioProvider(input);
    const replay = await service.createTwilioProvider(input);
    assert.equal(first.provider.type, 'twilio');
    assert.equal(first.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(createCount, 1);
    assert.equal(JSON.stringify(first).includes(TWILIO_INPUT.api_key_secret), false);
  });

  it('keeps Twilio credential linking disabled unless the independent provider gate is enabled', async () => {
    const { service } = createHarness({ service: { providerMutationsEnabled: false } });
    const preview = await service.previewTwilioProvider(TWILIO_INPUT);
    await assert.rejects(service.createTwilioProvider({
      ...TWILIO_INPUT, approved: true, confirmed_fingerprint: preview.requestFingerprint,
      confirm_account_sid: TWILIO_INPUT.account_sid,
    }), { code: 'cartesia_telephony_provider_mutations_disabled' });
  });

  it('rotates Twilio credentials only after HTTPS route approval data and persists no secret', async () => {
    const provider = {
      id: 'provider_twilio_01', type: 'twilio', label: 'Main Twilio',
      account_sid: `AC${'a'.repeat(32)}`, api_key_sid: 'SKold...1234', region: 'us1',
    };
    const { service, calls, rows } = createHarness({
      providers: [provider],
      service: { providerMutationsEnabled: true },
    });
    const update = {
      provider_id: provider.id, api_key_sid: `SK${'c'.repeat(32)}`,
      api_key_secret: 'new-private-twilio-secret', region: 'ie1', idempotency_key: 'twilio-rotate-test-01',
    };
    const preview = await service.previewTwilioProviderUpdate(update);
    assert.equal(preview.providerId, provider.id);
    assert.equal(JSON.stringify(preview).includes(update.api_key_secret), false);
    await assert.rejects(service.updateTwilioProvider({
      ...update, approved: true, confirmed_fingerprint: preview.requestFingerprint, confirm_provider_id: 'provider_other',
    }), { code: 'cartesia_twilio_provider_update_confirmation_mismatch' });
    const input = {
      ...update, approved: true, confirmed_fingerprint: preview.requestFingerprint, confirm_provider_id: provider.id,
    };
    const result = await service.updateTwilioProvider(input);
    const replay = await service.updateTwilioProvider(input);
    assert.equal(result.provider.region, 'ie1');
    assert.equal(result.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(calls.filter(([name]) => name === 'update_twilio').length, 1);
    assert.equal(JSON.stringify([...rows.values()]).includes(update.api_key_secret), false);
  });

  it('deletes providers only after a fresh zero-number inventory check and replays safely', async () => {
    const provider = { id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier', inbound: {}, outbound: {} };
    const { service, calls } = createHarness({
      providers: [provider],
      service: { providerMutationsEnabled: true },
    });
    const preview = await service.prepareProviderDeletion(provider.id);
    assert.equal(preview.canDelete, true);
    assert.equal(preview.linkedPhoneNumberCount, 0);
    const input = {
      provider_id: provider.id,
      idempotency_key: 'provider-delete-test-01',
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      confirm_label: preview.label,
    };
    const first = await service.deleteProvider(input);
    const replay = await service.deleteProvider(input);
    assert.equal(first.deleted, true);
    assert.equal(first.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(calls.filter(([name]) => name === 'delete_provider').length, 1);
  });

  it('blocks provider deletion when any linked numbers remain', async () => {
    const provider = { id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier', inbound: {}, outbound: {} };
    const { service, calls } = createHarness({
      providers: [provider],
      phoneNumbers: [{ id: 'pn_assigned_01', provider: { id: provider.id } }],
      service: { providerMutationsEnabled: true },
    });
    const preview = await service.prepareProviderDeletion(provider.id);
    assert.equal(preview.canDelete, false);
    assert.equal(preview.linkedPhoneNumberCount, 1);
    await assert.rejects(service.deleteProvider({
      provider_id: provider.id,
      idempotency_key: 'provider-delete-test-02',
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      confirm_label: preview.label,
    }), { code: 'cartesia_provider_delete_confirmation_mismatch' });
    assert.equal(calls.some(([name]) => name === 'delete_provider'), false);
  });

  it('fully paginates provider-linked number inventory before allowing deletion', async () => {
    const provider = { id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier', inbound: {}, outbound: {} };
    const pageQueries = [];
    const { service } = createHarness({
      providers: [provider],
      client: {
        async listPhoneNumbers(query) {
          pageQueries.push(query);
          return query.starting_after
            ? { data: [{ id: 'pn_second', provider: { id: provider.id } }], has_more: false }
            : { data: [{ id: 'pn_first', provider: { id: provider.id } }], has_more: true };
        },
      },
    });
    const preview = await service.prepareProviderDeletion(provider.id);
    assert.equal(preview.linkedPhoneNumberCount, 2);
    assert.equal(preview.canDelete, false);
    assert.equal(pageQueries.length, 2);
    assert.deepEqual(pageQueries.map((query) => query.provider_id), [provider.id, provider.id]);
    assert.equal(pageQueries[1].starting_after, 'pn_first');
  });

  it('keeps provider deletion disabled by default without reading Cartesia inventory', async () => {
    const provider = { id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier', inbound: {}, outbound: {} };
    const { service, calls } = createHarness({ providers: [provider] });
    await assert.rejects(service.deleteProvider({
      provider_id: provider.id,
      idempotency_key: 'provider-delete-test-04',
      approved: true,
      confirmed_fingerprint: 'a'.repeat(64),
      confirm_label: 'Carrier',
    }), { code: 'cartesia_telephony_provider_mutations_disabled' });
    assert.equal(calls.length, 0);
  });

  it('reconciles a lost provider-delete response by inventory without repeating the delete', async () => {
    const provider = { id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier', inbound: {}, outbound: {} };
    let deleteCalls = 0;
    const { service } = createHarness({
      providers: [provider],
      service: { providerMutationsEnabled: true },
      client: {
        async deleteTelephonyProvider(id) {
          deleteCalls += 1;
          this.deletedProviderId = id;
          throw Object.assign(new Error('connection lost'), { code: 'cartesia_network_error', retryable: true });
        },
        async listTelephonyProviders() {
          return this.deletedProviderId ? [] : [provider];
        },
      },
    });
    const preview = await service.prepareProviderDeletion(provider.id);
    const input = {
      provider_id: provider.id,
      idempotency_key: 'provider-delete-test-03',
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      confirm_label: preview.label,
    };
    const first = await service.deleteProvider(input);
    const replay = await service.deleteProvider(input);
    assert.equal(first.deleted, true);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(deleteCalls, 1);
  });

  it('replays SIP creation from durable SQLite idempotency after service recreation', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-sip-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    let createCount = 0;
    const client = {
      isConfigured: () => true,
      async listTelephonyProviders() { return []; },
      async createSipProvider(payload) {
        createCount += 1;
        return { id: 'provider_durable_01', type: 'sip_trunk', label: payload.label };
      },
    };
    const newService = () => new CartesiaTelephonyProviderService({
      client, db, enabled: true, sipMutationsEnabled: true, fingerprintSecret: API_KEY,
    });
    try {
      const firstService = newService();
      const preview = await firstService.previewSIPProvider(SIP_INPUT);
      const input = { ...SIP_INPUT, approved: true, confirmed_fingerprint: preview.requestFingerprint };
      const first = await firstService.createSIPProvider(input);
      const restartedService = newService();
      const replay = await restartedService.createSIPProvider(input);
      const row = await db.getOutboundCallIdempotency('voicednut:cartesia:sip_provider:sip-provider-test-001');
      assert.equal(first.provider.id, 'provider_durable_01');
      assert.equal(replay.idempotentReplay, true);
      assert.equal(createCount, 1);
      assert.equal(JSON.stringify(row).includes('inbound-secret'), false);
      assert.equal(JSON.stringify(row).includes('outbound-secret'), false);
    } finally {
      await new Promise((resolve) => db.db.close(resolve));
      [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
    }
  });
});
