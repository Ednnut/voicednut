'use strict';

const assert = require('node:assert/strict');
const { buildConfiguredProviderOrder, summarizeCallRoutingPolicy } = require('../services/callRoutingPolicy');

describe('explicit call provider routing policy', () => {
  it('preserves preferred provider then applies the configured eligible fallback order', () => {
    assert.deepEqual(buildConfiguredProviderOrder('plivo', ['vonage', 'twilio', 'unknown', 'vonage'], ['twilio', 'plivo', 'vonage']),
      ['plivo', 'vonage', 'twilio']);
  });

  it('uses a tenant-owned preference list before global fallbacks while keeping the explicit request first', () => {
    assert.deepEqual(buildConfiguredProviderOrder('twilio', ['vonage', 'plivo', 'plivo'], ['twilio', 'plivo', 'vonage']),
      ['twilio', 'vonage', 'plivo']);
  });

  it('reports readiness and open-circuit exclusions without silently switching after unknown submission', () => {
    const report = summarizeCallRoutingPolicy({
      preferredProvider: 'twilio',
      configuredOrder: ['twilio', 'plivo', 'vonage'],
      supportedProviders: ['twilio', 'plivo', 'vonage'],
      readiness: { twilio: true, plivo: true, vonage: false },
      circuitState: { twilio: 'open', plivo: 'closed', vonage: 'closed' },
      failoverEnabled: true,
      isProviderDegraded: (provider) => provider === 'twilio',
    });
    assert.deepEqual(report.eligible_order, ['plivo']);
    assert.deepEqual(report.open_circuits, ['twilio']);
    assert.equal(report.selected_provider, 'plivo');
    assert.equal(report.uncertain_submission_failover, false);
    assert.equal(report.blocked_providers.some((item) => item.provider === 'vonage' && item.reason === 'not_ready'), true);
  });
});
