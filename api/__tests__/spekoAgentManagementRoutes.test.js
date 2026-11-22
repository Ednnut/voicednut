const assert = require("node:assert/strict");
const request = require("supertest");
const config = require("../config");
const { app, __testables } = require("../app");

describe("Speko agent management routes", () => {
  const priorAdminToken = config.admin.apiToken;
  const priorAdminUserTokens = config.admin.userTokens;
  const priorSpekoConfig = { callControlEnabled: config.speko.callControlEnabled, brokerId: config.speko.brokerId };
  const priorOperators = config.telegram.operatorUserIds;
  const adminToken = "speko-agent-management-test-token";
  let adapter;

  before(() => {
    config.admin.apiToken = adminToken;
  });

  beforeEach(() => {
    adapter = {
      getAgentDraft: async () => ({
        has_draft: true,
        stale: false,
        draft_version_number: 4,
        changed_fields: ["systemPrompt"],
      }),
      deployAgentDraft: async () => ({ published_draft: true, version_number: 5 }),
      rollbackAgent: async (_agentId, targetVersion) => ({ version_number: 6, restored: targetVersion }),
    };
    __testables.setSpekoVoiceAdapterForTests(adapter);
  });

  afterEach(() => {
    __testables.setSpekoVoiceAdapterForTests(null);
  });

  after(() => {
    config.admin.apiToken = priorAdminToken;
    config.admin.userTokens = priorAdminUserTokens;
    config.speko.callControlEnabled = priorSpekoConfig.callControlEnabled;
    config.speko.brokerId = priorSpekoConfig.brokerId;
    config.telegram.operatorUserIds = priorOperators;
  });

  it("requires admin authentication for agent draft management", async () => {
    const response = await request(app).get("/admin/speko/agents/agent_1/draft");
    assert.equal(response.status, 403);
  });

  it("requires admin authentication for call transfers and human call control", async () => {
    const transfer = await request(app)
      .post("/admin/speko/calls/call_1/transfers/blind")
      .send({ to: "+12015550123" });
    const humanDial = await request(app)
      .post("/admin/speko/call-control/dial")
      .send({ to: "+12015550123" });
    const command = await request(app)
      .post("/admin/speko/call-control/controls/control_1/hangup");
    const presenceToken = await request(app)
      .post("/admin/speko/call-control/presence/token");
    const join = await request(app)
      .post("/admin/speko/call-control/legs/control_1/join");
    const reconcile = await request(app)
      .post("/admin/speko/call-control/calls/call_1/reconcile");
    const audit = await request(app).get("/admin/speko/call-control/audit");
    const ownerAssignment = await request(app)
      .put("/admin/speko/call-control/brokers/broker-test/owner")
      .set("x-admin-token", adminToken)
      .send({ telegramUserId: "12345" });
    const metrics = await request(app).get("/admin/speko/metrics");

    assert.equal(transfer.status, 403);
    assert.equal(humanDial.status, 403);
    assert.equal(command.status, 403);
    assert.equal(presenceToken.status, 403);
    assert.equal(join.status, 403);
    assert.equal(reconcile.status, 403);
    assert.equal(audit.status, 403);
    assert.equal(ownerAssignment.status, 403);
    assert.equal(metrics.status, 403);
  });

  it("returns no-store broker presence and join credentials only to admins", async () => {
    __testables.setSpekoCallControlServiceForTests({
      getPresenceToken: async () => ({ token: "presence-token", url: "wss://example.test" }),
      join: async (controlId) => ({ token: "join-token", controlId }),
    });
    try {
      const presence = await request(app)
        .post("/admin/speko/call-control/presence/token")
        .set("x-admin-token", adminToken);
      const joined = await request(app)
        .post("/admin/speko/call-control/legs/browser_control_1/join")
        .set("x-admin-token", adminToken);
      assert.equal(presence.status, 200);
      assert.equal(presence.headers["cache-control"], "no-store");
      assert.equal(presence.body.token, "presence-token");
      assert.equal(joined.status, 200);
      assert.equal(joined.headers["cache-control"], "no-store");
      assert.equal(joined.body.controlId, "browser_control_1");
    } finally {
      __testables.setSpekoCallControlServiceForTests(null);
    }
  });

  it("uses a configured named admin token for verified human-control audit attribution", async () => {
    config.admin.userTokens = { "ops-alice": "a-strong-test-admin-token-with-at-least-32-chars" };
    let auditContext;
    __testables.setSpekoCallControlServiceForTests({
      command: async (_command, _controlId, _body, context) => (auditContext = context, { ok: true }),
    });
    try {
      const response = await request(app)
        .post("/admin/speko/call-control/controls/control_1/hangup")
        .set("x-admin-token", config.admin.userTokens["ops-alice"])
        .set("x-admin-user", "spoofed-name");
      assert.equal(response.status, 200);
      assert.equal(auditContext.actorId, "ops-alice");
      assert.equal(auditContext.actorSource, "named_admin_token");
    } finally {
      __testables.setSpekoCallControlServiceForTests(null);
    }
  });

  it("assigns the configured broker only with a named admin token and audits the verified actor", async () => {
    config.admin.userTokens = { "ops-alice": "a-strong-test-admin-token-with-at-least-32-chars" };
    config.speko.callControlEnabled = true;
    config.speko.brokerId = "broker-test";
    config.telegram.operatorUserIds = ["12345"];
    const dbCalls = [];
    __testables.setDbForTests({
      startSpekoHumanCallControlAudit: async (entry) => (dbCalls.push(["start", entry]), 14),
      finishSpekoHumanCallControlAudit: async (entry) => dbCalls.push(["finish", entry]),
      setSpekoHumanBrokerOwner: async (entry) => (dbCalls.push(["owner", entry]), entry),
    });
    try {
      const legacy = await request(app)
        .put("/admin/speko/call-control/brokers/broker-test/owner")
        .set("x-admin-token", adminToken)
        .send({ telegramUserId: "12345" });
      assert.equal(legacy.status, 403);

      const assigned = await request(app)
        .put("/admin/speko/call-control/brokers/broker-test/owner")
        .set("x-admin-token", config.admin.userTokens["ops-alice"])
        .set("x-admin-user", "spoofed-name")
        .send({ telegramUserId: "12345" });
      assert.equal(assigned.status, 200);
      assert.deepEqual(assigned.body.owner, { broker_id: "broker-test", telegram_user_id: "12345", assigned_by: "ops-alice" });
      assert.equal(dbCalls[0][1].actor_hint, "ops-alice");
      assert.equal(dbCalls[0][1].actor_source, "named_admin_token");
      assert.deepEqual(dbCalls[1][1], {
        broker_id: "broker-test", telegram_user_id: "12345", assigned_by: "ops-alice",
      });
    } finally {
      __testables.setDbForTests(null);
    }
  });

  it("returns bounded provider and call metrics to administrators", async () => {
    const requestedHours = [];
    __testables.setDbForTests({
      getSpekoOperationalMetrics: async (hours) => {
        requestedHours.push(hours);
        return { period_hours: hours, events: [] };
      },
      getServiceHealthSummary: async (hours) => ({
        period_hours: hours,
        services: { speko: { outbound_call_created: { count: 2 } } },
      }),
    });
    try {
      const response = await request(app)
        .get("/admin/speko/metrics?hours=900")
        .set("x-admin-token", adminToken);
      assert.equal(response.status, 200);
      assert.equal(response.body.period_hours, 720);
      assert.deepEqual(requestedHours, [720]);
      assert.deepEqual(response.body.health, {
        outbound_call_created: { count: 2 },
      });
    } finally {
      __testables.setDbForTests(null);
    }
  });

  it("deploys only the explicitly reviewed, unchanged draft version", async () => {
    let deployments = 0;
    adapter.deployAgentDraft = async () => {
      deployments += 1;
      return { published_draft: true, version_number: 5 };
    };
    const noConfirmation = await request(app)
      .post("/admin/speko/agents/agent_1/deploy")
      .set("x-admin-token", adminToken)
      .send({ confirmed_draft_version_number: 4 });
    assert.equal(noConfirmation.status, 400);
    assert.equal(deployments, 0);

    adapter.getAgentDraft = async () => ({
      has_draft: true,
      stale: false,
      draft_version_number: 5,
    });
    const changedAfterReview = await request(app)
      .post("/admin/speko/agents/agent_1/deploy")
      .set("x-admin-token", adminToken)
      .send({ confirm_live_deploy: "agent_1", confirmed_draft_version_number: 4 });
    assert.equal(changedAfterReview.status, 409);
    assert.equal(deployments, 0);

    adapter.getAgentDraft = async () => ({
      has_draft: true,
      stale: false,
      draft_version_number: 4,
    });
    const deployed = await request(app)
      .post("/admin/speko/agents/agent_1/deploy")
      .set("x-admin-token", adminToken)
      .send({ confirm_live_deploy: "agent_1", confirmed_draft_version_number: 4 });
    assert.equal(deployed.status, 200);
    assert.equal(deployments, 1);
  });

  it("requires a version-specific confirmation before rollback", async () => {
    let rollbacks = 0;
    adapter.rollbackAgent = async (_agentId, version) => {
      rollbacks += 1;
      return { version_number: 6, restored: version };
    };
    const rejected = await request(app)
      .post("/admin/speko/agents/agent_1/rollback")
      .set("x-admin-token", adminToken)
      .send({ target_version_number: 2, confirm_live_rollback: "agent_1:1" });
    assert.equal(rejected.status, 400);
    assert.equal(rollbacks, 0);

    const accepted = await request(app)
      .post("/admin/speko/agents/agent_1/rollback")
      .set("x-admin-token", adminToken)
      .send({ target_version_number: 2, confirm_live_rollback: "agent_1:2" });
    assert.equal(accepted.status, 200);
    assert.equal(rollbacks, 1);
  });
});
