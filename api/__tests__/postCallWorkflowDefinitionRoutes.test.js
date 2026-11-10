const assert = require("node:assert/strict");

const { registerPostCallWorkflowDefinitionRoutes } = require("../services/postCallWorkflowDefinitionRoutes");

function createHarness(options = {}) {
  const routes = new Map();
  const calls = [];
  const service = {
    async listVersions(workflowId, limit, businessId) { calls.push(["list", workflowId, limit, businessId]); return []; },
    async createDraft(definition, actor, businessId) { calls.push(["create", definition, actor, businessId]); return { workflow_id: definition.workflow_id, business_id: businessId || null, version: 1, status: "draft" }; },
    async approveVersion(workflowId, version, actor, businessId) { calls.push(["approve", workflowId, version, actor, businessId]); return { workflow_id: workflowId, business_id: businessId || null, version: Number(version), status: "approved" }; },
  };
  const executionService = {
    async listRuns(filters) { calls.push(["runs", filters]); return []; },
    async getRun(runId, businessId) { calls.push(["getRun", runId, businessId]); return { run_id: runId, business_id: businessId, status: "waiting_approval", steps: [] }; },
    async approveRun(runId, actor) { calls.push(["approveRun", runId, actor]); return { run_id: runId, status: "queued" }; },
    async cancelRun(runId, actor) { calls.push(["cancelRun", runId, actor]); return { run_id: runId, status: "canceled" }; },
  };
  const app = Object.fromEntries(["get", "post"].map((method) => [method, (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers)]));
  const requireAdminToken = (req, res, next) => req.get("x-admin") === "authorized" ? next() : res.status(403).json({ success: false });
  const sendApiError = (res, status, code, message, requestId) => res.status(status).json({ success: false, error: { code, message }, request_id: requestId || null });
  registerPostCallWorkflowDefinitionRoutes(app, {
    db: options.db || { async getCallEBusinessOperator(businessId, telegramId) {
      return businessId === "biz-42" && telegramId === "123456" ? { role: options.role || "policy_manager" } : null;
    } },
    getService: () => service,
    getExecutionService: () => executionService,
    requireAdminToken,
    requireMiniAppSession: (req, res, next) => req.miniAppSession ? next() : res.status(401).json({ success: false }),
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
      miniAppSession: options.miniAppSession,
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
    assert.deepEqual(calls[0], ["list", "followup", "12", undefined]);
  });

  it("restores Mini App workflow routes with membership authorization and enforced business scope", async () => {
    const { dispatch, calls } = createHarness();
    const session = { telegram_id: "123456" };
    const base = "/miniapp/businesses/:business_id/post-call";
    let response = await dispatch("GET", `${base}/workflows`, {
      params: { business_id: "biz-42" }, miniAppSession: session,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1), ["list", undefined, undefined, "biz-42"]);

    response = await dispatch("POST", `${base}/workflows`, {
      params: { business_id: "biz-42" }, miniAppSession: session,
      body: { workflow_id: "business_followup", trigger_event: "post_call_completed" },
    });
    assert.equal(response.status, 201);
    assert.deepEqual(calls.at(-1), ["create", { workflow_id: "business_followup", trigger_event: "post_call_completed" }, "123456", "biz-42"]);

    response = await dispatch("POST", `${base}/workflows/:workflow_id/versions/:version/approve`, {
      params: { business_id: "biz-42", workflow_id: "business_followup", version: "1" },
      miniAppSession: session,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1), ["approve", "business_followup", "1", "123456", "biz-42"]);

    response = await dispatch("GET", `${base}/workflow-runs`, {
      params: { business_id: "biz-42" }, miniAppSession: session,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-1), ["runs", { business_id: "biz-42", limit: undefined }]);
  });

  it("denies builder writes to non-policy-manager memberships and does not resolve services", async () => {
    const { dispatch, calls } = createHarness({ role: "call_operator" });
    const response = await dispatch("POST", "/miniapp/businesses/:business_id/post-call/workflows", {
      params: { business_id: "biz-42" },
      miniAppSession: { telegram_id: "123456" },
      body: { workflow_id: "business_followup" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(calls, []);
  });
});
