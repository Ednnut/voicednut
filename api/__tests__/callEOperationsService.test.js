const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');
const { CallEReconciliationService } = require('../services/callEReconciliationService');

describe('CALL-E business-scoped operations history', () => {
  let db;
  let dbPath;
  const schema = { type: 'object', additionalProperties: false, required: [], properties: {} };
  const calls = [
    { id: 'call_e_123e4567-e89b-12d3-a456-426614174101', providerId: 'call_ops_alpha', business: 'business_ops_a', status: 'completed', outcome: 'completed', result: 'available' },
    { id: 'call_e_123e4567-e89b-12d3-a456-426614174102', providerId: 'call_ops_beta', business: 'business_ops_a', status: 'failed', outcome: null, result: 'unavailable' },
    { id: 'call_e_123e4567-e89b-12d3-a456-426614174103', providerId: 'call_ops_other', business: 'business_ops_b', status: 'queued', outcome: null, result: 'pending' },
  ];

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-calle-ops-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    await db.grantCallEBusinessOperator({ business_id: 'business_ops_a', telegram_id: '12345', role: 'call_operator' });
    await db.grantCallEBusinessOperator({ business_id: 'business_ops_b', telegram_id: '67890', role: 'policy_manager' });
    for (const call of calls) {
      await db.upsertCallEReconciliationRecord({
        local_call_id: call.id,
        provider_call_id: call.providerId,
        business_id: call.business,
        template_id: 21,
        template_version: 3,
        request_hash: 'a'.repeat(64),
        result_schema: schema,
        execution_status: call.status,
        call_outcome: call.outcome,
        result_status: call.result,
      });
    }
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
  });

  it('lists only current operator businesses and returns normalized, non-private summaries', async () => {
    const result = await new CallEReconciliationService({ db }).listCallsForOperator('12345', { limit: 20, offset: 0 });
    assert.equal(result.provider, 'call_e');
    assert.equal(result.total, 2);
    assert.deepEqual(result.summary, { active: 0, failed: 1, resultsReady: 1 });
    assert.deepEqual(new Set(result.rows.map((row) => row.localCallId)), new Set(calls.slice(0, 2).map((call) => call.id)));
    assert.equal('businessId' in result.rows[0], false);
    assert.equal('providerCallId' in result.rows[0], false);
    assert.equal('result' in result.rows[0], false);
    assert.equal('transcript' in result.rows[0], false);
    assert.equal(JSON.stringify(result).includes('business_ops_b'), false);
  });

  it('applies validated status, outcome, result, identifier, date, and pagination filters', async () => {
    const byStatus = await new CallEReconciliationService({ db }).listCallsForOperator('12345', {
      limit: 10,
      offset: 0,
      execution_status: 'failed',
      result_status: 'unavailable',
      query: 'beta',
    });
    assert.equal(byStatus.total, 1);
    assert.equal(byStatus.rows[0].localCallId, calls[1].id);
    assert.equal(byStatus.rows[0].executionStatus, 'failed');

    const byDate = await new CallEReconciliationService({ db }).listCallsForOperator('12345', {
      limit: 1,
      offset: 1,
      start_date: new Date().toISOString().slice(0, 10),
      end_date: new Date().toISOString().slice(0, 10),
    });
    assert.equal(byDate.rows.length, 1);
    assert.equal(byDate.offset, 1);
    await assert.rejects(
      new CallEReconciliationService({ db }).listCallsForOperator('12345', { limit: 10, execution_status: 'ringing' }),
      /filters are invalid/,
    );
  });

  it('denies users without an active business operator grant and honors revocation', async () => {
    const service = new CallEReconciliationService({ db });
    await assert.rejects(service.listCallsForOperator('99999', { limit: 20, offset: 0 }), (error) => error.status === 403);
    await db.revokeCallEBusinessOperator({ business_id: 'business_ops_a', telegram_id: '12345' });
    await assert.rejects(service.listCallsForOperator('12345', { limit: 20, offset: 0 }), (error) => error.status === 403);
  });
});
