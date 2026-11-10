const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { registerCartesiaCallRoutes } = require('../services/cartesiaCallRoutes');

function createApp(overrides = {}) {
  const app = express();
  app.use(express.json());
  const operations = [];
  const auditEvents = [];
  const providerAuditEvents = [];
  const providerOperations = [];
  const phoneNumberService = {
    mutationsEnabled: false,
    async list(query) { operations.push(['list', query]); return { phoneNumbers: [], pagination: { hasMore: false, nextCursor: null } }; },
    async get(id) { operations.push(['get', id]); return { id, ownership: 'cartesia_owned' }; },
    async prepareImport(input) { operations.push(['import_preview', input]); return { operation: 'import', label: input.label, number: input.number, providerId: input.provider_id, agentId: input.agent_id, ownership: 'twilio_imported', numberAlreadyPresent: false, requestFingerprint: 'b'.repeat(64), request: { private: true } }; },
    async importNumber(input) { operations.push(['import', input]); return { phoneNumber: { id: 'pn_imported_01' }, idempotentReplay: false }; },
    async prepareProvision(input) { operations.push(['provision_preview', input]); return { operation: 'provision', label: input.label, agentId: input.agent_id, ownership: 'cartesia_owned', potentialCharge: true, labelAlreadyUsed: false, requestFingerprint: 'c'.repeat(64), request: { private: true } }; },
    async provisionNumber(input) { operations.push(['provision', input]); return { phoneNumber: { id: 'pn_provisioned_01' }, idempotentReplay: false }; },
    async prepareRelease(id) { operations.push(['release_preview', id]); return { phoneNumberId: id, number: '+15555550123', ownership: 'cartesia_owned', permanentlyReleasesNumber: true, requestFingerprint: 'd'.repeat(64) }; },
    async releaseNumber(input) { operations.push(['release', input]); return { phoneNumberId: input.phoneNumberId, deleted: true }; },
    async prepareAssignment(id, agentId) { operations.push(['preview', id, agentId]); return { phoneNumberId: id, targetAgentId: agentId, requestFingerprint: 'a'.repeat(64) }; },
    async assignAgent(input) { operations.push(['assign', input]); return { phoneNumberId: input.phoneNumberId, previousAgentId: 'agent_old_01', agentId: input.agent_id, changed: true }; },
  };
  const db = overrides.db || {
    async recordCartesiaPhoneNumberOperationAudit(event) {
      auditEvents.unshift({ id: auditEvents.length + 1, ...event, created_at: '2026-11-04T12:00:00.000Z' });
      return { recorded: true };
    },
    async recordCartesiaProviderOperationAudit(event) {
      providerAuditEvents.unshift({ id: providerAuditEvents.length + 1, ...event });
      return { recorded: true };
    },
  };
  const telephonyProviderService = {
    async createTwilioProvider(input) { providerOperations.push(['twilio_create', input]); return { provider: { id: 'provider_twilio_created', type: 'twilio' }, idempotentReplay: false }; },
    async updateTwilioProvider(input) { providerOperations.push(['twilio_update', input]); return { provider: { id: input.provider_id, type: 'twilio' }, idempotentReplay: false }; },
    async createSIPProvider(input) { providerOperations.push(['sip_create', input]); return { provider: { id: 'provider_sip_created', type: 'sip_trunk' }, idempotentReplay: false }; },
    async updateSIPProvider(input) { providerOperations.push(['sip_update', input]); return { provider: { id: input.provider_id, type: 'sip_trunk' }, idempotentReplay: false }; },
    async deleteProvider(input) { providerOperations.push(['provider_delete', input]); return { providerId: input.provider_id, deleted: true }; },
  };
  app.set('trust proxy', true);
  const auth = (req, res, next) => req.get('x-admin-token') === 'test-admin'
    ? next()
    : res.status(403).json({ success: false, code: 'admin_required' });
  registerCartesiaCallRoutes(app, {
    service: {},
    client: { getConfigurationStatus: () => ({ enabled: true, configured: true, apiVersion: '2026-08-14' }) },
    phoneNumberService,
    telephonyProviderService,
    db,
    requireAdminToken: auth,
  });
  return { app, operations, auditEvents, providerAuditEvents, providerOperations };
}

