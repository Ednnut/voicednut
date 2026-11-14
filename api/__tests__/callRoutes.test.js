'use strict';

const assert = require('node:assert/strict');
const { __testables, registerCallRoutes } = require('../services/callRoutes');

describe('outbound call confirmation response', () => {
  it('returns the resolved telephony and AI voice providers without changing call submission', async () => {
    let responseBody;
    let submittedPayload;
    const handler = __testables.createOutboundCallHandler({
      config: { server: { hostname: 'calls.example.test' } },
      resolveHost: () => 'calls.example.test',
      placeOutboundCall: async (payload) => {
        submittedPayload = payload;
        return {
          callId: 'CA1234567890',
          callStatus: 'queued',
          provider: 'twilio',
          aiVoiceEngine: 'cartesia',
          idempotentReplay: false,
          warnings: [],
          functionSystem: { context: {}, functions: [] },
        };
      },
      getCurrentProvider: () => 'twilio',
      sendApiError: (_res, status, code, error) => {
        responseBody = { status, code, error };
        return responseBody;
      },
    });

    await handler({
      body: {
        number: '+15555550123',
        prompt: 'A test prompt',
        first_message: 'Hello',
      },
      headers: {},
      callEActorId: '7001',
    }, {
      json(body) {
        responseBody = body;
        return body;
      },
    });

    assert.equal(submittedPayload.number, '+15555550123');
    assert.equal(responseBody.success, true);
    assert.equal(responseBody.call_sid, 'CA1234567890');
    assert.equal(responseBody.status, 'queued');
    assert.equal(responseBody.provider, 'twilio');
    assert.equal(responseBody.ai_voice_engine, 'cartesia');
  });
});

