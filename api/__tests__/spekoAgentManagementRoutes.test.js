const assert = require("node:assert/strict");
const request = require("supertest");
const config = require("../config");
const { app, __testables } = require("../app");

describe("Speko agent management routes", () => {
  const priorAdminToken = config.admin.apiToken;
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
  });

  it("requires admin authentication for agent draft management", async () => {
    const response = await request(app).get("/admin/speko/agents/agent_1/draft");
    assert.equal(response.status, 403);
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
