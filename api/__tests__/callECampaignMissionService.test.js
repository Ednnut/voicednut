'use strict';

const assert = require('node:assert/strict');
const {
  CallECampaignMissionService,
  encryptDestination,
  decryptDestination,
} = require('../services/callECampaignMissionService');

const encryptionSecret = 'test-only-mission-encryption-secret-32-bytes';
const idempotencySecret = 'test-only-mission-idempotency-secret-32-bytes';
const destination1 = '+14155550101';
const destination2 = '+14155550102';
const missionId = `mission_${'a'.repeat(64)}`;

describe('CALL-E campaign mission approval', () => {
  it('decrypts persisted recipient values with retained key versions after rotation', () => {
    const oldKeys = { 1: encryptionSecret };
    const rotatedKeys = { 1: encryptionSecret, 2: 'rotated-test-key-secret-with-at-least-32-bytes' };
    const encrypted = encryptDestination(destination1, oldKeys, missionId, 0, 1);
    assert.equal(decryptDestination(encrypted, rotatedKeys, missionId, 0, 1), destination1);
    const nextVersion = encryptDestination(destination2, rotatedKeys, missionId, 1, 2);
    assert.equal(decryptDestination(nextVersion, rotatedKeys, missionId, 1, 2), destination2);
    assert.throws(() => decryptDestination(encrypted, { 2: rotatedKeys[2] }, missionId, 0, 1), (error) => error.code === 'call_e_mission_encryption_unavailable');
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`;
    assert.throws(() => decryptDestination(tampered, rotatedKeys, missionId, 0, 1), (error) => error.code === 'call_e_mission_recipient_decryption_failed');
  });

  it('returns sanitized approval history only inside the current business scope', async () => {
    const service = new CallECampaignMissionService({
      campaignService: { async assertMembership() { return { role: 'policy_manager' }; } },
      db: { async getCallECampaignMission() {
        return {
          mission_id: missionId, business_id: 'business_1', campaign_id: `campaign_${'b'.repeat(64)}`,
          request_hash: 'c'.repeat(64), status: 'approved', recipient_count: 1, recipients: [], resolutions: [],
          reviewHistory: [
            { reviewed_by: '23456', decision: 'approve', request_hash: 'c'.repeat(64), created_at: '2026-10-31T12:00:00Z' },
            { reviewed_by: 'private', decision: 'discard', request_hash: 'bad', created_at: '2026-10-31T12:01:00Z' },
          ],
        };
      } },
    });
    const result = await service.get({ mission_id: missionId, business_id: 'business_1', actor_id: '12345' });
    assert.deepEqual(result.review_history, [
      { reviewed_by: '23456', decision: 'approve', request_hash: 'c'.repeat(64), created_at: '2026-10-31T12:00:00Z' },
      { reviewed_by: null, decision: null, request_hash: null, created_at: '2026-10-31T12:01:00Z' },
    ]);
  });

  it('builds a read-only readiness report from current approval, consent, budget, safety, and provider gates', async () => {
    const hash = 'd'.repeat(64);
    const encrypted = encryptDestination(destination1, encryptionSecret, missionId, 0, 1);
    const mission = { mission_id: missionId, business_id: 'business_1', campaign_id: `campaign_${'b'.repeat(64)}`,
      request_hash: hash, status: 'approved', recipient_count: 1, created_by: '12345', template_id: 7, template_version: 3,
      result_schema_json: JSON.stringify({ type: 'object', properties: {}, additionalProperties: false }), encryption_key_version: 1,
      budget_limit_minor: 1000, per_call_cost_ceiling_minor: 200, budget_currency: 'USD', budget_reserved_minor: 100,
      recipients: [{ position: 0, encrypted_destination: encrypted }] };
    let dispatched = false;
    const service = new CallECampaignMissionService({
      idempotencySecret, encryptionKeys: { 1: encryptionSecret },
      env: { CALLE_MISSION_DISPATCH_ENABLED: 'true', CALLE_DISPATCH_ENABLED: 'true', CALLE_PILOT_READINESS_REVIEWED: 'true',
        CALLE_MISSION_APPROVED_ID: missionId, CALLE_MISSION_APPROVED_FINGERPRINT: hash, CALLE_MISSION_APPROVAL_REFERENCE: 'approval-ref-01',
        CALLE_MISSION_APPROVAL_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(), CALLE_MISSION_MAX_RECIPIENTS: '25' },
      campaignService: { async assertMembership() { return { role: 'call_operator' }; }, async preflight() { return { all_ready: true }; } },
      safetyService: { async assertDispatchAllowed() { return { policy: { timezone: 'UTC', quiet_hours_start: null, quiet_hours_end: null, emergency_stop: false } }; } },
      providerRoutingPreview: async () => ({ selected_provider: 'twilio', eligible_order: ['twilio'], blocked_providers: [] }),
      dispatchRecipient: async () => { dispatched = true; },
      db: { async getCallECampaignMission() { return mission; }, async validateCallECampaignMissionApproval() { return { valid: true }; },
        async getCallEMissionUsageReport() { return { actual_by_currency: { USD: 100 } }; } },
    });
    const report = await service.readinessReport({ mission_id: missionId, business_id: 'business_1', actor_id: '12345' });
    assert.equal(report.ready, true);
    assert.equal(report.dispatch_performed, false);
    assert.equal(report.checks.find((item) => item.key === 'consent_and_template').ready, true);
    assert.equal(report.budget.actual_minor, 100);
    assert.equal(dispatched, false);
  });

  it('persists only encrypted destinations and creates a pending-approval mission after fresh preflight', async () => {
    let inserted;
    let preflightInput;
    let savedMission;
    let allowPreflight = true;
    const service = new CallECampaignMissionService({
      idempotencySecret,
      encryptionSecret,
      campaignService: {
        async preflight(input) {
          preflightInput = input;
          if (!allowPreflight) return { all_ready: false, recipients: [{ status: 'blocked' }] };
          return {
            campaign: { campaign_id: `campaign_${'b'.repeat(64)}`, template_id: 7, template_version: 3 },
            recipients: [{ status: 'ready' }, { status: 'ready' }],
            all_ready: true,
          };
        },
        async assertMembership() { return { role: 'call_operator' }; },
      },
      db: {
        async getCallECampaignMission(id) {
          return savedMission?.mission_id === id ? { ...savedMission, recipients: inserted.recipients } : null;
        },
        async createCallECampaignMission(input) {
          inserted = input;
          savedMission = {
            mission_id: input.mission_id,
            business_id: input.business_id,
            campaign_id: input.campaign_id,
            template_id: input.template_id,
            template_version: input.template_version,
            request_hash: input.request_hash,
            result_schema_json: input.result_schema_json,
            recipient_count: input.recipients.length,
            status: 'pending_approval',
            created_by: input.created_by,
            reviewed_by: null,
          };
          return {
            mission: savedMission,
            idempotentReplay: false,
          };
        },
      },
    });

    const result = await service.create({
      business_id: 'business_1',
      actor_id: '12345',
      campaign_id: `campaign_${'b'.repeat(64)}`,
      idempotency_key: 'mission-request-001',
      destinations: [destination1, destination2],
      result_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
    });

    assert.equal(preflightInput.authorized, true);
    assert.equal(result.mission.status, 'pending_approval');
    assert.equal(inserted.recipients.length, 2);
    assert.equal(inserted.recipients[0].destination_masked.endsWith('0101'), true);
    assert.equal(inserted.recipients[0].encrypted_destination.includes(destination1), false);
    assert.equal(decryptDestination(inserted.recipients[0].encrypted_destination, encryptionSecret, inserted.mission_id, 0), destination1);
    assert.equal(JSON.stringify(result).includes(destination1), false);
    allowPreflight = false;
    const replay = await service.create({
      business_id: 'business_1', actor_id: '12345', campaign_id: `campaign_${'b'.repeat(64)}`,
      idempotency_key: 'mission-request-001', destinations: [destination1, destination2],
      result_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
    });
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.mission.mission_id, result.mission.mission_id);
  });

  it('fails closed when preflight blocks any recipient', async () => {
    const service = new CallECampaignMissionService({
      idempotencySecret,
      encryptionSecret,
      campaignService: {
        async assertMembership() { return { role: 'call_operator' }; },
        async preflight() { return { all_ready: false, recipients: [{ status: 'blocked' }] }; },
      },
      db: {
        async getCallECampaignMission() { return null; },
        async createCallECampaignMission() { assert.fail('must not persist a blocked mission'); },
      },
    });
    await assert.rejects(service.create({
      business_id: 'business_1', actor_id: '12345', campaign_id: `campaign_${'b'.repeat(64)}`,
      idempotency_key: 'mission-request-002', destinations: [destination1],
      result_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
    }), (error) => error.code === 'call_e_mission_preflight_blocked');
  });

  it('rejects an invalid configured encryption key version without silently selecting another key', async () => {
    const service = new CallECampaignMissionService({
      idempotencySecret,
      encryptionSecret,
      encryptionKeyVersion: 0,
      campaignService: { async assertMembership() { return { role: 'call_operator' }; } },
      db: { async getCallECampaignMission() { return null; }, async createCallECampaignMission() { assert.fail('must not persist'); } },
    });
    await assert.rejects(service.create({
      business_id: 'business_1', actor_id: '12345', campaign_id: `campaign_${'b'.repeat(64)}`,
      idempotency_key: 'mission-request-003', destinations: [destination1],
      result_schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
    }), (error) => error.code === 'call_e_mission_encryption_unavailable');
  });

  it('does not claim a recipient or dispatch while mission dispatch is disabled', async () => {
    let claimed = false;
    let dispatched = false;
    const service = new CallECampaignMissionService({
      campaignService: { async assertMembership() { return { role: 'call_operator' }; } },
      db: {
        async getCallECampaignMission() { return { mission_id: missionId, business_id: 'business_1', status: 'approved', request_hash: 'a'.repeat(64), recipient_count: 1 }; },
        async claimNextCallECampaignMissionRecipient() { claimed = true; },
      },
      env: { CALLE_MISSION_DISPATCH_ENABLED: 'false' },
      dispatchRecipient() { dispatched = true; },
    });
    await assert.rejects(service.advance({ business_id: 'business_1', actor_id: '12345', mission_id: missionId }),
      (error) => error.code === 'call_e_mission_dispatch_disabled');
    assert.equal(claimed, false);
    assert.equal(dispatched, false);
  });

  it('returns terminal mission state without requiring an active dispatch gate', async () => {
    const service = new CallECampaignMissionService({
      campaignService: { async assertMembership() { return { role: 'call_operator' }; } },
      db: { async getCallECampaignMission() { return { mission_id: missionId, business_id: 'business_1', status: 'completed' }; } },
      env: { CALLE_MISSION_DISPATCH_ENABLED: 'false' },
    });
    const result = await service.advance({ business_id: 'business_1', actor_id: '12345', mission_id: missionId });
    assert.equal(result.state, 'completed');
    assert.equal(result.provider_requests, 0);
  });

  it('requires the exact mission request fingerprint even when the mission ID is approved', () => {
    const mission = { mission_id: missionId, request_hash: 'a'.repeat(64), recipient_count: 1 };
    const service = new CallECampaignMissionService({ env: {
      CALLE_MISSION_DISPATCH_ENABLED: 'true', CALLE_DISPATCH_ENABLED: 'true', CALLE_PILOT_READINESS_REVIEWED: 'true',
      CALLE_MISSION_APPROVED_ID: missionId, CALLE_MISSION_APPROVAL_REFERENCE: 'approved-mission-2026',
      CALLE_MISSION_APPROVAL_EXPIRES_AT: '2099-01-01T00:00:00Z', CALLE_MISSION_MAX_RECIPIENTS: '1',
    } });
    assert.throws(() => service.missionDispatchApproval(mission), (error) => error.code === 'call_e_mission_approval_required');
    service.env.CALLE_MISSION_APPROVED_FINGERPRINT = mission.request_hash;
    assert.deepEqual(service.missionDispatchApproval(mission), { reference: 'approved-mission-2026' });
  });

  it('requires policy-manager membership and an idempotency key to resolve a paused mission', async () => {
    let resolutionInput;
    let role = 'policy_manager';
    const service = new CallECampaignMissionService({
      campaignService: { async assertMembership(_businessId, _actorId, roles) {
        assert.equal(roles.has('policy_manager'), true);
        if (role !== 'policy_manager') throw Object.assign(new Error('policy manager required'), { code: 'call_e_business_operator_access_denied', status: 403 });
        return { role };
      } },
      db: {
        async resolveCallECampaignMission(input) {
          resolutionInput = input;
          return { mission: { mission_id: missionId, status: 'running' }, idempotentReplay: false };
        },
      },
    });
    const result = await service.resolve({
      mission_id: missionId, business_id: 'business_1', actor_id: '23456',
      decision: 'continue', idempotency_key: 'resolution-key-0001',
    });
    assert.equal(result.mission.status, 'running');
    assert.equal(resolutionInput.resolved_by, '23456');
    assert.equal(resolutionInput.idempotency_key, 'resolution-key-0001');
    role = 'call_operator';
    await assert.rejects(service.resolve({
      mission_id: missionId, business_id: 'business_1', actor_id: '23456',
      decision: 'cancel', idempotency_key: 'resolution-key-0002',
    }), (error) => error.code === 'call_e_business_operator_access_denied');
  });

  it('does not advance to another recipient when call execution ended but the result is pending', async () => {
    let claims = 0;
    const service = new CallECampaignMissionService({
      campaignService: { async assertMembership() { return { role: 'call_operator' }; } },
      getTemplate: async () => null,
      dispatchRecipient: async () => assert.fail('must not dispatch while waiting for result'),
      reconcileCall: async () => ({ executionStatus: 'completed', resultStatus: 'pending' }),
      db: {
        async getCallECampaignMission() { return {
          mission_id: missionId, business_id: 'business_1', status: 'running', request_hash: 'a'.repeat(64),
          recipient_count: 2, recipients: [{ position: 0, status: 'accepted', local_call_id: 'call_e_123e4567-e89b-12d3-a456-426614174001' }],
        }; },
        async updateCallECampaignMissionRecipient() { assert.fail('must not mark recipient complete while result is pending'); },
        async claimNextCallECampaignMissionRecipient() { claims += 1; return null; },
      },
      env: {
        CALLE_MISSION_DISPATCH_ENABLED: 'true', CALLE_DISPATCH_ENABLED: 'true', CALLE_PILOT_READINESS_REVIEWED: 'true',
        CALLE_MISSION_APPROVED_ID: missionId, CALLE_MISSION_APPROVED_FINGERPRINT: 'a'.repeat(64),
        CALLE_MISSION_APPROVAL_REFERENCE: 'approved-mission-2026', CALLE_MISSION_APPROVAL_EXPIRES_AT: '2099-01-01T00:00:00Z',
        CALLE_MISSION_MAX_RECIPIENTS: '2',
      },
    });
    const result = await service.advance({ business_id: 'business_1', actor_id: '12345', mission_id: missionId });
    assert.equal(result.state, 'waiting_for_result');
    assert.equal(result.provider_requests, 0);
    assert.equal(claims, 0);
  });

  it('marks a terminal failed CALL-E execution for review instead of counting it as completed', async () => {
    let missionReads = 0;
    let update;
    const runningMission = {
      mission_id: missionId, business_id: 'business_1', status: 'running', request_hash: 'a'.repeat(64),
      recipient_count: 1, recipients: [{ position: 0, status: 'accepted', local_call_id: 'call_e_123e4567-e89b-12d3-a456-426614174001' }],
    };
    const service = new CallECampaignMissionService({
      campaignService: { async assertMembership() { return { role: 'call_operator' }; } },
      getTemplate: async () => null,
      dispatchRecipient: async () => assert.fail('must not dispatch after terminal failure'),
      reconcileCall: async () => ({ executionStatus: 'failed', resultStatus: 'not_applicable', errorCode: 'call_failed' }),
      db: {
        async getCallECampaignMission() {
          missionReads += 1;
          return missionReads === 1 ? runningMission : { ...runningMission, status: 'needs_review' };
        },
        async updateCallECampaignMissionRecipient(input) { update = input; },
        async claimNextCallECampaignMissionRecipient() { assert.fail('mission requiring review must not claim another recipient'); },
      },
      env: {
        CALLE_MISSION_DISPATCH_ENABLED: 'true', CALLE_DISPATCH_ENABLED: 'true', CALLE_PILOT_READINESS_REVIEWED: 'true',
        CALLE_MISSION_APPROVED_ID: missionId, CALLE_MISSION_APPROVED_FINGERPRINT: 'a'.repeat(64),
        CALLE_MISSION_APPROVAL_REFERENCE: 'approved-mission-2026', CALLE_MISSION_APPROVAL_EXPIRES_AT: '2099-01-01T00:00:00Z',
        CALLE_MISSION_MAX_RECIPIENTS: '1',
      },
    });
    await assert.rejects(service.advance({ business_id: 'business_1', actor_id: '12345', mission_id: missionId }),
      (error) => error.code === 'call_e_mission_not_approved');
    assert.equal(update.status, 'failed');
    assert.equal(update.error_code, 'call_failed');
  });

  it('dispatches one claimed recipient with the durable idempotency key and exact approval gate', async () => {
    const encrypted = encryptDestination(destination1, { 1: encryptionSecret }, missionId, 0, 1);
    const schema = { type: 'object', additionalProperties: false, required: [], properties: {} };
    const stored = {
      mission_id: missionId, business_id: 'business_1', campaign_id: `campaign_${'b'.repeat(64)}`,
      template_id: 7, template_version: 3, status: 'approved', request_hash: 'a'.repeat(64),
      recipient_count: 1, result_schema_json: JSON.stringify(schema), encryption_key_version: 1,
      recipients: [{ position: 0, encrypted_destination: encrypted, destination_masked: '••••0101',
        idempotency_key: 'voicednut:call-e:mission-recipient-0001', status: 'queued' }],
    };
    let claimedRecipient;
    let acceptedUpdate;
    let dispatchCalls = 0;
    const service = new CallECampaignMissionService({
      encryptionKeys: { 1: encryptionSecret },
      campaignService: {
        async assertMembership() { return { role: 'call_operator' }; },
        async preflight(input) { assert.deepEqual(input.destinations, [destination1]); return { all_ready: true }; },
      },
      getTemplate: async () => ({ id: 7, version: 3, business_id: 'business_1', lifecycle_state: 'live', prompt: 'Check the appointment.', first_message: 'Hello.' }),
      dispatchRecipient: async (request) => {
        dispatchCalls += 1;
        assert.equal(request.phone, destination1);
        assert.equal(request.idempotencyKey, 'mission-recipient-0001');
        assert.equal(request.missionAuthorization.request_hash, 'a'.repeat(64));
        return { localCallId: 'call_e_12345678-1234-4234-9234-123456789abc', idempotentReplay: false };
      },
      db: {
        async getCallECampaignMission() { return stored; },
        async claimNextCallECampaignMissionRecipient() {
          claimedRecipient = { ...stored.recipients[0], status: 'in_progress' };
          return { mission: stored, recipient: claimedRecipient, recovery: false };
        },
        async updateCallECampaignMissionRecipient(input) { acceptedUpdate = input; return stored; },
      },
      env: {
        CALLE_MISSION_DISPATCH_ENABLED: 'true', CALLE_DISPATCH_ENABLED: 'true', CALLE_PILOT_READINESS_REVIEWED: 'true',
        CALLE_MISSION_APPROVED_ID: missionId, CALLE_MISSION_APPROVED_FINGERPRINT: 'a'.repeat(64), CALLE_MISSION_APPROVAL_REFERENCE: 'approved-mission-2026',
        CALLE_MISSION_APPROVAL_EXPIRES_AT: '2099-01-01T00:00:00Z', CALLE_MISSION_MAX_RECIPIENTS: '1',
      },
    });
    const result = await service.advance({ business_id: 'business_1', actor_id: '12345', mission_id: missionId });
    assert.equal(result.state, 'call_accepted');
    assert.equal(result.provider_requests, 1);
    assert.equal(dispatchCalls, 1);
    assert.equal(acceptedUpdate.status, 'accepted');
    assert.equal(acceptedUpdate.local_call_id, 'call_e_12345678-1234-4234-9234-123456789abc');
  });

  it('enforces business safety policy before claiming or dispatching a mission recipient', async () => {
    let claims = 0;
    let dispatches = 0;
    const service = new CallECampaignMissionService({
      campaignService: { async assertMembership() { return { role: 'call_operator' }; } },
      safetyService: { async assertDispatchAllowed() { throw Object.assign(new Error('emergency stop'), { code: 'call_e_emergency_stop_active', status: 409 }); }, async reserveDispatch() { return { allowed: true }; } },
      db: { async getCallECampaignMission() { return { mission_id: missionId, business_id: 'business_1', status: 'approved', request_hash: 'a'.repeat(64), recipient_count: 1, recipients: [] }; },
        async claimNextCallECampaignMissionRecipient() { claims += 1; } },
      dispatchRecipient: async () => { dispatches += 1; },
      env: {
        CALLE_MISSION_DISPATCH_ENABLED: 'true', CALLE_DISPATCH_ENABLED: 'true', CALLE_PILOT_READINESS_REVIEWED: 'true',
        CALLE_MISSION_APPROVED_ID: missionId, CALLE_MISSION_APPROVED_FINGERPRINT: 'a'.repeat(64),
        CALLE_MISSION_APPROVAL_REFERENCE: 'approved-mission-2026', CALLE_MISSION_APPROVAL_EXPIRES_AT: '2099-01-01T00:00:00Z',
        CALLE_MISSION_MAX_RECIPIENTS: '1',
      },
    });
    await assert.rejects(service.advance({ business_id: 'business_1', actor_id: '12345', mission_id: missionId }), (error) => error.code === 'call_e_emergency_stop_active');
    assert.equal(claims, 0);
    assert.equal(dispatches, 0);
  });
});
