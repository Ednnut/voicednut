'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const Database = require('../db/db');
const { SCENARIOS } = require('../services/callAgentSimulationService');

function run(db, sql, params = []) { return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve())); }

describe('offline call agent simulation persistence', () => {
  it('persists bounded score summaries, replays idempotently, and adds the table on legacy startup', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-agent-sim-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database(); db.dbPath = dbPath;
    try {
      await db.initialize();
      const templateId = await db.createCallTemplate({ name: 'Synthetic agent', description: 'Test fixture', prompt: 'Use safe tools.', first_message: 'Hello, this is a synthetic test.' });
      const input = {
        run_id: `simrun_${'123e4567-e89b-42d3-a456-426614174000'}`, template_id: templateId, template_version: 1,
        created_by: 'admin', idempotency_key: 'agent-sim-db-0001', request_hash: 'a'.repeat(64),
        config_fingerprint: 'b'.repeat(64), scenario_ids: SCENARIOS.map((scenario) => scenario.id),
        results: { scenarios: SCENARIOS.map((scenario) => ({ id: scenario.id, status: 'passed', code: 'synthetic_test_passed' })), score: 100 },
        score: 100, passed_count: 1, failed_count: 0, created_at: new Date().toISOString(),
      };
      const first = await db.recordCallAgentSimulationRun(input);
      assert.equal(first.idempotent_replay, false);
      const replay = await db.recordCallAgentSimulationRun({ ...input, run_id: `simrun_${'223e4567-e89b-42d3-a456-426614174000'}` });
      assert.equal(replay.idempotent_replay, true);
      assert.equal(replay.run_id, input.run_id);
      const conflict = await db.recordCallAgentSimulationRun({ ...input, request_hash: 'c'.repeat(64), run_id: `simrun_${'323e4567-e89b-42d3-a456-426614174000'}` });
      assert.equal(conflict.conflict, true);
      assert.equal((await db.listCallAgentSimulationRuns(templateId)).length, 1);
      const versionTwo = await db.recordCallAgentSimulationRun({
        ...input, run_id: `simrun_${'423e4567-e89b-42d3-a456-426614174000'}`,
        template_version: 2, idempotency_key: 'agent-sim-db-v2-0001', request_hash: 'd'.repeat(64),
        config_fingerprint: 'e'.repeat(64), created_at: new Date(Date.now() + 1000).toISOString(),
      });
      assert.equal(versionTwo.template_version, 2);
      assert.equal((await db.getLatestCallAgentSimulationRun(templateId, 1)).template_version, 1);
      assert.equal((await db.getLatestCallAgentSimulationRun(templateId, 2)).template_version, 2);
      await db.initialize();
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
    }

    const legacyDb = new sqlite3.Database(dbPath);
    await run(legacyDb, 'DROP TABLE IF EXISTS call_agent_simulation_runs');
    await run(legacyDb, 'DROP TABLE IF EXISTS call_template_promotion_events');
    await new Promise((resolve) => legacyDb.close(resolve));
    const upgraded = new Database(); upgraded.dbPath = dbPath;
    try {
      await upgraded.initialize();
      const rows = await new Promise((resolve, reject) => upgraded.db.all('PRAGMA table_info(call_agent_simulation_runs)', (error, result) => error ? reject(error) : resolve(result || [])));
      assert.ok(rows.some((row) => row.name === 'config_fingerprint'));
      const promotionAuditRows = await new Promise((resolve, reject) => upgraded.db.all('PRAGMA table_info(call_template_promotion_events)', (error, result) => error ? reject(error) : resolve(result || [])));
      assert.ok(promotionAuditRows.some((row) => row.name === 'simulation_run_id'));
    } finally {
      if (upgraded.db) await new Promise((resolve) => upgraded.db.close(resolve));
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  });

  it('uses a version precondition so content changed after evaluation cannot be promoted', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-agent-promotion-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database(); db.dbPath = dbPath;
    try {
      await db.initialize();
      const templateId = await db.createCallTemplate({ name: 'Promotion fixture', prompt: 'A safe synthetic prompt.', first_message: 'Hello.' });
      const previousLiveId = await db.createCallTemplate({ name: 'Previously live fixture', prompt: 'Prior safe prompt.' });
      await db.setCallTemplateLifecycle(previousLiveId, { lifecycle_state: 'live' });
      await db.setCallTemplateLifecycle(templateId, { lifecycle_state: 'approved' });
      const template = await db.getCallTemplateById(templateId);
      const audit = {
        simulation_run_id: `simrun_${'123e4567-e89b-42d3-a456-426614174000'}`,
        simulation_score: 100,
        config_fingerprint: 'a'.repeat(64),
      };
      assert.equal(await db.promoteCallTemplateLive(templateId, 'admin', Number(template.version) + 1, audit), 0);
      assert.equal((await db.getCallTemplateById(templateId)).lifecycle_state, 'approved');
      assert.equal((await db.getCallTemplateById(previousLiveId)).lifecycle_state, 'live');
      await run(db.db, `CREATE TRIGGER fail_promotion_audit BEFORE INSERT ON call_template_promotion_events
        BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`);
      await assert.rejects(db.promoteCallTemplateLive(templateId, 'admin', Number(template.version), audit), /forced audit failure/);
      assert.equal((await db.getCallTemplateById(templateId)).lifecycle_state, 'approved');
      assert.equal((await db.getCallTemplateById(previousLiveId)).lifecycle_state, 'live');
      await run(db.db, 'DROP TRIGGER fail_promotion_audit');
      assert.equal(await db.promoteCallTemplateLive(templateId, 'telegram:12345', Number(template.version), audit), 1);
      assert.equal((await db.getCallTemplateById(templateId)).lifecycle_state, 'live');
      assert.equal((await db.getCallTemplateById(previousLiveId)).lifecycle_state, 'approved');
      const events = await db.listCallTemplatePromotionEvents(templateId);
      assert.equal(events.length, 1);
      assert.equal(events[0].template_version, Number(template.version));
      assert.equal(events[0].actor_label, 'telegram:12345');
      assert.equal(events[0].simulation_run_id, audit.simulation_run_id);
      assert.equal(events[0].simulation_score, 100);
      assert.equal(events[0].previous_live_template_id, previousLiveId);
      await assert.rejects(run(db.db, 'UPDATE call_template_promotion_events SET actor_label = ? WHERE event_id = ?', ['changed', events[0].event_id]));
      await assert.rejects(run(db.db, 'DELETE FROM call_template_promotion_events WHERE event_id = ?', [events[0].event_id]));
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  });
});
