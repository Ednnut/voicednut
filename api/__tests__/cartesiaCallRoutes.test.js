const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { registerCartesiaCallRoutes } = require('../services/cartesiaCallRoutes');

function createApp(overrides = {}) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const calls = [];
  const service = {
    dispatchEnabled: true,
    allowedDestinations: new Set(['+15555550123']),
    async prepareOutboundCall(body) { calls.push(['preview', body]); return { requestFingerprint: 'a'.repeat(64) }; },
    async createOutboundCall(body) { calls.push(['dispatch', body]); return { providerCallId: 'ac_test_01', status: 'created', idempotentReplay: false }; },
    async getCall(callId) { calls.push(['read', callId]); return { providerCallId: callId, status: 'completed' }; },
    async cancelCall(callId, approved) {
      calls.push(['cancel', callId, approved]);
      if (overrides.cancelError) throw overrides.cancelError;
      return { providerCallId: callId, cancelled: true };
    },
  };
  const client = { getConfigurationStatus: () => ({ enabled: true, configured: true, apiVersion: '2026-08-14' }) };
  const providerCalls = [];
  const providerAuditEvents = [];
  const callAuditEvents = [];
  const auditExportQueries = [];
  const webhookAssignments = [];
  const webhookConfigService = {
    mutationsEnabled: false,
    publicWebhookUrl: 'https://voice.example.test/api/webhooks/cartesia',
    async prepareWebhookCreation() {
      webhookAssignments.push(['create_preview']);
      return {
        operation: 'webhook_create', endpointHost: 'voice.example.test',
        endpointPath: '/api/webhooks/cartesia', secretConfigured: true,
        externalOperation: true, requestFingerprint: 'c'.repeat(64),
      };
    },
    async createWebhook(input) {
      webhookAssignments.push(['create', input]);
      return { webhookId: 'webhook_created_01', secretReturnedByProvider: false, idempotentReplay: false };
    },
    async prepareAssignment(agentId, webhookId) {
      webhookAssignments.push(['preview', agentId, webhookId]);
      return { agentId, previousWebhookId: null, webhookId, requestFingerprint: 'd'.repeat(64) };
    },
    async assignAgentWebhook(input) {
      webhookAssignments.push(['assign', input]);
      return { agentId: input.agent_id, webhookId: input.webhook_id };
    },
  };
  const telephonyProviderService = {
    sipMutationsEnabled: false,
    providerMutationsEnabled: false,
    async listProviders() { providerCalls.push(['list']); return [{ id: 'provider_sip_01', type: 'sip_trunk' }]; },
    async getProvider(providerId) { providerCalls.push(['get_provider', providerId]); return { id: providerId, type: 'sip_trunk' }; },
    async previewTwilioProvider(body) { providerCalls.push(['twilio_preview', body]); return { type: 'twilio', requestFingerprint: 'e'.repeat(64), apiKeySidSuffix: 'abcdef' }; },
    async createTwilioProvider(body) { providerCalls.push(['twilio_create', body]); return { provider: { id: 'provider_twilio_01', type: 'twilio' }, idempotentReplay: false }; },
    async previewTwilioProviderUpdate(body) { providerCalls.push(['twilio_update_preview', body]); return { providerId: body.provider_id, requestFingerprint: 'f'.repeat(64) }; },
    async updateTwilioProvider(body) { providerCalls.push(['twilio_update', body]); return { provider: { id: body.provider_id, type: 'twilio' } }; },
    async prepareProviderDeletion(providerId) { providerCalls.push(['provider_delete_preview', providerId]); return { providerId, label: 'Carrier', canDelete: true }; },
    async deleteProvider(body) { providerCalls.push(['provider_delete', body]); return { deleted: true }; },
    async previewSIPProvider(body) { providerCalls.push(['preview', body]); return { type: 'sip_trunk', requestFingerprint: 'b'.repeat(64) }; },
    async createSIPProvider(body) { providerCalls.push(['create', body]); return { provider: { id: 'provider_sip_01' }, idempotentReplay: false }; },
    async previewSIPProviderUpdate(body) { providerCalls.push(['sip_update_preview', body]); return { providerId: body.provider_id, requestFingerprint: 'c'.repeat(64), linkedPhoneNumberCount: 1 }; },
    async updateSIPProvider(body) { providerCalls.push(['sip_update', body]); return { provider: { id: body.provider_id, type: 'sip_trunk' } }; },
  };
  const auth = (req, res, next) => req.get('x-admin-token') === 'test-admin'
    ? next()
    : res.status(403).json({ success: false, code: 'admin_required' });
  registerCartesiaCallRoutes(app, {
    service,
    client,
    telephonyProviderService,
    webhookConfigService,
    db: {
      async recordCartesiaProviderOperationAudit(event) {
        providerAuditEvents.push(event);
        return { recorded: true };
      },
      async recordCartesiaWebhookAssignmentAudit(event) {
        providerAuditEvents.push(event);
        return { recorded: true };
      },
      async recordCartesiaWebhookCreationAudit(event) {
        providerAuditEvents.push(event);
        return { recorded: true };
      },
      async recordCartesiaCallOperationAudit(event) {
        if (overrides.callAuditError) throw overrides.callAuditError;
        callAuditEvents.push(event);
        return { recorded: true };
      },
      async listCartesiaAuditEvents(query) {
        auditExportQueries.push(query);
        if (overrides.auditExportError) throw overrides.auditExportError;
        const events = overrides.auditExportEvents || [];
        const cursorIndex = query.cursor
          ? events.findIndex((event) => event.source === query.cursor.source &&
            event.id === query.cursor.id && event.created_at === query.cursor.createdAt)
          : -1;
        return events.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
      },
    },
    requireAdminToken: auth,
    webhookSecret: 'configured',
    webhookHandler: (_req, res) => res.status(204).end(),
  });
  return { app, calls, providerCalls, providerAuditEvents, callAuditEvents, auditExportQueries, webhookAssignments };
}