describe('unified call history and operations', () => {
  it('protects call operations with the admin token and registers static routes before call IDs', () => {
    const adminOnly = () => {};
    const routes = [];
    const app = {
      get(path, ...handlers) { routes.push({ method: 'GET', path, handlers }); },
      post(path, ...handlers) { routes.push({ method: 'POST', path, handlers }); },
      patch(path, ...handlers) { routes.push({ method: 'PATCH', path, handlers }); },
    };
    registerCallRoutes(app, {
      requireOutboundAuthorization: () => {},
      requireAdminToken: adminOnly,
      getDb: () => null,
    });

    const operationsRoute = routes.find((route) => route.path === '/api/calls/operations');
    const activityRoute = routes.find((route) => route.path === '/api/calls/activity');
    const activityReconcileRoute = routes.find((route) => route.path === '/api/calls/activity/:callSid/reconcile');
    const searchIndex = routes.findIndex((route) => route.path === '/api/calls/search');
    const callDetailsIndex = routes.findIndex((route) => route.path === '/api/calls/:callSid');
    assert.equal(operationsRoute.handlers[0], adminOnly);
    assert.equal(activityRoute.handlers.length, 3);
    assert.ok(activityReconcileRoute);
    assert.equal(activityReconcileRoute.handlers.length, 3);
    assert.ok(searchIndex >= 0 && searchIndex < callDetailsIndex);
  });

  it('lists activity using only the verified actor and masks no provider payloads into the response', async () => {
    let options;
    let body;
    const handler = __testables.createCallActivityHandlers({ getDb: () => ({
      getRecentCalls: async (value) => { options = value; return [{ call_sid: 'vapi_call_1', user_chat_id: '7003', phone_number: '+15555550123', status: 'queued', created_at: '2026-01-01T00:00:00.000Z' }]; },
      getLatestCallState: async () => ({ provider: 'vapi', provider_call_id: 'provider-1', business_id: 'biz1' }),
    }) });
    await handler.list({ callEActorId: '7003', headers: { 'x-telegram-chat-id': '9999' }, query: { limit: '5' } }, { json: (value) => (body = value), status: () => ({ json: (value) => (body = value) }) });
    assert.equal(options.userChatId, '7003');
    assert.equal(body.calls[0].provider, 'vapi');
    assert.equal(body.calls[0].provider_call_id, 'provider-1');
    assert.equal(body.calls[0].phone_number, '••••0123');
  });

  it('denies activity detail when only the unverified Telegram header matches', async () => {
    let statusCode;
    let body;
    const handler = __testables.createCallActivityHandlers({ getDb: () => ({
      getCall: async () => ({ call_sid: 'CA1', user_chat_id: '7004' }),
    }) });
    await handler.detail({ callEActorId: '7005', headers: { 'x-telegram-chat-id': '7004' }, params: { callSid: 'CA1' } }, {
      status: (code) => { statusCode = code; return { json: (value) => (body = value) }; },
      json: (value) => (body = value),
    });
    assert.equal(statusCode, 403);
    assert.equal(body.error, 'not_authorized_for_call');
  });

  it('returns the canonical owner-scoped lifecycle timeline for call activity detail', async () => {
    let lifecycleScope;
    let body;
    const handler = __testables.createCallActivityHandlers({ getDb: () => ({
      getCall: async () => ({ call_sid: 'local-1', user_chat_id: '7008', status: 'completed', provider: 'twilio', provider_call_id: 'provider-1' }),
      getLatestCallState: async () => null,
      getCallStates: async () => [],
      listCallLifecycleEvents: async (callSid, actorId, options) => {
        lifecycleScope = { callSid, actorId, options };
        return [{ event_id: 1, provider: 'twilio', event_type: 'status_changed', status: 'completed', source: 'call_record_status', occurred_at: '2026-01-01T00:00:00.000Z' }];
      },
    }) });
    await handler.detail({ callEActorId: '7008', params: { callSid: 'local-1' } }, {
      json: (value) => (body = value),
      status: () => ({ json: (value) => (body = value) }),
    });
    assert.deepEqual(lifecycleScope, { callSid: 'local-1', actorId: '7008', options: { limit: 20 } });
    assert.equal(body.call.provider_call_id, 'provider-1');
    assert.equal(body.lifecycle_events[0].status, 'completed');
    assert.equal(body.lifecycle_events[0].source, 'call_record_status');
  });

  it('reconciles an owned Vapi call through the read-only provider path and records the result', async () => {
    const writes = [];
    let reconciled;
    let body;
    const handler = __testables.createCallActivityHandlers({
      getDb: () => ({
        getCall: async () => ({ call_sid: 'vapi_local-1', user_chat_id: '7009', business_id: 'biz-1', provider: 'vapi', provider_call_id: 'provider-1', status: 'unknown' }),
        getLatestCallState: async () => null,
        updateCallStatus: async (...args) => writes.push(['status', ...args]),
        updateCallState: async (...args) => writes.push(['state', ...args]),
      }),
      reconcileVapiCallActivity: async (input) => {
        reconciled = input;
        return { status: 'ended', endedReason: 'customer-ended-call' };
      },
      getCallActivityStatus: async () => { throw new Error('Vapi reconciliation should use its existing reconciliation service'); },
    });
    await handler.reconcile({ callEActorId: '7009', params: { callSid: 'vapi_local-1' } }, {
      json: (value) => (body = value),
      status: () => ({ json: (value) => (body = value) }),
    });
    assert.equal(reconciled.actorId, '7009');
    assert.equal(reconciled.call.provider_call_id, 'provider-1');
    assert.equal(writes[0][0], 'status');
    assert.equal(writes[0][2], 'completed');
    assert.equal(writes[1][1], 'vapi_local-1');
    assert.equal(writes[1][2], 'provider_call_reconciled');
    assert.equal(body.reconciliation.outcome, 'reconciled');
    assert.equal(body.retry_safe, false);
  });

  it('keeps calls without provider IDs unresolved instead of searching by time or destination', async () => {
    let lookupCount = 0;
    let statusCode;
    let body;
    const handler = __testables.createCallActivityHandlers({
      getDb: () => ({
        getCall: async () => ({ call_sid: 'local-unknown', user_chat_id: '7010', provider: 'twilio', status: 'unknown' }),
      }),
      getCallActivityStatus: async () => { lookupCount += 1; return { status: 'completed' }; },
    });
    await handler.reconcile({ callEActorId: '7010', params: { callSid: 'local-unknown' } }, {
      status: (code) => { statusCode = code; return { json: (value) => (body = value) }; },
      json: (value) => (body = value),
    });
    assert.equal(statusCode, 409);
    assert.equal(body.reconciliation.outcome, 'unresolved');
    assert.equal(body.retry_safe, false);
    assert.equal(lookupCount, 0);
  });

  it('refreshes status from the provider and never declares a retry safe', async () => {
    const calls = [];
    let body;
    const handler = __testables.createCallActivityHandlers({
      getDb: () => ({
        getCall: async () => ({ call_sid: 'cartesia_call_1', user_chat_id: '7006', business_id: 'biz1', phone_number: '+15555550123', status: 'initiated' }),
        getLatestCallState: async () => ({ provider: 'cartesia', provider_call_id: 'call_1', business_id: 'biz1' }),
        updateCallStatus: async (...args) => calls.push(['status', ...args]),
        updateCallState: async (...args) => calls.push(['state', ...args]),
      }),
      getCallActivityStatus: async ({ call, actorId }) => { assert.equal(call.provider, 'cartesia'); assert.equal(actorId, '7006'); return { status: 'completed' }; },
    });
    await handler.refresh({ callEActorId: '7006', params: { callSid: 'cartesia_call_1' } }, { json: (value) => (body = value), status: () => ({ json: (value) => (body = value) }) });
    assert.equal(body.call.status, 'completed');
    assert.equal(body.status_source, 'provider_lookup');
    assert.equal(body.retry_safe, false);
    assert.equal(calls[0][0], 'status');
    assert.equal(calls[1][1], 'cartesia_call_1');
  });

  it('does not guess a provider call ID from a local call ID when refresh metadata is missing', async () => {
    let statusCode;
    let body;
    let lookups = 0;
    const handler = __testables.createCallActivityHandlers({
      getDb: () => ({
        getCall: async () => ({ call_sid: 'local-call-1', user_chat_id: '7007', status: 'unknown' }),
        getLatestCallState: async () => ({ provider: 'twilio' }),
      }),
      getCallActivityStatus: async () => { lookups += 1; return { status: 'completed' }; },
    });
    await handler.refresh({ callEActorId: '7007', params: { callSid: 'local-call-1' } }, {
      status: (code) => { statusCode = code; return { json: (value) => (body = value) }; },
      json: (value) => (body = value),
    });
    assert.equal(statusCode, 409);
    assert.equal(lookups, 0);
    assert.equal(body.retry_safe, false);
  });

  it('scopes call-list queries and totals to the requesting Telegram user', async () => {
    let listOptions;
    let countOwner;
    let body;
    const handler = __testables.createListCallsHandler({
      getDb: () => ({
        getRecentCalls: async (options) => {
          listOptions = options;
          return [];
        },
        getCallsCount: async (owner) => {
          countOwner = owner;
          return 0;
        },
      }),
      parsePagination: () => ({ limit: 10, offset: 0 }),
      normalizeCallRecordForApi: (call) => call,
    });

    await handler(
      { query: {}, headers: { 'x-telegram-chat-id': '7002' } },
      { status: () => ({ json: (payload) => (body = payload) }), json: (payload) => (body = payload) },
    );

    assert.equal(listOptions.userChatId, '7002');
    assert.equal(countOwner, '7002');
    assert.equal(body.success, true);
  });

  it('constrains call search to the requesting Telegram user', async () => {
    let capturedQuery = '';
    let capturedParams = [];
    let body;
    const handler = __testables.createSearchCallsHandler({
      getDb: () => ({
        db: {
          all(query, params, callback) {
            capturedQuery = query;
            capturedParams = params;
            callback(null, []);
          },
        },
        attachLatestCallDispositions: async (rows) => rows,
      }),
      parseBoundedInteger: () => 10,
      normalizeCallRecordForApi: (call) => call,
    });

    await handler(
      { query: { q: 'CA123' }, headers: { 'x-telegram-chat-id': '7002' } },
      { status: () => ({ json: (payload) => (body = payload) }), json: (payload) => (body = payload) },
    );

    assert.match(capturedQuery, /c\.user_chat_id = \?/);
    assert.ok(capturedParams.includes('7002'));
    assert.equal(body.success, true);
  });

  it('returns redacted destinations and sanitized monitoring summaries', async () => {
    const monitoringQueries = [];
    const db = {
      db: {
        all(query, paramsOrCallback, maybeCallback) {
          monitoringQueries.push(query);
          const callback = typeof paramsOrCallback === 'function'
            ? paramsOrCallback
            : maybeCallback;
          if (query.includes('webhook_notifications')) {
            callback(null, [{ status: 'failed', count: 1 }]);
          } else if (query.includes('vapi_call_events')) {
            callback(null, [{ provider_call_id: 'vapi_1', provider_status: 'completed', event_type: 'ended', event_timestamp: '2025-01-01T00:03:00.000Z' }]);
          } else if (query.includes('cartesia_calls')) {
            callback(null, [{ provider_call_id: 'cartesia_1', phone_number: '+15555550111', status: 'started', created_at: '2025-01-01T00:02:00.000Z' }]);
          } else if (query.includes('GROUP BY provider')) {
            callback(null, [{ provider: 'twilio', count: 2 }]);
          } else if (query.includes('c.call_sid')) {
            callback(null, [{
              call_sid: 'CA123',
              phone_number: '+15555550199',
              status: 'ringing',
              created_at: '2025-01-01T00:00:00.000Z',
              runtime_provider: 'twilio',
              provider: 'twilio',
              call_created_state: JSON.stringify({
                provider: 'twilio',
                ai_voice_engine: 'cartesia',
              }),
              provider_state_data: JSON.stringify({
                provider: 'twilio',
                provider_call_id: 'CA_PROVIDER_123',
                status: 'unknown',
              }),
              last_event_at: '2025-01-01T00:01:00.000Z',
            }]);
          } else {
            callback(null, []);
          }
        },
        get(query, paramsOrCallback, maybeCallback) {
          monitoringQueries.push(query);
          const callback = typeof paramsOrCallback === 'function'
            ? paramsOrCallback
            : maybeCallback;
          callback(null, query.includes('service_health_logs')
            ? { count: 1, latest_at: '2025-01-01T00:00:00.000Z' }
            : { count: 2 });
        },
      },
    };
    let body;
    const handler = __testables.createCallOperationsHandler({ getDb: () => db });

    await handler({}, { status: () => ({ json: (payload) => (body = payload) }), json: (payload) => (body = payload) });

    assert.equal(body.success, true);
    assert.equal(body.active_calls[0].destination, '•••0199');
    assert.equal(body.active_calls[0].telephony_provider, 'twilio');
    assert.equal(body.active_calls[0].ai_voice_engine, 'cartesia');
    assert.equal(JSON.stringify(body).includes('+15555550199'), false);
    assert.equal(body.notification_delivery.failed, 1);
    assert.equal(body.webhook_processing_errors_24h.count, 1);
    assert.equal(body.counts.unknown_submissions, 2);
    assert.equal(body.unknown_submissions[0].provider_call_id, 'CA_PROVIDER_123');
    assert.equal(body.unknown_submissions[0].telephony_provider, 'twilio');
    assert.equal(body.unknown_submissions[0].last_event_at, '2025-01-01T00:01:00.000Z');
    assert.equal(body.unknown_submissions[0].destination, '•••0199');
    assert.deepEqual(body.recent_provider_calls.map((call) => call.telephony_provider), ['vapi', 'cartesia', 'twilio']);
    assert.equal(body.recent_provider_calls[1].destination, '•••0111');
    assert.ok(monitoringQueries.some((query) => query.includes("'voicemail'")));
    assert.ok(monitoringQueries.some((query) => query.includes("MAX(s.timestamp)")));
    assert.ok(monitoringQueries.some((query) => query.includes("provider_state_data")));
  });
});