describe('Cartesia phone number routes', () => {
  it('requires admin authorization for all inventory and assignment routes', async () => {
    const { app } = createApp();
    assert.equal((await request(app).get('/api/cartesia/phone-numbers')).status, 403);
    assert.equal((await request(app).get('/api/cartesia/phone-numbers/pn_test_01')).status, 403);
    assert.equal((await request(app).post('/api/cartesia/phone-numbers/pn_test_01/assignment/preview').send({ agent_id: null })).status, 403);
  });

  it('exposes bounded inventory, detail, preview and approved mutation contracts', async () => {
    const { app, operations, auditEvents } = createApp();
    const headers = { 'x-admin-token': 'test-admin' };
    const list = await request(app).get('/api/cartesia/phone-numbers?limit=10&type=cartesia').set(headers);
    const detail = await request(app).get('/api/cartesia/phone-numbers/pn_test_01').set(headers);
    const preview = await request(app).post('/api/cartesia/phone-numbers/pn_test_01/assignment/preview').set(headers).send({ agent_id: 'agent_test' });
    const assignment = await request(app).put('/api/cartesia/phone-numbers/pn_test_01/assignment').set(headers).send({
      agent_id: 'agent_test', approved: true, confirmed_fingerprint: 'a'.repeat(64), idempotency_key: 'assignment-key-01',
    });
    assert.equal(list.status, 200);
    assert.equal(detail.status, 200);
    assert.equal(preview.status, 200);
    assert.equal(assignment.status, 200);
    assert.deepEqual(operations[0], ['list', { limit: '10', type: 'cartesia' }]);
    assert.deepEqual(operations[1], ['get', 'pn_test_01']);
    assert.deepEqual(operations[2], ['preview', 'pn_test_01', 'agent_test']);
    assert.equal(operations[3][0], 'assign');
    assert.equal(operations[3][1].approved, true);
    assert.deepEqual(auditEvents.map((event) => event.outcome), ['succeeded', 'requested']);
    assert.equal(auditEvents[0].actor_type, 'admin_api');
    assert.equal(auditEvents[0].actor_id, 'shared_admin_token');
  });

  it('rejects unknown query/body fields and missing explicit preview inputs', async () => {
    const { app, operations, auditEvents } = createApp();
    const headers = { 'x-admin-token': 'test-admin' };
    const badList = await request(app).get('/api/cartesia/phone-numbers?secret=leak').set(headers);
    const badPreview = await request(app).post('/api/cartesia/phone-numbers/pn_test_01/assignment/preview').set(headers).send({});
    const badAssignment = await request(app).put('/api/cartesia/phone-numbers/pn_test_01/assignment').set(headers).send({ agent_id: 'agent_test', force: true });
    assert.equal(badList.status, 400);
    assert.equal(badPreview.status, 400);
    assert.equal(badAssignment.status, 400);
    assert.equal(operations.length, 0);
  });

  it('requires admin authorization for import and provisioning operations', async () => {
    const { app } = createApp();
    assert.equal((await request(app).post('/api/cartesia/phone-numbers/import/preview').send({})).status, 403);
    assert.equal((await request(app).post('/api/cartesia/phone-numbers/provision/preview').send({})).status, 403);
  });

  it('exposes redacted import and paid provisioning previews and explicit execute payloads', async () => {
    const { app, operations, auditEvents } = createApp();
    const headers = { 'x-admin-token': 'test-admin' };
    const importPayload = {
      label: 'Imported line', number: '+15555550123', provider_id: 'provider_01',
      agent_id: 'agent_01', idempotency_key: 'import-test-key-01',
    };
    const provisionPayload = { label: 'Cartesia line', agent_id: 'agent_01', idempotency_key: 'provision-test-key-01' };
    const importPreview = await request(app).post('/api/cartesia/phone-numbers/import/preview').set(headers).send(importPayload);
    const imported = await request(app).post('/api/cartesia/phone-numbers/import').set(headers).send({
      ...importPayload, approved: true, confirmed_fingerprint: 'b'.repeat(64),
    });
    const provisionPreview = await request(app).post('/api/cartesia/phone-numbers/provision/preview').set(headers).send(provisionPayload);
    const provisioned = await request(app).post('/api/cartesia/phone-numbers/provision').set(headers).send({
      ...provisionPayload, approved: true, confirmed_fingerprint: 'c'.repeat(64), confirm_label: 'Cartesia line',
    });
    assert.equal(importPreview.status, 200);
    assert.equal(importPreview.body.preview.requestFingerprint, 'b'.repeat(64));
    assert.equal(JSON.stringify(importPreview.body).includes('private'), false);
    assert.equal(imported.status, 201);
    assert.equal(provisionPreview.status, 200);
    assert.equal(provisionPreview.body.preview.potentialCharge, true);
    assert.equal(provisioned.status, 201);
    assert.equal(operations[0][0], 'import_preview');
    assert.equal(operations[1][0], 'import');
    assert.equal(operations[1][1].approved, true);
    assert.equal(operations[2][0], 'provision_preview');
    assert.equal(operations[3][0], 'provision');
    assert.equal(operations[3][1].confirm_label, 'Cartesia line');
    assert.deepEqual(auditEvents.filter((event) => event.outcome === 'requested').map((event) => event.action).sort(), ['phone_number_import', 'phone_number_provision']);
    assert.equal(JSON.stringify(auditEvents).includes('+15555550123'), false);
    assert.equal(JSON.stringify(auditEvents).includes('private'), false);
  });

  it('requires admin access and typed-number confirmation data for destructive release', async () => {
    const { app, operations, auditEvents } = createApp();
    assert.equal((await request(app).post('/api/cartesia/phone-numbers/pn_test_01/release/preview').send({})).status, 403);
    const headers = { 'x-admin-token': 'test-admin' };
    const preview = await request(app).post('/api/cartesia/phone-numbers/pn_test_01/release/preview').set(headers).send({});
    const release = await request(app).post('/api/cartesia/phone-numbers/pn_test_01/release').set(headers).send({
      approved: true, confirmed_fingerprint: 'd'.repeat(64), confirm_number: '+15555550123',
      idempotency_key: 'release-test-key-01',
    });
    const unknown = await request(app).post('/api/cartesia/phone-numbers/pn_test_01/release').set(headers).send({
      approved: true, confirmed_fingerprint: 'd'.repeat(64), confirm_number: '+15555550123', force: true,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.permanentlyReleasesNumber, true);
    assert.equal(release.status, 200);
    assert.equal(unknown.status, 400);
    assert.equal(operations[0][0], 'release_preview');
    assert.equal(operations[1][0], 'release');
    assert.equal(operations[1][1].approved, true);
    assert.deepEqual(auditEvents.map((event) => event.outcome), ['succeeded', 'requested']);
    assert.equal(auditEvents[0].action, 'phone_number_release');
  });

  it('blocks approved number mutations if the audit store is unavailable', async () => {
    const { app, operations } = createApp({ db: { async recordCartesiaPhoneNumberOperationAudit() { throw new Error('audit unavailable'); } } });
    const response = await request(app).post('/api/cartesia/phone-numbers/import').set('x-admin-token', 'test-admin').send({
      label: 'Imported line', number: '+15555550123', provider_id: 'provider_01',
      agent_id: 'agent_01', idempotency_key: 'import-audit-failure-01', approved: true, confirmed_fingerprint: 'b'.repeat(64),
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'cartesia_admin_action_audit_unavailable');
    assert.equal(operations.some((operation) => operation[0] === 'import'), false);
  });

  it('audits confirmed Cartesia Twilio and SIP provider mutations without storing credentials', async () => {
    const { app, providerAuditEvents, providerOperations } = createApp();
    const headers = { 'x-admin-token': 'test-admin', 'x-forwarded-proto': 'https' };
    const approval = { approved: true, confirmed_fingerprint: 'e'.repeat(64) };
    const operationsToRun = [
      ['post', '/api/cartesia/providers/twilio', { ...approval, idempotency_key: 'twilio-create-key-01', label: 'Twilio main', account_sid: 'AC00000000000000000000000000000000', api_key_sid: 'SK00000000000000000000000000000000', api_key_secret: 'twilio-secret-value', confirm_account_sid: 'AC00000000000000000000000000000000' }],
      ['post', '/api/cartesia/providers/twilio/update', { ...approval, idempotency_key: 'twilio-update-key-01', provider_id: 'provider_twilio_01', api_key_sid: 'SK11111111111111111111111111111111', api_key_secret: 'twilio-update-secret', confirm_provider_id: 'provider_twilio_01' }],
      ['post', '/api/cartesia/providers/sip', { ...approval, idempotency_key: 'sip-create-key-001', label: 'SIP main', inbound: { allowed_addresses: ['192.0.2.10'] }, outbound: { address: 'sip.example.test' } }],
      ['post', '/api/cartesia/providers/sip/update', { ...approval, idempotency_key: 'sip-update-key-001', provider_id: 'provider_sip_01', inbound: { allowed_addresses: ['192.0.2.10'] }, outbound: { address: 'sip.example.test' }, confirm_provider_id: 'provider_sip_01', confirm_linked_number_count: 0 }],
      ['delete', '/api/cartesia/providers/provider_delete_01', { ...approval, idempotency_key: 'provider-delete-key-01', confirm_label: 'Existing SIP' }],
    ];
    for (const [method, path, body] of operationsToRun) {
      const response = await request(app)[method](path).set(headers).send(body);
      assert.ok([200, 201].includes(response.status), `${method.toUpperCase()} ${path} returned ${response.status}`);
    }
    assert.deepEqual(providerOperations.map(([name]) => name), ['twilio_create', 'twilio_update', 'sip_create', 'sip_update', 'provider_delete']);
    assert.deepEqual(providerAuditEvents.filter((event) => event.outcome === 'requested').map((event) => event.action).sort(), [
      'sip_provider_create', 'sip_provider_update', 'telephony_provider_delete', 'twilio_provider_create', 'twilio_provider_update',
    ]);
    assert.deepEqual(providerAuditEvents.filter((event) => event.outcome === 'succeeded').map((event) => event.resource_id).sort(), [
      'provider_delete_01', 'provider_sip_01', 'provider_sip_created', 'provider_twilio_01', 'provider_twilio_created',
    ]);
    const serializedAudit = JSON.stringify(providerAuditEvents);
    assert.equal(serializedAudit.includes('twilio-secret-value'), false);
    assert.equal(serializedAudit.includes('twilio-update-secret'), false);
    assert.equal(serializedAudit.includes('192.0.2.10'), false);
    assert.equal(providerAuditEvents.every((event) => event.actor_id === 'shared_admin_token'), true);
  });

  it('fails closed when the provider audit store is unavailable', async () => {
    const { app, providerOperations } = createApp({ db: {
      async recordCartesiaPhoneNumberOperationAudit() { return { recorded: true }; },
      async recordCartesiaProviderOperationAudit() { throw new Error('audit unavailable'); },
    } });
    const response = await request(app).post('/api/cartesia/providers/sip').set({
      'x-admin-token': 'test-admin', 'x-forwarded-proto': 'https',
    }).send({
      approved: true, confirmed_fingerprint: 'f'.repeat(64), idempotency_key: 'sip-create-key-002',
      label: 'SIP main', inbound: { allowed_addresses: ['192.0.2.10'] }, outbound: { address: 'sip.example.test' },
    });
    assert.equal(response.status, 503);
    assert.equal(providerOperations.length, 0);
  });
});
