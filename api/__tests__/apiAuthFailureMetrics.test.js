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
    const result = metrics.get(2);
    assert.equal(result.total, 3);
    assert.equal(result.by_reason.missing_headers, 1);
    assert.equal(result.by_reason.invalid_signature, 1);
    assert.equal(result.by_reason.other, 1);
    assert.deepEqual(Object.keys(result.by_reason).sort(), [...AUTH_FAILURE_REASONS].sort());
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
});
