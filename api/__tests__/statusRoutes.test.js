'use strict';

const assert = require('node:assert/strict');
const { __testables } = require('../services/statusRoutes');

describe('call status ownership', () => {
  it('returns informational platform anomaly signals using configured thresholds', async () => {
    let capturedWindow;
    let body;
    let responseStatus = 200;
    const authMetricSteps = [];
    const handler = __testables.createAnomalyObservabilityHandler({
      config: {
        apiAuth: { hmacSecret: 'configured' },
        anomalyDetection: {
          callVolumeMinCurrent: 10, callVolumeGrowthFactor: 2,
          providerOpenCount: 1, providerFailureCount: 2, dispatchRetryCount: 3, campaignDispatchCount: 10,
          webhookFailureCount: 2, workflowFailureCount: 2, workflowRetryCount: 4, authAlertCount: 1, apiAuthFailureCount: 2,
          miniAppAuthFailureCount: 2, adminAuthFailureCount: 2, webhookAuthFailureCount: 2,
        },
      },
      verifyHmacSignature: () => ({ ok: true }),
      hasAdminToken: () => false,
      flushApiAuthFailureMetrics: async () => { authMetricSteps.push('flush'); },
      getApiAuthFailureMetrics: async (window) => {
        authMetricSteps.push('read');
        return { window_minutes: window, total: 2, by_reason: { invalid_signature: 2 },
          miniapp_session: { total: 2, by_reason: { miniapp_missing_session: 2 } },
          admin_token: { total: 2, by_reason: { admin_token_missing: 1, admin_token_invalid: 1 } },
          webhook_auth: { total: 2, by_reason: { webhook_auth_rejected: 2 } },
          scope: 'shared_sqlite', retention_minutes: 1440 };
      },
      getDb: () => ({
        getPlatformAnomalyMetrics: async (window) => {
          capturedWindow = window;
          return {
            window_minutes: window,
            calls: { current_window: 12, previous_window: 2, failed: 1 },
            provider_open_count: 1, open_providers: [{ provider: 'twilio', circuit_state: 'open' }],
            provider_call_error_count: 2, provider_call_errors: [{ provider: 'plivo', count: 2 }],
            dispatch_retry_count: 3, campaign_dispatches_today: 10,
            webhook_failure_count: 2, workflow_failure_count: 2, workflow_retry_count: 4, authorization_alert_count: 1,
          };
        },
      }),
    });
    await handler({ query: { window_minutes: '30' } }, {
      status(value) { responseStatus = value; return this; },
      json(value) { body = value; return value; },
    });
    assert.equal(responseStatus, 200);
    assert.equal(capturedWindow, 30);
    assert.equal(body.informational_only, true);
    assert.deepEqual(body.alerts.map((alert) => alert.code), [
      'call_volume_surge', 'provider_circuit_open', 'provider_call_failures', 'api_authentication_failures', 'miniapp_authentication_failures', 'admin_token_authentication_failures', 'webhook_authentication_failures', 'call_dispatch_retries',
      'campaign_consumption_high', 'outgoing_webhook_failures', 'workflow_failures_high', 'workflow_retries_high',
      'authorization_failure_alerts',
    ]);
    assert.deepEqual(body.alerts.find((alert) => alert.code === 'provider_call_failures').providers,
      [{ provider: 'plivo', count: 2 }]);
    assert.equal(JSON.stringify(body).includes('provider_timeout'), false);
    assert.deepEqual(body.alerts.find((alert) => alert.code === 'api_authentication_failures').by_reason,
      { invalid_signature: 2 });
    assert.equal(body.summary.api_hmac_auth_failures.scope, 'shared_sqlite');
    assert.equal(body.summary.miniapp_session_auth_failures.total, 2);
    assert.equal(body.summary.admin_token_auth_failures.total, 2);
    assert.deepEqual(body.alerts.find((alert) => alert.code === 'admin_token_authentication_failures').by_reason,
      { admin_token_missing: 1, admin_token_invalid: 1 });
    assert.deepEqual(body.alerts.find((alert) => alert.code === 'webhook_authentication_failures').by_reason,
      { webhook_auth_rejected: 2 });
    assert.deepEqual(authMetricSteps, ['flush', 'read']);
    assert.equal(body.alerts.find((alert) => alert.code === 'workflow_retries_high').current, 4);
  });

  it('rejects anomaly summaries without HMAC or admin authorization', async () => {
    let status;
    let metricsRead = false;
    const handler = __testables.createAnomalyObservabilityHandler({
      config: { apiAuth: { hmacSecret: null } },
      hasAdminToken: () => false,
      getDb: () => ({ getPlatformAnomalyMetrics: async () => { metricsRead = true; return {}; } }),
    });
    await handler({ query: {} }, {
      status(value) { status = value; return this; },
      json(value) { return value; },
    });
    assert.equal(status, 401);
    assert.equal(metricsRead, false);
  });

  it('falls back to process-local HMAC counts when shared metrics storage is unavailable', async () => {
    let body;
    const handler = __testables.createAnomalyObservabilityHandler({
      config: { apiAuth: { hmacSecret: 'configured' } },
      hasAdminToken: () => false,
      flushApiAuthFailureMetrics: async () => { throw new Error('database unavailable'); },
      getApiAuthFailureMetrics: async () => { throw new Error('database unavailable'); },
      getLocalApiAuthFailureMetrics: () => ({ window_minutes: 60, total: 3, by_reason: { invalid_signature: 3 }, scope: 'api_process_memory' }),
      getDb: () => ({ getPlatformAnomalyMetrics: async () => ({}) }),
    });
    await handler({ query: {} }, {
      status() { return this; },
      json(value) { body = value; return value; },
    });
    assert.equal(body.summary.api_hmac_auth_failures.total, 3);
    assert.equal(body.summary.api_hmac_auth_failures.scope, 'api_process_memory');
  });

  it('denies a Telegram user access to another user call status', async () => {
    let responseStatus = 200;
    let responseBody;
    let stateLookupCalled = false;
    const handler = __testables.createGetCallStatusHandler({
      isSafeId: () => true,
      normalizeCallRecordForApi: (call) => call,
      buildDigitSummary: () => ({ summary: '', count: 0 }),
      webhookService: { getCallStatusStats: () => ({}) },
      getDb: () => ({
        getCall: async () => ({
          call_sid: 'CA123',
          user_chat_id: 'owner-1',
        }),
        getLatestCallState: async () => {
          stateLookupCalled = true;
          return null;
        },
      }),
    });

    await handler(
      { params: { callSid: 'CA123' }, headers: { 'x-telegram-chat-id': 'owner-2' } },
      {
        status(value) {
          responseStatus = value;
          return this;
        },
        json(value) {
          responseBody = value;
          return value;
        },
      },
    );

    assert.equal(responseStatus, 403);
    assert.equal(responseBody.error, 'Not authorized for this call');
    assert.equal(stateLookupCalled, false);
  });

  it('returns allowlisted execution context and step progress from recent states', async () => {
    const executionStates = [
      {
        state: 'provider_submission_accepted',
        data: { execution_context: {
          internal_execution_id: 'exec_123', request_id: 'request-123', internal_call_id: 'call_123',
          organization_id: 'org_1', business_id: 'business_1', actor_id: '7001', agent_id: 'agent_123',
          agent_version: 3, provider: 'VAPI', provider_call_id: 'provider_123',
          execution_type: 'outbound_call', status: 'accepted', current_stage: 'provider_accepted',
          idempotency_reference: `sha256:${'a'.repeat(64)}`, api_key: 'must-not-leak',
        } },
      },
      {
        state: 'execution_step',
        data: {
          execution_id: 'exec_123', correlation_id: 'request-123', call_id: 'call_123', step_name: 'provider_dispatch',
          status: 'completed', result: 'accepted', started_at: '2026-11-14T12:00:00.000Z',
          completed_at: '2026-11-14T12:00:01.000Z', retry_count: 0, related_entity: 'provider_123',
          provider_payload: { api_key: 'must-not-leak' },
        },
      },
    ];
    const handler = __testables.createGetCallStatusHandler({
      isSafeId: () => true,
      normalizeCallRecordForApi: (call) => call,
      buildDigitSummary: () => ({ summary: '', count: 0 }),
      webhookService: { getCallStatusStats: () => ({}), getLiveConsoleSnapshot: () => null },
      getDb: () => ({
        getCall: async () => ({ call_sid: 'call_123', user_chat_id: '7001', digit_summary: 'No digits' }),
        getLatestCallState: async () => null,
        getCallStates: async () => Array.from({ length: 16 }, (_, index) => ({ state: 'ringing', data: { index } })),
        getCallExecutionStates: async () => executionStates,
        db: { all: (_sql, _params, callback) => callback(null, []) },
      }),
    });
    let body;

    await handler({ params: { callSid: 'call_123' }, headers: {} }, {
      json(value) { body = value; return value; },
      status() { return this; },
    });

    assert.equal(body.execution_progress.context.request_id, 'request-123');
    assert.equal(body.execution_progress.context.business_id, 'business_1');
    assert.equal(body.execution_progress.context.organization_id, 'org_1');
    assert.equal(body.execution_progress.context.agent_id, 'agent_123');
    assert.equal(body.execution_progress.context.agent_version, 3);
    assert.equal(body.execution_progress.context.provider, 'vapi');
    assert.equal(body.execution_progress.steps.length, 1);
    assert.equal(body.execution_progress.steps[0].step_name, 'provider_dispatch');
    assert.equal(body.execution_progress.steps[0].result, 'accepted');
    assert.equal(Object.hasOwn(body.execution_progress.context, 'api_key'), false);
    assert.equal(Object.hasOwn(body.execution_progress.steps[0], 'provider_payload'), false);
  });
});
