'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

describe('Cartesia webhook event persistence', () => {
  it('stores only lifecycle metadata and ignores duplicate event request IDs', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-webhook-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      const input = {
        webhook_request_id: 'webhook_req_1', call_id: 'call_1', agent_id: 'agent_1', webhook_id: 'agent_webhook_1',
        event_type: 'call_completed', event_timestamp: '2026-11-01T12:00:00.000Z', payload_hash: 'a'.repeat(64),
      };
      assert.deepEqual(await db.recordCartesiaWebhookEvent(input), { inserted: true, duplicate: false });
      assert.deepEqual(await db.recordCartesiaWebhookEvent(input), { inserted: false, duplicate: true });
      assert.deepEqual(await db.recordCartesiaWebhookEvent({ ...input, payload_hash: 'b'.repeat(64) }), { inserted: false, duplicate: false, conflict: true });
      assert.deepEqual(await db.recordCartesiaWebhookEvent({ ...input, webhook_request_id: 'webhook_req_2', event_type: 'call_started', payload_hash: 'c'.repeat(64) }), { inserted: true, duplicate: false });
      const rows = await db.listCartesiaWebhookEvents({ limit: 10 });
      assert.equal(rows.length, 2);
      assert.ok(rows.some((row) => row.webhook_request_id === 'webhook_req_1'));
      assert.equal(Object.hasOwn(rows[0], 'payload_hash'), false);
      const summary = await db.summarizeCartesiaWebhookEvents();
      assert.equal(summary.count, 2);
      assert.deepEqual(summary.eventTypes, { call_completed: 1, call_started: 1 });
      assert.equal(summary.latestReceivedAt, rows[0].received_at);
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch { /* already removed */ } }
    }
  });

  it('stores Cartesia call webhook receipts in an independent idempotency ledger', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-receipt-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      const input = {
        webhook_request_id: 'webhook_req_2',
        provider_call_id: 'ac_call_1',
        event_type: 'call_completed',
        event_timestamp: '2026-11-01T12:00:00.000Z',
        payload_hash: 'c'.repeat(64),
      };
      assert.deepEqual(await db.recordCartesiaWebhookReceipt(input), {
        inserted: true,
        duplicate: false,
        conflict: false,
      });
      assert.deepEqual(await db.recordCartesiaWebhookReceipt(input), {
        inserted: false,
        duplicate: true,
        conflict: false,
      });
      assert.deepEqual(await db.recordCartesiaWebhookReceipt({
        ...input,
        payload_hash: 'd'.repeat(64),
      }), {
        inserted: false,
        duplicate: false,
        conflict: true,
      });
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch { /* already removed */ } }
    }
  });
});
