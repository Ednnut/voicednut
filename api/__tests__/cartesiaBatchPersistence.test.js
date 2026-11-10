const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

function snapshot(overrides = {}) {
  return {
    provider_batch_id: 'batch_persist_01',
    business_id: 'business_persist_01',
    name: 'Persistence rehearsal',
    agent_id: 'agent_persist_01',
    from_number_id: 'number_persist_01',
    region: 'US',
    target_concurrency_limit: 2,
    status: 'in_progress',
    total_calls_scheduled: 2,
    total_calls_dispatched: 1,
    total_calls_finished: 0,
    retry_count: 0,
    provider_created_at: '2026-11-09T12:00:00.000Z',
    provider_updated_at: '2026-11-09T12:01:00.000Z',
    request_fingerprint: 'a'.repeat(64),
    expected_recipients: [{ to_number: '+15555550101' }, { to_number: '+15555550102' }],
    recipients: [{
      id: 'recipient_persist_01', to_number: '+15555550101', status: 'completed',
      created_at: '2026-11-09T12:00:01.000Z', agent_call_id: 'ac_persist_01',
      end_reason: 'agent_hangup', has_provider_error: true,
      error_message: 'This free-form provider error must never be stored',
    }],
    ...overrides,
  };
}

describe('Cartesia batch persistence', () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-cartesia-batch-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => {
      try { fs.unlinkSync(file); } catch (_) { /* temp database cleanup */ }
    });
  });

  it('creates durable batch and expected-recipient rows then enriches them from provider snapshots', async () => {
    await db.upsertCartesiaCallBatchSnapshot(snapshot({ recipients: [] }));
    let rows = await db.listCartesiaCallBatchRecipients('batch_persist_01', 'business_persist_01');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].local_state, 'awaiting_provider_snapshot');
    assert.equal(await db.getCartesiaCallBatch('batch_persist_01', 'other_business'), null);

    await db.upsertCartesiaCallBatchSnapshot(snapshot());
    rows = await db.listCartesiaCallBatchRecipients('batch_persist_01', 'business_persist_01');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].local_state, 'provider_snapshot');
    assert.equal(rows[0].provider_call_id, 'ac_persist_01');
    assert.equal(rows[0].has_provider_error, 1);
    assert.equal(rows[1].local_state, 'awaiting_provider_snapshot');
  });

  it('keeps the newest provider snapshot, stores retry attempts separately, and does not store provider error text', async () => {
    await db.upsertCartesiaCallBatchSnapshot(snapshot());
    await db.upsertCartesiaCallBatchSnapshot(snapshot({
      status: 'completed', total_calls_dispatched: 2, total_calls_finished: 2,
      provider_updated_at: '2026-11-09T12:02:00.000Z',
      recipients: [
        { id: 'recipient_persist_01', to_number: '+15555550101', status: 'completed', created_at: '2026-11-09T12:00:01.000Z', agent_call_id: 'ac_persist_01', end_reason: 'agent_hangup' },
        { id: 'recipient_retry_01', to_number: '+15555550101', status: 'completed', created_at: '2026-11-09T12:02:00.000Z', agent_call_id: 'ac_retry_01', end_reason: 'agent_hangup' },
      ],
    }));
    await db.upsertCartesiaCallBatchSnapshot(snapshot({
      status: 'pending', total_calls_dispatched: 0, total_calls_finished: 0,
      provider_updated_at: '2026-11-09T11:59:00.000Z',
      recipients: [{ id: 'recipient_persist_01', to_number: '+15555550101', status: 'queued', created_at: '2026-11-09T12:00:01.000Z' }],
    }));
    const batch = await db.getCartesiaCallBatch('batch_persist_01');
    const recipients = await db.listCartesiaCallBatchRecipients('batch_persist_01');
    assert.equal(batch.status, 'completed');
    assert.equal(batch.total_calls_dispatched, 2);
    assert.equal(recipients.length, 3);
    assert.equal(recipients.find((row) => row.provider_recipient_id === 'recipient_persist_01').provider_status, 'completed');
    const table = await new Promise((resolve, reject) => db.db.all('PRAGMA table_info(cartesia_call_batch_recipients)', [], (error, rows) => error ? reject(error) : resolve(rows)));
    assert.equal(table.some((column) => /error_message|dynamic_variables|transcript/i.test(column.name)), false);
  });

  it('rejects a provider recipient that was not part of the locally approved batch', async () => {
    await assert.rejects(db.upsertCartesiaCallBatchSnapshot(snapshot({
      recipients: [{ id: 'unexpected_recipient', to_number: '+15555550199', status: 'completed' }],
    })), /unknown recipient/);
  });

  it('deletes only recipient rows when the terminal batch snapshot and count still match', async () => {
    const oldSnapshot = snapshot({
      status: 'completed',
      total_calls_dispatched: 2,
      total_calls_finished: 2,
      provider_created_at: '2025-01-01T00:00:00.000Z',
      provider_updated_at: '2025-01-02T00:00:00.000Z',
      recipients: [],
    });
    await db.upsertCartesiaCallBatchSnapshot(oldSnapshot);
    const deleted = await db.deleteExpiredCartesiaBatchRecipients({
      provider_batch_id: 'batch_persist_01',
      business_id: 'business_persist_01',
      status: 'completed',
      provider_updated_at: '2025-01-02T00:00:00.000Z',
      expected_recipient_count: 2,
    });
    assert.equal(deleted.deletedCount, 2);
    assert.equal((await db.listCartesiaCallBatchRecipients('batch_persist_01')).length, 0);
    const retained = await db.getCartesiaCallBatch('batch_persist_01');
    assert.equal(retained.status, 'completed');
    assert.equal(retained.total_calls_finished, 2);
  });

  it('does not delete recipient rows when the preview snapshot or count is stale', async () => {
    await db.upsertCartesiaCallBatchSnapshot(snapshot({
      status: 'completed',
      total_calls_dispatched: 2,
      total_calls_finished: 2,
      provider_updated_at: '2025-01-02T00:00:00.000Z',
      recipients: [],
    }));
    await assert.rejects(db.deleteExpiredCartesiaBatchRecipients({
      provider_batch_id: 'batch_persist_01',
      business_id: 'business_persist_01',
      status: 'completed',
      provider_updated_at: '2025-01-01T00:00:00.000Z',
      expected_recipient_count: 2,
    }), { code: 'cartesia_batch_retention_stale' });
    assert.equal((await db.listCartesiaCallBatchRecipients('batch_persist_01')).length, 2);
  });

  it('selects only bounded expired terminal batches and exposes worker deletion audits', async () => {
    await db.upsertCartesiaCallBatchSnapshot(snapshot({
      status: 'completed',
      total_calls_dispatched: 2,
      total_calls_finished: 2,
      provider_updated_at: '2025-01-02T00:00:00.000Z',
    }));
    await db.upsertCartesiaCallBatchSnapshot(snapshot({
      provider_batch_id: 'batch_active_01',
      status: 'in_progress',
      provider_updated_at: '2025-01-01T00:00:00.000Z',
      recipients: [],
    }));
    const candidates = await db.listExpiredCartesiaBatchRetentionCandidates({
      cutoff: '2025-02-01T00:00:00.000Z',
      limit: 10,
    });
    assert.deepEqual(candidates.map((row) => row.provider_batch_id), ['batch_persist_01']);
    const audit = {
      provider_batch_id: 'batch_persist_01',
      request_fingerprint: 'b'.repeat(64),
      recipient_count: 2,
    };
    await db.recordCartesiaBatchRetentionWorkerAudit({ ...audit, outcome: 'requested' });
    await db.recordCartesiaBatchRetentionWorkerAudit({ ...audit, outcome: 'succeeded' });
    const events = await db.listCartesiaAuditEvents({ limit: 10 });
    assert.deepEqual(events.filter((event) => event.source === 'batch_retention_worker').map((event) => event.outcome), ['succeeded', 'requested']);
    await assert.rejects(db.listExpiredCartesiaBatchRetentionCandidates({ cutoff: '2025-02-01T00:00:00.000Z', limit: 11 }), /query is invalid/);
  });

  it('claims reconciliation work with a durable single-worker lease and only releases it for the matching token', async () => {
    await db.upsertCartesiaCallBatchSnapshot(snapshot({ status: 'in_progress', recipients: [] }));
    const first = await db.claimCartesiaBatchReconciliation({
      lease_token: 'worker_token_first_123456789',
      now: '2099-01-01T00:00:00.000Z',
      lease_until: '2099-01-01T00:01:00.000Z',
    });
    assert.equal(first.provider_batch_id, 'batch_persist_01');
    assert.equal(await db.claimCartesiaBatchReconciliation({
      lease_token: 'worker_token_second_123456789',
      now: '2099-01-01T00:00:30.000Z',
      lease_until: '2099-01-01T00:01:30.000Z',
    }), null);
    assert.deepEqual(await db.completeCartesiaBatchReconciliation('batch_persist_01', 'worker_token_wrong_123456789', false, '2099-01-01T00:02:00.000Z'), { updated: false });
    assert.deepEqual(await db.completeCartesiaBatchReconciliation('batch_persist_01', 'worker_token_first_123456789', false, '2099-01-01T00:02:00.000Z'), { updated: true });
    const tooEarly = await db.claimCartesiaBatchReconciliation({
      lease_token: 'worker_token_early_123456789',
      now: '2099-01-01T00:01:30.000Z',
      lease_until: '2099-01-01T00:02:30.000Z',
    });
    assert.equal(tooEarly, null);
    const next = await db.claimCartesiaBatchReconciliation({
      lease_token: 'worker_token_next_123456789',
      now: '2099-01-01T00:02:00.000Z',
      lease_until: '2099-01-01T00:03:00.000Z',
    });
    assert.equal(next.provider_batch_id, 'batch_persist_01');
    assert.deepEqual(await db.renewCartesiaBatchReconciliationLease('batch_persist_01', 'worker_token_wrong_123456789', '2099-01-01T00:04:00.000Z'), { updated: false });
    assert.deepEqual(await db.renewCartesiaBatchReconciliationLease('batch_persist_01', 'worker_token_next_123456789', '2099-01-01T00:04:00.000Z'), { updated: true });
    await new Promise((resolve) => db.db.close(resolve));
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    assert.equal(await db.claimCartesiaBatchReconciliation({
      lease_token: 'worker_token_expired_123456789',
      now: '2099-01-01T00:03:30.000Z',
      lease_until: '2099-01-01T00:04:30.000Z',
    }), null);
    const afterRestart = await db.claimCartesiaBatchReconciliation({
      lease_token: 'worker_token_restart_123456789',
      now: '2099-01-01T00:04:00.000Z',
      lease_until: '2099-01-01T00:05:00.000Z',
    });
    assert.equal(afterRestart.provider_batch_id, 'batch_persist_01');
  });

  it('re-adds reconciliation columns to an earlier batch table without losing batch records', async () => {
    await db.upsertCartesiaCallBatchSnapshot(snapshot({ recipients: [] }));
    await new Promise((resolve, reject) => {
      db.db.serialize(() => {
        db.db.run('DROP INDEX idx_cartesia_batches_reconciliation_due', (error) => error ? reject(error) : undefined);
        for (const column of ['reconcile_last_error_code', 'reconcile_lease_token', 'reconcile_lease_until', 'reconcile_next_at', 'reconcile_attempt_count']) {
          db.db.run(`ALTER TABLE cartesia_call_batches DROP COLUMN ${column}`, (error) => error ? reject(error) : undefined);
        }
        db.db.get('SELECT 1', (error) => error ? reject(error) : resolve());
      });
    });
    await new Promise((resolve) => db.db.close(resolve));
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    const rows = await new Promise((resolve, reject) => db.db.all('PRAGMA table_info(cartesia_call_batches)', (error, columns) => error ? reject(error) : resolve(columns)));
    assert.equal(rows.some((column) => column.name === 'reconcile_lease_token'), true);
    assert.equal((await db.getCartesiaCallBatch('batch_persist_01')).provider_batch_id, 'batch_persist_01');
  });

  it('adds batch tables when reopening a pre-batch schema and preserves existing Cartesia call data', async () => {
    await db.upsertCartesiaCallRecord({
      local_call_id: 'cartesia_call_before_batch_01',
      provider_call_id: 'ac_before_batch_01',
      agent_id: 'agent_before_batch_01',
      status: 'completed',
      event_timestamp: '2026-11-09T10:00:00.000Z',
    });
    await new Promise((resolve, reject) => {
      db.db.serialize(() => {
        db.db.run('DROP TABLE cartesia_call_batch_recipients', (error) => error ? reject(error) : undefined);
        db.db.run('DROP TABLE cartesia_call_batches', (error) => error ? reject(error) : resolve());
      });
    });
    await new Promise((resolve) => db.db.close(resolve));
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    const existingCall = await db.getCartesiaCallRecordByProviderId('ac_before_batch_01');
    assert.equal(existingCall.provider_call_id, 'ac_before_batch_01');
    await db.upsertCartesiaCallBatchSnapshot(snapshot({ recipients: [] }));
    assert.equal((await db.getCartesiaCallBatch('batch_persist_01')).status, 'in_progress');
  });
});
