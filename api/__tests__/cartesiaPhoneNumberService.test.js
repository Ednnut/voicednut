const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');
const { CartesiaPhoneNumberService, normalizePhoneNumber } = require('../services/cartesiaPhoneNumberService');
const { CartesiaApiError } = require('../services/cartesiaClient');

const initialNumber = {
  id: 'pn_test_01',
  number: '+15555550123',
  label: 'Support line',
  agent: { id: 'agent_old', name: 'Old agent' },
  provider: { type: 'twilio', id: 'provider_test', label: 'Existing Twilio', account_sid: 'must-not-leak', api_key_sid: 'also-private' },
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
};

function createHarness(overrides = {}) {
  let current = structuredClone(initialNumber);
  let deleted = false;
  let deletes = 0;
  const calls = [];
  const rows = new Map();
  const db = {
    async getOutboundCallIdempotency(key) { return rows.get(key) || null; },
    async reserveOutboundCallIdempotency(payload) {
      if (rows.has(payload.idempotency_key)) return { reserved: false };
      rows.set(payload.idempotency_key, { ...payload, status: 'pending' });
      return { reserved: true };
    },
    async completeOutboundCallIdempotency(payload) {
      rows.set(payload.idempotency_key, {
        ...rows.get(payload.idempotency_key),
        ...payload,
        response_payload: payload.response_payload ? JSON.stringify(payload.response_payload) : null,
      });
      return 1;
    },
  };
  const client = {
    isConfigured: () => true,
    async listTelephonyProviders() { return [{ id: 'provider_test', type: 'twilio' }]; },
    async listPhoneNumbers(query) {
      calls.push(['list', query]);
      return { data: [current], has_more: false };
    },
    async getPhoneNumber(id) {
      calls.push(['get', id]);
      if (deleted) throw Object.assign(new Error('not found'), { status: 404 });
      if (id !== current.id) throw Object.assign(new Error('not found'), { status: 404 });
      return structuredClone(current);
    },
    async updatePhoneNumber(id, patch) {
      calls.push(['update', id, patch]);
      current = { ...current, agent: patch.agent_id ? { id: patch.agent_id, name: 'New agent' } : null };
      return structuredClone(current);
    },
    async deletePhoneNumber(id) { calls.push(['delete', id]); deletes += 1; deleted = true; return { success: true }; },
    ...overrides.client,
  };
  const service = new CartesiaPhoneNumberService({
    client,
    db,
    enabled: true,
    mutationsEnabled: true,
    ...overrides.service,
  });
  return { service, calls, db, rows, getCurrent: () => structuredClone(current), setCurrent: (value) => { current = structuredClone(value); }, getDeleteCount: () => deletes };
}

