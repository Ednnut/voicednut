const assert = require("node:assert/strict");
const request = require("supertest");
const config = require("../config");
const { createMiniAppSessionToken } = require("../services/miniappAuth");
const { app, __testables } = require("../app");

describe("Speko Mini App broker ownership routes", () => {
  const userId = "783219991";
  const secret = "speko-miniapp-test-session-secret";
  const prior = {
    sessionSecret: config.miniApp.sessionSecret,
    operatorUserIds: config.telegram.operatorUserIds,
    brokerId: config.speko.brokerId,
  };
  let called = [];

  before(() => {
    config.miniApp.sessionSecret = secret;
    config.telegram.operatorUserIds = [...(config.telegram.operatorUserIds || []), userId];
    config.speko.brokerId = "broker-1";
  });

  beforeEach(() => {
    called = [];
    __testables.setDbForTests({
      getSpekoHumanBrokerOwner: async ({ telegram_user_id }) => telegram_user_id === userId
        ? { broker_id: "broker-1", telegram_user_id: userId }
        : null,
      getSpekoHumanCallLeg: async ({ control_id }) => control_id === "owned-control"
        ? { call_id: "owned-call", broker_id: null }
        : { call_id: "other-call", broker_id: null },
      isSpekoHumanCallOwnedByBroker: async ({ call_id, broker_id }) =>
        call_id === "owned-call" && broker_id === "broker-1",
    });
  });

  afterEach(() => {
    __testables.setDbForTests(null);
    __testables.setSpekoCallControlServiceForTests(null);
  });

  after(() => {
    config.miniApp.sessionSecret = prior.sessionSecret;
    config.telegram.operatorUserIds = prior.operatorUserIds;
    config.speko.brokerId = prior.brokerId;
  });

  function sessionHeader() {
    const token = createMiniAppSessionToken({
      telegram_id: userId, jti: `speko-test-${Date.now()}-${Math.random()}`,
    }, secret, { ttlSeconds: 600 });
    return { Authorization: `Bearer ${token}` };
  }

  it("requires a signed Mini App session and a provisioned broker owner", async () => {
    const unauthenticated = await request(app).get("/miniapp/speko/call-control/calls");
    assert.equal(unauthenticated.status, 401);
    const service = {
      listCalls: async (params) => (called.push(params), { calls: [
        { id: "owned-call", legs: [{ brokerId: "broker-1" }] },
        { id: "other-call", legs: [{ brokerId: "broker-2" }] },
      ] }),
    };
    __testables.setSpekoCallControlServiceForTests(service);
    const response = await request(app).get("/miniapp/speko/call-control/calls").set(sessionHeader());
    assert.equal(response.status, 200);
    assert.deepEqual(called, [{ brokerId: "broker-1", limit: undefined }]);
    assert.deepEqual(response.body.calls.map((call) => call.id), ["owned-call"]);
  });

  it("does not issue a command for another broker's call", async () => {
    const service = {
      command: async (...args) => (called.push(args), { ok: true }),
    };
    __testables.setSpekoCallControlServiceForTests(service);
    const response = await request(app)
      .post("/miniapp/speko/call-control/controls/other-control/hangup")
      .set(sessionHeader());
    assert.equal(response.status, 404);
    assert.deepEqual(called, []);
  });

  it("limits call commands to the assigned Telegram user's broker and audits the verified actor", async () => {
    let auditContext;
    __testables.setSpekoCallControlServiceForTests({
      command: async (_command, _controlId, _body, context) => (auditContext = context, { ok: true }),
    });
    const response = await request(app)
      .post("/miniapp/speko/call-control/controls/owned-control/hangup")
      .set(sessionHeader());
    assert.equal(response.status, 200);
    assert.equal(auditContext.actorId, userId);
    assert.equal(auditContext.actorSource, "miniapp_session");
  });

  it("refreshes broker-scoped calls before authorizing a newly arrived ring offer", async () => {
    let mapped = false;
    __testables.setDbForTests({
      getSpekoHumanBrokerOwner: async () => ({ broker_id: "broker-1", telegram_user_id: userId }),
      getSpekoHumanCallLeg: async () => mapped ? { call_id: "incoming-call", broker_id: "broker-1" } : null,
      isSpekoHumanCallOwnedByBroker: async () => true,
    });
    __testables.setSpekoCallControlServiceForTests({
      refreshCallsForBroker: async (brokerId, limit) => {
        called.push(["refresh", brokerId, limit]);
        mapped = true;
      },
      join: async (controlId) => (called.push(["join", controlId]), { token: "short", url: "wss://rtc.example" }),
    });
    const response = await request(app)
      .post("/miniapp/speko/call-control/legs/incoming-control/join")
      .set(sessionHeader());
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(called, [["refresh", "broker-1", 100], ["join", "incoming-control"]]);
  });
});
