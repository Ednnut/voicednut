'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

describe('CALL-E Goal Run persistence', () => {
  let db;
  let dbPath;
  const requestId = `goalrun_${'11111111-1111-4111-8111-111111111111'}`;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-call-e-goal-run-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch (_) {} }
  });

  function row(overrides = {}) {
    return {
      goal_run_request_id: requestId, business_id: 'business-a', goal_id: 'goal_delivery', goal_title: 'Delivery confirmation',
      published_run_spec_id: 'run-spec-7', published_run_spec_version: 7, destination_masked: '+••••••••0123',
      encrypted_payload: 'ciphertext-only', encryption_key_version: 1, request_hash: 'a'.repeat(64),
      idempotency_hash: 'b'.repeat(64), result_schema_json: '{"type":"object"}', status: 'pending_approval',
      created_by: '12345', ...overrides,
    };
  }

  it('stores only the encrypted request, replays the business-scoped idempotency key, and enforces a separate review', async () => {
    const created = await db.createCallEGoalRunRequest(row());
    assert.equal(created.status, 'pending_approval');
    assert.equal(created.encrypted_payload, 'ciphertext-only');
    assert.equal(JSON.stringify(created).includes('+14155550123'), false);
    const replay = await db.createCallEGoalRunRequest(row({ goal_run_request_id: `goalrun_${'22222222-2222-4222-8222-222222222222'}` }));
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.goal_run_request_id, requestId);
    assert.equal(await db.reviewCallEGoalRunRequest({ goal_run_request_id: requestId, business_id: 'business-a', reviewed_by: '12345', decision: 'approve' }), null);
    const approved = await db.reviewCallEGoalRunRequest({ goal_run_request_id: requestId, business_id: 'business-a', reviewed_by: '54321', decision: 'approve' });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.reviewed_by, '54321');
    const review = await db.getCallEGoalRunReview(requestId, 'business-a');
    assert.deepEqual({ reviewed_by: review.reviewed_by, decision: review.decision, request_hash: review.request_hash }, {
      reviewed_by: '54321', decision: 'approve', request_hash: 'a'.repeat(64),
    });
    assert.equal(await db.reviewCallEGoalRunRequest({ goal_run_request_id: requestId, business_id: 'business-a', reviewed_by: '67890', decision: 'reject' }), null);
  });

  it('persists accepted provider identity and encrypted results without exposing secrets in summaries', async () => {
    await db.createCallEGoalRunRequest(row());
    const beforeReview = await db.markCallEGoalRunSubmitting(requestId, 'business-a');
    assert.equal(beforeReview.status, 'pending_approval');
    const approved = await db.reviewCallEGoalRunRequest({ goal_run_request_id: requestId, business_id: 'business-a', reviewed_by: '54321', decision: 'approve' });
    assert.equal(approved.status, 'approved');
    const submitting = await db.markCallEGoalRunSubmitting(requestId, 'business-a');
    assert.equal(submitting.status, 'submitting');
    const saved = await db.saveCallEGoalRunProviderState({
      goal_run_request_id: requestId, business_id: 'business-a', status: 'completed', provider_goal_run_id: 'run:opaque-id',
      execution_status: 'completed', call_outcome: 'no_answer', result_status: 'available', encrypted_result: 'encrypted-result',
    });
    assert.equal(saved.status, 'completed');
    assert.equal(saved.provider_goal_run_id, 'run:opaque-id');
    assert.equal(saved.encrypted_result, 'encrypted-result');
    assert.equal(JSON.stringify(await db.listCallEGoalRunRequests('business-a')).includes('encrypted-result'), true);
    assert.equal(await db.getCallEGoalRunRequest(requestId, 'other-business'), null);
  });

  it('purges expired encrypted Goal Run content while preserving review and scoped audit history', async () => {
    const expired = '2000-01-01T00:00:00.000Z';
    await db.createCallEGoalRunRequest(row({ sensitive_data_expires_at: expired }));
    await db.reviewCallEGoalRunRequest({ goal_run_request_id: requestId, business_id: 'business-a', reviewed_by: '54321', decision: 'approve' });
    const preview = await db.getCallESensitiveRetentionPreview('business-a', new Date().toISOString());
    assert.equal(preview.expired_goal_runs, 1);
    assert.equal(preview.expired_missions, 0);
    const purged = await db.purgeCallESensitiveData({ business_id: 'business-a', actor_id: '54321', cutoff: new Date().toISOString() });
    assert.equal(purged.expired_goal_runs, 1);
    const saved = await db.getCallEGoalRunRequest(requestId, 'business-a');
    assert.equal(saved.encrypted_payload, '');
    assert.equal(saved.result_schema_json, '');
    assert.equal(saved.sensitive_data_purged_at != null, true);
    assert.equal(saved.status, 'needs_review');
    assert.equal((await db.getCallEGoalRunReview(requestId, 'business-a')).decision, 'approve');
    const audit = await db.listCallEOperationsAudit('business-a');
    assert.equal(audit[0].action, 'sensitive_data_purged');
    assert.equal(audit[0].metadata.expired_goal_runs, 1);
    assert.equal(await db.getCallESensitiveRetentionPreview('other-business').then((result) => result.expired_goal_runs), 0);
  });
});
