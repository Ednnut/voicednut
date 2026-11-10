const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const Database = require('../db/db');
const { registerCartesiaDashboardRoutes } = require('../services/cartesiaDashboardRoutes');

function createApp(overrides = {}) {
  const { db: dbOverrides = {}, ...routeOverrides } = overrides;
  const app = express();
  app.use(express.json());
  const externalReads = [];
  const auditEvents = [];
  const adminActionAuditEvents = [];
  const phoneNumberOperationAuditEvents = [];
  const providerOperationAuditEvents = [];
  const callOperationAuditEvents = [];
  const requireSession = (req, res, next) => {
    if (req.get('x-session') !== 'operator') {
      return res.status(401).json({ success: false, code: 'miniapp_auth_required' });
    }
    req.miniAppSession = {
      telegram_id: '12345',
      caps: [
        'provider_manage',
        ...(req.get('x-call-history') === 'users_manage' ? ['users_manage'] : []),
      ],
    };
    return next();
  };
  const requireCapability = (req, res, capability) => {
    if (capability === 'provider_manage' && req.get('x-capability') === 'provider_manage') return true;
    if (capability === 'users_manage' && req.get('x-call-history') === 'users_manage') return true;
    res.status(403).json({ success: false, code: 'miniapp_capability_denied' });
    return false;
  };
  const client = {
    getConfigurationStatus: () => ({ enabled: true, configured: true, apiVersion: '2026-08-14' }),
  };
  const phoneNumberService = {
    mutationsEnabled: true,
    async list() {
      externalReads.push('phone_numbers');
      return { phoneNumbers: [{
        id: 'pn_test_01',
        number: '+15555550123',
        label: 'Support',
        ownership: 'twilio_imported',
        agent: { id: 'agent_test_01', name: 'Support agent' },
        provider: { id: 'provider_test_01', type: 'twilio', label: 'Twilio', account_sid: 'must-not-leak' },
      }] };
    },
    async prepareAssignment(phoneNumberId, agentId) {
      externalReads.push(`assignment_preview:${phoneNumberId}:${agentId ?? 'unassigned'}`);
      return {
        phoneNumberId,
        number: '+15555550123',
        currentAgentId: 'agent_old_01',
        targetAgentId: agentId,
        requiresChange: true,
        requestFingerprint: 'a'.repeat(64),
      };
    },
    async assignAgent(input) {
      externalReads.push(`assignment:${input.phoneNumberId}:${input.agent_id ?? 'unassigned'}`);
      return { phoneNumberId: input.phoneNumberId, previousAgentId: 'agent_old_01', agentId: input.agent_id, changed: true, idempotentReplay: false };
    },
  };
  const telephonyProviderService = {
    async listProviders() {
      externalReads.push('providers');
      return [{ id: 'provider_test_01', type: 'twilio', label: 'Twilio', secret: 'must-not-leak' }];
    },
  };
  const db = {
    async listCartesiaCallRecords(limit) {
      assert.equal(limit, 10);
      return [{
        local_call_id: 'cartesia_local_01',
        provider_call_id: 'ac_test_01',
        agent_id: 'agent_test_01',
        phone_number: '+15555550123',
        direction: 'outbound',
        status: 'completed',
        start_time: '2026-11-04T12:00:00.000Z',
        telephony_account_type: 'twilio',
        transcript: 'must-not-leak',
      }];
    },
    async listCartesiaCallRecordsForBusiness(businessId, limit) {
      assert.equal(businessId, 'business_test_01');
      assert.equal(limit, 10);
      return [{
        local_call_id: 'cartesia_local_business_01',
        provider_call_id: 'ac_business_01',
        agent_id: 'agent_business_01',
        direction: 'inbound',
        status: 'completed',
        business_id: businessId,
      }];
    },
    async getCallEBusinessOperator(businessId, telegramId) {
      return businessId === 'business_test_01' && telegramId === '12345' ? { role: 'call_operator' } : null;
    },
    async getCartesiaCallRecordByProviderId(providerCallId, businessId) {
      if (providerCallId === 'ac_test_01' && businessId === undefined) return { provider_call_id: providerCallId };
      if (providerCallId === 'ac_business_01' && businessId === 'business_test_01') {
        return { provider_call_id: providerCallId, business_id: businessId };
      }
      return null;
    },
    async recordCartesiaCallReviewAudit(event) {
      const stored = { id: auditEvents.length + 1, ...event, created_at: '2026-11-04T12:01:00.000Z' };
      auditEvents.unshift(stored);
      return { id: stored.id, recorded: true };
    },
    async listCartesiaCallReviewAudit(limit) {
      return auditEvents.slice(0, limit);
    },
    async recordCartesiaAdminActionAudit(event) {
      const stored = { id: adminActionAuditEvents.length + 1, ...event, created_at: '2026-11-04T12:02:00.000Z' };
      adminActionAuditEvents.unshift(stored);
      return { id: stored.id, recorded: true };
    },
    async listCartesiaAdminActionAudit(limit) {
      return adminActionAuditEvents.slice(0, limit);
    },
    async recordCartesiaPhoneNumberOperationAudit(event) {
      const stored = { id: phoneNumberOperationAuditEvents.length + 1, ...event, created_at: '2026-11-04T12:03:00.000Z' };
      phoneNumberOperationAuditEvents.unshift(stored);
      return { id: stored.id, recorded: true };
    },
    async listCartesiaPhoneNumberOperationAudit(limit) {
      return phoneNumberOperationAuditEvents.slice(0, limit);
    },
    async recordCartesiaProviderOperationAudit(event) {
      const stored = { id: providerOperationAuditEvents.length + 1, ...event, created_at: '2026-11-04T12:04:00.000Z' };
      providerOperationAuditEvents.unshift(stored);
      return { id: stored.id, recorded: true };
    },
    async listCartesiaProviderOperationAudit(limit) {
      return providerOperationAuditEvents.slice(0, limit);
    },
    async recordCartesiaCallOperationAudit(event) {
      const stored = { id: callOperationAuditEvents.length + 1, ...event, created_at: '2026-11-04T12:05:00.000Z' };
      callOperationAuditEvents.unshift(stored);
      return { id: stored.id, recorded: true };
    },
    async listCartesiaCallOperationAudit(limit) {
      return callOperationAuditEvents.slice(0, limit);
    },
  };
  registerCartesiaDashboardRoutes(app, {
    requireMiniAppSession: requireSession,
    requireMiniAppCapability: requireCapability,
    client,
    callService: {
      dispatchEnabled: false,
      async getCall(providerCallId) {
        externalReads.push(`call:${providerCallId}`);
        return {
          provider: 'cartesia',
          providerCallId,
          agentId: 'agent_test_01',
          status: 'completed',
          startTime: '2026-11-04T12:00:00.000Z',
          endTime: '2026-11-04T12:00:12.000Z',
          direction: 'outbound',
          from: '+15555550100',
          to: '+15555550123',
          telephonyAccountType: 'twilio',
          summary: 'Customer asked for a callback.',
          transcript: [{ role: 'user', text: 'Please call tomorrow.', startTimestamp: 1, endTimestamp: 2 }],
          endReason: 'agent_hangup',
          zdrEnabled: false,
          secret: 'must-not-leak',
        };
      },
    },
    phoneNumberService,
    telephonyProviderService,
    lineAgentEnabled: false,
    lineDataHandlingReviewed: false,
    ttsProvider: 'cartesia',
    sttProvider: 'deepgram',
    ...routeOverrides,
    db: { ...db, ...dbOverrides },
  });
  return { app, externalReads, auditEvents, adminActionAuditEvents, phoneNumberOperationAuditEvents, providerOperationAuditEvents, callOperationAuditEvents };
}

