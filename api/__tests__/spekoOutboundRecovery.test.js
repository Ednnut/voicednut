const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");

const config = require("../config");
const providerState = require("../adapters/providerState");
const priorProvider = providerState.getActiveCallProvider();
const priorSpekoConfig = { ...config.speko };
const priorHostname = config.server?.hostname;
config.server.hostname = "api.example.test";
Object.assign(config.speko, {
  enabled: true,
  apiKey: "speko-test-key",
  agentId: "agent_test",
  phoneNumber: "+12015550199",
  webhookSecret: `whsec_${Buffer.from("speko-test-secret").toString("base64")}`,
  requestTimeoutMs: 30000,
  maxDurationSeconds: 300,
  ringTimeoutSeconds: 45,
});
providerState.setActiveCallProvider("speko");
const { __testables } = require("../app");
__testables.syncRuntimeProviderMirrors();

function outboundPayload(idempotencyKey) {
  return {
    number: "+12015550123",
    prompt: "Help the caller with their appointment.",
    first_message: "Hello, how can I help?",
    idempotency_key: idempotencyKey,
    preferred_provider: "speko",
  };
}

function fakeAdapter({ uncertainFirst = false } = {}) {
  const state = { dialCount: 0, recoveryCount: 0, session: null, threw: false };
  return {
    state,
    async createOrRecoverCall(options) {
      if (options.reconcile) {
        state.recoveryCount += 1;
        return state.session;
      }
      state.dialCount += 1;
      state.session = {
        sessionId: `session_${options.callId}`,
        status: "dialing",
        raw: { callControlId: "control_test" },
      };
      if (uncertainFirst && !state.threw) {
        state.threw = true;
        const error = new Error("simulated timeout after provider acceptance");
        error.code = "speko_dial_timeout";
        error.uncertain = true;
        throw error;
      }
      return state.session;
    },
  };
}

describe("Speko outbound call recovery", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `voicednut-speko-outbound-${Date.now()}-${Math.random()}.sqlite`,
    );
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    __testables.setDbForTests(db);
  });

  afterEach(async () => {
    __testables.setSpekoVoiceAdapterForTests(null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (db?.db) await new Promise((resolve) => db.db.close(() => resolve()));
    __testables.setDbForTests(null);
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => {
      try { fs.unlinkSync(file); } catch (_) {}
    });
  });

  it("recovers an accepted call after a timeout without placing another call", async () => {
    const adapter = fakeAdapter({ uncertainFirst: true });
    __testables.setSpekoVoiceAdapterForTests(adapter);
    const payload = outboundPayload("recover-after-timeout");

    await assert.rejects(
      __testables.placeOutboundCall(payload, "api.example.test"),
      { uncertain: true, code: "speko_dial_timeout" },
    );
    const recovered = await __testables.placeOutboundCall(payload, "api.example.test");
    const replay = await __testables.placeOutboundCall(payload, "api.example.test");

    assert.equal(recovered.provider, "speko");
    assert.equal(recovered.callId, replay.callId);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(adapter.state.dialCount, 1);
    assert.equal(adapter.state.recoveryCount, 1);
  });

  it("reconciles provider acceptance when local call persistence fails", async () => {
    const adapter = fakeAdapter();
    __testables.setSpekoVoiceAdapterForTests(adapter);
    const originalUpdateCallState = db.updateCallState.bind(db);
    let failCallCreatedOnce = true;
    db.updateCallState = async (callSid, stateType, statePayload) => {
      if (stateType === "call_created" && failCallCreatedOnce) {
        failCallCreatedOnce = false;
        throw new Error("simulated local persistence failure");
      }
      return originalUpdateCallState(callSid, stateType, statePayload);
    };
    const payload = outboundPayload("recover-after-persistence-failure");

    await assert.rejects(
      __testables.placeOutboundCall(payload, "api.example.test"),
      { code: "outbound_persistence_failed" },
    );
    const recovered = await __testables.placeOutboundCall(payload, "api.example.test");

    assert.equal(recovered.provider, "speko");
    assert.equal(adapter.state.dialCount, 1);
    assert.equal(adapter.state.recoveryCount, 1);
    const idempotency = await db.getOutboundCallIdempotency("recover-after-persistence-failure");
    assert.equal(idempotency.status, "completed");
    assert.ok(await db.getCall(idempotency.call_sid));
  });
});

after(() => {
  Object.assign(config.speko, priorSpekoConfig);
  config.server.hostname = priorHostname;
  providerState.setActiveCallProvider(priorProvider);
  __testables.syncRuntimeProviderMirrors();
});
