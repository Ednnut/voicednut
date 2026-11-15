const assert = require("node:assert/strict");
const { registerPostCallExtractionRoutes } = require("../services/postCallExtractionRoutes");

function harness() {
  const routes = new Map();
  const record = {
    call_sid: "call-1", status: "pending_review", schema: {
      type: "object", additionalProperties: false, required: ["intent"],
      properties: { intent: { type: "string", enum: ["schedule", "question"] } },
    }, data: { intent: "schedule" },
  };
  const calls = [];
  const db = {
    async listCallStructuredExtractions(filter) { calls.push(["list", filter]); return [record]; },
    async getCallStructuredExtraction(callSid) { calls.push(["get", callSid]); return record; },
    async reviewCallStructuredExtraction(input) { calls.push(["review", input]); return { ...record, status: input.decision }; },
    async getCallEBusinessOperator(businessId, actor) { return businessId === "biz-1" && actor === "12345" ? { role: "policy_manager" } : null; },
  };
  const app = Object.fromEntries(["get", "post"].map((method) => [method, (route, ...handlers) => routes.set(`${method.toUpperCase()} ${route}`, handlers)]));
  const requireAdminToken = (req, res, next) => req.get("x-admin") === "authorized" ? next() : res.status(403).json({ success: false });
  const requireMiniAppSession = (req, res, next) => req.miniAppSession ? next() : res.status(401).json({ success: false });
  const sendApiError = (res, status, code, message, requestId) => res.status(status).json({ success: false, error: { code, message }, request_id: requestId || null });
  registerPostCallExtractionRoutes(app, { db, requireAdminToken, requireMiniAppSession, sendApiError });
  async function dispatch(method, route, options = {}) {
    const handlers = routes.get(`${method} ${route}`);
    assert.ok(handlers, `missing route ${method} ${route}`);
    const req = { params: options.params || {}, query: options.query || {}, body: options.body || {}, miniAppSession: options.miniAppSession, requestId: "extract-test", get: (key) => options.headers?.[key] };
    const res = { statusCode: 200, body: null, ended: false, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; this.ended = true; return this; } };
    for (const handler of handlers) {
      let next = false;
      await handler(req, res, () => { next = true; });
      if (!next || res.ended) break;
    }
    return res;
  }
  return { dispatch, calls };
}

describe("Post-call extraction review routes", () => {
  it("requires admin auth and validates corrections against the pinned extraction schema", async () => {
    const { dispatch, calls } = harness();
    const denied = await dispatch("GET", "/post-call/extractions");
    assert.equal(denied.statusCode, 403);
    assert.equal(calls.length, 0);

    const bad = await dispatch("POST", "/post-call/extractions/:call_sid/review", {
      headers: { "x-admin": "authorized" }, params: { call_sid: "call-1" },
      body: { decision: "corrected", corrected_data: { intent: "make purchase" } },
    });
    assert.equal(bad.statusCode, 400);

    const good = await dispatch("POST", "/post-call/extractions/:call_sid/review", {
      headers: { "x-admin": "authorized" }, params: { call_sid: "call-1" },
      body: { decision: "corrected", corrected_data: { intent: "question" }, review_note: "checked transcript" },
    });
    assert.equal(good.statusCode, 200);
    assert.equal(good.body.extraction.status, "corrected");
    const review = calls.find(([kind]) => kind === "review")[1];
    assert.equal(review.reviewed_by, "admin_token");
    assert.deepEqual(review.corrected_data, { intent: "question" });
  });

  it("scopes business reads and reviews to membership, with policy-manager reviewer attribution", async () => {
    const { dispatch, calls } = harness();
    const base = "/miniapp/businesses/:business_id/post-call/extractions";
    const session = { telegram_id: "12345" };
    const list = await dispatch("GET", base, { params: { business_id: "biz-1" }, miniAppSession: session });
    assert.equal(list.statusCode, 200);
    assert.equal(calls[0][1].business_id, "biz-1");

    const reviewed = await dispatch("POST", `${base}/:call_sid/review`, {
      params: { business_id: "biz-1", call_sid: "call-1" }, miniAppSession: session,
      body: { decision: "approved" },
    });
    assert.equal(reviewed.statusCode, 200);
    assert.equal(calls.find(([kind]) => kind === "review")[1].reviewed_by, "12345");
    assert.equal(calls.find(([kind]) => kind === "review")[1].business_id, "biz-1");
  });
});
