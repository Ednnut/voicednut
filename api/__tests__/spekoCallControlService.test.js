const assert = require("node:assert/strict");
const { SpekoCallControlService } = require("../adapters/spekoCallControlService");

function createHarness(overrides = {}) {
  const calls = [];
  const client = {
    callControl: {
      dial: async (params) => (calls.push(["dial", params]), { call: { id: "human_1" } }),
      get: async (callId) => (calls.push(["get", callId]), { id: callId }),
      list: async (params) => (calls.push(["list", params]), { calls: [] }),
      events: async (callId) => (calls.push(["events", callId]), { events: [] }),
      presenceToken: async () => (calls.push(["presenceToken"]), { token: "short-token" }),
      join: async (controlId) => (calls.push(["join", controlId]), { token: "join-token" }),
      transfer: async (controlId, params) => (calls.push(["transfer", controlId, params]), params),
      bridge: async (controlId, params) => (calls.push(["bridge", controlId, params]), params),
      dtmf: async (controlId, params) => (calls.push(["dtmf", controlId, params]), params),
      hangup: async (controlId, params) => (calls.push(["hangup", controlId, params]), params),
      setStatus: async (status) => (calls.push(["setStatus", status]), { status }),
      register: async () => (calls.push(["register"]), { status: "available" }),
      heartbeat: async () => (calls.push(["heartbeat"]), { status: "available" }),
      answer: async (controlId) => (calls.push(["answer", controlId]), { status: "active" }),
    },
  };
  const config = {
    enabled: true,
    apiKey: "test-key",
    callControlEnabled: true,
    brokerId: "broker-test",
    ...overrides,
  };
  const voiceAdapter = {
    config,
    validateApiConfig: () => true,
    validateConfig: () => true,
    getClient: async () => client,
  };
  return { service: new SpekoCallControlService({ config, voiceAdapter, store: overrides.store }), calls };
}

describe("Speko human call-control service", () => {
  it("keeps AI call adapter separate and supports documented browser presence and join", async () => {
    const { service, calls } = createHarness();
    assert.deepEqual(await service.getPresenceToken(), { token: "short-token" });
    assert.deepEqual(await service.join("browser-control-1"), { token: "join-token" });
    assert.deepEqual(calls, [
      ["presenceToken"],
      ["join", "browser-control-1"],
    ]);
  });

  it("accepts PSTN or opaque broker control IDs for transfers", async () => {
    const { service, calls } = createHarness();
    await service.command("transfer", "pstn-control", {
      to: "+12015550124",
      mode: "blind",
    });
    await service.command("transfer", "browser-control", {
      to: "opaque-broker-leg-control-id",
      mode: "warm",
    });
    assert.deepEqual(calls, [
      ["transfer", "pstn-control", { to: "+12015550124", mode: "blind" }],
      ["transfer", "browser-control", { to: "opaque-broker-leg-control-id", mode: "warm" }],
    ]);
    await assert.rejects(
      service.command("transfer", "pstn-control", { to: "", mode: "blind" }),
      { code: "speko_invalid_transfer" },
    );
    await assert.rejects(
      service.command("transfer", "pstn-control", { to: "+12015550124", mode: "fast" }),
      { code: "speko_invalid_transfer" },
    );
  });

  it("validates call-control inputs and bounds list options", async () => {
    const { service, calls } = createHarness();
    await service.dial({ to: "+12015550124", metadata: ["ignored"] });
    await service.listCalls({ status: "active", limit: 20, ignored: "value" });
    await service.command("dtmf", "pstn-control", { digits: "1w2#" });
    await assert.rejects(service.getCall(" "), { code: "speko_missing_call_id" });
    await assert.rejects(service.join(" "), { code: "speko_missing_control_id" });
    await assert.rejects(service.listCalls({ limit: 101 }), {
      code: "speko_invalid_call_list_limit",
    });
    assert.deepEqual(calls, [
      ["dial", { to: "+12015550124" }],
      ["list", { status: "active", limit: 20 }],
      ["dtmf", "pstn-control", { digits: "1w2#" }],
    ]);
  });

  it("marks network and timeout dial failures uncertain while preserving definite rejections", async () => {
    const networkHarness = createHarness();
    networkHarness.service.voiceAdapter.getClient = async () => ({
      callControl: { ...networkHarness.calls, dial: async () => { throw new Error("socket closed"); } },
    });
    await assert.rejects(networkHarness.service.dial({ to: "+12015550124" }), {
      code: "speko_human_dial_uncertain", status: 503, uncertain: true,
    });

    const rejected = createHarness();
    rejected.service.voiceAdapter.getClient = async () => ({
      callControl: { dial: async () => { throw Object.assign(new Error("invalid destination"), { status: 422 }); } },
    });
    await assert.rejects(rejected.service.dial({ to: "+12015550124" }), { status: 422 });
  });

  it("fails closed when human calling is disabled or lacks its broker identity", async () => {
    const disabled = createHarness({ callControlEnabled: false }).service;
    await assert.rejects(disabled.getPresenceToken(), { code: "speko_call_control_disabled" });
    const noBrokerHarness = createHarness({ brokerId: "" });
    const noBroker = noBrokerHarness.service;
    await assert.rejects(noBroker.getPresenceToken(), { code: "speko_missing_broker_id" });
    assert.deepEqual(await noBroker.getCall("call_read_without_broker"), {
      id: "call_read_without_broker",
    });
  });

  it("validates shared API credentials without requiring AI-call settings", async () => {
    const { service, calls } = createHarness({
      agentId: "",
      phoneNumber: "not-a-number",
      maxDurationSeconds: 1,
      ringTimeoutSeconds: 1,
    });
    await service.getPresenceToken();
    assert.deepEqual(calls, [["presenceToken"]]);
  });

  it("persists provider call mappings and recovers history idempotently", async () => {
    const stored = [];
    const store = {
      saveSpekoHumanCall: async ({ call }) => stored.push(["call", call.id]),
      recordSpekoHumanCallEvent: async (event) => stored.push(["event", event.event_id, event.source]),
    };
    const { service } = createHarness({ store });
    const result = await service.reconcileCallEvents("recover-me");
    assert.equal(result.call.id, "recover-me");
    assert.deepEqual(stored, [["call", "recover-me"]]);
  });

  it("requires a persisted opaque leg mapping before browser join", async () => {
    const store = { getSpekoHumanCallLeg: async () => null };
    const { service, calls } = createHarness({ store });
    await assert.rejects(service.join("unmapped-leg"), { code: "speko_call_leg_not_found" });
    assert.deepEqual(calls, []);
  });

  it("records only safe administrator command attribution around provider mutations", async () => {
    const audits = [];
    const store = {
      getSpekoHumanCallLeg: async () => ({ call_id: "call-audit-1" }),
      startSpekoHumanCallControlAudit: async (entry) => (audits.push(["start", entry]), 22),
      finishSpekoHumanCallControlAudit: async (entry) => audits.push(["finish", entry]),
    };
    const { service } = createHarness({ store });
    await service.command("dtmf", "opaque-control", { digits: "123#" }, {
      actorId: "ops-person", actorSource: "named_admin_token", requestId: "req-22",
    });
    assert.deepEqual(audits, [
      ["start", {
        operation: "dtmf", call_id: "call-audit-1", control_id: "opaque-control",
        actor_hint: "ops-person", actor_source: "named_admin_token", request_id: "req-22",
      }],
      ["finish", { id: 22, status: "succeeded" }],
    ]);
  });
});
