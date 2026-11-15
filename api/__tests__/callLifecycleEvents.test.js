'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const Database = require('../db/db');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}

describe('provider-neutral call lifecycle events', function () {
  this.timeout(120000);

  it('records an owner-scoped append-only timeline and preserves terminal status', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-call-lifecycle-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      await db.createCall({
        call_sid: 'local-call-1',
        phone_number: '+15555550123',
        user_chat_id: '7001',
        business_id: 'business-1',
        direction: 'outbound',
        status: 'submission_pending',
        outbound_idempotency_key: 'request-1',
        ai_voice_engine: 'cartesia',
      });
      await db.updateCallState('local-call-1', 'outbound_submission_pending', { source: 'dispatch' });
      await db.updateCallState('local-call-1', 'provider_submission_accepted', {
        provider: 'twilio',
        provider_call_id: 'provider-call-1',
        status: 'queued',
      });
      await db.updateCallState('local-call-1', 'provider_submission_accepted', {
        provider: 'twilio',
        provider_call_id: 'provider-call-1',
        status: 'queued',
      });
      await db.updateCallStatus('local-call-1', 'completed');
      await db.updateCallStatus('local-call-1', 'ringing');
      await db.updateCallState('local-call-1', 'provider_call_reconciled', {
        provider: 'twilio',
        status: 'completed',
        source: 'provider_reconciliation',
      });
      await db.updateCallState('local-call-1', 'provider_call_reconciled', {
        provider: 'twilio',
        status: 'completed',
        source: 'provider_reconciliation',
      });
      await db.createCall({
        call_sid: 'ownerless-call-1',
        phone_number: '+15555550124',
        direction: 'outbound',
      });

      const events = await db.listCallLifecycleEvents('local-call-1', '7001', { limit: 20 });
      assert.deepEqual(events.map((event) => event.event_type), [
        'call_created',
        'submission_pending',
        'submission_accepted',
        'status_changed',
        'reconciled',
      ]);
      assert.equal(events.at(-1).status, 'completed');
      assert.equal(events.at(-1).provider, 'twilio');
      assert.equal(events.filter((event) => event.event_type === 'submission_accepted').length, 1);
      assert.equal(events.filter((event) => event.event_type === 'reconciled').length, 1);
      assert.deepEqual(await db.listCallLifecycleEvents('local-call-1', '7002'), []);
      assert.deepEqual(await db.listCallLifecycleEvents('ownerless-call-1', '7001'), []);
      assert.equal((await db.getCall('local-call-1')).status, 'completed');
      await assert.rejects(run(db.db, "UPDATE call_lifecycle_events SET source = 'changed' WHERE call_sid = 'local-call-1'"), /append-only/);
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
      }
    }
  });

  it('upgrades a legacy calls table and backfills only records with an owner', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-call-lifecycle-legacy-${Date.now()}-${Math.random()}.sqlite`);
    const legacy = new sqlite3.Database(dbPath);
    await run(legacy, `CREATE TABLE calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT, call_sid TEXT UNIQUE NOT NULL, phone_number TEXT,
      prompt TEXT, first_message TEXT, user_chat_id TEXT, status TEXT, business_context TEXT,
      generated_functions TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, started_at DATETIME,
      ended_at DATETIME, duration INTEGER, call_summary TEXT, ai_analysis TEXT, twilio_status TEXT,
      answered_by TEXT, error_code TEXT, error_message TEXT, ring_duration INTEGER, answer_delay INTEGER,
      direction TEXT, business_id TEXT
    )`);
    await run(legacy, `CREATE TABLE call_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT, call_sid TEXT NOT NULL, state TEXT NOT NULL,
      data TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, sequence_number INTEGER
    )`);
    await run(legacy, `INSERT INTO calls (call_sid, user_chat_id, business_id, status)
      VALUES ('legacy-owned', '7003', 'business-legacy', 'completed')`);
    await run(legacy, `INSERT INTO calls (call_sid, user_chat_id, status)
      VALUES ('legacy-ownerless', '', 'completed')`);
    await run(legacy, `INSERT INTO call_states (call_sid, state, data, sequence_number)
      VALUES ('legacy-owned', 'provider_submission_accepted', '{"provider":"vapi","provider_call_id":"legacy-provider-1","status":"queued"}', 1)`);
    await new Promise((resolve) => legacy.close(resolve));

    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      const events = await db.listCallLifecycleEvents('legacy-owned', '7003', { limit: 20 });
      assert.ok(events.some((event) => event.status === 'completed'));
      assert.ok(events.some((event) => event.event_type === 'submission_accepted' && event.provider === 'vapi'));
      assert.deepEqual(await db.listCallLifecycleEvents('legacy-ownerless', '7003'), []);
      await db.backfillCallLifecycleEvents(500);
      const eventCount = await new Promise((resolve, reject) => db.db.get(
        "SELECT COUNT(*) AS count FROM call_lifecycle_events WHERE call_sid = 'legacy-owned'",
        (error, row) => error ? reject(error) : resolve(Number(row?.count) || 0),
      ));
      assert.equal(eventCount, events.length);
      const columns = await new Promise((resolve, reject) => db.db.all('PRAGMA table_info(calls)', (error, rows) => error ? reject(error) : resolve(rows || [])));
      assert.ok(columns.some((column) => column.name === 'provider_call_id'));
      assert.ok(columns.some((column) => column.name === 'outbound_idempotency_key'));
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
      }
    }
  });
});
