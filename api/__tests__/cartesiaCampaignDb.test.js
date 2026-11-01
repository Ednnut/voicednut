'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve())); }

describe('Cartesia campaign durable state', () => {
  it('persists an encrypted draft and atomically claims bounded daily capacity once', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-campaign-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database(); db.dbPath = dbPath;
    try {
      await db.initialize();
      await run(db.db, `INSERT INTO call_e_business_safety_policies
        (business_id, max_calls_per_day, timezone, emergency_stop, updated_by) VALUES ('biz-1', 2, 'UTC', 0, '7001')`);
      const contactReservation = await db.reserveOutboundContactDispatch({ reservation_key: 'cartesia:reservation-test-0001', business_id: 'biz-1', destination_hash: 'c'.repeat(64), provider: 'cartesia' });
      assert.equal(contactReservation.allowed, true);
      await db.updateOutboundContactDispatch({ reservation_key: 'cartesia:reservation-test-0001', status: 'accepted' });
      const input = {
        campaign_id: `cartesia_campaign_${'a'.repeat(64)}`, business_id: 'biz-1', created_by: '7001',
        request_key: 'cartesia:request-0001', request_hash: 'b'.repeat(64), name: 'Consent checks',
        agent_id: 'agent_1', from_number_id: 'number_1', target_concurrency_limit: 1,
        encryption_key_version: 1,
        recipients: [{ position: 0, encrypted_destination: 'v1.ciphertext', destination_masked: '+••••0123', readiness: 'ready', reason_code: 'ready' }],
      };
      const first = await db.createCartesiaCampaignDraft(input);
      assert.equal(first.idempotentReplay, false);
      const replay = await db.createCartesiaCampaignDraft(input);
      assert.equal(replay.idempotentReplay, true);
      assert.equal(replay.campaign.campaign_id, input.campaign_id);
      assert.equal(await db.transitionCartesiaCampaign({ campaign_id: input.campaign_id, business_id: 'biz-1', expected_status: 'draft', status: 'approved', approved_by: '7001' }), true);
      const attempt = { campaign_id: input.campaign_id, business_id: 'biz-1', request_hash: input.request_hash,
        usage_date: '2026-10-31', now_iso: '2026-10-31T12:00:00.000Z' };
      const claims = await Promise.all([db.claimCartesiaCampaignSubmission(attempt), db.claimCartesiaCampaignSubmission(attempt)]);
      assert.equal(claims.filter((result) => result.claimed).length, 1);
      assert.equal(claims.filter((result) => result.reason === 'campaign_not_approvable').length, 1);
      const saved = await db.getCartesiaCampaign(input.campaign_id, 'biz-1');
      assert.equal(saved.campaign.status, 'submitting');
      assert.equal(saved.recipients.length, 1);
      assert.equal(saved.recipients[0].encrypted_destination, 'v1.ciphertext');
      const scheduledInput = { ...input, campaign_id: `cartesia_campaign_${'c'.repeat(64)}`, request_key: 'cartesia:request-0003',
        request_hash: 'e'.repeat(64), scheduled_at: '2026-11-01T14:00:00.000Z' };
      await db.createCartesiaCampaignDraft(scheduledInput);
      assert.equal((await db.getCartesiaCampaign(scheduledInput.campaign_id, 'biz-1')).campaign.scheduled_at, scheduledInput.scheduled_at);
      await db.transitionCartesiaCampaign({ campaign_id: scheduledInput.campaign_id, business_id: 'biz-1', expected_status: 'draft', status: 'approved', approved_by: '7001' });
      assert.deepEqual(await db.listDueCartesiaCampaigns({ now_iso: '2026-11-01T13:59:59.000Z' }), []);
      assert.equal((await db.listDueCartesiaCampaigns({ now_iso: '2026-11-01T14:00:00.000Z' })).some((row) => row.campaign_id === scheduledInput.campaign_id), true);
      const scheduledClaim = await db.claimCartesiaCampaignSubmission({ ...attempt, campaign_id: scheduledInput.campaign_id,
        request_hash: scheduledInput.request_hash, usage_date: '2026-11-01', scheduled_at: scheduledInput.scheduled_at });
      assert.equal(scheduledClaim.claimed, true);
      const reservationDates = await new Promise((resolve, reject) => db.db.all(
        'SELECT usage_date FROM cartesia_campaign_daily_reservations WHERE campaign_id = ?', [scheduledInput.campaign_id],
        (error, rows) => error ? reject(error) : resolve(rows || []),
      ));
      assert.deepEqual(reservationDates.map((row) => row.usage_date), ['2026-11-01']);
      await db.transitionCartesiaCampaign({ campaign_id: input.campaign_id, business_id: 'biz-1', expected_status: 'submitting', status: 'submitted', provider_batch_id: 'batch_1' });
      await db.syncCartesiaCampaignBatch({ campaign_id: input.campaign_id, business_id: 'biz-1', provider_batch_id: 'batch_1', provider_status: 'completed', recipients: [
        { position: 0, provider_call_id: 'campaign_call_1', provider_status: 'completed', provider_end_reason: 'agent_hangup' },
      ] });
      assert.equal(await db.getCartesiaCallBusinessScope('campaign_call_1'), 'biz-1');
      await db.reserveOutboundCallIdempotency({ idempotency_key: 'cartesia:business-call-0001', provider: 'cartesia', business_id: 'biz-1', request_hash: 'f'.repeat(64) });
      await db.completeOutboundCallIdempotency({ idempotency_key: 'cartesia:business-call-0001', provider: 'cartesia', business_id: 'biz-1', request_hash: 'f'.repeat(64), call_sid: 'single_call_1', status: 'completed' });
      assert.equal(await db.getCartesiaCallBusinessScope('single_call_1'), 'biz-1');
      assert.equal((await db.getCartesiaCallReviewRules('biz-1')).review_failed_calls, true);
      const configuredRules = await db.saveCartesiaCallReviewRules({ business_id: 'biz-1', review_failed_calls: false, review_tool_calls: true, review_missing_summary: true, updated_by: '7001' });
      assert.deepEqual({ review_failed_calls: configuredRules.review_failed_calls, review_tool_calls: configuredRules.review_tool_calls,
        review_missing_summary: configuredRules.review_missing_summary }, { review_failed_calls: false, review_tool_calls: true, review_missing_summary: true });
      assert.equal((await db.getCartesiaCallReviewRules('biz-2')).review_tool_calls, false);
      const retryInput = { campaign_id: input.campaign_id, business_id: 'biz-1', retry_number: 0, recipient_positions: [0], actor_id: '7001', usage_date: '2026-10-31', now_iso: '2026-10-31T12:00:00Z' };
      assert.equal((await db.claimCartesiaCampaignRetry(retryInput)).claimed, true);
      assert.equal((await db.claimCartesiaCampaignRetry(retryInput)).claimed, false);
      assert.equal(await db.finishCartesiaCampaignRetry(input.campaign_id, 0, 'unknown'), true);
      assert.equal((await db.claimCartesiaCampaignRetry(retryInput)).claimed, false);
      assert.deepEqual(await db.claimCartesiaCampaignRetry({ ...retryInput, retry_number: 1 }), { claimed: false, reason: 'daily_limit_reached' });

      await run(db.db, "UPDATE call_e_business_safety_policies SET quiet_hours_start = '13:00', quiet_hours_end = '14:00' WHERE business_id = 'biz-1'");
      const quietInput = { ...input, campaign_id: `cartesia_campaign_${'d'.repeat(64)}`, request_key: 'cartesia:request-0002', request_hash: 'd'.repeat(64) };
      await db.createCartesiaCampaignDraft(quietInput);
      await db.transitionCartesiaCampaign({ campaign_id: quietInput.campaign_id, business_id: 'biz-1', expected_status: 'draft', status: 'approved', approved_by: '7001' });
      const quietClaim = await db.claimCartesiaCampaignSubmission({ ...attempt, campaign_id: quietInput.campaign_id, request_hash: quietInput.request_hash,
        scheduled_at: '2026-11-01T13:30:00.000Z', usage_date: '2026-11-01' });
      assert.deepEqual(quietClaim, { claimed: false, reason: 'quiet_hours_active' });
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  });
});