describe('Cartesia phone number service', () => {
  it('normalizes ownership and does not expose provider credentials', () => {
    const number = normalizePhoneNumber(initialNumber);
    assert.equal(number.ownership, 'twilio_imported');
    assert.equal(number.provider.type, 'twilio');
    assert.equal(JSON.stringify(number).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(number).includes('also-private'), false);
    assert.equal(normalizePhoneNumber({ id: 'pn_cartesia', number: '+15555550124', agent: null }).ownership, 'cartesia_owned');
  });

  it('lists validated inventory using opaque provider cursors', async () => {
    const { service, calls } = createHarness();
    const result = await service.list({ limit: '25', type: 'twilio', starting_after: 'pn_cursor' });
    assert.equal(result.phoneNumbers[0].id, 'pn_test_01');
    assert.deepEqual(result.pagination, { hasMore: false, nextCursor: null });
    assert.deepEqual(calls[0], ['list', { limit: 25, starting_after: 'pn_cursor', type: 'twilio' }]);
    await assert.rejects(service.list({ limit: 101 }), { code: 'cartesia_phone_number_query_invalid' });
  });

  it('previews the current inbound agent assignment and requires an exact confirmation', async () => {
    const { service, calls } = createHarness();
    const preview = await service.prepareAssignment('pn_test_01', 'agent_new');
    assert.equal(preview.currentAgentId, 'agent_old');
    assert.equal(preview.targetAgentId, 'agent_new');
    assert.equal(preview.requiresChange, true);
    await assert.rejects(service.assignAgent({
      phoneNumberId: 'pn_test_01',
      agent_id: 'agent_new',
      approved: true,
      confirmed_fingerprint: '0'.repeat(64),
      idempotency_key: 'assignment-key-01',
    }), { code: 'cartesia_phone_number_confirmation_mismatch' });
    assert.equal(calls.some(([operation]) => operation === 'update'), false);
  });

  it('keeps assignment mutations disabled unless the independent gate is enabled', async () => {
    const { service } = createHarness({ service: { mutationsEnabled: false } });
    await assert.rejects(service.assignAgent({ phoneNumberId: 'pn_test_01', agent_id: 'agent_new' }), {
      code: 'cartesia_phone_number_mutations_disabled',
    });
  });

  it('rejects stale previews if another administrator changed the assignment', async () => {
    const { service, setCurrent, calls } = createHarness();
    const preview = await service.prepareAssignment('pn_test_01', 'agent_new');
    setCurrent({ ...initialNumber, agent: { id: 'agent_other', name: 'Other agent' } });
    await assert.rejects(service.assignAgent({
      phoneNumberId: 'pn_test_01', agent_id: 'agent_new', approved: true,
      confirmed_fingerprint: preview.requestFingerprint, idempotency_key: 'assignment-key-stale',
    }), { code: 'cartesia_phone_number_confirmation_mismatch' });
    assert.equal(calls.some(([operation]) => operation === 'update'), false);
  });

  it('applies an approved assignment once and replays the durable result', async () => {
    const { service, calls } = createHarness();
    const preview = await service.prepareAssignment('pn_test_01', null);
    const input = {
      phoneNumberId: 'pn_test_01',
      agent_id: null,
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      idempotency_key: 'assignment-key-02',
    };
    const first = await service.assignAgent(input);
    const replay = await service.assignAgent(input);
    assert.equal(first.agentId, null);
    assert.equal(first.changed, true);
    assert.equal(first.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(calls.filter(([operation]) => operation === 'update').length, 1);
  });

  it('persists assignment replay protection in a temporary SQLite database', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-assignment-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    let assignedAgentId = 'agent_old';
    let updates = 0;
    const client = {
      isConfigured: () => true,
      async getPhoneNumber() {
        return { ...structuredClone(initialNumber), agent: { id: assignedAgentId, name: assignedAgentId } };
      },
      async updatePhoneNumber(_id, patch) {
        updates += 1;
        assignedAgentId = patch.agent_id;
        return { ...structuredClone(initialNumber), agent: { id: assignedAgentId, name: assignedAgentId } };
      },
    };
    const service = new CartesiaPhoneNumberService({ client, db, enabled: true, mutationsEnabled: true });
    try {
      const preview = await service.prepareAssignment('pn_test_01', 'agent_new');
      const input = {
        phoneNumberId: 'pn_test_01', agent_id: 'agent_new', approved: true,
        confirmed_fingerprint: preview.requestFingerprint, idempotency_key: 'sqlite-assignment-01',
      };
      const first = await service.assignAgent(input);
      const replay = await service.assignAgent(input);
      assert.equal(first.changed, true);
      assert.equal(replay.idempotentReplay, true);
      assert.equal(updates, 1);
    } finally {
      await new Promise((resolve) => db.db.close(resolve));
      [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
    }
  });

  it('reconciles an ambiguous PATCH by reading current state and does not submit a second PATCH', async () => {
    let applied = false;
    const { service, calls } = createHarness({
      client: {
        async updatePhoneNumber(id, patch) {
          calls.push(['update', id, patch]);
          // Cartesia applied the assignment, but the response was lost.
          applied = true;
          throw Object.assign(new Error('network lost'), { code: 'cartesia_network_error', retryable: true });
        },
        async getPhoneNumber(id) {
          calls.push(['get', id]);
          return {
            ...structuredClone(initialNumber),
            agent: applied ? { id: 'agent_new', name: 'New agent' } : initialNumber.agent,
          };
        },
      },
    });
    const preview = await service.prepareAssignment('pn_test_01', 'agent_new');
    const result = await service.assignAgent({
      phoneNumberId: 'pn_test_01', agent_id: 'agent_new', approved: true,
      confirmed_fingerprint: preview.requestFingerprint, idempotency_key: 'assignment-key-03',
    });
    assert.equal(result.agentId, 'agent_new');
    assert.equal(calls.filter(([operation]) => operation === 'update').length, 1);
  });

  it('imports a provider number only after exact preview approval and replays without importing twice', async () => {
    let imported;
    let importCount = 0;
    const { service, calls } = createHarness({
      client: {
        async listPhoneNumbers(query) {
          calls.push(['list', query]);
          return { data: imported ? [imported] : [], has_more: false };
        },
        async importPhoneNumber(payload) {
          importCount += 1;
          imported = {
            id: 'pn_imported_01', number: payload.number, label: payload.label,
            agent: { id: payload.agent_id }, provider: { type: 'twilio', id: payload.provider.id },
          };
          return structuredClone(imported);
        },
      },
    });
    const input = {
      label: 'Imported support', number: '+15555550199', provider_id: 'provider_test',
      agent_id: 'agent_new', idempotency_key: 'phone-import-test-01',
    };
    const preview = await service.prepareImport(input);
    assert.equal(preview.ownership, 'twilio_imported');
    assert.equal(preview.numberAlreadyPresent, false);
    await assert.rejects(service.importNumber({ ...input, approved: true, confirmed_fingerprint: '0'.repeat(64) }), {
      code: 'cartesia_phone_number_confirmation_mismatch',
    });
    const first = await service.importNumber({ ...input, approved: true, confirmed_fingerprint: preview.requestFingerprint });
    const replay = await service.importNumber({ ...input, approved: true, confirmed_fingerprint: preview.requestFingerprint });
    assert.equal(first.phoneNumber.id, 'pn_imported_01');
    assert.equal(replay.idempotentReplay, true);
    assert.equal(importCount, 1);
  });

  it('keeps paid number provisioning behind its separate gate and typed confirmation', async () => {
    let provisioned;
    let provisionCount = 0;
    const { service } = createHarness({
      service: { provisioningEnabled: true },
      client: {
        async listPhoneNumbers() { return { data: provisioned ? [provisioned] : [], has_more: false }; },
        async provisionPhoneNumber(payload) {
          provisionCount += 1;
          provisioned = {
            id: 'pn_owned_01', number: '+15555550198', label: payload.label,
            agent: payload.agent_id ? { id: payload.agent_id } : null, provider: null,
          };
          return structuredClone(provisioned);
        },
      },
    });
    const input = { label: 'New Cartesia line', agent_id: 'agent_new', idempotency_key: 'phone-provision-test-01' };
    const preview = await service.prepareProvision(input);
    assert.equal(preview.ownership, 'cartesia_owned');
    assert.equal(preview.potentialCharge, true);
    await assert.rejects(service.provisionNumber({
      ...input, approved: true, confirmed_fingerprint: preview.requestFingerprint, confirm_label: 'wrong label',
    }), { code: 'cartesia_phone_number_confirmation_mismatch' });
    const first = await service.provisionNumber({
      ...input, approved: true, confirmed_fingerprint: preview.requestFingerprint, confirm_label: preview.label,
    });
    const replay = await service.provisionNumber({
      ...input, approved: true, confirmed_fingerprint: preview.requestFingerprint, confirm_label: preview.label,
    });
    assert.equal(first.phoneNumber.id, 'pn_owned_01');
    assert.equal(replay.idempotentReplay, true);
    assert.equal(provisionCount, 1);
  });

  it('does not provision when the dedicated provisioning flag is disabled', async () => {
    const { service, calls } = createHarness({ service: { provisioningEnabled: false } });
    await assert.rejects(service.provisionNumber({}), { code: 'cartesia_phone_number_provisioning_disabled' });
    assert.equal(calls.length, 0);
  });

  it('requires unassignment before releasing Cartesia and SIP numbers', async () => {
    const { service, setCurrent, calls } = createHarness();
    setCurrent({ ...initialNumber, provider: null });
    await assert.rejects(service.prepareRelease('pn_test_01'), { code: 'cartesia_phone_number_must_be_unassigned' });
    setCurrent({ ...initialNumber, provider: { type: 'sip_trunk', id: 'sip_provider' }, agent: { id: 'agent_old', name: 'Old agent' } });
    await assert.rejects(service.prepareRelease('pn_test_01'), { code: 'cartesia_phone_number_must_be_unassigned' });
    assert.equal(calls.some(([operation]) => operation === 'delete'), false);
  });

  it('releases a Twilio-imported number only with exact preview, typed number, and durable replay protection', async () => {
    const { service, getDeleteCount } = createHarness();
    const preview = await service.prepareRelease('pn_test_01');
    assert.equal(preview.ownership, 'twilio_imported');
    assert.equal(preview.permanentlyReleasesNumber, false);
    const input = {
      phoneNumberId: 'pn_test_01', approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      confirm_number: preview.number,
      idempotency_key: 'phone-release-test-01',
    };
    await assert.rejects(service.releaseNumber({ ...input, confirm_number: '+15555550000' }), {
      code: 'cartesia_phone_number_confirmation_mismatch',
    });
    const first = await service.releaseNumber(input);
    const replay = await service.releaseNumber(input);
    assert.equal(first.deleted, true);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(getDeleteCount(), 1);
  });

  it('reconciles an ambiguous number release by read-only 404 and never repeats DELETE', async () => {
    let deleted = false;
    let deletes = 0;
    const { service } = createHarness({
      client: {
        async deletePhoneNumber() {
          deletes += 1;
          deleted = true;
          throw new CartesiaApiError('network outcome unknown', { code: 'cartesia_network_error', retryable: true });
        },
        async getPhoneNumber() {
          if (deleted) throw new CartesiaApiError('not found', { status: 404, code: 'cartesia_not_found' });
          return structuredClone(initialNumber);
        },
      },
    });
    const preview = await service.prepareRelease('pn_test_01');
    const result = await service.releaseNumber({
      phoneNumberId: 'pn_test_01', approved: true,
      confirmed_fingerprint: preview.requestFingerprint, confirm_number: preview.number,
      idempotency_key: 'phone-release-ambiguous-01',
    });
    assert.equal(result.deleted, true);
    assert.equal(result.ownership, 'twilio_imported');
    assert.equal(deletes, 1);
  });
});
