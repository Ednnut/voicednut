'use strict';

const assert = require('node:assert/strict');
const { CallECampaignSafetyService } = require('../services/callECampaignSafetyService');

function harness(now = new Date('2026-10-31T18:30:00.000Z')) {
  const state = { policy: null, control: { paused: false }, lease: null, mission: { mission_id: `mission_${'a'.repeat(64)}` }, usage: { used: 0 } };
  const db = {
    async getCallEBusinessSafetyPolicy() { return state.policy; },
    async setCallEBusinessSafetyPolicy(input) { state.policy = { ...input, emergency_stop: input.emergency_stop, updated_by: input.actor_id }; return state.policy; },
    async getCallEBusinessDispatchUsage() { return state.usage; },
    async getCallECampaignMissionWorkerControl() { return state.control; },
    async setCallECampaignMissionWorkerControl(input) { state.control = { paused: input.paused, updated_by: input.actor_id }; return state.control; },
    async getCallECampaignMissionWorkerLeaseStatus() { return state.lease; },
    async getCallECampaignMission() { return state.mission; },
    async reserveCallEBusinessDispatch() { return { allowed: true, calls_remaining: 2 }; },
    async listCallEOperationsAudit() { return []; },
  };
  const campaignService = { async assertMembership(_businessId, actorId, roles) {
    const membership = { role: actorId === '54321' ? 'policy_manager' : 'call_operator' };
    if (roles && !roles.has(membership.role)) throw Object.assign(new Error('role denied'), { code: 'call_e_business_operator_access_denied', status: 403 });
    return membership;
  } };
  const service = new CallECampaignSafetyService({ db, campaignService, now: () => now, isWorkerConfigured: () => true });
  return { service, state };
}

describe('CALL-E mission safety controls', () => {
  it('requires a policy manager and validates daily caps, IANA timezones, and paired quiet hours', async () => {
    const { service } = harness();
    const policy = { max_calls_per_day: 25, quiet_hours_start: '22:00', quiet_hours_end: '07:00', timezone: 'America/Los_Angeles', emergency_stop: true };
    await assert.rejects(service.updatePolicy({ business_id: 'biz-a', actor_id: '12345', ...policy }), (error) => error.code === 'call_e_business_operator_access_denied');
    await assert.rejects(service.updatePolicy({ business_id: 'biz-a', actor_id: '54321', ...policy, timezone: 'Mars/Olympus' }), (error) => error.code === 'call_e_safety_policy_invalid');
    const saved = await service.updatePolicy({ business_id: 'biz-a', actor_id: '54321', ...policy, contact_cooldown_hours: 72 });
    assert.equal(saved.safety_policy.configured, true);
    assert.equal(saved.safety_policy.emergency_stop, true);
    assert.equal(saved.safety_policy.contact_cooldown_hours, 72);
  });

  it('blocks emergency stop, quiet hours, and paused workers before dispatch reservation', async () => {
    const { service, state } = harness();
    state.policy = { max_calls_per_day: 10, quiet_hours_start: null, quiet_hours_end: null, timezone: 'UTC', emergency_stop: true };
    await assert.rejects(service.reserveDispatch({ businessId: 'biz-a', missionId: `mission_${'a'.repeat(64)}`, position: 0, workerManaged: true }), (error) => error.code === 'call_e_emergency_stop_active');
    state.policy.emergency_stop = false;
    state.policy.quiet_hours_start = '18:00';
    state.policy.quiet_hours_end = '19:00';
    await assert.rejects(service.reserveDispatch({ businessId: 'biz-a', missionId: `mission_${'a'.repeat(64)}`, position: 0 }), (error) => error.code === 'call_e_quiet_hours_active');
    state.policy.quiet_hours_start = null;
    state.policy.quiet_hours_end = null;
    state.control.paused = true;
    await assert.rejects(service.reserveDispatch({ businessId: 'biz-a', missionId: `mission_${'a'.repeat(64)}`, position: 0, workerManaged: true }), (error) => error.code === 'call_e_mission_worker_paused');
  });

  it('reports an expired lease as stale and exposes only scoped operational state', async () => {
    const { service, state } = harness();
    state.lease = { lease_owner: 'worker-1', active: false, last_state: 'error', last_error_code: 'worker_timeout', lease_expires_at: '2026-10-31 18:00:00', updated_at: '2026-10-31 17:59:00' };
    const result = await service.getWorkerStatus({ business_id: 'biz-a', actor_id: '12345', mission_id: state.mission.mission_id });
    assert.equal(result.worker.configured, true);
    assert.equal(result.worker.stale, true);
    assert.equal(result.worker.last_error_code, 'worker_timeout');
    assert.doesNotMatch(JSON.stringify(result), /lease_token|destination|phone/i);
  });
});
