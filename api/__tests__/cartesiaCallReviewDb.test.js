'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

describe('Cartesia call review rule persistence', () => {
  it('uses safe defaults and persists validated account rules without transcript data', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-cartesia-review-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      assert.deepEqual(await db.getCartesiaCallReviewRules('biz-1'), {
        review_failed_calls: true, review_tool_calls: false, review_missing_summary: false, updated_at: null,
      });
      const saved = await db.saveCartesiaCallReviewRules({
        business_id: 'biz-1', review_failed_calls: false, review_tool_calls: true, review_missing_summary: true, updated_by: '7001',
      });
      assert.deepEqual({
        review_failed_calls: saved.review_failed_calls,
        review_tool_calls: saved.review_tool_calls,
        review_missing_summary: saved.review_missing_summary,
      }, { review_failed_calls: false, review_tool_calls: true, review_missing_summary: true });
      assert.ok(saved.updated_at);
      assert.equal((await db.getCartesiaCallReviewRules('biz-2')).review_failed_calls, true);
      await assert.rejects(db.saveCartesiaCallReviewRules({
        business_id: 'biz-1', review_failed_calls: 'false', review_tool_calls: true, review_missing_summary: true, updated_by: '7001',
      }), { code: 'cartesia_review_rules_invalid' });
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(file); } catch { /* already removed */ } }
    }
  });
});
