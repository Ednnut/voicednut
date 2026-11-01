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
  const executionService = {
    async listRuns(filters) { calls.push(["runs", filters]); return []; },
    async getRun(runId) { calls.push(["getRun", runId]); return { run_id: runId, status: "waiting_approval", steps: [] }; },
    async approveRun(runId, actor) { calls.push(["approveRun", runId, actor]); return { run_id: runId, status: "queued" }; },
    async cancelRun(runId, actor) { calls.push(["cancelRun", runId, actor]); return { run_id: runId, status: "canceled" }; },
  };
  const app = Object.fromEntries(["get", "post"].map((method) => [method, (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers)]));
  const requireAdminToken = (req, res, next) => req.get("x-admin") === "authorized" ? next() : res.status(403).json({ success: false });
  const sendApiError = (res, status, code, message, requestId) => res.status(status).json({ success: false, error: { code, message }, request_id: requestId || null });
  registerPostCallWorkflowDefinitionRoutes(app, {
    getService: () => service,
    getExecutionService: () => executionService,
    requireAdminToken,
    sendApiError,
  });

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

  it("keeps run audit, approval, and cancellation endpoints behind admin authorization", async () => {
    const { dispatch, calls } = createHarness();
    let response = await dispatch("GET", "/post-call/workflows/runs");
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);

    const headers = { "x-admin": "authorized" };
    response = await dispatch("GET", "/post-call/workflows/runs", { headers, query: { status: "waiting_approval", limit: "10" } });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], ["runs", { workflow_id: undefined, status: "waiting_approval", trigger_reference: undefined, limit: "10" }]);

    response = await dispatch("POST", "/post-call/workflows/runs/:run_id/approve", { headers, params: { run_id: "run_1" } });
    assert.equal(response.body.run.status, "queued");
    response = await dispatch("POST", "/post-call/workflows/runs/:run_id/cancel", { headers, params: { run_id: "run_1" } });
    assert.equal(response.body.run.status, "canceled");
    assert.deepEqual(calls.slice(1), [["approveRun", "run_1", "admin_token"], ["cancelRun", "run_1", "admin_token"]]);
  });

  it("passes a requested workflow filter to the global version list", async () => {
    const { dispatch, calls } = createHarness();
    const response = await dispatch("GET", "/post-call/workflows", {
      headers: { "x-admin": "authorized" },
      query: { workflow_id: "followup", limit: "12" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], ["list", "followup", "12"]);
  });
});
