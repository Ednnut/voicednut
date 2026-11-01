'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const Database = require('../db/db');

describe('Cartesia clone consent governance persistence', () => {
  it('records consent without audio content, links resources, revokes future use, and tracks clone deletion', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-governance-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database(); db.dbPath = dbPath;
    const consentId = 'a'.repeat(32);
    try {
      await new Promise((resolve, reject) => {
        const legacy = new sqlite3.Database(dbPath, (error) => {
          if (error) return reject(error);
          legacy.run(`CREATE TABLE cartesia_voice_governance (
            consent_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('instant_clone', 'pro_clone_dataset')),
            resource_id TEXT, resource_type TEXT, fine_tune_id TEXT, sample_count INTEGER NOT NULL DEFAULT 0,
            resource_name TEXT, status TEXT NOT NULL CHECK(status IN ('active', 'revoked', 'deleted', 'provider_failed')),
            consented_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            revoked_at DATETIME, deleted_at DATETIME
          )`, (createError) => legacy.close((closeError) => createError || closeError ? reject(createError || closeError) : resolve()));
        });
      });
      await db.initialize();
      const migratedColumns = await new Promise((resolve, reject) => {
        db.db.all('PRAGMA table_info(cartesia_voice_governance)', (error, rows) => {
          if (error) reject(error);
          else resolve(new Set(rows.map((row) => row.name)));
        });
      });
      assert.ok(migratedColumns.has('active_operations'));
      assert.ok(migratedColumns.has('operation_token'));
      assert.ok(migratedColumns.has('operation_started_at'));
      await db.recordCartesiaVoiceConsent({ consent_id: consentId, actor_id: '7001', operation: 'instant_clone', resource_name: 'Support Voice' });
      assert.equal(await db.linkCartesiaVoiceGovernanceResource({ consent_id: consentId, resource_id: 'voice_1', resource_type: 'voice' }), true);
      assert.equal(await db.finishCartesiaVoiceGovernanceCreation(consentId, consentId), true);
      const row = await db.getCartesiaVoiceGovernance(consentId);
      assert.equal(row.status, 'active');
      assert.equal(row.resource_id, 'voice_1');
      assert.equal(row.actor_id, '7001');
      assert.equal(Object.hasOwn(row, 'audio'), false);
      assert.equal(await db.revokeCartesiaVoiceConsent(consentId), true);
      assert.equal(await db.revokeCartesiaVoiceConsent(consentId), false);
      const deletionToken = 'voice-delete-token';
      assert.equal(await db.claimCartesiaVoiceGovernanceResourceCleanup(consentId, 'voice_1', 'voice', deletionToken), true);
      assert.equal(await db.markCartesiaVoiceResourceDeleted(consentId, deletionToken), true);
      assert.equal((await db.getCartesiaVoiceGovernance(consentId)).status, 'deleted');
      await assert.rejects(db.recordCartesiaVoiceConsent({ consent_id: 'bad', actor_id: '7001', operation: 'instant_clone', resource_name: 'Invalid' }), { code: 'cartesia_voice_governance_invalid' });
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  });

  it('requires active consent for Pro Clone uploads and attaches the fine-tune identifier', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-pro-governance-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database(); db.dbPath = dbPath;
    const consentId = 'b'.repeat(32);
    try {
      await db.initialize();
      await db.recordCartesiaVoiceConsent({ consent_id: consentId, actor_id: '7001', operation: 'pro_clone_dataset', resource_name: 'Support PVC' });
      await db.linkCartesiaVoiceGovernanceResource({ consent_id: consentId, resource_id: 'dataset_1', resource_type: 'dataset' });
      assert.equal(await db.finishCartesiaVoiceGovernanceCreation(consentId), true);
      const uploadToken = 'upload-token';
      assert.equal(await db.beginCartesiaVoiceGovernanceOperation(consentId, 'dataset_1', uploadToken), true);
      assert.equal(await db.revokeCartesiaVoiceConsent(consentId), false);
      await new Promise((resolve, reject) => db.db.run("UPDATE cartesia_voice_governance SET operation_started_at = datetime('now', '-20 minutes') WHERE consent_id = ?", [consentId], (error) => error ? reject(error) : resolve()));
      const recoveredToken = 'recovered-upload-token';
      assert.equal(await db.beginCartesiaVoiceGovernanceOperation(consentId, 'dataset_1', recoveredToken), true);
      assert.equal(await db.finishCartesiaVoiceGovernanceOperation(consentId, uploadToken, { sampleUploaded: true }), false);
      assert.equal(await db.finishCartesiaVoiceGovernanceOperation(consentId, recoveredToken, { sampleUploaded: true }), true);
      const tuneToken = 'tune-token';
      assert.equal(await db.beginCartesiaVoiceGovernanceOperation(consentId, 'dataset_1', tuneToken), true);
      assert.equal(await db.finishCartesiaVoiceGovernanceOperation(consentId, tuneToken, { fineTuneId: 'fine_tune_1' }), true);
      assert.equal(await db.revokeCartesiaVoiceConsent(consentId), true);
      assert.equal(await db.beginCartesiaVoiceGovernanceOperation(consentId, 'dataset_1', 'revoked-token'), false);
      const row = await db.getCartesiaVoiceGovernance(consentId);
      assert.equal(row.sample_count, 1);
      assert.equal(row.fine_tune_id, 'fine_tune_1');
      assert.equal(row.status, 'revoked');
      const cleanupToken = 'cleanup-token';
      assert.equal(await db.claimCartesiaVoiceGovernanceCleanup(consentId, 'dataset_1', cleanupToken), true);
      assert.equal(await db.clearCartesiaFineTuneLink(consentId, 'fine_tune_1'), true);
      assert.equal(await db.markCartesiaVoiceResourceDeleted(consentId, cleanupToken), true);
      assert.equal((await db.getCartesiaVoiceGovernance(consentId)).status, 'deleted');
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  });
});
