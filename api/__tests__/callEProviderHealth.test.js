'use strict';

const assert = require('node:assert/strict');
const { CallEProviderHealth } = require('../services/callEProviderHealth');

describe('CALL-E provider circuit', () => {
  it('opens after bounded transient create failures and permits a half-open probe after cooldown', () => {
    let now = 1000;
    const health = new CallEProviderHealth({ threshold: 2, windowMs: 1000, cooldownMs: 500, now: () => now });
    health.observe({ operation: 'call.create', outcome: 'error', statusCode: 503 });
    health.observe({ operation: 'call.read', outcome: 'error', statusCode: 503 });
    assert.equal(health.snapshot().circuitState, 'closed');
    health.observe({ operation: 'call.create', outcome: 'error', errorCode: 'call_e_network_error' });
    assert.equal(health.canDispatch(), false);
    assert.equal(health.snapshot().circuitState, 'open');
    now += 1001;
    assert.equal(health.canDispatch(), true);
    assert.equal(health.snapshot().circuitState, 'half_open');
    assert.equal(health.canDispatch(), false);
    health.observe({ operation: 'call.create', outcome: 'success', statusCode: 202 });
    assert.equal(health.snapshot().circuitState, 'closed');
    assert.equal(health.snapshot().dispatchAllowed, true);
  });

  it('does not open the circuit for non-transient authorization failures', () => {
    const health = new CallEProviderHealth({ threshold: 1 });
    health.observe({ operation: 'call.create', outcome: 'error', statusCode: 403, errorCode: 'call_e_forbidden' });
    assert.equal(health.snapshot().circuitState, 'closed');
  });
});
