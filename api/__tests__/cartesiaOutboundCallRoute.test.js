"use strict";

const assert = require("node:assert/strict");
const { registerCallRoutes, __testables } = require("../services/callRoutes");

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    type(value) { this.headers['Content-Type'] = value; return this; },
    send(value) { this.body = value; return this; },
  };
}

function makeHandler(overrides = {}) {
  return __testables.createOutboundCallHandler({
    sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    resolveHost: () => "api.example.test",
    config: { server: { hostname: "api.example.test" } },
    placeOutboundCall: async () => { throw new Error("legacy provider path must not run"); },
    buildErrorDetails: () => ({}),
    ...overrides,
  });
}

describe("Cartesia outbound call API contract", () => {
  it("dispatches Cartesia Managed Agent calls through the approved Cartesia service", async () => {
    let received;
    const handler = makeHandler({
      placeCartesiaOutboundCall: async (input) => {
        received = input;
        return { providerCallId: "call_123", status: "created", idempotentReplay: false };
      },
    });
    const res = makeResponse();
    await handler({
      body: {
        provider: "cartesia", business_id: "biz-1", number: "+15555550123",
        agent_id: "agent_1", from_number_id: "ap_number_1", idempotency_key: "idem-key-123",
        approval_token: "signed-approval-token",
      },
      headers: {}, callEActorId: "7001", requestId: "req-1",
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.call_sid, "call_123");
    assert.equal(res.body.provider, "cartesia");
    assert.equal(received.actor_id, "7001");
    assert.equal(received.approval_token, "signed-approval-token");
  });

  it("rejects Cartesia dispatch when required approval input is missing", async () => {
    let dispatched = false;
    const handler = makeHandler({ placeCartesiaOutboundCall: async () => { dispatched = true; } });
    const res = makeResponse();
    await handler({ body: { provider: "cartesia" }, headers: {}, requestId: "req-1" }, res);
    assert.equal(dispatched, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "cartesia_call_input_invalid");
  });

  it("registers the approval endpoint behind rate limiting, API authorization, and signed actor assertion", () => {
    const routes = new Map();
    const app = {
      post(path, ...handlers) { routes.set(path, handlers); },
      get() {},
      patch() {},
    };
    const limiter = () => {};
    const authorization = () => {};
    const actor = () => {};
    registerCallRoutes(app, {
      cartesiaApprovalLimiter: limiter,
      requireOutboundAuthorization: authorization,
      requireCallEActorAssertion: actor,
      sendApiError() {},
    });
    const handlers = routes.get("/api/cartesia/call-approval");
    assert.equal(handlers[0], limiter);
    assert.equal(handlers[1], authorization);
    assert.equal(handlers[2], actor);
    assert.equal(typeof handlers[3], "function");
  });

  it("reads business-scoped provider defaults and permits writes only for Cartesia admins", async () => {
    const routes = new Map();
    const app = {
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      patch() {},
    };
    const limiter = () => {};
    const authorization = () => {};
    const actorAssertion = () => {};
    const stored = [];
    registerCallRoutes(app, {
      cartesiaApprovalLimiter: limiter,
      requireOutboundAuthorization: authorization,
      requireCallEActorAssertion: actorAssertion,
      isCartesiaAdminActor: async (actorId) => actorId === "7001",
      getCartesiaCallDefaults: async (input) => {
        assert.deepEqual(input, { business_id: "biz-1", actor_id: "7001" });
        return { agentId: "agent_1", fromNumberId: "ap_number_1" };
      },
      setCartesiaCallDefaults: async (input) => {
        stored.push(input);
        return { agentId: input.agent_id, fromNumberId: input.from_number_id };
      },
      sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    });

    const read = routes.get("GET /api/cartesia/provider-defaults");
    assert.deepEqual(read.slice(0, 3), [limiter, authorization, actorAssertion]);
    const readResponse = makeResponse();
    await read[3]({ query: { business_id: "biz-1" }, callEActorId: "7001" }, readResponse);
    assert.deepEqual(readResponse.body, {
      success: true,
      profile: { business_id: "biz-1", agent_id: "agent_1", from_number_id: "ap_number_1" },
    });

    const write = routes.get("POST /api/cartesia/provider-defaults");
    assert.deepEqual(write.slice(0, 3), [limiter, authorization, actorAssertion]);
    const denied = makeResponse();
    await write[3]({
      body: { business_id: "biz-1", agent_id: "agent_1", from_number_id: "ap_number_1" },
      callEActorId: "7002",
    }, denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(stored.length, 0);

    const written = makeResponse();
    await write[3]({
      body: { business_id: "biz-1", agent_id: "agent_1", from_number_id: "ap_number_1" },
      callEActorId: "7001",
    }, written);
    assert.deepEqual(stored, [{
      business_id: "biz-1", actor_id: "7001", agent_id: "agent_1", from_number_id: "ap_number_1",
    }]);
    assert.deepEqual(written.body, readResponse.body);

    const invalid = makeResponse();
    await write[3]({
      body: { business_id: "biz-1", agent_id: "agent_1", from_number_id: "ap_number_1", approval_token: "must-not-be-persisted" },
      callEActorId: "7001",
    }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(stored.length, 1);
  });

  it("registers reconciliation behind the same protected and rate-limited route boundary", async () => {
    const routes = new Map();
    const app = {
      post(path, ...handlers) { routes.set(path, handlers); },
      get() {}, patch() {},
    };
    const limiter = () => {};
    const authorization = () => {};
    const actorAssertion = () => {};
    let received;
    registerCallRoutes(app, {
      cartesiaApprovalLimiter: limiter,
      requireOutboundAuthorization: authorization,
      requireCallEActorAssertion: actorAssertion,
      reconcileCartesiaOutboundCall: async (input) => { received = input; return {
        outcome: "reconciled", status: "started", call: {
          callId: "call_1", agentId: "agent_1", status: "started", startTime: null, endTime: null, endReason: null,
        },
      }; },
      sendApiError() {},
    });
    const handlers = routes.get("/api/cartesia/call-reconcile");
    assert.deepEqual(handlers.slice(0, 3), [limiter, authorization, actorAssertion]);
    const res = makeResponse();
    await handlers[3]({ body: { business_id: "biz-1", idempotency_key: "cartesia-request-001" }, callEActorId: "7001" }, res);
    assert.equal(received.actorId, "7001");
    assert.deepEqual(res.body, {
      success: true, outcome: "reconciled", reason: null, status: "started",
      call: { call_id: "call_1", agent_id: "agent_1", status: "started", start_time: null, end_time: null, end_reason: null },
    });
  });

  it("keeps the account-wide agent inventory behind API auth, actor assertion, rate limit, and API admin check", async () => {
    const routes = new Map();
    const app = {
      post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
      get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
      patch() {},
    };
    const limiter = () => {};
    const authorization = () => {};
    const actorAssertion = () => {};
    let adminChecks = 0;
    registerCallRoutes(app, {
      cartesiaApprovalLimiter: limiter,
      requireOutboundAuthorization: authorization,
      requireCallEActorAssertion: actorAssertion,
      isCartesiaAdminActor: async (actorId) => { adminChecks += 1; return actorId === "7001"; },
      listCartesiaAgents: async () => [{ id: "agent_1", ready: true, phoneNumbers: [] }],
      sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    });
    const handlers = routes.get("GET /api/cartesia/agents");
    assert.deepEqual(handlers.slice(0, 3), [limiter, authorization, actorAssertion]);
    const denied = makeResponse();
    await handlers[3]({ callEActorId: "7002" }, denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(adminChecks, 1);
    const allowed = makeResponse();
    await handlers[3]({ callEActorId: "7001" }, allowed);
    assert.deepEqual(allowed.body, { success: true, agents: [{ id: "agent_1", ready: true, phoneNumbers: [] }] });
    assert.equal(adminChecks, 2);
  });

  it("protects agent deployment health behind the existing Cartesia admin boundary", async () => {
    const routes = new Map();
    const app = { post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); }, patch() {} };
    const limiter = () => {};
    const authorization = () => {};
    const actorAssertion = () => {};
    let received;
    registerCallRoutes(app, {
      cartesiaApprovalLimiter: limiter, requireOutboundAuthorization: authorization, requireCallEActorAssertion: actorAssertion,
      isCartesiaAdminActor: async (actorId) => actorId === "7001",
      getCartesiaAgentDeploymentHealth: async (input) => { received = input; return { agent: { id: "agent_1" }, deployments: [], ready: false, warnings: ["no_deployments"] }; },
      sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    });
    const handlers = routes.get("GET /api/cartesia/agents/:agentId/health");
    assert.deepEqual(handlers.slice(0, 3), [limiter, authorization, actorAssertion]);
    const denied = makeResponse();
    await handlers[3]({ params: { agentId: "agent_1" }, callEActorId: "7002" }, denied);
    assert.equal(denied.statusCode, 403);
    const allowed = makeResponse();
    await handlers[3]({ params: { agentId: "agent_1" }, callEActorId: "7001" }, allowed);
    assert.deepEqual(received, { agent_id: "agent_1", actor_id: "7001" });
    assert.deepEqual(allowed.body, { success: true, agent: { id: "agent_1" }, deployments: [], ready: false, warnings: ["no_deployments"] });
  });

  it("protects campaign status lookup and scopes it to the asserted actor and requested business", async () => {
    const routes = new Map();
    const app = { post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); }, patch() {} };
    const limiter = () => {};
    const authorization = () => {};
    const actorAssertion = () => {};
    let received;
    registerCallRoutes(app, {
      cartesiaApprovalLimiter: limiter, requireOutboundAuthorization: authorization, requireCallEActorAssertion: actorAssertion,
      isCartesiaAdminActor: async (actorId) => actorId === "7001",
      getCartesiaCampaign: async (input) => { received = input; return { campaign: { campaign_id: input.campaign_id, status: "unknown" } }; },
      sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    });
    const handlers = routes.get("GET /api/cartesia/campaigns/:campaignId");
    assert.deepEqual(handlers.slice(0, 3), [limiter, authorization, actorAssertion]);
    const denied = makeResponse();
    await handlers[3]({ params: { campaignId: `cartesia_campaign_${"a".repeat(64)}` }, query: { business_id: "biz-1" }, callEActorId: "7002" }, denied);
    assert.equal(denied.statusCode, 403);
    const allowed = makeResponse();
    await handlers[3]({ params: { campaignId: `cartesia_campaign_${"a".repeat(64)}` }, query: { business_id: "biz-1" }, callEActorId: "7001" }, allowed);
    assert.deepEqual(received, { campaign_id: `cartesia_campaign_${"a".repeat(64)}`, business_id: "biz-1", actor_id: "7001" });
    assert.equal(allowed.body.campaign.status, "unknown");
  });

  it('keeps reconcile and cancel protected while rejecting campaign submit and batch retry', async () => {
    const routes = new Map();
    const app = { post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); }, patch() {} };
    const limiter = () => {};
    const authorization = () => {};
    const actorAssertion = () => {};
    const received = [];
    registerCallRoutes(app, {
      cartesiaApprovalLimiter: limiter, requireOutboundAuthorization: authorization, requireCallEActorAssertion: actorAssertion,
      isCartesiaAdminActor: async (actorId) => actorId === '7001',
      reconcileCartesiaCampaign: async (input) => { received.push(['reconcile', input]); return { campaign: { status: 'submitted' } }; },
      cancelCartesiaCampaignBatch: async (input) => { received.push(['cancel', input]); return { status: 'cancelled' }; },
      retryCartesiaCampaignBatch: async (input) => { received.push(['retry', input]); return { retried_recipient_count: 1 }; },
      sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    });

    it('rejects campaign submission without invoking the dispatch service', async () => {
      const routes = new Map();
      const app = { post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }, get() {}, patch() {} };
      const limiter = () => {};
      const authorization = () => {};
      const assertion = () => {};
      let received;
      registerCallRoutes(app, {
        cartesiaApprovalLimiter: limiter,
        requireOutboundAuthorization: authorization,
        requireCallEActorAssertion: assertion,
        isCartesiaAdminActor: async (actorId) => actorId === '7001',
        submitCartesiaCampaign: async (input) => {
          received = input;
          return { queued_for_async_dispatch: true, campaign: { campaign_id: input.campaign_id, status: 'approved', dispatch_queued: true } };
        },
        sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
      });
      const handlers = routes.get('POST /api/cartesia/campaigns/:campaignId/submit');
      assert.deepEqual(handlers.slice(0, 3), [limiter, authorization, assertion]);
      const res = makeResponse();
      await handlers[3]({
        params: { campaignId: `cartesia_campaign_${'a'.repeat(64)}` },
        body: { business_id: 'biz-1', confirmation_phrase: 'exact phrase' },
        callEActorId: '7001',
      }, res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'cartesia_is_ai_capability');
      assert.equal(received, undefined);
    });
    const createHandlers = routes.get('POST /api/cartesia/campaigns');
    assert.deepEqual(createHandlers.slice(0, 3), [limiter, authorization, actorAssertion]);
    const campaignCreate = makeResponse();
    await createHandlers[3]({
      body: { business_id: 'biz-1', request_key: 'request-key-0001', destinations: ['+15555550123'] },
      callEActorId: '7001',
    }, campaignCreate);
    assert.equal(campaignCreate.statusCode, 409);
    assert.equal(campaignCreate.body.code, 'cartesia_is_ai_capability');

    const campaignId = `cartesia_campaign_${'a'.repeat(64)}`;
    for (const [operation, expectedName] of [['reconcile', 'reconcileCartesiaCampaign'], ['cancel', 'cancelCartesiaCampaignBatch'], ['retry', 'retryCartesiaCampaignBatch']]) {
      const path = `POST /api/cartesia/campaigns/:campaignId/${operation}`;
      const handlers = routes.get(path);
      assert.deepEqual(handlers.slice(0, 3), [limiter, authorization, actorAssertion]);
      assert.equal(typeof handlers[3], 'function', expectedName);
      const denied = makeResponse();
      await handlers[3]({ params: { campaignId }, body: { business_id: 'biz-1' }, callEActorId: '7002' }, denied);
      assert.equal(denied.statusCode, 403);
      const allowed = makeResponse();
      await handlers[3]({ params: { campaignId }, body: { business_id: 'biz-1', confirmation_phrase: 'exact phrase' }, callEActorId: '7001' }, allowed);
      assert.equal(allowed.statusCode, operation === 'retry' ? 409 : 200);
      if (operation === 'retry') assert.equal(allowed.body.code, 'cartesia_is_ai_capability');
    }
    assert.deepEqual(received.map(([operation]) => operation), ['reconcile', 'cancel']);
    assert.ok(received.every(([, input]) => input.campaign_id === campaignId && input.business_id === 'biz-1' && input.actor_id === '7001'));
  });

  it("protects call history and exposes only service-sanitized operation records", async () => {
    const routes = new Map();
    const app = { post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); }, patch() {} };
    const limiter = () => {};
    const authorization = () => {};
    const actorAssertion = () => {};
    let received;
    registerCallRoutes(app, {
      cartesiaApprovalLimiter: limiter, requireOutboundAuthorization: authorization, requireCallEActorAssertion: actorAssertion,
      isCartesiaAdminActor: async (actorId) => actorId === "7001",
      listCartesiaCalls: async (input) => { received = input; return { calls: [{ callId: "call_1", status: "started", to: "••••0123" }], hasMore: false, nextPage: null }; },
      sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    });
    const handlers = routes.get("GET /api/cartesia/calls");
    assert.deepEqual(handlers.slice(0, 3), [limiter, authorization, actorAssertion]);
    const denied = makeResponse();
    await handlers[3]({ callEActorId: "7002", query: { agent_id: "agent_1" } }, denied);
    assert.equal(denied.statusCode, 403);
    const allowed = makeResponse();
    await handlers[3]({ callEActorId: "7001", query: { agent_id: "agent_1", business_id: "biz-1", limit: "10", starting_after: "call_0" } }, allowed);
    assert.deepEqual(received, { agentId: "agent_1", businessId: "biz-1", actorId: "7001", startTimeGte: "", startTimeLte: "", startingAfter: "call_0", reviewQueue: false, limit: "10" });
    assert.equal(allowed.body.calls[0].to, "••••0123");
  });

  it("keeps transcript return opt-in and protects persistent review-rule management as admin-only", async () => {
    const routes = new Map();
    const app = { post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); }, patch() {} };
    const limiter = () => {};
    const auth = () => {};
    const assertion = () => {};
    const received = [];
    registerCallRoutes(app, {
      cartesiaApprovalLimiter: limiter, requireOutboundAuthorization: auth, requireCallEActorAssertion: assertion,
      isCartesiaAdminActor: async (actorId) => actorId === '7001',
      getCartesiaCall: async (...args) => { received.push(args); return { callId: args[0], transcript: args[1]?.includeTranscript ? [{ role: 'user', text: 'sensitive' }] : undefined }; },
      getCartesiaCallReviewRules: async () => ({ review_failed_calls: true, review_tool_calls: false, review_missing_summary: false }),
      saveCartesiaCallReviewRules: async (input) => ({ ...input.rules, updated_by: input.actorId }),
      sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    });
    const detailRoute = routes.get('GET /api/cartesia/calls/:callId');
    const compact = makeResponse();
    await detailRoute[3]({ params: { callId: 'call_1' }, query: { business_id: 'biz-1' }, callEActorId: '7001' }, compact);
    assert.deepEqual(received[0], ['call_1', { businessId: 'biz-1', actorId: '7001', includeReviewDetails: true, includeTranscript: false }]);
    const transcript = makeResponse();
    await detailRoute[3]({ params: { callId: 'call_1' }, query: { business_id: 'biz-1', include_transcript: 'true' }, callEActorId: '7001' }, transcript);
    assert.deepEqual(received[1], ['call_1', { businessId: 'biz-1', actorId: '7001', includeReviewDetails: true, includeTranscript: true }]);
    assert.match(JSON.stringify(transcript.body), /sensitive/);

    const rulesRead = routes.get('GET /api/cartesia/review-rules');
    const denied = makeResponse();
    await rulesRead[3]({ callEActorId: '7002', query: { business_id: 'biz-1' } }, denied);
    assert.equal(denied.statusCode, 403);
    const rulesWrite = routes.get('POST /api/cartesia/review-rules');
    const saved = makeResponse();
    await rulesWrite[3]({ callEActorId: '7001', body: { business_id: 'biz-1', rules: { review_failed_calls: false, review_tool_calls: true, review_missing_summary: true } } }, saved);
    assert.deepEqual(saved.body.rules, { review_failed_calls: false, review_tool_calls: true, review_missing_summary: true, updated_by: '7001' });
    assert.deepEqual(rulesRead.slice(0, 3), [limiter, auth, assertion]);
    assert.deepEqual(rulesWrite.slice(0, 3), [limiter, auth, assertion]);
  });

  it("requires admin access and call-specific confirmation before cancellation", async () => {
    const routes = new Map();
    const app = { post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); }, patch() {} };
    let canceled = 0;
    registerCallRoutes(app, {
      isCartesiaAdminActor: async (actorId) => actorId === "7001",
      cancelCartesiaCall: async (callId) => { canceled += 1; return { cancelled: true, call: { callId, status: "completed" } }; },
      sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    });
    const handler = routes.get("POST /api/cartesia/calls/:callId/cancel")[3];
    const invalid = makeResponse();
    await handler({ params: { callId: "call_1" }, body: { confirmation_phrase: "yes" }, callEActorId: "7001" }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(canceled, 0);
    const denied = makeResponse();
    await handler({ params: { callId: "call_1" }, body: { confirmation_phrase: "CANCEL CARTESIA CALL call_1" }, callEActorId: "7002" }, denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(canceled, 0);
    const approved = makeResponse();
    await handler({ params: { callId: "call_1" }, body: { confirmation_phrase: "CANCEL CARTESIA CALL call_1" }, callEActorId: "7001" }, approved);
    assert.deepEqual(approved.body, { success: true, cancelled: true, call: { callId: "call_1", status: "completed" } });
    assert.equal(canceled, 1);
  });

  it("protects call recording downloads and requires exact confirmation before irreversible redaction", async () => {
    const routes = new Map();
    const app = { post(path, ...handlers) { routes.set(`POST ${path}`, handlers); }, get(path, ...handlers) { routes.set(`GET ${path}`, handlers); }, patch() {} };
    const audio = Buffer.from([1, 2]);
    const requests = [];
    registerCallRoutes(app, {
      isCartesiaAdminActor: async (actorId) => actorId === '7001',
      async getCartesiaCallAudio(callId, options) { requests.push({ type: 'audio', callId, options }); return { bytes: audio, contentType: 'audio/wav' }; },
      async redactCartesiaCallData(callId, options) { requests.push({ type: 'redact', callId, options }); return { deleted: true, alreadyRemoved: false, callId }; },
      sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
    });
    const audioHandlers = routes.get('GET /api/cartesia/calls/:callId/audio');
    const denied = makeResponse();
    await audioHandlers[3]({ params: { callId: 'call_1' }, query: { business_id: 'biz-1' }, callEActorId: '7002' }, denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(requests.length, 0);
    const downloaded = makeResponse();
    await audioHandlers[3]({ params: { callId: 'call_1' }, query: { business_id: 'biz-1' }, callEActorId: '7001' }, downloaded);
    assert.deepEqual(downloaded.body, audio);
    assert.equal(downloaded.headers['Cache-Control'], 'private, no-store');
    assert.equal(requests[0].options.businessId, 'biz-1');
    const redactHandler = routes.get('POST /api/cartesia/calls/:callId/redact')[3];
    const invalid = makeResponse();
    await redactHandler({ params: { callId: 'call_1' }, body: { business_id: 'biz-1', confirmation_phrase: 'delete it' }, callEActorId: '7001' }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(requests.length, 1);
    const approved = makeResponse();
    await redactHandler({ params: { callId: 'call_1' }, body: { business_id: 'biz-1', confirmation_phrase: 'DELETE CARTESIA CALL DATA call_1 CONSENT WITHDRAWN' }, callEActorId: '7001' }, approved);
    assert.equal(approved.body.deleted, true);
    assert.equal(requests[1].type, 'redact');
  });
});
