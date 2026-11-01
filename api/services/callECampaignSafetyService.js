'use strict';

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const MISSION_ID_PATTERN = /^mission_[a-f0-9]{64}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function safetyError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function validateTimeZone(timeZone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date()); return true; }
  catch { return false; }
}

function localDateTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((value, part) => (value[part.type] = part.value, value), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) };
}

function normalizePolicy(policy) {
  if (!policy) return Object.freeze({
    configured: false, max_calls_per_day: 0, quiet_hours_start: null, quiet_hours_end: null,
    timezone: 'UTC', emergency_stop: true, updated_by: null, updated_at: null,
  });
  return Object.freeze({
    configured: true,
    max_calls_per_day: Math.max(0, Math.min(1000, Math.floor(Number(policy.max_calls_per_day) || 0))),
    quiet_hours_start: TIME_PATTERN.test(String(policy.quiet_hours_start || '')) ? policy.quiet_hours_start : null,
    quiet_hours_end: TIME_PATTERN.test(String(policy.quiet_hours_end || '')) ? policy.quiet_hours_end : null,
    timezone: validateTimeZone(String(policy.timezone || '')) ? String(policy.timezone) : 'UTC',
    emergency_stop: policy.emergency_stop !== false,
    contact_cooldown_hours: Math.max(0, Math.min(8760, Math.floor(Number(policy.contact_cooldown_hours) || 0))),
    updated_by: ACTOR_ID_PATTERN.test(String(policy.updated_by || '')) ? String(policy.updated_by) : null,
    updated_at: policy.updated_at || null,
  });
}

class CallECampaignSafetyService {
  constructor(options = {}) {
    this.db = options.db;
    this.campaignService = options.campaignService;
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.isWorkerConfigured = typeof options.isWorkerConfigured === 'function' ? options.isWorkerConfigured : () => false;
  }

  async assertMembership(businessId, actorId, role = null) {
    if (!BUSINESS_ID_PATTERN.test(businessId) || !ACTOR_ID_PATTERN.test(actorId) || typeof this.campaignService?.assertMembership !== 'function') {
      throw safetyError('call_e_business_operator_access_denied', 'CALL-E business operator access is required', 403);
    }
    const roles = role ? new Set([role]) : undefined;
    return this.campaignService.assertMembership(businessId, actorId, roles);
  }

  async getPolicy(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const policy = normalizePolicy(await this.db.getCallEBusinessSafetyPolicy(businessId));
    const local = localDateTime(this.now(), policy.timezone);
    const usage = await this.db.getCallEBusinessDispatchUsage?.(businessId, local.date) || { used: 0 };
    return { safety_policy: { ...policy, calls_used_today: Number(usage.used) || 0, local_date: local.date } };
  }

