const assert = require("node:assert/strict");
const { registerBusinessIntegrationConnectionRoutes } = require("../services/businessIntegrationConnectionRoutes");

function createHarness() {
  const routes = new Map();
  const calls = [];
  const service = {
    async list(businessId, filters) { calls.push(["list", businessId, filters]); return []; },
    async create(businessId, input, actor) {
      calls.push(["create", businessId, input, actor]);
      return { created: true, connection: { connection_id: "connection-1", business_id: businessId, provider: input.provider, status: "active" } };
    },
    async revoke(businessId, connectionId, actor) {
      calls.push(["revoke", businessId, connectionId, actor]);
      return { connection_id: connectionId, business_id: businessId, status: "revoked" };
    },
  };
  const app = Object.fromEntries(["get", "post"].map((method) => [method, (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers)]));
  const requireAdminToken = (req, res, next) => req.get("x-admin") === "authorized" ? next() : res.status(403).json({ success: false });
  const sendApiError = (res, status, code, message, requestId) => res.status(status).json({ success: false, error: { code, message }, request_id: requestId || null });
  registerBusinessIntegrationConnectionRoutes(app, { getService: () => service, requireAdminToken, sendApiError });

  async function dispatch(method, route, options = {}) {
    const handlers = routes.get(`${method} ${route}`);
    assert.ok(handlers, `missing route ${method} ${route}`);
    const req = {
      body: options.body || {}, params: options.params || {}, query: options.query || {}, requestId: "connection-route-test",
      get(name) { return options.headers?.[name] || options.headers?.[name.toLowerCase()]; },
    };
    const res = {
      statusCode: 200, body: null, ended: false,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; this.ended = true; return this; },
    };
    for (const handler of handlers) {
      let nextCalled = false;
      await handler(req, res, () => { nextCalled = true; });
      if (!nextCalled || res.ended) break;
    }
    return { status: res.statusCode, body: res.body };
  }

  return { calls, dispatch };
}

describe("business integration connection routes", () => {
  const listRoute = "/post-call/businesses/:business_id/integrations/connections";
  const createRoute = "/post-call/businesses/:business_id/integrations/connections";
  const revokeRoute = "/post-call/businesses/:business_id/integrations/connections/:connection_id/revoke";

  it("requires admin authorization and returns metadata without secret references", async () => {
    const { dispatch, calls } = createHarness();
    let response = await dispatch("POST", createRoute, { body: { provider: "hubspot" } });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);

    response = await dispatch("POST", createRoute, {
      headers: { "x-admin": "authorized" },
      params: { business_id: "biz-a" },
      body: { provider: "hubspot", secret_reference: "env://BUSINESS_INTEGRATION_SECRET_A" },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.connection.status, "active");
    assert.equal(JSON.stringify(response.body).includes("secret_reference"), false);
    assert.equal(calls[0][3], "admin_token");
  });

  it("passes exact business scope and filters to the service and rejects revoke bodies", async () => {
    const { dispatch, calls } = createHarness();
    const headers = { "x-admin": "authorized" };
    let response = await dispatch("GET", listRoute, { headers, params: { business_id: "biz-a" }, query: { status: "active" } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], ["list", "biz-a", { status: "active" }]);

    response = await dispatch("POST", revokeRoute, {
      headers,
      params: { business_id: "biz-a", connection_id: "connection-1" },
      body: { force: true },
    });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 1);

    response = await dispatch("POST", revokeRoute, { headers, params: { business_id: "biz-a", connection_id: "connection-1" } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[1], ["revoke", "biz-a", "connection-1", "admin_token"]);
  });
});
