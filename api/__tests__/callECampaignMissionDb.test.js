'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

describe('CALL-E campaign mission persistence', () => {
  let db;
  let dbPath;
  const campaignId = `campaign_${'a'.repeat(64)}`;
  const missionId = `mission_${'b'.repeat(64)}`;
  const localCallId = 'call_e_123e4567-e89b-12d3-a456-426614174000';

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-call-e-mission-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    await new Promise((resolve, reject) => db.db.run(
      `INSERT INTO call_e_campaign_reviews (
         campaign_id, business_id, template_id, template_version, schema_fingerprint, request_hash,
         created_by, status, recipient_count, ready_count, blocked_count
       ) VALUES (?, 'biz-a', 7, 3, ?, ?, '111', 'approved', 2, 2, 0)`,
      [campaignId, 'c'.repeat(64), 'd'.repeat(64)],
      (error) => error ? reject(error) : resolve(),
    ));
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
  });

  function missionInput(overrides = {}) {
    return {
      mission_id: missionId,
      business_id: 'biz-a',
      campaign_id: campaignId,
      template_id: 7,
      template_version: 3,
      result_schema_json: JSON.stringify({
        type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } },
      }),
      created_by: '111',
      request_hash: 'e'.repeat(64),
      encryption_key_version: 1,
      recipients: [0, 1].map((position) => ({
        position,
        encrypted_destination: `cipher:v1:synthetic-${position}`,
        destination_masked: `+${'•'.repeat(8)}${String(position).padStart(3, '0')}1`,
        idempotency_key: `mission-item-${position}-key`,
      })),
      ...overrides,
    };
  }

  it('records append-only campaign review decisions and replays the original reviewer decision', async () => {
    const created = await db.createCallECampaignReviewDraft({
      campaign_id: `campaign_${'c'.repeat(64)}`,
      business_id: 'biz-a',
      template_id: 7,
      template_version: 3,
      schema_fingerprint: 'f'.repeat(64),
      request_hash: '1'.repeat(64),
      created_by: '111',
      recipients: [{ position: 0, phone_masked: '+••••••••0123', status: 'ready', reason_code: 'compatible' }],
    });
    assert.equal(created.campaign.status, 'draft');
    const approved = await db.reviewCallECampaignForBusiness({
      campaign_id: created.campaign.campaign_id,
      business_id: 'biz-a',
      reviewed_by: '222',
      decision: 'approve',
    });
    assert.equal(approved.campaign.status, 'approved');
    assert.equal(approved.reviewHistory.length, 1);
    assert.equal(approved.reviewHistory[0].request_hash, '1'.repeat(64));
    const replay = await db.reviewCallECampaignForBusiness({
      campaign_id: created.campaign.campaign_id,
      business_id: 'biz-a',
      reviewed_by: '222',
      decision: 'approve',
    });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.reviewHistory.length, 1);
  });

  it('creates encrypted recipient rows idempotently and enforces a separate reviewer', async () => {
    const created = await db.createCallECampaignMission(missionInput());
    assert.equal(created.idempotentReplay, false);
    assert.equal(created.mission.status, 'pending_approval');
    assert.equal(created.mission.encryption_key_version, 1);
    assert.equal(JSON.parse(created.mission.result_schema_json).required[0], 'ok');
    assert.equal(created.recipients.length, 2);
    assert.equal(JSON.stringify(created).includes('+12345678901'), false);

    const replay = await db.createCallECampaignMission(missionInput());
    assert.equal(replay.idempotentReplay, true);
    await assert.rejects(db.createCallECampaignMission(missionInput({ request_hash: 'f'.repeat(64) })), (error) => error.code === 'call_e_mission_idempotency_conflict');
    await assert.rejects(db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '111', decision: 'approve' }), (error) => error.code === 'call_e_mission_four_eyes_required');

    const approved = await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    assert.equal(approved.mission.status, 'approved');
    assert.equal(approved.mission.reviewed_by, '222');
    assert.equal(approved.reviewHistory.length, 1);
    assert.equal(approved.reviewHistory[0].decision, 'approve');
    assert.equal(approved.reviewHistory[0].request_hash, 'e'.repeat(64));
    const reviewReplay = await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    assert.equal(reviewReplay.mission.status, 'approved');
    assert.equal(reviewReplay.idempotentReplay, true);
    assert.equal(reviewReplay.reviewHistory.length, 1);
    await assert.rejects(new Promise((resolve, reject) => db.db.run(
      `UPDATE call_e_approval_decisions SET decision = 'reject' WHERE entity_type = 'mission' AND entity_id = ?`,
      [missionId], (error) => error ? reject(error) : resolve(),
    )), /append-only/);
    assert.deepEqual(await db.listCallECampaignMissionsForBusiness('biz-other'), []);
  });

  it('claims a single recipient for idempotent recovery and enforces recipient transitions', async () => {
    await db.createCallECampaignMission(missionInput());
    await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });

    const firstClaim = await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    assert.equal(firstClaim.recipient.status, 'in_progress');
    assert.equal(firstClaim.recovery, false);
    const retryClaim = await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    assert.equal(retryClaim.recipient.idempotency_key, firstClaim.recipient.idempotency_key);
    assert.equal(retryClaim.recovery, true);

    const accepted = await db.updateCallECampaignMissionRecipient({
      mission_id: missionId, business_id: 'biz-a', position: 0, status: 'accepted', local_call_id: localCallId,
    });
    assert.equal(accepted.recipients[0].status, 'accepted');
    assert.equal(accepted.recipients[0].local_call_id, localCallId);
    const waitingForAccepted = await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    assert.equal(waitingForAccepted.waitingForAccepted, true);
    assert.equal(waitingForAccepted.recipient, null);
    await assert.rejects(db.updateCallECampaignMissionRecipient({
      mission_id: missionId, business_id: 'biz-a', position: 0, status: 'queued',
    }), (error) => error.code === 'call_e_mission_transition_invalid');

    await db.updateCallECampaignMissionRecipient({ mission_id: missionId, business_id: 'biz-a', position: 0, status: 'completed' });
    const secondClaim = await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    assert.equal(secondClaim.recipient.position, 1);
    await db.updateCallECampaignMissionRecipient({ mission_id: missionId, business_id: 'biz-a', position: 1, status: 'failed', error_code: 'provider_timeout' });
    assert.equal((await db.getCallECampaignMissionForBusiness(missionId, 'biz-a')).mission.status, 'needs_review');
    assert.equal((await db.listCallECampaignMissionsForBusiness('biz-a'))[0].attention_count, 1);
  });

  it('records a separate policy-manager resolution before continuing or canceling a paused mission', async () => {
    await db.createCallECampaignMission(missionInput());
    await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    await db.updateCallECampaignMissionRecipient({ mission_id: missionId, business_id: 'biz-a', position: 0, status: 'failed', error_code: 'call_failed' });
    assert.equal((await db.getCallECampaignMissionForBusiness(missionId, 'biz-a')).mission.status, 'needs_review');
    await assert.rejects(db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a'), (error) => error.code === 'call_e_mission_not_approved');
    await assert.rejects(db.resolveCallECampaignMission({
      mission_id: missionId, business_id: 'biz-a', resolved_by: '111', decision: 'continue', idempotency_key: 'resolution-test-0001',
    }), (error) => error.code === 'call_e_mission_four_eyes_required');

    const continued = await db.resolveCallECampaignMission({
      mission_id: missionId, business_id: 'biz-a', resolved_by: '333', decision: 'continue', idempotency_key: 'resolution-test-0001',
    });
    assert.equal(continued.mission.status, 'running');
    assert.equal(continued.idempotentReplay, false);
    const replay = await db.resolveCallECampaignMission({
      mission_id: missionId, business_id: 'biz-a', resolved_by: '333', decision: 'continue', idempotency_key: 'resolution-test-0001',
    });
    assert.equal(replay.idempotentReplay, true);
    const next = await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    assert.equal(next.recipient.position, 1);
    await db.updateCallECampaignMissionRecipient({ mission_id: missionId, business_id: 'biz-a', position: 1, status: 'failed', error_code: 'call_failed' });
    const canceled = await db.resolveCallECampaignMission({
      mission_id: missionId, business_id: 'biz-a', resolved_by: '333', decision: 'cancel', idempotency_key: 'resolution-test-0002',
    });
    assert.equal(canceled.mission.status, 'canceled');
    assert.equal(canceled.recipients[0].status, 'failed');
  });

  it('refuses mission creation unless the matching campaign was approved and fully ready', async () => {
    await assert.rejects(db.createCallECampaignMission(missionInput({ business_id: 'biz-other' })), (error) => error.code === 'call_e_mission_campaign_not_approved');
    await assert.rejects(db.createCallECampaignMission(missionInput({ template_version: 2 })), (error) => error.code === 'call_e_mission_campaign_not_approved');
    await assert.rejects(db.createCallECampaignMission(missionInput({ result_schema_json: '{invalid' })), (error) => error.code === 'call_e_mission_invalid');
    await assert.rejects(db.createCallECampaignMission(missionInput({ result_schema_json: JSON.stringify([]) })), (error) => error.code === 'call_e_mission_invalid');
    await assert.rejects(db.createCallECampaignMission(missionInput({ result_schema_json: JSON.stringify({ extra: 'x'.repeat(16000) }) })), (error) => error.code === 'call_e_mission_invalid');
  });

  it('enforces explicit business safety policy, daily reservations, worker pause, and lease renewal', async () => {
    await db.createCallECampaignMission(missionInput());
    await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    const noPolicy = await db.reserveCallEBusinessDispatch({ business_id: 'biz-a', mission_id: missionId, recipient_position: 0, usage_date: '2026-10-31' });
    assert.equal(noPolicy.allowed, false);
    assert.equal(noPolicy.reason, 'safety_policy_required');
    await db.setCallEBusinessSafetyPolicy({ business_id: 'biz-a', actor_id: '222', max_calls_per_day: 1,
      quiet_hours_start: null, quiet_hours_end: null, timezone: 'UTC', emergency_stop: false });
    assert.equal((await db.getCallEBusinessSafetyPolicy('biz-a')).emergency_stop, false);
    const lease = { mission_id: missionId, business_id: 'biz-a', worker_id: 'worker-1', lease_token: 'token_12345678901234567890', lease_ms: 60000 };
    assert.equal(await db.acquireCallECampaignMissionWorkerLease(lease), true);
    assert.equal(await db.renewCallECampaignMissionWorkerLease(lease), true);
    await db.setCallECampaignMissionWorkerControl({ mission_id: missionId, business_id: 'biz-a', actor_id: '222', paused: true });
    assert.equal((await db.getCallECampaignMissionWorkerControl(missionId, 'biz-a')).paused, true);
    const paused = await db.getCallECampaignMissionWorkerControl(missionId, 'biz-a');
    assert.equal(paused.updated_by, '222');
    await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    const workerPaused = await db.reserveCallEBusinessDispatch({ business_id: 'biz-a', mission_id: missionId, recipient_position: 0, usage_date: '2026-10-31', worker_managed: true });
    assert.equal(workerPaused.reason, 'mission_worker_paused');
    await db.setCallECampaignMissionWorkerControl({ mission_id: missionId, business_id: 'biz-a', actor_id: '222', paused: false });
    const reservation = await db.reserveCallEBusinessDispatch({ business_id: 'biz-a', mission_id: missionId, recipient_position: 0, usage_date: '2026-10-31' });
    assert.deepEqual({ allowed: reservation.allowed, calls_remaining: reservation.calls_remaining }, { allowed: true, calls_remaining: 0 });
    const duplicate = await db.reserveCallEBusinessDispatch({ business_id: 'biz-a', mission_id: missionId, recipient_position: 0, usage_date: '2026-10-31' });
    assert.equal(duplicate.idempotent, true);
    await db.updateCallECampaignMissionRecipient({ mission_id: missionId, business_id: 'biz-a', position: 0, status: 'accepted', local_call_id: localCallId });
    await db.updateCallECampaignMissionRecipient({ mission_id: missionId, business_id: 'biz-a', position: 0, status: 'completed' });
    await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    const second = await db.reserveCallEBusinessDispatch({ business_id: 'biz-a', mission_id: missionId, recipient_position: 1, usage_date: '2026-10-31' });
    assert.equal(second.reason, 'daily_limit_reached');
    const audit = await db.listCallEOperationsAudit('biz-a');
    assert.ok(audit.some((entry) => entry.action === 'safety_policy_updated'));
    assert.ok(audit.some((entry) => entry.action === 'worker_paused'));
  });

  it('requires two different policy managers at the configured recipient threshold and expires old approvals', async () => {
    await db.setCallEBusinessMissionPolicy({ business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 2, approval_ttl_hours: 24 });
    await db.createCallECampaignMission(missionInput());
    const first = await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    assert.equal(first.mission.status, 'pending_approval');
    assert.equal(first.awaitingSecondaryApproval, true);
    assert.equal((await db.validateCallECampaignMissionApproval(missionId, 'biz-a')).valid, false);
    const sameReviewerReplay = await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    assert.equal(sameReviewerReplay.idempotentReplay, true);
    const second = await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '333', decision: 'approve' });
    assert.equal(second.mission.status, 'approved');
    assert.equal(second.awaitingSecondaryApproval, false);
    assert.equal(second.reviewHistory.length, 2);
    assert.equal((await db.validateCallECampaignMissionApproval(missionId, 'biz-a')).valid, true);
  });

  it('interprets SQLite approval timestamps as UTC regardless of the host timezone', async () => {
    await db.setCallEBusinessMissionPolicy({ business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 26, approval_ttl_hours: 1 });
    await db.createCallECampaignMission(missionInput());
    const twoHoursAgoUtc = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    await new Promise((resolve, reject) => db.db.run(
      `INSERT INTO call_e_approval_decisions (entity_type, entity_id, business_id, reviewed_by, decision, request_hash, created_at)
       VALUES ('mission', ?, 'biz-a', '222', 'approve', ?, ?)`, [missionId, 'e'.repeat(64), twoHoursAgoUtc],
      (error) => error ? reject(error) : resolve(),
    ));
    const priorTimezone = process.env.TZ;
    process.env.TZ = 'Pacific/Honolulu';
    try {
      assert.equal((await db.validateCallECampaignMissionApproval(missionId, 'biz-a')).valid, false);
    } finally {
      if (priorTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = priorTimezone;
    }
  });

  it('retries only a provider-confirmed rejected recipient and records an append-only timeline event', async () => {
    await db.createCallECampaignMission(missionInput());
    await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    await db.updateCallECampaignMissionRecipient({ mission_id: missionId, business_id: 'biz-a', position: 0, status: 'failed', error_code: 'call_e_request_rejected' });
    const retried = await db.retryCallECampaignMissionRecipient({
      mission_id: missionId, business_id: 'biz-a', actor_id: '333', position: 0, idempotency_key: 'retry-confirmed-0001',
    });
    assert.equal(retried.mission.status, 'running');
    assert.equal(retried.recipients[0].status, 'queued');
    const replay = await db.retryCallECampaignMissionRecipient({
      mission_id: missionId, business_id: 'biz-a', actor_id: '333', position: 0, idempotency_key: 'retry-confirmed-0001',
    });
    assert.equal(replay.idempotentReplay, true);
    const timeline = await db.listCallEMissionActivity('biz-a', missionId);
    assert.ok(timeline.some((event) => event.event_type === 'recipient_retry_requested' && event.actor_id === '333'));
    await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    await db.updateCallECampaignMissionRecipient({ mission_id: missionId, business_id: 'biz-a', position: 0, status: 'failed', error_code: 'provider_timeout' });
    await assert.rejects(db.retryCallECampaignMissionRecipient({
      mission_id: missionId, business_id: 'biz-a', actor_id: '333', position: 0, idempotency_key: 'retry-uncertain-0001',
    }), (error) => error.code === 'call_e_mission_retry_not_safe');
  });

  it('persists business routing and alert preferences and aggregates masked mission outcome counts', async () => {
    await db.createCallECampaignMission(missionInput());
    await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    await db.claimNextCallECampaignMissionRecipient(missionId, 'biz-a');
    await db.updateCallECampaignMissionRecipient({ mission_id: missionId, business_id: 'biz-a', position: 0, status: 'failed', error_code: 'call_failed' });
    await db.setCallEBusinessMissionPolicy({ business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 10, approval_ttl_hours: 48 });
    assert.equal((await db.getCallEBusinessMissionPolicy('biz-a')).approval_ttl_hours, 48);
    await db.setCallEBusinessProviderRouting({ business_id: 'biz-a', actor_id: '222', provider_order: ['plivo', 'vonage'] });
    assert.deepEqual((await db.getCallEBusinessProviderRouting('biz-a')).provider_order, ['plivo', 'vonage']);
    await db.grantCallEBusinessOperator({ business_id: 'biz-a', telegram_id: '222', role: 'call_operator' });
    await db.setCallEMissionAlertSubscription({ business_id: 'biz-a', actor_id: '222', enabled: true });
    assert.equal((await db.getCallEMissionAlertSubscription('biz-a', '222')).enabled, true);
    let subscriptions = await db.listCallEMissionAlertSubscriptions();
    assert.equal(subscriptions.some((subscription) => subscription.actor_id === '222'), true);
    const maxEvent = await new Promise((resolve, reject) => db.db.get('SELECT MAX(event_id) AS event_id FROM call_e_mission_activity WHERE business_id = ?', ['biz-a'],
      (error, row) => error ? reject(error) : resolve(Number(row?.event_id) || 0)));
    assert.equal(subscriptions.find((subscription) => subscription.actor_id === '222').last_notified_event_id, maxEvent);
    await db.revokeCallEBusinessOperator({ business_id: 'biz-a', telegram_id: '222' });
    subscriptions = await db.listCallEMissionAlertSubscriptions();
    assert.equal(subscriptions.some((subscription) => subscription.actor_id === '222'), false);
    await db.resolveCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', resolved_by: '333', decision: 'cancel', idempotency_key: 'cancel-report-0001' });
    const report = await db.getCallECampaignMissionReport('biz-a', '2000-01-01', '2100-01-01');
    assert.equal(report.mission_count, 1);
    assert.equal(report.failed_recipients, 1);
    assert.equal(report.canceled_recipients, 1);
    assert.ok((await db.getCallECampaignMission(missionId, 'biz-a')).activity.length >= 3);
  });

  it('persists scheduled launches, one-time review escalations, hard budget reservations, and contact cooldowns', async () => {
    const dueMissionId = `mission_${'c'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({
      mission_id: dueMissionId,
      scheduled_at: '2020-01-01T00:00:00.000Z',
      budget_limit_minor: 300,
      budget_currency: 'USD',
      per_call_cost_ceiling_minor: 200,
    }));
    await db.reviewCallECampaignMission({ mission_id: dueMissionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    const due = await db.listDueCallECampaignMissions(new Date().toISOString());
    assert.equal(due.some((mission) => mission.mission_id === dueMissionId && mission.actor_id === '222'), true);
    const budget1 = await db.reserveCallECampaignMissionBudget({ mission_id: dueMissionId, business_id: 'biz-a', recipient_position: 0 });
    const budget2 = await db.reserveCallECampaignMissionBudget({ mission_id: dueMissionId, business_id: 'biz-a', recipient_position: 1 });
    const budgetReplay = await db.reserveCallECampaignMissionBudget({ mission_id: dueMissionId, business_id: 'biz-a', recipient_position: 0 });
    assert.equal(budget1.allowed, true);
    assert.deepEqual(budget2, { allowed: false, reason: 'budget_exhausted', reserved_minor: 200 });
    assert.equal(budgetReplay.idempotent_replay, true);

    await db.setCallEBusinessMissionPolicy({ business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 10, approval_ttl_hours: 24, review_sla_minutes: 10 });
    const escalationMissionId = `mission_${'e'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({ mission_id: escalationMissionId, request_hash: '8'.repeat(64), recipients: missionInput().recipients.map((recipient) => ({ ...recipient, idempotency_key: `${recipient.idempotency_key}-escalation` })) }));
    await new Promise((resolve, reject) => db.db.run("UPDATE call_e_campaign_missions SET created_at = '2020-01-01 00:00:00' WHERE mission_id = ?", [escalationMissionId], (error) => error ? reject(error) : resolve()));
    const overdue = await db.listDueCallEMissionEscalations(new Date().toISOString());
    assert.equal(overdue.some((mission) => mission.mission_id === escalationMissionId), true);
    assert.equal(await db.recordCallEMissionEscalation({ mission_id: escalationMissionId, business_id: 'biz-a' }), true);
    assert.equal(await db.recordCallEMissionEscalation({ mission_id: escalationMissionId, business_id: 'biz-a' }), false);
    assert.ok((await db.listCallEMissionActivity('biz-a', escalationMissionId)).some((event) => event.state === 'review_escalated'));

    await db.setCallEBusinessSafetyPolicy({
      business_id: 'biz-a', actor_id: '222', max_calls_per_day: 10, timezone: 'UTC',
      quiet_hours_start: null, quiet_hours_end: null, emergency_stop: false, contact_cooldown_hours: 24,
    });
    const hash = 'f'.repeat(64);
    assert.equal((await db.reserveCallEContactCooldown({ business_id: 'biz-a', destination_hash: hash, mission_id: dueMissionId, recipient_position: 0 })).allowed, true);
    const secondMissionId = `mission_${'f'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({ mission_id: secondMissionId, request_hash: '9'.repeat(64), recipients: missionInput().recipients.map((recipient) => ({ ...recipient, idempotency_key: `${recipient.idempotency_key}-second` })) }));
    const blocked = await db.reserveCallEContactCooldown({ business_id: 'biz-a', destination_hash: hash, mission_id: secondMissionId, recipient_position: 0 });
    assert.deepEqual(blocked, { allowed: false, reason: 'cooldown_active' });
    await db.updateCallEContactCooldownReservation({ mission_id: dueMissionId, recipient_position: 0, status: 'released' });
    assert.equal((await db.reserveCallEContactCooldown({ business_id: 'biz-a', destination_hash: hash, mission_id: secondMissionId, recipient_position: 0 })).allowed, true);
  });

  it('rolls back escalation deduplication when its activity event cannot be recorded', async () => {
    await db.setCallEBusinessMissionPolicy({ business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 10, approval_ttl_hours: 24, review_sla_minutes: 10 });
    const escalationMissionId = `mission_${'d'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({
      mission_id: escalationMissionId,
      request_hash: '7'.repeat(64),
      recipients: missionInput().recipients.map((recipient) => ({ ...recipient, idempotency_key: `${recipient.idempotency_key}-atomic-escalation` })),
    }));
    await new Promise((resolve, reject) => db.db.run(
      `CREATE TRIGGER fail_review_escalation_activity BEFORE INSERT ON call_e_mission_activity
       WHEN NEW.state = 'review_escalated' BEGIN SELECT RAISE(ABORT, 'test activity failure'); END`,
      (error) => error ? reject(error) : resolve(),
    ));

    await assert.rejects(db.recordCallEMissionEscalation({ mission_id: escalationMissionId, business_id: 'biz-a' }), /test activity failure/);
    const remaining = await new Promise((resolve, reject) => db.db.get(
      'SELECT COUNT(*) AS count FROM call_e_mission_escalations WHERE mission_id = ?', [escalationMissionId],
      (error, row) => error ? reject(error) : resolve(Number(row?.count) || 0),
    ));
    assert.equal(remaining, 0);

    await new Promise((resolve, reject) => db.db.run('DROP TRIGGER fail_review_escalation_activity', (error) => error ? reject(error) : resolve()));
    assert.equal(await db.recordCallEMissionEscalation({ mission_id: escalationMissionId, business_id: 'biz-a' }), true);
  });

  it('uses the reassigned escalation owner for review inbox display and acknowledgment authorization', async () => {
    const escalationMissionId = `mission_${'c'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({ mission_id: escalationMissionId, request_hash: '6'.repeat(64),
      recipients: missionInput().recipients.map((recipient) => ({ ...recipient, idempotency_key: `${recipient.idempotency_key}-reassigned` })) }));
    await db.setCallEBusinessMissionPolicy({ business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 10,
      approval_ttl_hours: 24, review_sla_minutes: 10, review_repeat_minutes: 0 });
    assert.equal(await db.recordCallEMissionEscalation({ mission_id: escalationMissionId, business_id: 'biz-a' }), true);
    const reassigned = await db.recordCallEMissionEscalationAction({ business_id: 'biz-a', mission_id: escalationMissionId,
      action: 'reassigned', actor_id: '222', assigned_to: '333', idempotency_key: 'reassign-owner-0001', request_hash: 'a'.repeat(64) });
    assert.equal(reassigned.recorded, true);
    const inbox = await db.listCallEMissionReviewInbox('biz-a');
    assert.equal(inbox.find((row) => row.mission_id === escalationMissionId).assigned_to, '333');
    const acknowledged = await db.recordCallEMissionReviewAction({ business_id: 'biz-a', mission_id: escalationMissionId,
      action: 'acknowledged', actor_id: '333', assigned_to: '333', idempotency_key: 'ack-reassigned-owner-0001' });
    assert.equal(acknowledged.recorded, true);
  });

  it('queues only stale or actionable recipients in the recovery inbox and scopes by business', async () => {
    const recoverMissionId = `mission_${'7'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({ mission_id: recoverMissionId, request_hash: '4'.repeat(64),
      recipients: missionInput().recipients.map((recipient) => ({ ...recipient, idempotency_key: `${recipient.idempotency_key}-recovery` })) }));
    await new Promise((resolve, reject) => db.db.run(
      `UPDATE call_e_campaign_mission_recipients SET status = 'accepted', local_call_id = 'call_e_123e4567-e89b-12d3-a456-426614174000', updated_at = '2020-01-01 00:00:00'
       WHERE mission_id = ? AND position = 0`, [recoverMissionId], (error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => db.db.run(
      `UPDATE call_e_campaign_mission_recipients SET status = 'failed', error_code = 'call_e_request_rejected' WHERE mission_id = ? AND position = 1`,
      [recoverMissionId], (error) => error ? reject(error) : resolve()));
    const items = await db.listCallEMissionRecoveryInbox('biz-a', 50, new Date().toISOString());
    assert.equal(items.some((row) => row.mission_id === recoverMissionId && row.position === 0 && row.local_call_id), true);
    assert.equal(items.some((row) => row.mission_id === recoverMissionId && row.position === 1 && row.error_code === 'call_e_request_rejected'), true);
    assert.equal((await db.listCallEMissionRecoveryInbox('biz-other')).length, 0);
  });

  it('repeats deadline escalation only at configured intervals and stops when disabled', async () => {
    await db.setCallEBusinessMissionPolicy({ business_id: 'biz-a', actor_id: '222', secondary_approval_threshold: 10,
      approval_ttl_hours: 24, review_sla_minutes: 10, review_repeat_minutes: 30 });
    const repeatedMissionId = `mission_${'6'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({ mission_id: repeatedMissionId, request_hash: '3'.repeat(64),
      recipients: missionInput().recipients.map((recipient) => ({ ...recipient, idempotency_key: `${recipient.idempotency_key}-repeat` })) }));
    await new Promise((resolve, reject) => db.db.run("UPDATE call_e_campaign_missions SET created_at = '2020-01-01 00:00:00' WHERE mission_id = ?", [repeatedMissionId], (error) => error ? reject(error) : resolve()));
    const now = new Date().toISOString();
    assert.equal(await db.recordCallEMissionEscalation({ mission_id: repeatedMissionId, business_id: 'biz-a', now_iso: now }), true);
    assert.equal(await db.recordCallEMissionEscalation({ mission_id: repeatedMissionId, business_id: 'biz-a', now_iso: now }), false);
    const repeatAt = new Date(Date.parse(now) + 31 * 60000).toISOString();
    assert.equal(await db.recordCallEMissionEscalation({ mission_id: repeatedMissionId, business_id: 'biz-a', now_iso: repeatAt }), true);
    assert.equal((await db.listCallEMissionActivity('biz-a', repeatedMissionId)).filter((row) => row.state === 'review_escalated').length, 2);
  });

  it('stages CDR imports with duplicate and budget preview before commit', async () => {
    const cdrMissionId = `mission_${'5'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({ mission_id: cdrMissionId, request_hash: '2'.repeat(64), budget_limit_minor: 1000,
      per_call_cost_ceiling_minor: 250, budget_currency: 'USD',
      recipients: missionInput().recipients.map((recipient) => ({ ...recipient, idempotency_key: `${recipient.idempotency_key}-cdr-stage` })) }));
    const records = [
      { recipient_position: 0, provider: 'twilio', provider_call_id: 'cdr-stage-call-001', amount_minor: 700, currency: 'USD', occurred_at: '2026-10-31T10:00:00.000Z', source_reference: 'source-test-0001' },
      { recipient_position: 1, provider: 'twilio', provider_call_id: 'cdr-stage-call-001', amount_minor: 700, currency: 'USD', occurred_at: '2026-10-31T10:00:00.000Z', source_reference: 'source-test-0001' },
    ];
    const staged = await db.stageCallEMissionCdrImport({ business_id: 'biz-a', mission_id: cdrMissionId, created_by: '222',
      idempotency_key: 'cdr-import-stage-0001', request_hash: 'f'.repeat(64), records });
    assert.equal(staged.status, 'staged');
    assert.equal(staged.preview.duplicate_count, 1);
    assert.equal(staged.preview.new_record_count, 1);
    assert.equal(staged.preview.budget_exceeded, false);
    const replay = await db.stageCallEMissionCdrImport({ business_id: 'biz-a', mission_id: cdrMissionId, created_by: '222',
      idempotency_key: 'cdr-import-stage-0001', request_hash: 'f'.repeat(64), records });
    assert.equal(replay.idempotent_replay, true);
    assert.equal(await db.markCallEMissionCdrImportCommitted('biz-a', staged.import_id, '222'), 1);
    assert.equal((await db.getCallEMissionCdrImport('biz-a', staged.import_id)).status, 'committed');
  });

  it('assigns and acknowledges pending mission reviews with append-only, replay-safe events', async () => {
    const reviewMissionId = `mission_${'9'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({ mission_id: reviewMissionId, request_hash: '6'.repeat(64),
      recipients: missionInput().recipients.map((recipient) => ({ ...recipient, idempotency_key: `${recipient.idempotency_key}-review-action` })) }));
    const inbox = await db.listCallEMissionReviewInbox('biz-a');
    assert.equal(inbox.some((item) => item.mission_id === reviewMissionId && item.assigned_to === null), true);
    const assigned = await db.recordCallEMissionReviewAction({ business_id: 'biz-a', mission_id: reviewMissionId, action: 'assigned', actor_id: '222', assigned_to: '333', idempotency_key: 'review-assign-0001' });
    assert.equal(assigned.recorded, true);
    const denied = await db.recordCallEMissionReviewAction({ business_id: 'biz-a', mission_id: reviewMissionId, action: 'acknowledged', actor_id: '222', assigned_to: '222', idempotency_key: 'review-acknowledge-0001' });
    assert.equal(denied.assignment_required, true);
    const acknowledged = await db.recordCallEMissionReviewAction({ business_id: 'biz-a', mission_id: reviewMissionId, action: 'acknowledged', actor_id: '333', assigned_to: '333', idempotency_key: 'review-acknowledge-0002' });
    assert.equal(acknowledged.recorded, true);
    const replay = await db.recordCallEMissionReviewAction({ business_id: 'biz-a', mission_id: reviewMissionId, action: 'acknowledged', actor_id: '333', assigned_to: '333', idempotency_key: 'review-acknowledge-0002' });
    assert.equal(replay.idempotent_replay, true);
    assert.ok((await db.listCallEMissionActivity('biz-a', reviewMissionId)).some((event) => event.state === 'review_acknowledged'));
  });

  it('reconciles provider usage against a currency-pinned mission budget and emits one budget event', async () => {
    const usageMissionId = `mission_${'8'.repeat(64)}`;
    await db.createCallECampaignMission(missionInput({ mission_id: usageMissionId, request_hash: '5'.repeat(64), budget_limit_minor: 1000,
      per_call_cost_ceiling_minor: 250, budget_currency: 'USD',
      recipients: missionInput().recipients.map((recipient) => ({ ...recipient, idempotency_key: `${recipient.idempotency_key}-usage` })) }));
    const record = { business_id: 'biz-a', mission_id: usageMissionId, recipient_position: 0, provider: 'plivo', provider_call_id: 'cdr-test-call-0001',
      amount_minor: 1250, currency: 'USD', billed_duration_seconds: 60, source_type: 'provider_cdr', source_reference: 'provider-cdr-ref-0001',
      recorded_by: '222', idempotency_key: 'usage-test-idempotency-0001', request_hash: 'a'.repeat(64), occurred_at: '2026-10-31T10:00:00Z' };
    const first = await db.recordCallEMissionUsageRecord(record);
    assert.equal(first.recorded, true);
    assert.equal(first.budget_exceeded, true);
    const replay = await db.recordCallEMissionUsageRecord(record);
    assert.equal(replay.idempotent_replay, true);
    await Promise.all(Array.from({ length: 100 }, (_, index) => new Promise((resolve, reject) => db.db.run(
      `INSERT INTO call_e_mission_usage_records (
         business_id, mission_id, recipient_position, provider, provider_call_id, amount_minor, currency,
         source_type, source_reference, recorded_by, idempotency_key, request_hash, occurred_at
       ) VALUES (?, ?, ?, 'plivo', ?, 1, 'USD', 'provider_cdr', ?, '222', ?, ?, '2026-10-31T10:00:00.000Z')`,
      ['biz-a', usageMissionId, 1, `cdr-extra-${index}`, `source-extra-${index}`, `usage-extra-${index}`, String(index).padStart(64, '0')],
      (error) => error ? reject(error) : resolve(),
    ))));
    const report = await db.getCallEMissionUsageReport('biz-a', usageMissionId);
    assert.equal(report.budget_exceeded, true);
    assert.deepEqual(report.actual_by_currency, { USD: 1350 });
    assert.equal(report.records.length, 100);
    const events = await db.listCallEMissionActivity('biz-a', usageMissionId);
    assert.equal(events.filter((event) => event.state === 'budget_exceeded').length, 1);
  });

  it('claims and advances daily or weekly report digest subscriptions only for current operators', async () => {
    await db.grantCallEBusinessOperator({ business_id: 'biz-a', telegram_id: '222', role: 'call_operator' });
    const subscription = await db.setCallEMissionReportDigestSubscription({ business_id: 'biz-a', actor_id: '222', enabled: true, interval_hours: 24 });
    assert.equal(subscription.enabled, true);
    assert.equal(subscription.interval_hours, 24);
    const future = new Date(Date.parse(`${subscription.next_delivery_at.replace(' ', 'T')}Z`) + 10 * 60000).toISOString();
    const due = await db.listDueCallEMissionReportDigests(future);
    assert.equal(due.some((row) => row.actor_id === '222'), true);
    const row = due.find((item) => item.actor_id === '222');
    assert.equal(await db.claimCallEMissionReportDigest({ business_id: 'biz-a', actor_id: '222', previous_due_at: row.next_delivery_at, now: future }), true);
    assert.equal(await db.claimCallEMissionReportDigest({ business_id: 'biz-a', actor_id: '222', previous_due_at: row.next_delivery_at, now: future }), false);
    assert.equal(await db.advanceCallEMissionReportDigest({ business_id: 'biz-a', actor_id: '222', previous_due_at: row.next_delivery_at }), true);
    await db.revokeCallEBusinessOperator({ business_id: 'biz-a', telegram_id: '222' });
    assert.equal((await db.listDueCallEMissionReportDigests(new Date(Date.parse(future) + 30 * 3600000).toISOString())).some((item) => item.actor_id === '222'), false);
  });

  it('purges expired mission destination ciphertext but retains recipient and review audit rows', async () => {
    await db.createCallECampaignMission(missionInput({ sensitive_data_expires_at: '2000-01-01T00:00:00.000Z' }));
    await db.reviewCallECampaignMission({ mission_id: missionId, business_id: 'biz-a', reviewed_by: '222', decision: 'approve' });
    const result = await db.purgeCallESensitiveData({ business_id: 'biz-a', actor_id: '222', cutoff: new Date().toISOString() });
    assert.equal(result.expired_missions, 1);
    const saved = await db.getCallECampaignMission(missionId, 'biz-a');
    assert.equal(saved.recipients.every((recipient) => recipient.encrypted_destination === ''), true);
    assert.equal(saved.status, 'needs_review');
    assert.equal(saved.reviewHistory.length, 1);
    assert.equal(saved.sensitive_data_purged_at != null, true);
  });
});