describe('Cartesia Mini App operations overview', () => {
  it('serves a bounded read-only voice catalog only to authenticated provider managers', async () => {
    const { app } = createApp({ speechService: { async listVoices(query) {
      assert.equal(query.limit, '10');
      return { voices: [{ id: 'voice_test_01', name: 'Test Voice', language: 'en' }], nextPage: null };
    } } });
    assert.equal((await request(app).get('/miniapp/cartesia/voices?limit=10')).status, 401);
    assert.equal((await request(app).get('/miniapp/cartesia/voices?limit=10').set('x-session', 'operator')).status, 403);
    const response = await request(app).get('/miniapp/cartesia/voices?limit=10')
      .set('x-session', 'operator').set('x-capability', 'provider_manage');
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.body.voices, [{ id: 'voice_test_01', name: 'Test Voice', language: 'en' }]);
  });

  it('requires an authenticated provider manager', async () => {
    const { app } = createApp();
    assert.equal((await request(app).get('/miniapp/cartesia/overview')).status, 401);
    assert.equal((await request(app).get('/miniapp/cartesia/overview').set('x-session', 'operator')).status, 403);
  });

  it('returns sanitized read-only operations data and capability-aware configuration status', async () => {
    const { app, externalReads } = createApp();
    const response = await request(app).get('/miniapp/cartesia/overview?limit=10')
      .set('x-session', 'operator')
      .set('x-capability', 'provider_manage')
      .set('x-call-history', 'users_manage');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.status, {
      enabled: true,
      configured: true,
      apiVersion: '2026-08-14',
      dispatchEnabled: false,
      lineRuntimeEnabled: false,
      lineDataHandlingReviewed: false,
      ttsProvider: 'cartesia',
      sttProvider: 'other',
      callHistoryAvailable: true,
      phoneAssignmentAvailable: true,
      reviewAuditAvailable: true,
      adminActionAuditAvailable: true,
      phoneNumberOperationAuditAvailable: true,
      providerOperationAuditAvailable: true,
      callOperationAuditAvailable: true,
    });
    assert.equal(response.body.phoneNumbers[0].number, '+15555550123');
    assert.equal(response.body.phoneNumbers[0].ownership, 'twilio_imported');
    assert.equal(response.body.calls[0].phoneNumberMasked, '+•••••••0123');
    assert.equal(response.body.calls[0].transcript, undefined);
    assert.deepEqual(externalReads, ['phone_numbers', 'providers']);
    assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false);
    assert.ok(response.body.capabilities.some((entry) => entry.name === 'managed_agent_websocket'));
  });

  it('shows webhook assignment audit actions in the existing provider-operation audit feed', async () => {
    const { app, providerOperationAuditEvents } = createApp();
    providerOperationAuditEvents.push({
      id: 77,
      actor_type: 'admin_api',
      actor_id: 'shared_admin_token',
      action: 'agent_webhook_assignment',
      resource_id: 'agent:agent_test_01',
      outcome: 'succeeded',
      created_at: '2026-11-04T12:04:00.000Z',
    });
    const response = await request(app).get('/miniapp/cartesia/overview?limit=10')
      .set('x-session', 'operator')
      .set('x-capability', 'provider_manage')
      .set('x-call-history', 'users_manage');
    assert.equal(response.status, 200);
    assert.equal(response.body.providerOperationAudit[0].action, 'agent_webhook_assignment');
    assert.equal(response.body.providerOperationAudit[0].resourceId, 'agent:agent_test_01');
  });

  it('does not make provider inventory requests when Cartesia is disabled', async () => {
    const { app, externalReads } = createApp({
      client: { getConfigurationStatus: () => ({ enabled: false, configured: false, apiVersion: '2026-08-14' }) },
    });
    const response = await request(app).get('/miniapp/cartesia/overview?limit=10')
      .set('x-session', 'operator')
      .set('x-capability', 'provider_manage');
    assert.equal(response.status, 200);
    assert.equal(response.body.status.enabled, false);
    assert.equal(response.body.status.callHistoryAvailable, false);
    assert.equal(response.body.status.phoneAssignmentAvailable, false);
    assert.deepEqual(response.body.calls, []);
    assert.deepEqual(externalReads, []);
  });

  it('bounds the call-history query and rejects unsupported filters', async () => {
    const { app } = createApp();
    const headers = { 'x-session': 'operator', 'x-capability': 'provider_manage' };
    assert.equal((await request(app).get('/miniapp/cartesia/overview?limit=1000').set(headers)).status, 400);
    assert.equal((await request(app).get('/miniapp/cartesia/overview?business_id=other').set(headers)).status, 403);
    assert.equal((await request(app).get('/miniapp/cartesia/overview?business_id[]=business_test_01').set(headers)).status, 400);
  });

  it('allows only global admins to preview and explicitly confirm Cartesia phone assignments', async () => {
    const { app, externalReads, adminActionAuditEvents } = createApp();
    const baseHeaders = { 'x-session': 'operator', 'x-capability': 'provider_manage' };
    const denied = await request(app).post('/miniapp/cartesia/phone-numbers/pn_test_01/assignment/preview')
      .set(baseHeaders).send({ agent_id: 'agent_next_01' });
    assert.equal(denied.status, 403);

    const headers = { ...baseHeaders, 'x-call-history': 'users_manage' };
    const preview = await request(app).post('/miniapp/cartesia/phone-numbers/pn_test_01/assignment/preview')
      .set(headers).send({ agent_id: 'agent_next_01' });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers['cache-control'], 'no-store');
    assert.equal(preview.body.preview.currentAgentId, 'agent_old_01');
    assert.equal(preview.body.preview.targetAgentId, 'agent_next_01');

    const invalid = await request(app).put('/miniapp/cartesia/phone-numbers/pn_test_01/assignment')
      .set(headers).send({ agent_id: 'agent_next_01', approved: true, confirmed_fingerprint: 'a'.repeat(64) });
    assert.equal(invalid.status, 400);

    const assignment = await request(app).put('/miniapp/cartesia/phone-numbers/pn_test_01/assignment')
      .set(headers).send({
        agent_id: 'agent_next_01', approved: true, confirmed_fingerprint: 'a'.repeat(64), idempotency_key: 'ui-assignment-01',
      });
    assert.equal(assignment.status, 200);
    assert.deepEqual(assignment.body.assignment, {
      phoneNumberId: 'pn_test_01', previousAgentId: 'agent_old_01', agentId: 'agent_next_01', changed: true, idempotentReplay: false,
    });
    assert.equal(externalReads.filter((operation) => operation.startsWith('assignment')).length, 2);
    assert.deepEqual(adminActionAuditEvents.map((event) => event.outcome), ['succeeded', 'requested']);
    assert.equal(adminActionAuditEvents[0].actor_telegram_id, '12345');
    assert.equal(adminActionAuditEvents[0].resource_id, 'pn_test_01');
    assert.equal(adminActionAuditEvents[0].previous_agent_id, 'agent_old_01');
    assert.equal(adminActionAuditEvents[0].target_agent_id, 'agent_next_01');
    assert.equal(JSON.stringify(adminActionAuditEvents).includes('+15555550123'), false);

    const overview = await request(app).get('/miniapp/cartesia/overview?limit=10').set(headers);
    assert.equal(overview.body.status.adminActionAuditAvailable, true);
    assert.deepEqual(overview.body.adminActionAudit.map((event) => event.outcome), ['succeeded', 'requested']);
  });

  it('does not preview phone assignments when the server-side mutation gate is disabled', async () => {
    const { app, externalReads } = createApp({ phoneNumberService: { mutationsEnabled: false } });
    const headers = { 'x-session': 'operator', 'x-capability': 'provider_manage', 'x-call-history': 'users_manage' };
    const response = await request(app).post('/miniapp/cartesia/phone-numbers/pn_test_01/assignment/preview')
      .set(headers).send({ agent_id: 'agent_next_01' });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'cartesia_phone_number_mutations_disabled');
    assert.equal(externalReads.some((operation) => operation.startsWith('assignment')), false);
  });

  it('audits ambiguous assignment outcomes and requires an intent audit before provider writes', async () => {
    const ambiguous = createApp({
      phoneNumberService: {
        mutationsEnabled: true,
        async prepareAssignment() { return { requestFingerprint: 'a'.repeat(64) }; },
        async assignAgent() {
          throw Object.assign(new Error('outcome unknown'), { code: 'cartesia_phone_assignment_outcome_unknown', status: 409 });
        },
      },
    });
    const headers = { 'x-session': 'operator', 'x-capability': 'provider_manage', 'x-call-history': 'users_manage' };
    const response = await request(ambiguous.app).put('/miniapp/cartesia/phone-numbers/pn_test_01/assignment')
      .set(headers).send({ agent_id: 'agent_next_01', approved: true, confirmed_fingerprint: 'a'.repeat(64), idempotency_key: 'ui-assignment-02' });
    assert.equal(response.status, 409);
    assert.equal(ambiguous.adminActionAuditEvents[0].outcome, 'outcome_unknown');

    const auditUnavailable = createApp({
      db: { async recordCartesiaAdminActionAudit() { throw new Error('audit unavailable'); } },
    });
    const denied = await request(auditUnavailable.app).put('/miniapp/cartesia/phone-numbers/pn_test_01/assignment')
      .set(headers).send({ agent_id: 'agent_next_01', approved: true, confirmed_fingerprint: 'a'.repeat(64), idempotency_key: 'ui-assignment-03' });
    assert.equal(denied.status, 503);
    assert.equal(denied.body.code, 'cartesia_admin_action_audit_unavailable');
    assert.equal(auditUnavailable.externalReads.some((operation) => operation.startsWith('assignment:')), false);
  });

  it('returns business-scoped call metadata only to an active business operator', async () => {
    const { app } = createApp();
    const headers = { 'x-session': 'operator', 'x-capability': 'provider_manage' };
    const denied = await request(app).get('/miniapp/cartesia/overview?limit=10&business_id=other_business').set(headers);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'cartesia_business_access_denied');
    const allowed = await request(app).get('/miniapp/cartesia/overview?limit=10&business_id=business_test_01').set(headers);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.business_id, 'business_test_01');
    assert.equal(allowed.body.status.callHistoryAvailable, true);
    assert.equal(allowed.body.status.reviewAuditAvailable, false);
    assert.equal(allowed.body.status.adminActionAuditAvailable, false);
    assert.deepEqual(allowed.body.reviewAudit, []);
    assert.deepEqual(allowed.body.adminActionAudit, []);
    assert.equal(allowed.body.status.phoneNumberOperationAuditAvailable, false);
    assert.deepEqual(allowed.body.phoneNumberOperationAudit, []);
    assert.equal(allowed.body.status.providerOperationAuditAvailable, false);
    assert.deepEqual(allowed.body.providerOperationAudit, []);
    assert.equal(allowed.body.status.callOperationAuditAvailable, false);
    assert.deepEqual(allowed.body.callOperationAudit, []);
    assert.deepEqual(allowed.body.calls.map((call) => call.providerCallId), ['ac_business_01']);
  });

  it('returns partial inventory warnings without forwarding provider errors', async () => {
    const { app } = createApp({
      telephonyProviderService: { async listProviders() { throw new Error('credential value must-not-leak'); } },
    });
    const response = await request(app).get('/miniapp/cartesia/overview?limit=10')
      .set('x-session', 'operator')
      .set('x-capability', 'provider_manage');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.warnings, [{ source: 'telephony_providers', code: 'cartesia_read_failed' }]);
    assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false);
  });

  it('keeps call metadata hidden from provider managers without admin call-history permission', async () => {
    const { app } = createApp();
    const response = await request(app).get('/miniapp/cartesia/overview?limit=10')
      .set('x-session', 'operator')
      .set('x-capability', 'provider_manage');
    assert.equal(response.status, 200);
    assert.equal(response.body.status.callHistoryAvailable, false);
    assert.deepEqual(response.body.calls, []);
  });

  it('lists only bounded Cartesia call metadata from the existing database table', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-dashboard-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    try {
      await db.upsertCartesiaCallRecord({
        local_call_id: 'cartesia_local_01',
        provider_call_id: 'ac_test_01',
        agent_id: 'agent_test_01',
        phone_number: '+15555550123',
        direction: 'outbound',
        status: 'completed',
        event_timestamp: '2026-11-04T12:00:00.000Z',
      });
      const rows = await db.listCartesiaCallRecords(10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].provider_call_id, 'ac_test_01');
      assert.equal(rows[0].phone_number, '+15555550123');
      const stored = await db.getCartesiaCallRecordByProviderId('ac_test_01');
      assert.equal(stored.provider_call_id, 'ac_test_01');
      assert.equal(await db.getCartesiaCallRecordByProviderId('ac_unknown_01'), null);
      await assert.rejects(db.getCartesiaCallRecordByProviderId('../invalid'), /provider call ID is invalid/);
      await db.upsertCartesiaCallRecord({
        local_call_id: 'cartesia_local_business_01',
        provider_call_id: 'ac_business_01',
        business_id: 'business_test_01',
        agent_id: 'agent_business_01',
        direction: 'inbound',
        status: 'completed',
        event_timestamp: '2026-11-04T12:00:00.000Z',
      });
      const scopedRows = await db.listCartesiaCallRecordsForBusiness('business_test_01', 10);
      assert.deepEqual(scopedRows.map((row) => row.provider_call_id), ['ac_business_01']);
      assert.equal((await db.getCartesiaCallRecordByProviderId('ac_business_01', 'business_test_01')).business_id, 'business_test_01');
      assert.equal(await db.getCartesiaCallRecordByProviderId('ac_business_01', 'another_business'), null);
      await assert.rejects(db.listCartesiaCallRecordsForBusiness('../invalid', 10), /query is invalid/);
      const audit = await db.recordCartesiaCallReviewAudit({
        actor_telegram_id: '12345',
        business_id: 'business_test_01',
        provider_call_id: 'ac_business_01',
        outcome: 'allowed',
      });
      assert.equal(audit.recorded, true);
      const auditRows = await db.listCartesiaCallReviewAudit(10);
      assert.equal(auditRows.length, 1);
      assert.deepEqual(Object.keys(auditRows[0]).sort(), ['actor_telegram_id', 'business_id', 'created_at', 'id', 'outcome', 'provider_call_id', 'reason_code']);
      await assert.rejects(db.recordCartesiaCallReviewAudit({ actor_telegram_id: 'bad', provider_call_id: 'ac_test_01', outcome: 'allowed' }), /audit input is invalid/);
      await assert.rejects(db.listCartesiaCallReviewAudit(101), /audit limit is invalid/);
      await db.recordCartesiaAdminActionAudit({
        actor_telegram_id: '12345',
        action: 'phone_agent_assignment',
        resource_type: 'phone_number',
        resource_id: 'pn_test_01',
        outcome: 'requested',
        target_agent_id: 'agent_next_01',
        request_fingerprint: 'a'.repeat(64),
      });
      await db.recordCartesiaAdminActionAudit({
        actor_telegram_id: '12345',
        action: 'phone_agent_assignment',
        resource_type: 'phone_number',
        resource_id: 'pn_test_01',
        outcome: 'succeeded',
        previous_agent_id: 'agent_old_01',
        target_agent_id: 'agent_next_01',
        request_fingerprint: 'a'.repeat(64),
      });
      const adminActionAuditRows = await db.listCartesiaAdminActionAudit(10);
      assert.equal(adminActionAuditRows.length, 2);
      assert.equal(adminActionAuditRows[0].previous_agent_id, 'agent_old_01');
      assert.equal(Object.hasOwn(adminActionAuditRows[0], 'request_fingerprint'), false);
      await assert.rejects(db.recordCartesiaAdminActionAudit({ actor_telegram_id: 'bad' }), /admin-action audit input is invalid/);
      await assert.rejects(db.listCartesiaAdminActionAudit(101), /admin-action audit limit is invalid/);
      await db.recordCartesiaPhoneNumberOperationAudit({
        actor_type: 'admin_api',
        actor_id: 'shared_admin_token',
        action: 'phone_number_import',
        resource_id: 'pending:abcdef0123456789',
        outcome: 'requested',
        request_fingerprint: 'b'.repeat(64),
      });
      const phoneOperationAuditRows = await db.listCartesiaPhoneNumberOperationAudit(10);
      assert.equal(phoneOperationAuditRows.length, 1);
      assert.equal(phoneOperationAuditRows[0].actor_type, 'admin_api');
      assert.equal(phoneOperationAuditRows[0].actor_id, 'shared_admin_token');
      assert.equal(Object.hasOwn(phoneOperationAuditRows[0], 'request_fingerprint'), false);
      await assert.rejects(db.recordCartesiaPhoneNumberOperationAudit({ actor_type: 'admin_api', actor_id: 'actual-secret-value' }), /phone-number operation audit input is invalid/);
      await assert.rejects(db.listCartesiaPhoneNumberOperationAudit(101), /operation audit limit is invalid/);
      await db.recordCartesiaProviderOperationAudit({
        actor_type: 'admin_api',
        actor_id: 'shared_admin_token',
        action: 'sip_provider_update',
        resource_id: 'provider_sip_test',
        outcome: 'requested',
        request_fingerprint: 'c'.repeat(64),
      });
      await db.recordCartesiaWebhookAssignmentAudit({
        actor_type: 'admin_api',
        actor_id: 'shared_admin_token',
        action: 'agent_webhook_assignment',
        resource_id: 'agent:agent_test_01',
        outcome: 'succeeded',
        request_fingerprint: 'd'.repeat(64),
      });
      await db.recordCartesiaWebhookCreationAudit({
        actor_type: 'admin_api',
        actor_id: 'shared_admin_token',
        action: 'webhook_create',
        resource_id: `endpoint:${'e'.repeat(32)}`,
        outcome: 'succeeded',
        request_fingerprint: 'f'.repeat(64),
      });
      const providerOperationAuditRows = await db.listCartesiaProviderOperationAudit(10);
      assert.equal(providerOperationAuditRows.length, 3);
      assert.deepEqual(providerOperationAuditRows.map((row) => row.action).sort(), ['agent_webhook_assignment', 'sip_provider_update', 'webhook_create']);
      assert.equal(Object.hasOwn(providerOperationAuditRows.find((row) => row.action === 'agent_webhook_assignment'), 'request_fingerprint'), false);
      assert.equal(Object.hasOwn(providerOperationAuditRows.find((row) => row.action === 'webhook_create'), 'request_fingerprint'), false);
      await assert.rejects(db.recordCartesiaProviderOperationAudit({ actor_type: 'admin_api', actor_id: 'real-user' }), /provider operation audit input is invalid/);
      await assert.rejects(db.listCartesiaProviderOperationAudit(101), /provider operation audit limit is invalid/);
      await db.recordCartesiaCallOperationAudit({
        actor_type: 'admin_api', actor_id: 'shared_admin_token', action: 'outbound_call_cancel',
        resource_id: 'ac_test_01', outcome: 'requested', request_fingerprint: 'd'.repeat(64),
      });
      const callOperationAuditRows = await db.listCartesiaCallOperationAudit(10);
      assert.equal(callOperationAuditRows.length, 1);
      assert.equal(callOperationAuditRows[0].action, 'outbound_call_cancel');
      assert.equal(Object.hasOwn(callOperationAuditRows[0], 'request_fingerprint'), false);
      await assert.rejects(db.recordCartesiaCallOperationAudit({ actor_type: 'admin_api', actor_id: 'wrong' }), /call operation audit input is invalid/);
      await assert.rejects(db.listCartesiaCallOperationAudit(101), /call operation audit limit is invalid/);
      assert.equal(Object.hasOwn(rows[0], 'business_id'), false);
      await assert.rejects(db.listCartesiaCallRecords(51), /limit is invalid/);
    } finally {
      await db.close();
      for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
      }
    }
  });

  it('requires an authenticated provider manager with global call-history access', async () => {
    const { app, externalReads } = createApp();
    const path = '/miniapp/cartesia/calls/ac_test_01/review';
    assert.equal((await request(app).post(path).send({ confirm_private_data_review: true })).status, 401);
    assert.equal((await request(app).post(path).set('x-session', 'operator').send({ confirm_private_data_review: true })).status, 403);
    assert.equal((await request(app).post(path).set({ 'x-session': 'operator', 'x-capability': 'provider_manage' }).send({ confirm_private_data_review: true })).status, 403);
    assert.deepEqual(externalReads, []);
  });

  it('allows a business operator to review only a call belonging to their business', async () => {
    const { app, externalReads, auditEvents } = createApp();
    const headers = { 'x-session': 'operator', 'x-capability': 'provider_manage' };
    const path = '/miniapp/cartesia/calls/ac_business_01/review';
    const denied = await request(app).post(path).set(headers).send({ confirm_private_data_review: true, business_id: 'other_business' });
    assert.equal(denied.status, 404);
    assert.deepEqual(externalReads, []);
    assert.equal(auditEvents[0].outcome, 'denied');
    assert.equal(auditEvents[0].business_id, 'other_business');
    const allowed = await request(app).post(path).set(headers).send({ confirm_private_data_review: true, business_id: 'business_test_01' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.call.providerCallId, 'ac_business_01');
    assert.equal(auditEvents[0].outcome, 'allowed');
    assert.equal(auditEvents[0].business_id, 'business_test_01');
    assert.deepEqual(externalReads, ['call:ac_business_01']);
  });

  it('requires exact explicit review confirmation and a locally stored call before provider reads', async () => {
    const { app, externalReads } = createApp();
    const headers = { 'x-session': 'operator', 'x-capability': 'provider_manage', 'x-call-history': 'users_manage' };
    assert.equal((await request(app).post('/miniapp/cartesia/calls/ac_test_01/review').set(headers).send({})).status, 400);
    assert.equal((await request(app).post('/miniapp/cartesia/calls/ac_test_01/review').set(headers).send({ confirm_private_data_review: true, include_recording: true })).status, 400);
    assert.equal((await request(app).post('/miniapp/cartesia/calls/ac_unknown_01/review').set(headers).send({ confirm_private_data_review: true })).status, 404);
    assert.deepEqual(externalReads, []);
  });

  it('returns bounded private review details only after confirmation and omits identifiers and secrets', async () => {
    const { app, externalReads, auditEvents } = createApp();
    const response = await request(app).post('/miniapp/cartesia/calls/ac_test_01/review')
      .set({ 'x-session': 'operator', 'x-capability': 'provider_manage', 'x-call-history': 'users_manage' })
      .send({ confirm_private_data_review: true });
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.body.call, {
      provider: 'cartesia',
      providerCallId: 'ac_test_01',
      agentId: 'agent_test_01',
      status: 'completed',
      startTime: '2026-11-04T12:00:00.000Z',
      endTime: '2026-11-04T12:00:12.000Z',
      direction: 'outbound',
      fromNumberMasked: '+•••••••0100',
      toNumberMasked: '+•••••••0123',
      telephonyAccountType: 'twilio',
      summary: 'Customer asked for a callback.',
      transcript: [{ role: 'user', text: 'Please call tomorrow.', startTimestamp: 1, endTimestamp: 2 }],
      transcriptTruncated: false,
      zdrEnabled: false,
      endReason: 'agent_hangup',
    });
    assert.deepEqual(externalReads, ['call:ac_test_01']);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].outcome, 'allowed');
    assert.equal(auditEvents[0].provider_call_id, 'ac_test_01');
    assert.equal(Object.hasOwn(auditEvents[0], 'transcript'), false);
    assert.equal(Object.hasOwn(auditEvents[0], 'phone_number'), false);
    assert.equal(JSON.stringify(response.body).includes('+15555550123'), false);
    assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false);
    const overview = await request(app).get('/miniapp/cartesia/overview?limit=10')
      .set({ 'x-session': 'operator', 'x-capability': 'provider_manage', 'x-call-history': 'users_manage' });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.status.reviewAuditAvailable, true);
    assert.equal(overview.body.reviewAudit[0].outcome, 'allowed');
    assert.equal(overview.body.reviewAudit[0].providerCallId, 'ac_test_01');
    assert.equal(JSON.stringify(overview.body.reviewAudit).includes('Please call tomorrow.'), false);
  });

  it('bounds transcript content and suppresses private content for zero-data-retention calls', async () => {
    const longTranscript = Array.from({ length: 205 }, (_, index) => ({ role: 'user', text: `turn-${index}-${'x'.repeat(2100)}` }));
    const { app } = createApp({
      callService: {
        async getCall(providerCallId) {
          return { providerCallId, agentId: 'agent_test_01', status: 'completed', summary: 'must-not-leak', transcript: longTranscript, zdrEnabled: true };
        },
      },
    });
    const response = await request(app).post('/miniapp/cartesia/calls/ac_test_01/review')
      .set({ 'x-session': 'operator', 'x-capability': 'provider_manage', 'x-call-history': 'users_manage' })
      .send({ confirm_private_data_review: true });
    assert.equal(response.status, 200);
    assert.equal(response.body.call.zdrEnabled, true);
    assert.equal(response.body.call.summary, null);
    assert.deepEqual(response.body.call.transcript, []);
    assert.equal(response.body.call.transcriptTruncated, false);
    assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false);
  });

  it('bounds retained transcript review responses', async () => {
    const longTranscript = Array.from({ length: 205 }, (_, index) => ({ role: 'assistant', text: `turn-${index}-${'x'.repeat(2100)}` }));
    const { app } = createApp({
      callService: {
        async getCall(providerCallId) {
          return { providerCallId, agentId: 'agent_test_01', status: 'completed', transcript: longTranscript, zdrEnabled: false };
        },
      },
    });
    const response = await request(app).post('/miniapp/cartesia/calls/ac_test_01/review')
      .set({ 'x-session': 'operator', 'x-capability': 'provider_manage', 'x-call-history': 'users_manage' })
      .send({ confirm_private_data_review: true });
    assert.equal(response.status, 200);
    assert.ok(response.body.call.transcript.length <= 200);
    assert.ok(response.body.call.transcript.reduce((size, turn) => size + turn.text.length, 0) <= 30000);
    assert.equal(response.body.call.transcriptTruncated, true);
  });

  it('sanitizes Cartesia review failures', async () => {
    const { app, auditEvents } = createApp({
      callService: { async getCall() { const error = new Error('sensitive provider response'); error.code = 'cartesia_call_read_failed'; error.status = 502; throw error; } },
    });
    const response = await request(app).post('/miniapp/cartesia/calls/ac_test_01/review')
      .set({ 'x-session': 'operator', 'x-capability': 'provider_manage', 'x-call-history': 'users_manage' })
      .send({ confirm_private_data_review: true });
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'cartesia_call_read_failed');
    assert.equal(response.body.error, 'Cartesia call review is unavailable');
    assert.equal(JSON.stringify(response.body).includes('sensitive provider response'), false);
    assert.equal(auditEvents[0].outcome, 'failed');
    assert.equal(auditEvents[0].reason_code, 'cartesia_call_read_failed');
  });

  it('does not return private call content when the successful review cannot be audited', async () => {
    const { app, externalReads } = createApp({
      db: { async recordCartesiaCallReviewAudit() { throw new Error('audit storage unavailable'); } },
    });
    const response = await request(app).post('/miniapp/cartesia/calls/ac_test_01/review')
      .set({ 'x-session': 'operator', 'x-capability': 'provider_manage', 'x-call-history': 'users_manage' })
      .send({ confirm_private_data_review: true });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'cartesia_review_audit_unavailable');
    assert.equal(JSON.stringify(response.body).includes('Please call tomorrow.'), false);
    assert.deepEqual(externalReads, ['call:ac_test_01']);
  });
});
