'use strict';

const assert = require('node:assert/strict');
const { CallECampaignRetentionWorker } = require('../services/callECampaignRetentionWorker');

describe('CALL-E retention worker', () => {
  it('stays disabled by default and does not query or purge data', async () => {
    let queries = 0;
    const worker = new CallECampaignRetentionWorker({ db: { async listCallESensitiveRetentionScopes() { queries += 1; return ['biz-a']; }, async purgeCallESensitiveData() { queries += 1; } } });
    assert.equal(await worker.start(), false);
    assert.deepEqual(await worker.drain(), { state: 'disabled', businesses_processed: 0, records_purged: 0 });
    assert.equal(queries, 0);
  });

  it('purges only returned expired business scopes using a system actor and bounded batches', async () => {
    const purges = [];
    const worker = new CallECampaignRetentionWorker({ enabled: true, batchSize: 2, db: {
      async listCallESensitiveRetentionScopes(_cutoff, limit) { assert.equal(limit, 2); return ['biz-a', 'biz-b']; },
      async purgeCallESensitiveData(input) { purges.push(input); return { expired_goal_runs: 1, expired_missions: 2 }; },
    } });
    const result = await worker.drain();
    assert.deepEqual(result, { state: 'completed', businesses_processed: 2, records_purged: 6 });
    assert.equal(purges.length, 2);
    assert.ok(purges.every((input) => input.actor_id === '0' && Number.isFinite(Date.parse(input.cutoff))));
  });
});