describe('Cartesia call routes', () => {
  it('requires admin authorization for configuration and call routes', async () => {
    const { app } = createApp();
    const status = await request(app).get('/api/cartesia/status');
    const preview = await request(app).post('/api/cartesia/calls/preview').send({});
    assert.equal(status.status, 403);
    assert.equal(preview.status, 403);
  });

  it('exports bounded, sanitized audit CSV pages only to admins', async () => {
    const auditExportEvents = [
      {
        id: 2,
        source: 'call_operation',
        created_at: '2026-11-04 12:05:01',
        actor_type: 'admin_api',
        actor_id: 'shared_admin_token',
        action: 'outbound_call_cancel',
        resource_type: 'call',
        resource_id: '=formula',
        outcome: 'succeeded',
        reason_code: null,
        business_id: null,
        target_agent_id: null,
        request_fingerprint: 'must-not-export',
      },
      {
        id: 1,
        source: 'call_review',
        created_at: '2026-11-04 12:05:00',
        actor_type: 'miniapp_user',
        actor_id: '12345',
        action: 'private_call_review',
        resource_type: 'call',
        resource_id: 'ac_test_01',
        outcome: 'allowed',
        reason_code: null,
        business_id: 'business_test',
        target_agent_id: null,
      },
    ];
    const { app, auditExportQueries } = createApp({ auditExportEvents });
    const unauthenticated = await request(app).get('/api/cartesia/audit/export');
    const invalid = await request(app).get('/api/cartesia/audit/export?limit=501').set('x-admin-token', 'test-admin');
    const unsupported = await request(app).get('/api/cartesia/audit/export?include_private=true').set('x-admin-token', 'test-admin');
    const firstPage = await request(app).get('/api/cartesia/audit/export?limit=1').set('x-admin-token', 'test-admin');
    const cursor = firstPage.headers['x-cartesia-audit-next-cursor'];
    const secondPage = await request(app).get('/api/cartesia/audit/export')
      .query({ limit: 1, cursor }).set('x-admin-token', 'test-admin');

    assert.equal(unauthenticated.status, 403);
    assert.equal(invalid.status, 400);
    assert.equal(unsupported.status, 400);
    assert.equal(firstPage.status, 200);
    assert.match(firstPage.headers['content-type'], /text\/csv/);
    assert.equal(firstPage.headers['cache-control'], 'no-store');
    assert.equal(firstPage.headers['content-disposition'], 'attachment; filename="cartesia-audit.csv"');
    assert.equal(firstPage.headers['x-cartesia-audit-has-more'], 'true');
    assert.ok(cursor);
    assert.match(firstPage.text, /'=formula/);
    assert.equal(firstPage.text.includes('must-not-export'), false);
    assert.equal(secondPage.status, 200);
    assert.equal(secondPage.headers['x-cartesia-audit-has-more'], 'false');
    assert.match(secondPage.text, /ac_test_01/);
    const invalidCursor = await request(app).get('/api/cartesia/audit/export')
      .query({ cursor: Buffer.from(JSON.stringify({ createdAt: '2026-11-04', source: 'unknown', id: 1 })).toString('base64url') })
      .set('x-admin-token', 'test-admin');
    assert.equal(invalidCursor.status, 400);
    assert.deepEqual(auditExportQueries.map(({ limit }) => limit), [2, 2]);
    assert.equal(auditExportQueries[1].cursor.source, 'call_operation');
  });

  it('returns a sanitized unavailable response when audit storage fails', async () => {
    const { app } = createApp({ auditExportError: new Error('sensitive database detail') });
    const response = await request(app).get('/api/cartesia/audit/export').set('x-admin-token', 'test-admin');
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'cartesia_audit_export_unavailable');
    assert.equal(JSON.stringify(response.body).includes('sensitive database detail'), false);
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  it('keeps preview, history and cancellation while retiring direct Cartesia dispatch', async () => {
    const { app, calls, callAuditEvents } = createApp();
    const headers = { 'x-admin-token': 'test-admin' };
    const payload = {
      business_id: 'business_test',
      to_number: '+15555550123',
      from_number_id: 'phone_test_01',
      agent_id: 'agent_test_01',
    };
    const preview = await request(app).post('/api/cartesia/calls/preview').set(headers).send(payload);
    const dispatch = await request(app).post('/api/cartesia/calls').set(headers).send({
      ...payload,
      approved: true,
      confirmed_fingerprint: 'a'.repeat(64),
      idempotency_key: 'cartesia-test-key',
    });
    const read = await request(app).get('/api/cartesia/calls/ac_test_01').set(headers);
    const cancel = await request(app).post('/api/cartesia/calls/ac_test_01/cancel').set(headers).send({ approved: true });

    assert.equal(preview.status, 200);
    assert.equal(dispatch.status, 409);
    assert.equal(dispatch.body.code, 'cartesia_is_ai_capability');
    assert.equal(read.status, 200);
    assert.equal(cancel.status, 200);
    assert.deepEqual(callAuditEvents.map((event) => event.outcome), ['requested', 'succeeded']);
    assert.deepEqual(callAuditEvents.map((event) => event.action), [
      'outbound_call_cancel', 'outbound_call_cancel',
    ]);
    assert.equal(callAuditEvents[0].resource_id, 'ac_test_01');
    assert.equal(JSON.stringify(callAuditEvents).includes('+15555550123'), false);
    assert.equal(JSON.stringify(callAuditEvents).includes('dynamic_variables'), false);
    assert.equal(calls[0][0], 'preview');
    assert.deepEqual(calls.slice(1), [['read', 'ac_test_01'], ['cancel', 'ac_test_01', true]]);
  });

  it('rejects unknown execution fields and requires cancellation approval', async () => {
    const { app, calls } = createApp();
    const headers = { 'x-admin-token': 'test-admin' };
    const unknown = await request(app).post('/api/cartesia/calls').set(headers).send({ phone: '+15555550123' });
    const cancel = await request(app).post('/api/cartesia/calls/ac_test_01/cancel').set(headers).send({});
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.code, 'cartesia_is_ai_capability');
    assert.equal(cancel.status, 400);
    assert.equal(calls.length, 0);
  });

  it('keeps the webhook route behind its dedicated handler', async () => {
    const { app } = createApp();
    const result = await request(app).post('/api/webhooks/cartesia').send({});
    assert.equal(result.status, 204);
  });

  it('previews and audits only an HTTPS, explicitly approved agent webhook assignment', async () => {
    const { app, webhookAssignments, providerAuditEvents } = createApp();
    const admin = { 'x-admin-token': 'test-admin' };
    const preview = await request(app).post('/api/cartesia/agents/agent_test_01/webhook/assignment/preview')
      .set(admin).send({ webhook_id: 'webhook_test_01' });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.requestFingerprint, 'd'.repeat(64));
    const insecure = await request(app).put('/api/cartesia/agents/agent_test_01/webhook/assignment')
      .set(admin).send({
        webhook_id: 'webhook_test_01', approved: true,
        confirmed_fingerprint: 'd'.repeat(64), idempotency_key: 'webhook-route-key',
      });
    const confirmed = await request(app).put('/api/cartesia/agents/agent_test_01/webhook/assignment')
      .set({ ...admin, 'x-forwarded-proto': 'https' }).send({
        webhook_id: 'webhook_test_01', approved: true,
        confirmed_fingerprint: 'd'.repeat(64), idempotency_key: 'webhook-route-key',
      });
    assert.equal(insecure.status, 400);
    assert.equal(insecure.body.code, 'cartesia_webhook_tls_required');
    assert.equal(confirmed.status, 200);
    assert.equal(webhookAssignments[0][0], 'preview');
    assert.equal(webhookAssignments[1][0], 'assign');
    assert.equal(webhookAssignments[1][1].approved, true);
    assert.deepEqual(providerAuditEvents.map((event) => [event.action, event.outcome]), [
      ['agent_webhook_assignment', 'requested'], ['agent_webhook_assignment', 'succeeded'],
    ]);
    const unauthorized = await request(app).post('/api/cartesia/agents/agent_test_01/webhook/assignment/preview')
      .send({ webhook_id: 'webhook_test_01' });
    assert.equal(unauthorized.status, 403);
  });

  it('requires admin access, previews without mutation, and audits HTTPS-confirmed webhook creation', async () => {
    const { app, webhookAssignments, providerAuditEvents } = createApp();
    const admin = { 'x-admin-token': 'test-admin' };
    const unauthorized = await request(app).post('/api/cartesia/webhooks/preview').send({});
    const preview = await request(app).post('/api/cartesia/webhooks/preview').set(admin).send({});
    assert.equal(unauthorized.status, 403);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.endpointHost, 'voice.example.test');
    assert.equal(preview.body.preview.requestFingerprint, 'c'.repeat(64));
    assert.equal(webhookAssignments[0][0], 'create_preview');

    const insecure = await request(app).post('/api/cartesia/webhooks').set(admin).send({
      approved: true,
      confirmed_fingerprint: 'c'.repeat(64),
      idempotency_key: 'webhook-route-create-key',
    });
    const created = await request(app).post('/api/cartesia/webhooks')
      .set({ ...admin, 'x-forwarded-proto': 'https' }).send({
        approved: true,
        confirmed_fingerprint: 'c'.repeat(64),
        idempotency_key: 'webhook-route-create-key',
      });
    assert.equal(insecure.status, 400);
    assert.equal(insecure.body.code, 'cartesia_webhook_tls_required');
    assert.equal(created.status, 201);
    assert.deepEqual(webhookAssignments[1][0], 'create');
    assert.equal(Object.hasOwn(created.body.webhook, 'secret'), false);
    assert.deepEqual(providerAuditEvents.map((event) => [event.action, event.outcome]), [
      ['webhook_create', 'requested'], ['webhook_create', 'succeeded'],
    ]);
  });

  it('requires admin authorization for Cartesia provider inventory and SIP management', async () => {
    const { app } = createApp();
    assert.equal((await request(app).get('/api/cartesia/providers')).status, 403);
    assert.equal((await request(app).post('/api/cartesia/providers/sip/preview').send({})).status, 403);
  });

  it('requires HTTPS for SIP credentials and rejects unknown fields', async () => {
    const { app, providerCalls } = createApp();
    const headers = { 'x-admin-token': 'test-admin' };
    const payload = { label: 'Carrier', inbound: {}, outbound: {}, idempotency_key: 'sip-test-key-01' };
    const insecure = await request(app).post('/api/cartesia/providers/sip/preview').set(headers).send(payload);
    const unknown = await request(app).post('/api/cartesia/providers/sip/preview').set(headers)
      .set('x-forwarded-proto', 'https').send({ ...payload, api_key: 'not-allowed' });
    assert.equal(insecure.status, 400);
    assert.equal(insecure.body.code, 'cartesia_sip_tls_required');
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'cartesia_sip_configuration_invalid');
    assert.equal(providerCalls.length, 0);
  });

  it('lists and wires an HTTPS SIP preview and explicit confirmed create', async () => {
    const { app, providerCalls } = createApp();
    const headers = { 'x-admin-token': 'test-admin', 'x-forwarded-proto': 'https' };
    const payload = {
      label: 'Carrier',
      idempotency_key: 'sip-test-key-01',
      inbound: { credentials: { username: 'inbound', password: 'private-inbound' }, media_encryption: 'allowed' },
      outbound: {
        address: 'sip.carrier.example', transport: 'tls', destination_country: 'US',
        media_encryption: 'required', credentials: { username: 'outbound', password: 'private-outbound' },
      },
    };
    const inventory = await request(app).get('/api/cartesia/providers').set({ 'x-admin-token': 'test-admin' });
    const preview = await request(app).post('/api/cartesia/providers/sip/preview').set(headers).send(payload);
    const create = await request(app).post('/api/cartesia/providers/sip').set(headers).send({
      ...payload, approved: true, confirmed_fingerprint: 'b'.repeat(64),
    });
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.providers[0].type, 'sip_trunk');
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.requestFingerprint, 'b'.repeat(64));
    assert.equal(create.status, 201);
    assert.equal(JSON.stringify(preview.body).includes('private-inbound'), false);
    assert.equal(JSON.stringify(preview.body).includes('private-outbound'), false);
    assert.equal(providerCalls[0][0], 'list');
    assert.equal(providerCalls[1][0], 'preview');
    assert.equal(providerCalls[2][0], 'create');
    assert.equal(providerCalls[2][1].approved, true);
    assert.equal(providerCalls[2][1].confirmed_fingerprint, 'b'.repeat(64));
  });

  it('requires HTTPS and admin authorization for Twilio credential linking', async () => {
    const { app, providerCalls } = createApp();
    const headers = { 'x-admin-token': 'test-admin' };
    const payload = {
      label: 'Twilio', account_sid: `AC${'a'.repeat(32)}`, api_key_sid: `SK${'b'.repeat(32)}`,
      api_key_secret: 'private-twilio-secret', region: 'us1', idempotency_key: 'twilio-test-key-01',
    };
    const denied = await request(app).post('/api/cartesia/providers/twilio/preview').send(payload);
    const insecure = await request(app).post('/api/cartesia/providers/twilio/preview').set(headers).send(payload);
    const preview = await request(app).post('/api/cartesia/providers/twilio/preview').set({
      ...headers, 'x-forwarded-proto': 'https',
    }).send(payload);
    const linked = await request(app).post('/api/cartesia/providers/twilio').set({
      ...headers, 'x-forwarded-proto': 'https',
    }).send({
      ...payload, approved: true, confirmed_fingerprint: 'e'.repeat(64), confirm_account_sid: payload.account_sid,
    });
    assert.equal(denied.status, 403);
    assert.equal(insecure.status, 400);
    assert.equal(preview.status, 200);
    assert.equal(JSON.stringify(preview.body).includes('private-twilio-secret'), false);
    assert.equal(linked.status, 201);
    assert.equal(providerCalls[0][0], 'twilio_preview');
    assert.equal(providerCalls[0][1].api_key_secret, 'private-twilio-secret');
    assert.equal(providerCalls[1][0], 'twilio_create');
  });

  it('serves normalized provider details and HTTPS-gated Twilio rotation and provider deletion', async () => {
    const { app, providerCalls } = createApp();
    const headers = { 'x-admin-token': 'test-admin', 'x-forwarded-proto': 'https' };
    const update = {
      provider_id: 'provider_twilio_01', api_key_sid: `SK${'a'.repeat(32)}`,
      api_key_secret: 'private-new-secret', region: 'us1', idempotency_key: 'twilio-update-test-01',
    };
    const detail = await request(app).get('/api/cartesia/providers/provider_sip_01').set({ 'x-admin-token': 'test-admin' });
    const insecure = await request(app).post('/api/cartesia/providers/twilio/update/preview').set({ 'x-admin-token': 'test-admin' }).send(update);
    const preview = await request(app).post('/api/cartesia/providers/twilio/update/preview').set(headers).send(update);
    const updated = await request(app).post('/api/cartesia/providers/twilio/update').set(headers).send({
      ...update, approved: true, confirmed_fingerprint: 'f'.repeat(64), confirm_provider_id: update.provider_id,
    });
    const deletePreview = await request(app).post('/api/cartesia/providers/provider_sip_01/delete/preview').set({ 'x-admin-token': 'test-admin' });
    const deleted = await request(app).delete('/api/cartesia/providers/provider_sip_01').set(headers).send({
      approved: true, confirmed_fingerprint: 'a'.repeat(64), confirm_label: 'Carrier', idempotency_key: 'provider-delete-test-01',
    });
    assert.equal(detail.status, 200);
    assert.equal(insecure.status, 400);
    assert.equal(preview.status, 200);
    assert.equal(JSON.stringify(preview.body).includes('private-new-secret'), false);
    assert.equal(updated.status, 200);
    assert.equal(JSON.stringify(updated.body).includes('private-new-secret'), false);
    assert.equal(deletePreview.status, 200);
    assert.equal(deleted.status, 200);
    assert.deepEqual(providerCalls.slice(-5).map(([name]) => name), [
      'get_provider', 'twilio_update_preview', 'twilio_update', 'provider_delete_preview', 'provider_delete',
    ]);
    assert.equal(providerCalls.at(-1)[1].provider_id, 'provider_sip_01');
  });

  it('requires HTTPS for SIP provider update and exposes only a redacted preview', async () => {
    const { app, providerCalls } = createApp();
    const update = {
      provider_id: 'provider_sip_01',
      inbound: { credentials: { username: 'inbound', password: 'private-sip-secret' }, media_encryption: 'required' },
      outbound: { address: 'sip.carrier.example', transport: 'tls', destination_country: 'US', media_encryption: 'required' },
      idempotency_key: 'sip-update-route-test-01',
    };
    const headers = { 'x-admin-token': 'test-admin' };
    const insecure = await request(app).post('/api/cartesia/providers/sip/update/preview').set(headers).send(update);
    const preview = await request(app).post('/api/cartesia/providers/sip/update/preview')
      .set({ ...headers, 'x-forwarded-proto': 'https' }).send(update);
    const updated = await request(app).post('/api/cartesia/providers/sip/update')
      .set({ ...headers, 'x-forwarded-proto': 'https' }).send({
        ...update, approved: true, confirmed_fingerprint: 'c'.repeat(64),
        confirm_provider_id: update.provider_id, confirm_linked_number_count: 1,
      });
    assert.equal(insecure.status, 400);
    assert.equal(preview.status, 200);
    assert.equal(JSON.stringify(preview.body).includes('private-sip-secret'), false);
    assert.equal(updated.status, 200);
    assert.equal(providerCalls.at(-1)[0], 'sip_update');
    assert.equal(providerCalls.at(-1)[1].confirm_linked_number_count, 1);
  });

  it('records ambiguous cancellation outcomes without retrying the provider operation', async () => {
    const { app, calls, callAuditEvents } = createApp({ cancelError: Object.assign(new Error('network failure'), { code: 'cartesia_cancel_outcome_unknown' }) });
    const response = await request(app).post('/api/cartesia/calls/ac_test_01/cancel')
      .set('x-admin-token', 'test-admin').send({ approved: true });
    assert.equal(response.status, 502);
    assert.deepEqual(callAuditEvents.map((event) => event.outcome), ['requested', 'outcome_unknown']);
    assert.deepEqual(calls.filter(([name]) => name === 'cancel'), [['cancel', 'ac_test_01', true]]);
  });

  it('does not attempt direct Cartesia dispatch even when audit storage is unavailable', async () => {
    const { app, calls } = createApp({ callAuditError: new Error('audit unavailable') });
    const response = await request(app).post('/api/cartesia/calls').set('x-admin-token', 'test-admin').send({
      business_id: 'business_test', to_number: '+15555550123', from_number_id: 'phone_test_01', agent_id: 'agent_test_01',
      approved: true, confirmed_fingerprint: 'a'.repeat(64), idempotency_key: 'cartesia-audit-failure',
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'cartesia_is_ai_capability');
    assert.equal(calls.some(([name]) => name === 'dispatch'), false);
  });
});
