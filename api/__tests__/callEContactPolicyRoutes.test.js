const assert = require("node:assert/strict");
const { registerCallEContactPolicyRoutes } = require("../services/callEContactPolicyRoutes");

function createRouteHarness() {
  const routes = new Map();
  const memberships = new Map();
  const records = [];
  const db = {
    async hasCallTemplateBusinessId(businessId) { return businessId === "business_route_001"; },
    async grantCallEBusinessOperator(input) { memberships.set(`${input.business_id}:${input.telegram_id}`, input.role); return { saved: true }; },
    async revokeCallEBusinessOperator(input) { return memberships.delete(`${input.business_id}:${input.telegram_id}`); },
    async getCallEBusinessOperator(businessId, telegramId) {
      const role = memberships.get(`${businessId}:${telegramId}`);
      return role ? { role } : null;
    },
  };
  const policyService = {
    async recordConsent(input) { records.push({ kind: "consent", input }); return { recorded: true, idempotentReplay: false }; },
    async recordOptOut(input) { records.push({ kind: "optout", input }); return { recorded: true, idempotentReplay: false }; },
  };
  const app = Object.fromEntries(["put", "delete", "post"].map((method) => [method, (route, ...handlers) => {
    routes.set(`${method.toUpperCase()} ${route}`, handlers);
  }]));
  const requireAdminToken = (req, res, next) => req.get("authorization") === "Bearer test-admin" ? next() : res.status(403).json({ success: false });
  const requireMiniAppSession = (req, res, next) => {
    const telegramId = req.get("x-test-telegram-id");
    if (!telegramId) return res.status(401).json({ success: false });
    req.miniAppSession = { telegram_id: telegramId, caps: ["provider_manage"] };
    return next();
  };
  const requireMiniAppCapability = (req, res, capability) => {
    if (req.miniAppSession?.caps?.includes(capability)) return true;
    res.status(403).json({ success: false });
    return false;
  };
  registerCallEContactPolicyRoutes(app, {
    db,
    getTemplate: async (id) => Number(id) === 9 ? { id: 9, business_id: "business_route_001" } : null,
    policyService,
    requireAdminToken,
    requireMiniAppSession,
    requireMiniAppCapability,
  });

  async function dispatch(method, route, options = {}) {
    const handlers = routes.get(`${method} ${route}`);
    assert.ok(handlers, `missing route ${method} ${route}`);
    const headers = options.headers || {};
    const req = {
      body: options.body || {},
      miniAppSession: null,
      get(name) {
        const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
        return key ? headers[key] : undefined;
      },
    };
    const res = {
      statusCode: 200,
      body: null,
      ended: false,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; this.ended = true; return this; },
    };
    for (const handler of handlers) {
      let nextCalled = false;
      let nextError = null;
      await handler(req, res, (error) => { nextCalled = true; nextError = error || null; });
      if (nextError) throw nextError;
      if (!nextCalled || res.ended) break;
    }
    return { status: res.statusCode, body: res.body };
  }

  return { dispatch, memberships, records };
}

describe("CALL-E business-scoped contact policy routes", () => {
  it("restricts business membership changes to admin and known template businesses", async () => {
    const { dispatch, memberships } = createRouteHarness();
    let response = await dispatch("PUT", "/api/call-e/business-operators", {
      body: { business_id: "business_route_001", telegram_id: "123456789", role: "policy_manager" },
    });
    assert.equal(response.status, 403);

    response = await dispatch("PUT", "/api/call-e/business-operators", {
      headers: { authorization: "Bearer test-admin" },
      body: { business_id: "unknown_business", telegram_id: "123456789", role: "policy_manager" },
    });
    assert.equal(response.status, 404);

    response = await dispatch("PUT", "/api/call-e/business-operators", {
      headers: { authorization: "Bearer test-admin" },
      body: { business_id: "business_route_001", telegram_id: "123456789", role: "policy_manager", extra: true },
    });
    assert.equal(response.status, 400);

    response = await dispatch("PUT", "/api/call-e/business-operators", {
      headers: { authorization: "Bearer test-admin" },
      body: { business_id: "business_route_001", telegram_id: "123456789", role: "policy_manager" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { success: true, role: "policy_manager" });
    assert.equal(memberships.get("business_route_001:123456789"), "policy_manager");

    response = await dispatch("DELETE", "/api/call-e/business-operators", {
      headers: { authorization: "Bearer test-admin" },
      body: { business_id: "business_route_001", telegram_id: "123456789" },
    });
    assert.equal(response.status, 200);
    assert.equal(memberships.has("business_route_001:123456789"), false);
  });

  it("requires policy-manager membership and derives business and actor from trusted context", async () => {
    const { dispatch, memberships, records } = createRouteHarness();
    memberships.set("business_route_001:123456789", "call_operator");
    const payload = {
      template_id: 9,
      destination: "+14155550123",
      event_key: "consent:route:0001",
      source: "written",
      occurred_at: new Date().toISOString(),
      evidence_reference: "evidence:route:0001",
    };
    let response = await dispatch("POST", "/miniapp/call-e/contact-policy/consent", {
      headers: { "x-test-telegram-id": "123456789" },
      body: payload,
    });
    assert.equal(response.status, 403);
    assert.equal(records.length, 0);

    memberships.set("business_route_001:123456789", "policy_manager");
    response = await dispatch("POST", "/miniapp/call-e/contact-policy/consent", {
      headers: { "x-test-telegram-id": "123456789" },
      body: payload,
    });
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { success: true, recorded: true, idempotentReplay: false });
    assert.equal(records[0].input.businessId, "business_route_001");
    assert.equal(records[0].input.recordedByTelegramId, "123456789");
    assert.equal("destination" in response.body, false);
    assert.equal("evidenceReference" in response.body, false);

    response = await dispatch("POST", "/miniapp/call-e/contact-policy/consent", {
      headers: { "x-test-telegram-id": "123456789" },
      body: { ...payload, business_id: "other_business", recordedByTelegramId: "999999999" },
    });
    assert.equal(response.status, 400);
    assert.equal(records.length, 1);
  });

  it("records opt-outs through the same business policy-manager boundary", async () => {
    const { dispatch, memberships, records } = createRouteHarness();
    memberships.set("business_route_001:987654321", "policy_manager");
    let response = await dispatch("POST", "/miniapp/call-e/contact-policy/opt-out", {
      headers: { "x-test-telegram-id": "987654321" },
      body: {
        template_id: 9,
        destination: "+14155550124",
        event_key: "optout:route:0001",
        source: "recipient_request",
        occurred_at: new Date().toISOString(),
      },
    });
    assert.equal(response.status, 201);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "optout");
    assert.equal(records[0].input.recordedByTelegramId, "987654321");
    response = await dispatch("POST", "/miniapp/call-e/contact-policy/opt-out", { body: { template_id: 9 } });
    assert.equal(response.status, 401);
    assert.equal(records.length, 1);
  });
});
