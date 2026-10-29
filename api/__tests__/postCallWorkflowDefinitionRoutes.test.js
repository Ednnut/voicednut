const assert = require("node:assert/strict");

const { registerPostCallWorkflowDefinitionRoutes } = require("../services/postCallWorkflowDefinitionRoutes");

function createHarness() {
  const routes = new Map();
  const calls = [];
  const service = {
    async listVersions(workflowId, limit) { calls.push(["list", workflowId, limit]); return []; },
    async createDraft(definition, actor) { calls.push(["create", definition, actor]); return { workflow_id: definition.workflow_id, version: 1, status: "draft" }; },
    async approveVersion(workflowId, version, actor) { calls.push(["approve", workflowId, version, actor]); return { workflow_id: workflowId, version: Number(version), status: "approved" }; },
  };
  const app = Object.fromEntries(["get", "post"].map((method) => [method, (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers)]));
  const requireAdminToken = (req, res, next) => req.get("x-admin") === "authorized" ? next() : res.status(403).json({ success: false });
  const sendApiError = (res, status, code, message, requestId) => res.status(status).json({ success: false, error: { code, message }, request_id: requestId || null });
  registerPostCallWorkflowDefinitionRoutes(app, { getService: () => service, requireAdminToken, sendApiError });

  async function dispatch(method, route, options = {}) {
    const handlers = routes.get(`${method} ${route}`);
    assert.ok(handlers, `missing route ${method} ${route}`);
    const headers = options.headers || {};
    const req = {
      body: options.body || {},
      params: options.params || {},
      query: options.query || {},
      requestId: "request-workflow-test",
      get(name) { return headers[name] || headers[name.toLowerCase()]; },
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
      await handler(req, res, () => { nextCalled = true; });
      if (!nextCalled || res.ended) break;
    }
    return { status: res.statusCode, body: res.body };
  }
  return { dispatch, calls };
}

describe("Post-call workflow definition routes", () => {
  it("requires admin authorization and uses a stable API envelope for draft and approval operations", async () => {
    const { dispatch, calls } = createHarness();
    let response = await dispatch("GET", "/post-call/workflows");
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);

    response = await dispatch("POST", "/post-call/workflows", {
      headers: { "x-admin": "authorized" },
      body: { workflow_id: "followup" },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.version.status, "draft");

    response = await dispatch("POST", "/post-call/workflows/:workflow_id/versions/:version/approve", {
      headers: { "x-admin": "authorized" },
      params: { workflow_id: "followup", version: "1" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.version.status, "approved");
    assert.deepEqual(calls.map(([kind]) => kind), ["create", "approve"]);
    assert.equal(calls[0][2], "admin_token");
    assert.equal(calls[1][3], "admin_token");
  });
});
