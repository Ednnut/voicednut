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
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

describe('CALL-E mission additive schema migration', () => {
  it('recreates new policy, activity, routing, and subscription tables on a legacy database without changing existing mission rows', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-call-e-ops-migration-${Date.now()}-${Math.random()}.sqlite`);
    const first = new Database();
    first.dbPath = dbPath;
    try {
      await first.initialize();
      await run(first.db,
        `INSERT INTO call_e_campaign_reviews (campaign_id, business_id, template_id, template_version, schema_fingerprint, request_hash, created_by, status, recipient_count, ready_count, blocked_count)
         VALUES (?, 'biz-migration', 7, 1, ?, ?, '111', 'approved', 1, 1, 0)`,
        [`campaign_${'a'.repeat(64)}`, 'b'.repeat(64), 'c'.repeat(64)]);
      await run(first.db,
        `INSERT INTO call_e_campaign_missions (mission_id, business_id, campaign_id, template_id, template_version, result_schema_json, created_by, request_hash, status, recipient_count, encryption_key_version)
         VALUES (?, 'biz-migration', ?, 7, 1, '{}', '111', ?, 'pending_approval', 1, 1)`,
        [`mission_${'d'.repeat(64)}`, `campaign_${'a'.repeat(64)}`, 'e'.repeat(64)]);
      await new Promise((resolve) => first.db.close(resolve));
      first.db = null;

      const legacy = new sqlite3.Database(dbPath);
      await new Promise((resolve, reject) => legacy.exec(
        `DROP TABLE call_e_mission_alert_subscriptions;
         DROP TABLE call_e_mission_report_digest_subscriptions;
         DROP TABLE call_e_mission_escalations;
         DROP TABLE call_e_contact_dispatch_history;
         DROP TABLE call_e_mission_budget_reservations;
         DROP TABLE call_e_mission_review_actions;
         DROP TABLE call_e_mission_escalation_actions;
         DROP TABLE call_e_mission_cdr_imports;
         CREATE TABLE call_e_mission_escalation_actions (
           action_id INTEGER PRIMARY KEY AUTOINCREMENT, business_id TEXT NOT NULL, mission_id TEXT NOT NULL,
           action TEXT NOT NULL, actor_id TEXT NOT NULL, assigned_to TEXT, deadline_at TEXT,
           idempotency_key TEXT NOT NULL UNIQUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
         );
         DROP TABLE call_e_mission_usage_records;
         DROP TABLE call_e_result_workflow_action_approvals;
         DROP TABLE call_e_business_provider_routing;
         DROP TABLE call_e_mission_activity;
         DROP TABLE call_e_mission_secondary_approvals;
         ALTER TABLE call_e_campaign_missions DROP COLUMN scheduled_at;
         ALTER TABLE call_e_campaign_missions DROP COLUMN budget_limit_minor;
         ALTER TABLE call_e_campaign_missions DROP COLUMN per_call_cost_ceiling_minor;
         ALTER TABLE call_e_campaign_missions DROP COLUMN budget_currency;
         ALTER TABLE call_e_business_safety_policies DROP COLUMN contact_cooldown_hours;
         ALTER TABLE call_e_business_mission_policies DROP COLUMN review_sla_minutes;
         DROP TABLE call_e_business_mission_policies;`,
        (error) => error ? reject(error) : resolve(),
      ));
      await new Promise((resolve) => legacy.close(resolve));

      const upgraded = new Database();
      upgraded.dbPath = dbPath;
      try {
        await upgraded.initialize();
        const tables = await all(upgraded.db, "SELECT name FROM sqlite_master WHERE type = 'table'");
        const names = new Set(tables.map((row) => row.name));
        for (const name of [
          'call_e_business_mission_policies', 'call_e_mission_secondary_approvals', 'call_e_mission_activity',
          'call_e_business_provider_routing', 'call_e_mission_alert_subscriptions', 'call_e_mission_escalations',
          'call_e_mission_budget_reservations', 'call_e_contact_dispatch_history', 'call_e_mission_report_digest_subscriptions',
          'call_e_mission_review_actions', 'call_e_mission_usage_records', 'call_e_result_workflow_action_approvals',
          'call_e_mission_escalation_actions', 'call_e_mission_cdr_imports',
        ]) assert.equal(names.has(name), true, `missing additive table ${name}`);
        const escalationColumns = new Set((await all(upgraded.db, 'PRAGMA table_info(call_e_mission_escalations)')).map((row) => row.name));
        assert.equal(escalationColumns.has('deadline_at'), true);
        assert.equal(escalationColumns.has('next_escalation_at'), true);
        const escalationActionColumns = new Set((await all(upgraded.db, 'PRAGMA table_info(call_e_mission_escalation_actions)')).map((row) => row.name));
        assert.equal(escalationActionColumns.has('request_hash'), true);
        const policyColumns = new Set((await all(upgraded.db, 'PRAGMA table_info(call_e_business_mission_policies)')).map((row) => row.name));
        assert.equal(policyColumns.has('review_repeat_minutes'), true);
        const missionColumns = new Set((await all(upgraded.db, 'PRAGMA table_info(call_e_campaign_missions)')).map((row) => row.name));
        assert.equal(missionColumns.has('scheduled_at'), true);
        assert.equal(missionColumns.has('budget_limit_minor'), true);
        assert.equal(missionColumns.has('budget_currency'), true);
        const safetyColumns = new Set((await all(upgraded.db, 'PRAGMA table_info(call_e_business_safety_policies)')).map((row) => row.name));
        assert.equal(safetyColumns.has('contact_cooldown_hours'), true);
        const missions = await all(upgraded.db, 'SELECT mission_id, status FROM call_e_campaign_missions WHERE business_id = ?', ['biz-migration']);
        assert.deepEqual(missions, [{ mission_id: `mission_${'d'.repeat(64)}`, status: 'pending_approval' }]);
        await upgraded.initialize();
        const again = await all(upgraded.db, 'SELECT mission_id FROM call_e_campaign_missions WHERE business_id = ?', ['biz-migration']);
        assert.equal(again.length, 1);
      } finally {
        if (upgraded.db) await new Promise((resolve) => upgraded.db.close(resolve));
      }
    } finally {
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  });
});
