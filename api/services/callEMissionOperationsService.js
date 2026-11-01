'use strict';

const crypto = require('node:crypto');

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const PROVIDERS = new Set(['twilio', 'plivo', 'vonage']);

function operationError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function day(value, fallback) {
  const normalized = String(value || '').trim() || fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || !Number.isFinite(Date.parse(`${normalized}T00:00:00Z`)) ||
      new Date(`${normalized}T00:00:00Z`).toISOString().slice(0, 10) !== normalized) {
    throw operationError('call_e_report_date_invalid', 'Report dates must use YYYY-MM-DD');
  }
  return normalized;
}

class CallEMissionOperationsService {
  constructor(options = {}) {
    this.db = options.db;
    this.campaignService = options.campaignService;
    this.providerRoutingPreview = options.providerRoutingPreview;
    this.missionService = options.missionService || null;
    this.idempotencySecret = String(options.idempotencySecret || '');
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
  }

  async assertMembership(businessId, actorId, policyManager = false) {
    if (!BUSINESS_ID_PATTERN.test(businessId) || !ACTOR_ID_PATTERN.test(actorId) || typeof this.campaignService?.assertMembership !== 'function') {
      throw operationError('call_e_business_operator_access_denied', 'CALL-E business operator access is required', 403);
    }
    return this.campaignService.assertMembership(businessId, actorId, policyManager ? new Set(['policy_manager']) : undefined);
  }

  async getApprovalPolicy(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const row = await this.db.getCallEBusinessMissionPolicy(businessId);
    return { policy: {
      business_id: businessId,
      secondary_approval_threshold: Number(row?.secondary_approval_threshold) || 26,
      approval_ttl_hours: Number(row?.approval_ttl_hours) || 24,
      review_sla_minutes: Number(row?.review_sla_minutes) || 0,
      review_repeat_minutes: Number(row?.review_repeat_minutes) || 0,
      updated_by: row?.updated_by || null,
      updated_at: row?.updated_at || null,
    } };
  }

