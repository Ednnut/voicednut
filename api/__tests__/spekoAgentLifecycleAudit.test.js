const assert = require("node:assert/strict");
const request = require("supertest");
const config = require("../config");
const { app, __testables } = require("../app");

describe("Speko agent lifecycle audit", () => {
  const previousAdminToken = config.admin.apiToken;
  const previousUserTokens = config.admin.userTokens;
  const adminToken = "speko-lifecycle-audit-test-token";
  let events;
  let adapter;

  before(() => {
    config.admin.apiToken = adminToken;
    config.admin.userTokens = {};
  });

  beforeEach(() => {
    events = [];
    __testables.setDbForTests({
      async logServiceHealth(service, status, details) {
        if (service === "speko_agent_lifecycle") {
          events.push({ service, status, details });
        }
      },
      db: {
        all(_sql, params, callback) {
          assert.deepEqual(params, ["speko_agent_lifecycle", 25]);
          callback(null, [
            {
              status: "succeeded",
              timestamp: "2026-11-22 14:00:00",
              details: JSON.stringify({ operation: "deploy", agent_id: "agent_1" }),
            },
          ]);
        },
      },
    });
    adapter = {
      async getAgentDraft() {
        return { has_draft: true, stale: false, draft_version_number: 4 };
      },
      async deployAgentDraft() {
        return { version_number: 5 };
      },
      async rollbackAgent() {
        const error = new Error("provider accepted rollback but response was lost");
        error.code = "speko_rollback_uncertain";
        error.uncertain = true;
        error.status = 503;
        throw error;
      },
    };
    __testables.setSpekoVoiceAdapterForTests(adapter);
  });

  afterEach(() => {
    __testables.setDbForTests(null);
    __testables.setSpekoVoiceAdapterForTests(null);
  });

  after(() => {
    config.admin.apiToken = previousAdminToken;
    config.admin.userTokens = previousUserTokens;
  });

  it("persists the confirmed deployment and resulting provider version", async () => {
    const response = await request(app)
      .post("/admin/speko/agents/agent_1/deploy")
      .set("x-admin-token", adminToken)
      .send({ confirm_live_deploy: "agent_1", confirmed_draft_version_number: 4 });

    assert.equal(response.status, 200);
    assert.deepEqual(events.map((event) => event.status), ["started", "succeeded"]);
    assert.equal(events[0].service, "speko_agent_lifecycle");
    assert.equal(events[1].details.operation, "deploy");
    assert.equal(events[1].details.agent_id, "agent_1");
    assert.equal(events[1].details.reviewed_version, 4);
    assert.equal(events[1].details.resulting_version, 5);
    assert.equal(events[1].details.actor_source, "shared_admin_token");
    assert.equal(events[1].details.actor_id, null);
  });

  it("records ambiguous rollback outcomes without storing provider error text", async () => {
    const response = await request(app)
      .post("/admin/speko/agents/agent_1/rollback")
      .set("x-admin-token", adminToken)
      .send({ target_version_number: 2, confirm_live_rollback: "agent_1:2" });

    assert.equal(response.status, 503);
    assert.deepEqual(events.map((event) => event.status), ["started", "uncertain"]);
    assert.equal(events[1].details.operation, "rollback");
    assert.equal(events[1].details.target_version, 2);
    assert.equal(events[1].details.error_code, "speko_rollback_uncertain");
    assert.equal(JSON.stringify(events).includes("response was lost"), false);
  });

  it("exposes only bounded lifecycle records behind admin authentication", async () => {
    const denied = await request(app).get("/admin/speko/agent-lifecycle-audit");
    assert.equal(denied.status, 403);

    const response = await request(app)
      .get("/admin/speko/agent-lifecycle-audit")
      .set("x-admin-token", adminToken);
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.body.events[0], {
      status: "succeeded",
      timestamp: "2026-11-22 14:00:00",
      details: { operation: "deploy", agent_id: "agent_1" },
    });
  });
});
