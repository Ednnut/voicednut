const assert = require("node:assert/strict");

const { registerPostCallWorkflowDefinitionRoutes } = require("../services/postCallWorkflowDefinitionRoutes");

function createHarness() {
  const routes = new Map();
  const calls = [];
  const service = {
    async listVersions(workflowId, limit, businessId) { calls.push(["list", workflowId, limit, businessId]); return []; },
    async createDraft(definition, actor, businessId) { calls.push(["create", definition, actor, businessId]); return { workflow_id: definition.workflow_id, business_id: businessId, version: 1, status: "draft" }; },
    async approveVersion(workflowId, version, actor, businessId) { calls.push(["approve", workflowId, version, actor, businessId]); return { workflow_id: workflowId, business_id: businessId, version: Number(version), status: "approved" }; },
  };
  const executionService = {
    async listRuns(limit, businessId) { calls.push(["runs", limit, businessId]); return []; },
    async getRun(runId, businessId) { calls.push(["get_run", runId, businessId]); return { run_id: runId, status: "completed" }; },
    async start(input, actor, businessId) { calls.push(["start_run", input, actor, businessId]); return { run_id: "run-1", status: "completed" }; },
    async approveStep(runId, stepId, actor, businessId) { calls.push(["approve_step", runId, stepId, actor, businessId]); return { run_id: runId, status: "completed" }; },
    async cancelRun(runId, businessId) { calls.push(["cancel_run", runId, businessId]); return { run_id: runId, status: "canceled" }; },
    async retryFailedEmailStep(runId, stepId, actor, businessId) { calls.push(["retry_email", runId, stepId, actor, businessId]); return { run_id: runId, status: "queued" }; },
    async reviewRun(runId, decision, actor, businessId) { calls.push(["review_run", runId, decision, actor, businessId]); return { run_id: runId, status: "failed", review_decision: decision }; },
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
<<<<<<< HEAD
  registerPostCallWorkflowDefinitionRoutes(app, {
    getService: () => service,
    getExecutionService: () => executionService,
    requireAdminToken,
    sendApiError,
  });
=======
  const db = { async getCallEBusinessOperator(businessId, telegramId) {
    return businessId === "business-a" && telegramId === "12345" ? { role: "policy_manager" } : null;
  } };
  const requireMiniAppSession = (req, _res, next) => { req.miniAppSession = { telegram_id: "12345" }; return next(); };
  registerPostCallWorkflowDefinitionRoutes(app, { db, getService: () => service, getExecutionService: () => executionService, requireAdminToken, requireMiniAppSession, sendApiError });
>>>>>>> 95a068c (updated)

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

<<<<<<< HEAD
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
=======
  it("protects workflow run controls with admin authorization and exposes only execution state", async () => {
    const { dispatch, calls } = createHarness();
    let response = await dispatch("POST", "/post-call/workflow-runs");
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);

    response = await dispatch("POST", "/post-call/workflow-runs/:run_id/review", {
      params: { run_id: "run-1" }, body: { decision: "confirm_failed" },
    });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);

    response = await dispatch("POST", "/post-call/workflow-runs/:run_id/steps/:step_id/retry", {
      params: { run_id: "run-1", step_id: "email" },
    });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);

    response = await dispatch("POST", "/post-call/workflow-runs", {
      headers: { "x-admin": "authorized" },
      body: { workflow_id: "followup", version: 1, idempotency_key: "request-12345678", payload: { email: "private@example.test" } },
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.run.run_id, "run-1");
    assert.equal("payload" in response.body.run, false);

    response = await dispatch("POST", "/post-call/workflow-runs/:run_id/cancel", {
      headers: { "x-admin": "authorized" }, params: { run_id: "run-1" },
    });
    assert.equal(response.body.run.status, "canceled");
    response = await dispatch("POST", "/post-call/workflow-runs/:run_id/steps/:step_id/retry", {
      headers: { "x-admin": "authorized" }, params: { run_id: "run-1", step_id: "email" },
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.run.status, "queued");
    response = await dispatch("POST", "/post-call/workflow-runs/:run_id/review", {
      headers: { "x-admin": "authorized" }, params: { run_id: "run-1" }, body: { decision: "confirm_failed" },
    });
    assert.equal(response.body.run.review_decision, "confirm_failed");
    assert.deepEqual(calls.map(([kind]) => kind), ["start_run", "cancel_run", "retry_email", "review_run"]);
    assert.equal(calls[0][2], "admin_token");
    assert.equal(calls[2][3], "admin_token");
    assert.equal(calls[3][3], "admin_token");
  });

  it("requires authenticated business membership and passes verified scope to workflow services", async () => {
    const { dispatch, calls } = createHarness();
    let response = await dispatch("GET", "/miniapp/businesses/:business_id/post-call/workflows", {
      params: { business_id: "business-b" },
    });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);

    response = await dispatch("GET", "/miniapp/businesses/:business_id/post-call/workflows", {
      params: { business_id: "business-a" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.business_id, "business-a");
    assert.equal(calls[0][0], "list");
    assert.equal(calls[0][3], "business-a");

    response = await dispatch("POST", "/miniapp/businesses/:business_id/post-call/workflows", {
      params: { business_id: "business-a" },
      body: { schema_version: 1, workflow_id: "tenant_flow", name: "Tenant flow", trigger_event: "post_call.completed", start_step_id: "end", steps: [{ id: "end", type: "end" }] },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.version.business_id, "business-a");
    assert.equal(calls[1][2], "12345");
    assert.equal(calls[1][3], "business-a");
>>>>>>> 95a068c (updated)
  });
});
