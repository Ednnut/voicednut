'use strict';

const assert = require('node:assert/strict');
const { ApiAuthFailureMetrics, AUTH_FAILURE_REASONS } = require('../services/apiAuthFailureMetrics');

describe('API HMAC auth failure metrics', () => {
  it('counts only bounded reason buckets and omits request identifiers', () => {
    let now = 120_000;
    const metrics = new ApiAuthFailureMetrics({ now: () => now });
    metrics.record('missing_headers');
    metrics.record('invalid_signature');
    metrics.record('private-path-or-ip');
    metrics.record('miniapp_missing_session');
    metrics.record('admin_token_missing');
    metrics.record('webhook_auth_rejected');
    const result = metrics.get(2);
    assert.equal(result.total, 3);
    assert.equal(result.by_reason.missing_headers, 1);
    assert.equal(result.by_reason.invalid_signature, 1);
    assert.equal(result.by_reason.other, 1);
    assert.deepEqual(Object.keys(result.by_reason).sort(), [...AUTH_FAILURE_REASONS].sort());
    assert.equal(result.miniapp_session.total, 1);
    assert.equal(result.miniapp_session.by_reason.miniapp_missing_session, 1);
    assert.equal(result.admin_token.total, 1);
    assert.equal(result.admin_token.by_reason.admin_token_missing, 1);
    assert.equal(result.webhook_auth.total, 1);
    assert.equal(JSON.stringify(result).includes('private-path-or-ip'), false);
    assert.equal(result.scope, 'api_process_memory');

    now += 60_000;
    assert.equal(metrics.get(1).total, 0);
    assert.equal(metrics.get(1440).total, 3);
  });

  it('bounds the in-memory bucket count to the retention window', () => {
    let now = 0;
    const metrics = new ApiAuthFailureMetrics({ now: () => now });
    for (let minute = 0; minute <= 1440; minute += 1) {
      now = minute * 60_000;
      metrics.record('invalid_signature');
    }
    assert.equal(metrics.buckets.size, 1440);
    assert.equal(metrics.get(1440).total, 1440);
  });

  it('flushes cumulative per-process buckets idempotently and retries failed persistence', async () => {
    let now = 120_000;
    const metrics = new ApiAuthFailureMetrics({ now: () => now, processInstanceId: 'process-one' });
    const writes = [];
    metrics.record('invalid_signature');
    metrics.record('invalid_signature');
    await metrics.flush(async (entries) => { writes.push(entries); });
    assert.deepEqual(writes[0], [{ bucket_minute: 2, process_instance_id: 'process-one', reason: 'invalid_signature', count: 2 }]);

    metrics.record('invalid_signature');
    await assert.rejects(() => metrics.flush(async () => { throw new Error('temporary database failure'); }));
    assert.equal(await metrics.flush(async (entries) => { writes.push(entries); }), true);
    assert.equal(writes[1][0].count, 3);
    assert.equal(metrics.get(1).total, 3);

    now += 60_000;
    assert.equal(metrics.get(1).total, 0);
    assert.equal(await metrics.flush(async (entries) => { writes.push(entries); }), false);
  });

  it('waits for an active flush and persists events recorded during it on the next pass', async () => {
    const metrics = new ApiAuthFailureMetrics({ now: () => 120_000, processInstanceId: 'process-one' });
    metrics.record('invalid_signature');
    let finishFirst;
    const writes = [];
    const first = metrics.flush(async (entries) => {
      writes.push(entries);
      await new Promise((resolve) => { finishFirst = resolve; });
    });
    metrics.record('invalid_signature');
    const second = metrics.flush(async (entries) => { writes.push(entries); });
    finishFirst();
    await Promise.all([first, second]);
    assert.equal(writes.length, 2);
    assert.equal(writes[0][0].count, 1);
    assert.equal(writes[1][0].count, 2);
  });
});
