'use strict';

const assert = require('node:assert/strict');
const { CallEMissionOperationsService } = require('../services/callEMissionOperationsService');

describe('CALL-E mission operations service', () => {
  function setup() {
    const writes = [];
    const service = new CallEMissionOperationsService({
      db: {
        async getCallEBusinessMissionPolicy() { return null; },
        async setCallEBusinessMissionPolicy(input) { writes.push(input); return input; },
        async getCallEBusinessProviderRouting() { return null; },
        async setCallEBusinessProviderRouting(input) { writes.push(input); return input; },
        async getCallECampaignMissionReport() { return { mission_count: 2, completed_missions: 1, attention_missions: 1, completed_recipients: 3, failed_recipients: 1, review_recipients: 0, canceled_recipients: 1, open_recipients: 0 }; },
        async setCallEMissionAlertSubscription(input) { return input; },
        async getCallEMissionAlertSubscription(businessId, actorId) { return { business_id: businessId, actor_id: actorId, enabled: true }; },
        async setCallEMissionReportDigestSubscription(input) { return input; },
        async getCallEMissionReportDigestSubscription(businessId, actorId) { return { business_id: businessId, actor_id: actorId, enabled: true, interval_hours: 168 }; },
        async listCallEMissionReviewInbox() { return [{ mission_id: `mission_${'a'.repeat(64)}`, created_at: '2026-01-01', assigned_to: '333', latest_review_action: 'assigned' }]; },
        async getCallECampaignMission(missionId, businessId) { return { mission_id: missionId, business_id: businessId, created_by: '111' }; },
        async recordCallEMissionReviewAction(input) { writes.push(input); return { recorded: true }; },
        async recordCallEMissionUsageRecord(input) { writes.push(input); return { recorded: true, budget_exceeded: true, confidence: input.source_type }; },
        async getCallEMissionUsageReport() { return { reserved_minor: 1000, actual_by_currency: { USD: 1250 }, budget_currency: 'USD', budget_exceeded: true }; },
      },
      campaignService: { async assertMembership(_businessId, _actorId, roles) { if (roles && !roles.has('policy_manager')) throw new Error('role denied'); return { telegram_id: '222' }; } },
      providerRoutingPreview: async ({ configuredOrder }) => ({ selected_provider: configuredOrder[0], eligible_order: configuredOrder, dispatch_performed: false }),
      idempotencySecret: 'x'.repeat(64),
      now: () => new Date('2026-10-31T00:00:00Z'),
    });
    return { service, writes };
  }

  it('requires a policy manager and validates approval thresholds and expiry', async () => {
    const { service, writes } = setup();
    await assert.rejects(service.setApprovalPolicy({ business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 1, approval_ttl_hours: 24 }));
    const result = await service.setApprovalPolicy({ business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 8, approval_ttl_hours: 72 });
    assert.equal(result.policy.secondary_approval_threshold, 8);
    assert.equal(writes.length, 1);
  });

  it('stores a bounded review escalation SLA as part of the business approval policy', async () => {
    const { service, writes } = setup();
    const result = await service.setApprovalPolicy({
      business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 8, approval_ttl_hours: 72, review_sla_minutes: 45,
    });
    assert.equal(result.policy.review_sla_minutes, 45);
    assert.equal(writes[0].review_sla_minutes, 45);
    await assert.rejects(service.setApprovalPolicy({
      business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 8, approval_ttl_hours: 72, review_sla_minutes: 10081,
    }), (error) => error.code === 'call_e_mission_policy_invalid');
  });

  it('keeps deadline-extension idempotency stable when an operator retries after a lost response', async () => {
    let now = new Date('2026-10-31T00:00:00Z');
    const received = [];
    const { service } = setup();
    service.now = () => now;
    service.db.getCallECampaignMission = async (missionId, businessId) => ({ mission_id: missionId, business_id: businessId, status: 'pending_approval' });
    service.db.listCallEMissionReviewInbox = async () => [{ mission_id: `mission_${'a'.repeat(64)}`, escalated_at: '2026-10-30T00:00:00Z', deadline_at: '2026-10-30T00:00:00Z' }];
    service.db.recordCallEMissionEscalationAction = async (input) => {
      received.push(input);
      return received.length === 1
        ? { recorded: true, deadline_at: input.deadline_at }
        : { recorded: false, idempotent_replay: true, deadline_at: received[0].deadline_at };
    };
    const request = { business_id: 'biz-a', mission_id: `mission_${'a'.repeat(64)}`, actor_id: '222', action: 'extend_deadline', extend_minutes: 45, idempotency_key: 'extend-review-0001' };
    const first = await service.updateMissionEscalation(request);
    now = new Date('2026-10-31T00:05:00Z');
    const retry = await service.updateMissionEscalation(request);
    assert.equal(received[0].request_hash, received[1].request_hash);
    assert.equal(retry.idempotent_replay, true);
    assert.equal(retry.deadline_at, first.deadline_at);
  });

  it('classifies recovery inbox actions conservatively and invokes only the selected safe operation', async () => {
    const { service } = setup();
    service.db.listCallEMissionRecoveryInbox = async () => [
      { mission_id: `mission_${'a'.repeat(64)}`, position: 0, mission_status: 'running', recipient_status: 'accepted', local_call_id: 'call_e_local', destination_masked: '+••••1234' },
      { mission_id: `mission_${'b'.repeat(64)}`, position: 1, mission_status: 'running', recipient_status: 'failed', error_code: 'call_e_request_rejected' },
      { mission_id: `mission_${'c'.repeat(64)}`, position: 2, mission_status: 'needs_review', recipient_status: 'needs_review', error_code: 'call_e_outcome_unknown' },
    ];
    const actions = [];
    service.missionService = {
      async reconcileRecipient(input) { actions.push({ kind: 'reconcile', ...input }); return { state: 'completed' }; },
      async retryRecipient(input) { actions.push({ kind: 'retry', ...input }); return { state: 'queued' }; },
    };
    const inbox = await service.getMissionRecoveryInbox({ business_id: 'biz-a', actor_id: '222' });
    assert.deepEqual(inbox.items.map((row) => row.action), ['reconcile_only', 'retry_confirmed_rejection', 'manual_review']);
    assert.equal(inbox.items.every((row) => row.automatic_retry_allowed === false), true);
    await service.recoverMissionRecipient({ business_id: 'biz-a', actor_id: '222', mission_id: inbox.items[0].mission_id, position: 0, action: 'reconcile_only' });
    await service.recoverMissionRecipient({ business_id: 'biz-a', actor_id: '222', mission_id: inbox.items[1].mission_id, position: 1, action: 'retry_confirmed_rejection', idempotency_key: 'retry-confirmed-0001' });
    assert.deepEqual(actions.map((row) => row.kind), ['reconcile', 'retry']);
    assert.equal(actions.length, 2, 'manual-review queue items were not offered an automated action');
  });

  it('stages normalized CDR rows with business membership and idempotent preview metadata', async () => {
    const { service } = setup();
    service.db.getCallECampaignMission = async (missionId, businessId) => ({ mission_id: missionId, business_id: businessId,
      recipients: [{ position: 0 }, { position: 1 }] });
    let stagedInput;
    service.db.stageCallEMissionCdrImport = async (input) => { stagedInput = input; return { import_id: 'cdrimp_123e4567-e89b-12d3-a456-426614174000', status: 'staged', preview: { new_record_count: 1 } }; };
    const result = await service.stageMissionCdrImport({ business_id: 'biz-a', actor_id: '222', mission_id: `mission_${'a'.repeat(64)}`,
      idempotency_key: 'cdr-stage-0001', source_reference: 'opaque-cdr-2026-10', records: [{ recipient_position: 0, provider: 'twilio',
        provider_call_id: 'CA123', amount_minor: 125, currency: 'USD', occurred_at: '2026-10-30T00:00:00Z' }] });
    assert.equal(result.status, 'staged');
    assert.equal(result.preview.new_record_count, 1);
    assert.equal(result.idempotent_replay, false);
    assert.match(stagedInput.request_hash, /^[a-f0-9]{64}$/);
    await assert.rejects(service.stageMissionCdrImport({ business_id: 'biz-a', actor_id: '222', mission_id: `mission_${'a'.repeat(64)}`,
      idempotency_key: 'cdr-stage-0002', source_reference: 'opaque-cdr-2026-10', records: [{ recipient_position: 2, provider: 'twilio',
        provider_call_id: 'CA124', amount_minor: 1, currency: 'USD', occurred_at: '2026-10-30T00:00:00Z' }] }),
    (error) => error.code === 'call_e_cdr_import_invalid');
  });

  it('persists only normalized provider health observations for diagnostics', async () => {
    const { service } = setup();
    let saved;
    service.providerRoutingPreview = async () => ({ provider_health: [{ provider: 'twilio', ready: true, state: 'closed', score: 88, circuit_reason: 'healthy' }] });
    service.db.logProviderDiagnosticsSnapshot = async (entries) => { saved = entries; };
    service.db.listProviderDiagnosticsHistory = async () => [{ provider: 'twilio', status: 'ready' }];
    const result = await service.getProviderDiagnostics({ business_id: 'biz-a', actor_id: '222' });
    assert.deepEqual(saved, [{ provider: 'twilio', ready: true, circuit_state: 'closed', score: 88, reason_code: 'healthy' }]);
    assert.equal(result.history.length, 1);
  });

  it('validates per-business provider order and returns only masked aggregate reports', async () => {
    const { service } = setup();
    await assert.rejects(service.setProviderRouting({ business_id: 'biz-a', actor_id: '222', provider_order: ['call_e'] }));
    const routing = await service.setProviderRouting({ business_id: 'biz-a', actor_id: '222', provider_order: ['plivo', 'twilio'] });
    assert.deepEqual(routing.policy.provider_order, ['plivo', 'twilio']);
    const report = await service.report({ business_id: 'biz-a', actor_id: '222' });
    assert.equal(report.report.completion_rate, 60);
    assert.equal(report.report.canceled_recipients, 1);
    assert.equal('destination' in report.report, false);
    await assert.rejects(service.report({ business_id: 'biz-a', actor_id: '222', from: '2026-01-01', to: '2026-10-31' }), (error) => error.code === 'call_e_report_range_invalid');
  });

  it('previews provider routing without dispatch and limits review actions to eligible missions and managers', async () => {
    const { service, writes } = setup();
    const preview = await service.previewProviderRouting({ business_id: 'biz-a', actor_id: '222', provider_order: ['plivo', 'twilio'] });
    assert.equal(preview.preview.selected_provider, 'plivo');
    assert.equal(preview.preview.dispatch_performed, false);
    await assert.rejects(service.previewProviderRouting({ business_id: 'biz-a', actor_id: '222', provider_order: ['call_e'] }), (error) => error.code === 'call_e_provider_routing_invalid');
    const assigned = await service.assignMissionReview({ business_id: 'biz-a', mission_id: `mission_${'a'.repeat(64)}`, actor_id: '222', assigned_to: '333', idempotency_key: 'assign-review-0001' });
    assert.equal(assigned.assigned, true);
    assert.equal(writes.at(-1).action, 'assigned');
  });

  it('records operator-entered provider usage and returns currency-aware budget alerts', async () => {
    const { service, writes } = setup();
    const result = await service.recordMissionUsage({
      business_id: 'biz-a', actor_id: '222', mission_id: `mission_${'a'.repeat(64)}`, recipient_position: 0,
      provider: 'plivo', provider_call_id: 'cdr-call-0001', amount_minor: 1250, currency: 'USD',
      source_type: 'provider_cdr', source_reference: 'provider-record-0001', occurred_at: '2026-10-30T00:00:00Z', idempotency_key: 'usage-record-0001',
    });
    assert.equal(result.confidence, 'operator_entered_provider_cdr');
    assert.equal(result.budget_exceeded, true);
    assert.equal(writes.at(-1).recorded_by, '222');
    const report = await service.getMissionUsageReport({ business_id: 'biz-a', actor_id: '222', mission_id: `mission_${'a'.repeat(64)}` });
    assert.equal(report.report.budget_exceeded, true);
  });

  it('scopes alert subscription reads and requires an explicit boolean choice', async () => {
    const { service } = setup();
    assert.equal((await service.getAlertSubscription({ business_id: 'biz-a', actor_id: '222' })).subscription.enabled, true);
    await assert.rejects(service.setAlertSubscription({ business_id: 'biz-a', actor_id: '222', enabled: 'yes' }), (error) => error.code === 'call_e_alert_subscription_invalid');
    assert.equal((await service.setAlertSubscription({ business_id: 'biz-a', actor_id: '222', enabled: false })).subscription.enabled, false);
  });

  it('requires current membership and daily or weekly cadence for report digests', async () => {
    const { service } = setup();
    assert.equal((await service.getReportDigestSubscription({ business_id: 'biz-a', actor_id: '222' })).subscription.interval_hours, 168);
    await assert.rejects(service.setReportDigestSubscription({ business_id: 'biz-a', actor_id: '222', enabled: true, interval_hours: 48 }),
      (error) => error.code === 'call_e_report_digest_invalid');
    assert.equal((await service.setReportDigestSubscription({ business_id: 'biz-a', actor_id: '222', enabled: true, interval_hours: 24 })).subscription.enabled, true);
  });
});