  async updatePolicy(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const membership = await this.assertMembership(businessId, actorId, 'policy_manager');
    const maxCalls = Number(input.max_calls_per_day);
    const start = input.quiet_hours_start === '' || input.quiet_hours_start == null ? null : String(input.quiet_hours_start);
    const end = input.quiet_hours_end === '' || input.quiet_hours_end == null ? null : String(input.quiet_hours_end);
    const timezone = String(input.timezone || '').trim();
    const currentPolicy = input.contact_cooldown_hours == null ? await this.db.getCallEBusinessSafetyPolicy(businessId) : null;
    const contactCooldownHours = Number(input.contact_cooldown_hours ?? currentPolicy?.contact_cooldown_hours ?? 0);
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 1000 || !validateTimeZone(timezone) ||
        (start !== null && !TIME_PATTERN.test(start)) || (end !== null && !TIME_PATTERN.test(end)) ||
        ((start === null) !== (end === null)) || (start !== null && start === end) || typeof input.emergency_stop !== 'boolean' ||
        !Number.isSafeInteger(contactCooldownHours) || contactCooldownHours < 0 || contactCooldownHours > 8760) {
      throw safetyError('call_e_safety_policy_invalid', 'Safety policy requires a daily limit, valid IANA timezone, paired quiet hours, explicit emergency-stop state, and cooldown from 0 to 8760 hours');
    }
    const policy = await this.db.setCallEBusinessSafetyPolicy({
      business_id: businessId, actor_id: actorId, max_calls_per_day: maxCalls,
      quiet_hours_start: start, quiet_hours_end: end, timezone, emergency_stop: input.emergency_stop,
      contact_cooldown_hours: contactCooldownHours,
    });
    return { safety_policy: normalizePolicy({ ...policy, updated_by: membership?.telegram_id || policy.updated_by }) };
  }

  async setWorkerPaused(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    if (!MISSION_ID_PATTERN.test(missionId) || typeof input.paused !== 'boolean') throw safetyError('call_e_mission_worker_control_invalid', 'Mission worker control request is invalid');
    await this.assertMembership(businessId, actorId, 'policy_manager');
    const control = await this.db.setCallECampaignMissionWorkerControl({ business_id: businessId, actor_id: actorId, mission_id: missionId, paused: input.paused });
    if (!control) throw safetyError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    return { worker_control: { mission_id: missionId, paused: control.paused, updated_at: control.updated_at } };
  }

  async getWorkerStatus(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    await this.assertMembership(businessId, actorId);
    if (!MISSION_ID_PATTERN.test(missionId)) throw safetyError('call_e_mission_invalid', 'CALL-E mission ID is invalid');
    const [control, lease, mission] = await Promise.all([
      this.db.getCallECampaignMissionWorkerControl(missionId, businessId),
      this.db.getCallECampaignMissionWorkerLeaseStatus(missionId, businessId),
      this.db.getCallECampaignMission(missionId, businessId),
    ]);
    if (!mission) throw safetyError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    return { worker: { mission_id: missionId, paused: control?.paused === true,
      configured: this.isWorkerConfigured() === true, active: lease?.active === true,
      stale: Boolean(lease?.lease_owner && lease?.active !== true),
      last_state: lease?.last_state || 'idle', last_error_code: lease?.last_error_code || null,
      lease_expires_at: lease?.lease_expires_at || null, heartbeat_at: lease?.updated_at || null,
      updated_by: control?.updated_by || null, updated_at: control?.updated_at || null } };
  }

  async getAudit(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 50)));
    return { audit: await this.db.listCallEOperationsAudit(businessId, limit) };
  }

  async assertDispatchAllowed({ businessId, missionId, workerManaged = false }) {
    const policy = normalizePolicy(await this.db.getCallEBusinessSafetyPolicy(businessId));
    if (!policy.configured) throw safetyError('call_e_safety_policy_required', 'A policy manager must configure CALL-E mission safety controls before dispatch', 409);
    if (policy.emergency_stop) throw safetyError('call_e_emergency_stop_active', 'CALL-E mission emergency stop is active', 409);
    if (workerManaged) {
      const control = await this.db.getCallECampaignMissionWorkerControl(missionId, businessId);
      if (control?.paused) throw safetyError('call_e_mission_worker_paused', 'CALL-E mission worker is paused', 409);
    }
    if (policy.quiet_hours_start && policy.quiet_hours_end) {
      const local = localDateTime(this.now(), policy.timezone);
      const start = Number(policy.quiet_hours_start.slice(0, 2)) * 60 + Number(policy.quiet_hours_start.slice(3));
      const end = Number(policy.quiet_hours_end.slice(0, 2)) * 60 + Number(policy.quiet_hours_end.slice(3));
      const quiet = start < end ? local.minuteOfDay >= start && local.minuteOfDay < end : local.minuteOfDay >= start || local.minuteOfDay < end;
      if (quiet) throw safetyError('call_e_quiet_hours_active', 'CALL-E mission dispatch is outside the configured calling window', 409);
    }
    return { policy, local: localDateTime(this.now(), policy.timezone) };
  }

  async reserveDispatch(input = {}) {
    const { local } = await this.assertDispatchAllowed(input);
    const result = await this.db.reserveCallEBusinessDispatch({
      business_id: input.businessId, mission_id: input.missionId, recipient_position: input.position,
      usage_date: local.date, worker_managed: input.workerManaged === true,
    });
    if (!result.allowed) throw safetyError(`call_e_${result.reason}`, result.reason === 'daily_limit_reached'
      ? 'CALL-E business daily call limit has been reached'
      : 'CALL-E mission safety policy blocks dispatch', 409);
    return result;
  }
}

module.exports = { CallECampaignSafetyService, validateTimeZone, localDateTime, normalizePolicy };
