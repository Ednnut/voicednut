const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");

const config = require("../config");
const providerState = require("../adapters/providerState");
const priorProvider = providerState.getActiveCallProvider();
const priorSpekoConfig = { ...config.speko };
const priorInboundRoutes = config.inbound.routes;
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
    Object.assign(config.speko, priorSpekoConfig, {
      enabled: true,
      apiKey: "speko-test-key",
      agentId: "agent_test",
      phoneNumber: "+12015550199",
      webhookSecret: `whsec_${Buffer.from("speko-test-secret").toString("base64")}`,
      requestTimeoutMs: 30000,
      maxDurationSeconds: 300,
      ringTimeoutSeconds: 45,
    });
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
    Object.assign(config.speko, priorSpekoConfig);
    config.inbound.routes = priorInboundRoutes;
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

  it("creates an idempotent inbound record for a configured Speko route", async () => {
    Object.assign(config.speko, {
      enabled: true,
      inboundEnabled: true,
      inboundPhoneNumber: "+12015550199",
      agentId: "agent_test",
    });
    config.inbound.routes = {
      "+12015550199": {
        user_chat_id: "chat-123",
        prompt: "Inbound support prompt",
        first_message: "Thanks for calling.",
      },
    };
    const event = {
      type: "call.pre_call",
      call_id: "session_inbound_123",
      session_id: "session_inbound_123",
      direction: "inbound",
      from: "+12015550123",
      to: "+12015550199",
      phone_number_id: "pn_inbound_123",
      agent_id: "agent_test",
    };

    const first = await __testables.handleSpekoPreCall(event);
    const callSid = first.metadata.voicednut_call_id;
    const second = await __testables.handleSpekoPreCall(event);
    const call = await db.getCall(callSid);
    const createdState = await db.getLatestCallState(callSid, "call_created");

    assert.equal(second.metadata.voicednut_call_id, callSid);
    assert.equal(call.direction, "inbound");
    assert.equal(call.phone_number, "+12015550123");
    assert.equal(call.user_chat_id, "chat-123");
    assert.equal(createdState.provider, "speko");
    assert.equal(createdState.provider_metadata.speko_session_id, "session_inbound_123");
    assert.equal(createdState.provider_metadata.speko_phone_number_id, "pn_inbound_123");
  });

  it("accepts a signed inbound agent identity without a global SPEKO_AGENT_ID", async () => {
    Object.assign(config.speko, {
      enabled: true,
      inboundEnabled: true,
      inboundPhoneNumber: "+12015550199",
      agentId: "",
    });
    config.inbound.routes = {
      "+12015550199": { user_chat_id: "chat-dynamic-agent" },
    };
    const result = await __testables.handleSpekoPreCall({
      type: "call.pre_call",
      call_id: "session_dynamic_inbound",
      session_id: "session_dynamic_inbound",
      direction: "inbound",
      from: "+12015550123",
      to: "+12015550199",
      phone_number_id: "pn_inbound_dynamic",
      agent_id: "agent_created_in_speko",
    });
    const call = await db.getCall(result.metadata.voicednut_call_id);
    const state = await db.getLatestCallState(result.metadata.voicednut_call_id, "call_created");
    assert.equal(call.direction, "inbound");
    assert.equal(state.provider_metadata.speko_agent_id, "agent_created_in_speko");
  });

  it("rejects disabled, unassigned, and mismatched-agent inbound sessions", async () => {
    Object.assign(config.speko, {
      enabled: true,
      inboundEnabled: true,
      inboundPhoneNumber: "+12015550199",
      agentId: "agent_test",
    });
    config.inbound.routes = {
      "+12015550199": { user_chat_id: "chat-123" },
    };
    const event = {
      type: "call.pre_call",
      call_id: "session_inbound_rejected",
      session_id: "session_inbound_rejected",
      direction: "inbound",
      from: "+12015550123",
      to: "+12015550100",
    };

    await assert.rejects(__testables.handleSpekoPreCall(event), {
      code: "speko_inbound_number_unassigned",
      status: 403,
    });
    await assert.rejects(
      __testables.handleSpekoPreCall({
        ...event,
        to: "+12015550199",
        agent_id: "other_agent",
      }),
      { code: "speko_inbound_agent_mismatch", status: 403 },
    );
    config.speko.inboundEnabled = false;
    await assert.rejects(
      __testables.handleSpekoPreCall({ ...event, to: "+12015550199" }),
      { code: "speko_inbound_disabled", status: 403 },
    );
  });

  it("reconciles call status from the bounded Speko event and call reads", async () => {
    const adapter = fakeAdapter();
    let detailReads = 0;
    let eventReads = 0;
    adapter.getCall = async (sessionId) => {
      detailReads += 1;
      return {
        id: sessionId,
        status: "ended",
        metadata: { voicednut_call_id: callId },
        report: null,
      };
    };
    adapter.getCallEvents = async () => {
      eventReads += 1;
      return [
        {
          id: "evt_1",
          event_type: "call.initiated",
          status: "dialing",
          payload: { sequence: 1 },
        },
        {
          id: "evt_2",
          event_type: "call.answered",
          status: "active",
          payload: { sequence: 2 },
        },
        {
          id: "evt_3",
          event_type: "call.hangup",
          status: "ended",
          payload: { sequence: 3 },
        },
      ];
    };
    __testables.setSpekoVoiceAdapterForTests(adapter);
    const created = await __testables.placeOutboundCall(
      outboundPayload("reconcile-lifecycle"),
      "api.example.test",
    );
    const callId = created.callId;

    const result = await __testables.reconcileSpekoCall(callId);
    assert.equal(result.status, "completed");
    assert.equal(result.events_examined, 3);
    assert.equal(result.latest_sequence, 3);
    assert.equal((await db.getCall(callId)).status, "completed");
    assert.equal((await db.getLatestCallState(callId, "speko_reconciliation")).outcome, "complete");
    await assert.rejects(__testables.reconcileSpekoCall(callId), {
      code: "speko_reconciliation_rate_limited",
      status: 429,
    });
    assert.equal(detailReads, 1);
    assert.equal(eventReads, 1);
  });
});

after(() => {
  Object.assign(config.speko, priorSpekoConfig);
  config.server.hostname = priorHostname;
  providerState.setActiveCallProvider(priorProvider);
  __testables.syncRuntimeProviderMirrors();
});