  async setApprovalPolicy(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId, true);
    const threshold = Number(input.secondary_approval_threshold);
    const ttl = Number(input.approval_ttl_hours);
    const current = await this.db.getCallEBusinessMissionPolicy(businessId);
    const reviewSlaMinutes = input.review_sla_minutes == null ? Number(current?.review_sla_minutes) || 0 : Number(input.review_sla_minutes);
    const reviewRepeatMinutes = input.review_repeat_minutes == null ? Number(current?.review_repeat_minutes) || 0 : Number(input.review_repeat_minutes);
    if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > 26 || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 720 ||
        !Number.isSafeInteger(reviewSlaMinutes) || reviewSlaMinutes < 0 || reviewSlaMinutes > 10080 ||
        !Number.isSafeInteger(reviewRepeatMinutes) || reviewRepeatMinutes < 0 || reviewRepeatMinutes > 10080 || (reviewRepeatMinutes > 0 && reviewSlaMinutes === 0)) {
      throw operationError('call_e_mission_policy_invalid', 'Set second approval threshold from 2 to 26 and expiry from 1 to 720 hours');
    }
    return { policy: await this.db.setCallEBusinessMissionPolicy({
      business_id: businessId, actor_id: actorId,
      secondary_approval_threshold: threshold, approval_ttl_hours: ttl, review_sla_minutes: reviewSlaMinutes, review_repeat_minutes: reviewRepeatMinutes,
    }) };
  }

  async getProviderRouting(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const row = await this.db.getCallEBusinessProviderRouting(businessId);
    return { policy: { business_id: businessId, provider_order: row?.provider_order || [], updated_by: row?.updated_by || null, updated_at: row?.updated_at || null } };
  }

  async setProviderRouting(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId, true);
    const order = Array.isArray(input.provider_order) ? input.provider_order.map((provider) => String(provider).toLowerCase()) : [];
    if (order.length < 1 || order.length > 3 || order.some((provider) => !PROVIDERS.has(provider)) || new Set(order).size !== order.length) {
      throw operationError('call_e_provider_routing_invalid', 'Provider order must list one to three unique supported voice providers');
    }
    return { policy: { business_id: businessId, ...await this.db.setCallEBusinessProviderRouting({ business_id: businessId, actor_id: actorId, provider_order: order }) } };
  }

  async previewProviderRouting(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    if (typeof this.providerRoutingPreview !== 'function') throw operationError('call_e_provider_routing_unavailable', 'Provider routing preview is unavailable', 503);
    const preferredProvider = String(input.preferred_provider || '').trim().toLowerCase();
    let configuredOrder = Array.isArray(input.provider_order) ? input.provider_order.map((provider) => String(provider).toLowerCase()) : null;
    if (configuredOrder && (configuredOrder.length < 1 || configuredOrder.length > 3 || configuredOrder.some((provider) => !PROVIDERS.has(provider)) || new Set(configuredOrder).size !== configuredOrder.length)) {
      throw operationError('call_e_provider_routing_invalid', 'Provider preview order must list one to three unique supported voice providers');
    }
    if (!configuredOrder) {
      const row = await this.db.getCallEBusinessProviderRouting(businessId);
      configuredOrder = row?.provider_order || [];
    }
    return { preview: await this.providerRoutingPreview({ businessId, preferredProvider, configuredOrder }) };
  }

  async getProviderDiagnostics(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    if (typeof this.providerRoutingPreview !== 'function') throw operationError('call_e_provider_diagnostics_unavailable', 'Provider diagnostics are unavailable', 503);
    const current = await this.providerRoutingPreview({ businessId, preferredProvider: '', configuredOrder: [] });
    const entries = (current.provider_health || []).map((item) => ({ provider: item.provider, ready: item.ready,
      circuit_state: item.state, score: item.score, reason_code: item.circuit_reason || null }));
    await this.db.logProviderDiagnosticsSnapshot(entries);
    return { business_id: businessId, current: entries, history: await this.db.listProviderDiagnosticsHistory(input.limit) };
  }

  async getMissionReviewInbox(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId, true);
    const rows = await this.db.listCallEMissionReviewInbox(businessId, input.limit);
    return { business_id: businessId, items: (rows || []).map((row) => ({
      mission_id: row.mission_id, created_at: row.created_at, escalated_at: row.escalated_at || null,
      recipient_count: Number(row.recipient_count) || 0, assigned_to: row.assigned_to || null,
      deadline_at: row.deadline_at || null, escalation_count: Number(row.escalation_count) || 0,
      acknowledged: row.latest_review_action === 'acknowledged', review_action_at: row.review_action_at || null,
    })) };
  }

  async updateMissionEscalation(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const action = String(input.action || '').trim();
    const idempotencyKey = String(input.idempotency_key || '').trim();
    await this.assertMembership(businessId, actorId, true);
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !['reassign', 'extend_deadline'].includes(action) ||
        !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) throw operationError('call_e_mission_escalation_action_invalid', 'Escalation action input is invalid');
    const mission = await this.db.getCallECampaignMission(missionId, businessId);
    if (!mission || mission.status !== 'pending_approval') throw operationError('call_e_mission_review_not_pending', 'Only pending mission reviews can be updated', 409);
    const inbox = await this.db.listCallEMissionReviewInbox(businessId, 100);
    const row = (inbox || []).find((item) => item.mission_id === missionId);
    if (!row?.escalated_at) throw operationError('call_e_mission_not_escalated', 'Mission has not reached its escalation deadline', 409);
    let assignedTo = null;
    let deadlineAt = null;
    let extendMinutes = null;
    if (action === 'reassign') {
      assignedTo = String(input.assigned_to || '').trim();
      if (!/^\d{1,20}$/.test(assignedTo) || assignedTo === String(mission.created_by)) throw operationError('call_e_mission_four_eyes_required', 'Choose a valid policy manager other than the mission creator', 403);
      await this.assertMembership(businessId, assignedTo, true);
    } else {
      extendMinutes = Number(input.extend_minutes);
      if (!Number.isSafeInteger(extendMinutes) || extendMinutes < 5 || extendMinutes > 10080) throw operationError('call_e_mission_escalation_deadline_invalid', 'Deadline extension must be from 5 to 10080 minutes');
      const base = Date.parse(row.deadline_at || row.escalated_at);
      if (!Number.isFinite(base)) throw operationError('call_e_mission_escalation_deadline_invalid', 'Current escalation deadline is invalid', 409);
      deadlineAt = new Date(Math.max(base, this.now().getTime()) + extendMinutes * 60000).toISOString();
    }
    if (this.idempotencySecret.length < 32) throw operationError('call_e_mission_escalation_unavailable', 'Escalation idempotency is unavailable', 503);
    const requestHash = crypto.createHmac('sha256', this.idempotencySecret).update(JSON.stringify({ businessId, missionId, actorId, action, assignedTo, extendMinutes, idempotencyKey })).digest('hex');
    const result = await this.db.recordCallEMissionEscalationAction({ business_id: businessId, mission_id: missionId,
      action: action === 'reassign' ? 'reassigned' : 'deadline_extended', actor_id: actorId,
      assigned_to: assignedTo, deadline_at: deadlineAt, idempotency_key: idempotencyKey, request_hash: requestHash });
    if (result.conflict) throw operationError('call_e_mission_escalation_conflict', 'Escalation idempotency key conflicts with another request', 409);
    if (result.not_pending || result.not_escalated) throw operationError('call_e_mission_not_escalated', 'Mission escalation is no longer actionable', 409);
    return { updated: result.recorded || result.idempotent_replay, idempotent_replay: result.idempotent_replay === true,
      assigned_to: assignedTo, deadline_at: result.deadline_at || deadlineAt };
  }

  async getMissionRecoveryInbox(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId, true);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 50)));
    const staleMinutes = Math.max(5, Math.min(1440, Math.floor(Number(input.stale_minutes) || 15)));
    const staleBefore = new Date(this.now().getTime() - staleMinutes * 60000).toISOString();
    const rows = await this.db.listCallEMissionRecoveryInbox(businessId, limit, staleBefore);
    return { business_id: businessId, stale_minutes: staleMinutes, items: (rows || []).map((row) => {
      const status = String(row.recipient_status || 'unknown');
      const safeRetry = status === 'failed' && row.error_code === 'call_e_request_rejected';
      const canReconcile = ['accepted', 'in_progress', 'needs_review'].includes(status) && Boolean(row.local_call_id);
      return { mission_id: row.mission_id, position: Number(row.position), mission_status: row.mission_status,
        recipient_status: status, error_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(row.error_code || '')) ? row.error_code : null,
        destination_masked: row.destination_masked, updated_at: row.recipient_updated_at,
        action: canReconcile ? 'reconcile_only' : safeRetry ? 'retry_confirmed_rejection' : 'manual_review',
        automatic_retry_allowed: false };
    }) };
  }

  async recoverMissionRecipient(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    const position = Number(input.position);
    const action = String(input.action || '').trim();
    await this.assertMembership(businessId, actorId, true);
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !Number.isSafeInteger(position) || position < 0 || position > 24 ||
        !['reconcile_only', 'retry_confirmed_rejection'].includes(action)) {
      throw operationError('call_e_mission_recovery_invalid', 'Mission recovery action is invalid');
    }
    if (!this.missionService) throw operationError('call_e_mission_recovery_unavailable', 'Mission recovery service is unavailable', 503);
    if (action === 'reconcile_only') return this.missionService.reconcileRecipient({ business_id: businessId, actor_id: actorId, mission_id: missionId, position });
    const idempotencyKey = String(input.idempotency_key || '').trim();
    return this.missionService.retryRecipient({ business_id: businessId, actor_id: actorId,
      mission_id: missionId, position, idempotency_key: idempotencyKey });
  }

  async assignMissionReview(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const assignedTo = String(input.assigned_to || '').trim();
    const idempotencyKey = String(input.idempotency_key || '').trim();
    await this.assertMembership(businessId, actorId, true);
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^\d{1,20}$/.test(assignedTo) ||
        !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) throw operationError('call_e_mission_review_action_invalid', 'Review assignment input is invalid');
    await this.assertMembership(businessId, assignedTo, true);
    const mission = await this.db.getCallECampaignMission(missionId, businessId);
    if (!mission) throw operationError('call_e_mission_not_found', 'Mission was not found', 404);
    if (String(mission.created_by) === assignedTo) throw operationError('call_e_mission_four_eyes_required', 'Mission creator cannot be assigned as its reviewer', 403);
    const requestHash = crypto.createHmac('sha256', this.idempotencySecret).update(JSON.stringify({ businessId, missionId, actorId, assignedTo })).digest('hex');
    const result = await this.db.recordCallEMissionReviewAction({
      business_id: businessId, mission_id: missionId, action: 'assigned', actor_id: actorId,
      assigned_to: assignedTo, idempotency_key: idempotencyKey, request_hash: requestHash,
    });
    if (result.conflict) throw operationError('call_e_mission_review_idempotency_conflict', 'Review assignment key conflicts with another action', 409);
    if (result.not_pending) throw operationError('call_e_mission_review_not_pending', 'Only pending reviews can be assigned', 409);
    return { assigned: result.recorded || result.idempotent_replay, idempotent_replay: result.idempotent_replay === true, assigned_to: assignedTo };
  }

  async acknowledgeMissionReview(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const idempotencyKey = String(input.idempotency_key || '').trim();
    await this.assertMembership(businessId, actorId, true);
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
      throw operationError('call_e_mission_review_action_invalid', 'Review acknowledgement input is invalid');
    }
    const requestHash = crypto.createHmac('sha256', this.idempotencySecret).update(JSON.stringify({ businessId, missionId, actorId, action: 'acknowledged' })).digest('hex');
    const result = await this.db.recordCallEMissionReviewAction({
      business_id: businessId, mission_id: missionId, action: 'acknowledged', actor_id: actorId,
      assigned_to: actorId, idempotency_key: idempotencyKey, request_hash: requestHash,
    });
    if (result.conflict) throw operationError('call_e_mission_review_idempotency_conflict', 'Review acknowledgement key conflicts with another action', 409);
    if (result.not_pending) throw operationError('call_e_mission_review_not_pending', 'Only pending reviews can be acknowledged', 409);
    if (result.assignment_required) throw operationError('call_e_mission_review_assignment_required', 'Only the currently assigned policy manager can acknowledge this review', 403);
    return { acknowledged: result.recorded || result.idempotent_replay, idempotent_replay: result.idempotent_replay === true };
  }

  async recordMissionUsage(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId, true);
    const required = ['mission_id', 'provider', 'provider_call_id', 'amount_minor', 'currency', 'source_type', 'source_reference', 'idempotency_key', 'occurred_at'];
    if (required.some((field) => input[field] === undefined || input[field] === null || input[field] === '')) {
      throw operationError('call_e_mission_usage_invalid', 'Usage records require provider call identity, amount, currency, source, time, and idempotency key');
    }
    if (this.idempotencySecret.length < 32) throw operationError('call_e_mission_usage_unavailable', 'Usage idempotency protection is unavailable', 503);
    const safe = Object.fromEntries(required.map((key) => [key, input[key]]));
    safe.recipient_position = Number(input.recipient_position);
    safe.billed_duration_seconds = input.billed_duration_seconds == null || input.billed_duration_seconds === '' ? null : Number(input.billed_duration_seconds);
    safe.provider = String(input.provider).trim().toLowerCase();
    safe.currency = String(input.currency).trim().toUpperCase();
    const requestHash = crypto.createHmac('sha256', this.idempotencySecret).update(JSON.stringify({ ...safe, business_id: businessId, actor_id: actorId })).digest('hex');
    const result = await this.db.recordCallEMissionUsageRecord({ ...safe, business_id: businessId, recorded_by: actorId, request_hash: requestHash });
    if (result.conflict) throw operationError('call_e_mission_usage_conflict', 'Provider usage ID or idempotency key is already associated with another record', 409);
    if (result.not_found) throw operationError('call_e_mission_not_found', 'Mission usage target was not found', 404);
    return { ...result, confidence: safe.source_type === 'provider_cdr' ? 'operator_entered_provider_cdr' : safe.source_type };
  }

  async getMissionUsageReport(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const report = await this.db.getCallEMissionUsageReport(businessId, missionId);
    if (!report) throw operationError('call_e_mission_not_found', 'Mission usage report was not found', 404);
    return { business_id: businessId, mission_id: missionId, report };
  }

  async stageMissionCdrImport(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    const idempotencyKey = String(input.idempotency_key || '').trim();
    const sourceReference = String(input.source_reference || '').trim();
    const records = Array.isArray(input.records) ? input.records : [];
    await this.assertMembership(businessId, actorId, true);
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) ||
        !/^[A-Za-z0-9._:-]{8,180}$/.test(sourceReference) || records.length < 1 || records.length > 100) {
      throw operationError('call_e_cdr_import_invalid', 'CDR import requires a mission, opaque source reference, idempotency key, and 1 to 100 records');
    }
    if (this.idempotencySecret.length < 32) throw operationError('call_e_cdr_import_unavailable', 'CDR import idempotency protection is unavailable', 503);
    const mission = await this.db.getCallECampaignMission(missionId, businessId);
    if (!mission) throw operationError('call_e_mission_not_found', 'Mission was not found', 404);
    const normalized = records.map((row, index) => {
      const provider = String(row?.provider || '').trim().toLowerCase();
      const providerCallId = String(row?.provider_call_id || '').trim();
      const position = Number(row?.recipient_position);
      const amountMinor = Number(row?.amount_minor);
      const currency = String(row?.currency || '').trim().toUpperCase();
      const duration = row?.billed_duration_seconds == null ? null : Number(row.billed_duration_seconds);
      const occurredAt = String(row?.occurred_at || '').trim();
      if (!PROVIDERS.has(provider) || !/^[A-Za-z0-9._:-]{1,180}$/.test(providerCallId) ||
          !Number.isSafeInteger(position) || position < 0 || position > 24 ||
          !Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor > 1000000000000 ||
          !/^[A-Z]{3}$/.test(currency) || (duration !== null && (!Number.isSafeInteger(duration) || duration < 0 || duration > 86400)) ||
          !Number.isFinite(Date.parse(occurredAt)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredAt)) {
        throw operationError('call_e_cdr_import_invalid', `CDR import record ${index + 1} is invalid`);
      }
      return { recipient_position: position, provider, provider_call_id: providerCallId, amount_minor: amountMinor,
        currency, billed_duration_seconds: duration, occurred_at: new Date(Date.parse(occurredAt)).toISOString(),
        source_type: 'provider_cdr', source_reference: sourceReference };
    });
    if (normalized.some((row) => row.recipient_position >= (mission.recipients || []).length)) {
      throw operationError('call_e_cdr_import_invalid', 'A CDR recipient position is outside this mission');
    }
    const requestHash = crypto.createHmac('sha256', this.idempotencySecret).update(JSON.stringify({ businessId, missionId, actorId, idempotencyKey, sourceReference, normalized })).digest('hex');
    const result = await this.db.stageCallEMissionCdrImport({ business_id: businessId, mission_id: missionId,
      created_by: actorId, idempotency_key: idempotencyKey, request_hash: requestHash, records: normalized });
    if (result.conflict) throw operationError('call_e_cdr_import_conflict', 'Import idempotency key conflicts with another staged import', 409);
    if (result.not_found) throw operationError('call_e_mission_not_found', 'Mission was not found', 404);
    return { ...result, idempotent_replay: result.idempotent_replay === true };
  }

  async commitMissionCdrImport(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const importId = String(input.import_id || '').trim();
    await this.assertMembership(businessId, actorId, true);
    if (!/^cdrimp_[a-f0-9-]{36}$/.test(importId)) throw operationError('call_e_cdr_import_invalid', 'CDR import ID is invalid');
    const staged = await this.db.getCallEMissionCdrImport(businessId, importId);
    if (!staged) throw operationError('not_found', 'Staged CDR import was not found', 404);
    if (staged.created_by !== actorId) throw operationError('call_e_cdr_import_owner_required', 'Only the policy manager who staged this import may commit it', 403);
    if (staged.status === 'committed') return { import_id: importId, committed: true, idempotent_replay: true, preview: staged.preview };
    const records = staged.records || [];
    let saved = 0;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (staged.preview.records[index]?.duplicate) continue;
      const result = await this.recordMissionUsage({ ...record, business_id: businessId, mission_id: staged.mission_id,
        actor_id: actorId, idempotency_key: `${importId}:${index}`, source_type: 'provider_cdr' });
      if (result.conflict || result.not_found) throw operationError('call_e_cdr_import_commit_failed', 'A staged CDR record could not be committed safely', 409);
      if (result.recorded) saved += 1;
    }
    await this.db.markCallEMissionCdrImportCommitted(businessId, importId, actorId);
    return { import_id: importId, committed: true, idempotent_replay: false, records_saved: saved, preview: staged.preview };
  }

  async report(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const today = this.now().toISOString().slice(0, 10);
    const from = day(input.from, new Date(this.now().getTime() - 29 * 86400000).toISOString().slice(0, 10));
    const to = day(input.to, today);
    if (from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 90 * 86400000) {
      throw operationError('call_e_report_range_invalid', 'Report range must be ordered and no longer than 90 days');
    }
    const raw = await this.db.getCallECampaignMissionReport(businessId, from, to);
    const number = (value) => Math.max(0, Number(value) || 0);
    const missionCount = number(raw.mission_count);
    const recipientCount = number(raw.completed_recipients) + number(raw.failed_recipients) + number(raw.review_recipients) + number(raw.canceled_recipients) + number(raw.open_recipients);
    return { report: {
      business_id: businessId, from, to, mission_count: missionCount,
      completed_missions: number(raw.completed_missions), attention_missions: number(raw.attention_missions),
      recipient_count: recipientCount, completed_recipients: number(raw.completed_recipients),
      failed_recipients: number(raw.failed_recipients), review_recipients: number(raw.review_recipients),
      canceled_recipients: number(raw.canceled_recipients), open_recipients: number(raw.open_recipients),
      completion_rate: recipientCount ? Math.round(number(raw.completed_recipients) / recipientCount * 10000) / 100 : 0,
    } };
  }

  async setAlertSubscription(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    if (typeof input.enabled !== 'boolean') throw operationError('call_e_alert_subscription_invalid', 'Alert subscription enabled must be true or false');
    return { subscription: await this.db.setCallEMissionAlertSubscription({ business_id: businessId, actor_id: actorId, enabled: input.enabled }) };
  }

  async getAlertSubscription(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    return { subscription: await this.db.getCallEMissionAlertSubscription(businessId, actorId) };
  }

  async setReportDigestSubscription(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    if (typeof input.enabled !== 'boolean' || ![24, 168].includes(Number(input.interval_hours))) {
      throw operationError('call_e_report_digest_invalid', 'Report digests must be enabled or disabled with a daily or weekly interval');
    }
    return { subscription: await this.db.setCallEMissionReportDigestSubscription({
      business_id: businessId, actor_id: actorId, enabled: input.enabled, interval_hours: Number(input.interval_hours),
    }) };
  }

  async getReportDigestSubscription(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    return { subscription: await this.db.getCallEMissionReportDigestSubscription(businessId, actorId) };
  }
}

module.exports = { CallEMissionOperationsService, operationError };
