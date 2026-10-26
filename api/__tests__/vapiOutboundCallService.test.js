const assert = require("node:assert/strict");
const { VapiOutboundCallService } = require("../services/vapiOutboundCallService");

describe("VapiOutboundCallService", () => {
  const mapping = {
    id: 12,
    template_id: 5,
    template_version: 3,
    compatibility_status: "compatible",
    mapping_status: "provisioned",
    sync_status: "synced",
    vapi_assistant_id: "asst_123",
    vapi_assistant_version: "v2",
    summary: { unsupported: [] },
  };

  function createIdempotencyDb() {
    const rows = new Map();
    return {
      async reserveOutboundCallIdempotency(input) {
        if (rows.has(input.idempotency_key)) return { reserved: false };
        rows.set(input.idempotency_key, { ...input, status: "pending" });
        return { reserved: true };
      },
      async getOutboundCallIdempotency(key) { return rows.get(key) || null; },
      async completeOutboundCallIdempotency(input) {
        Object.assign(rows.get(input.idempotency_key), {
          ...input,
          response_payload: input.response_payload == null ? null : JSON.stringify(input.response_payload),
        });
        return 1;
      },
    };
  }

  it("creates one outbound call from an explicit synced template mapping and Vapi number", async () => {
    const calls = [];
    const service = new VapiOutboundCallService({
      db: createIdempotencyDb(),
      client: { isConfigured: () => true, createCall: async (body) => {
        calls.push(body);
        return { id: "call_456", status: "queued" };
      } },
      getMapping: async (id) => id === 12 ? mapping : null,
      getTemplate: async (id) => id === 5 ? { id: 5, version: 3 } : null,
    });

    const result = await service.createOutboundCall({
      mappingId: 12,
      idempotencyKey: "request-0001",
      phoneNumberId: "phone_789",
      number: "+14155550123",
    });

    assert.equal(result.providerCallId, "call_456");
    assert.equal(result.status, "queued");
    assert.deepEqual(calls, [{
      assistantId: "asst_123",
      assistantVersion: "v2",
      phoneNumberId: "phone_789",
      customer: { number: "+14155550123" },
    }]);
  });

  it("refuses stale, incompatible, unsynced, or missing mappings before calling Vapi", async () => {
    let callCount = 0;
    const base = {
      db: createIdempotencyDb(),
      client: { isConfigured: () => true, createCall: async () => { callCount += 1; return { id: "call" }; } },
      getMapping: async () => mapping,
      getTemplate: async () => ({ id: 5, version: 4 }),
    };
    await assert.rejects(new VapiOutboundCallService(base).createOutboundCall({
      mappingId: 12, idempotencyKey: "request-0002", phoneNumberId: "phone_789", number: "+14155550123",
    }), (error) => error.code === "vapi_mapping_stale");
    assert.equal(callCount, 0);
  });

  it("requires explicit Vapi resources and E.164 destination and never calls an unmapped template", async () => {
    let callCount = 0;
    const service = new VapiOutboundCallService({
      db: createIdempotencyDb(),
      client: { isConfigured: () => true, createCall: async () => { callCount += 1; return { id: "call" }; } },
      getMapping: async () => ({ ...mapping, sync_status: "failed" }),
      getTemplate: async () => ({ id: 5, version: 3 }),
    });
    await assert.rejects(service.createOutboundCall({ mappingId: 12, idempotencyKey: "request-0003", phoneNumberId: "", number: "+14155550123" }), /phone number ID/);
    await assert.rejects(service.createOutboundCall({ mappingId: 12, idempotencyKey: "request-0003", phoneNumberId: "phone_789", number: "4155550123" }), /E.164/);
    await assert.rejects(service.createOutboundCall({ mappingId: 12, idempotencyKey: "request-0003", phoneNumberId: "phone_789", number: "+14155550123" }), (error) => error.code === "vapi_mapping_not_ready");
    assert.equal(callCount, 0);
  });

  it("rejects Vapi mappings with unsupported behavior instead of silently dropping it", async () => {
    const service = new VapiOutboundCallService({
      db: createIdempotencyDb(),
      client: { isConfigured: () => true, createCall: async () => ({ id: "call" }) },
      getMapping: async () => ({ ...mapping, summary: { unsupported: ["payment_workflow"] } }),
      getTemplate: async () => ({ id: 5, version: 3 }),
    });
    await assert.rejects(service.createOutboundCall({
      mappingId: 12, idempotencyKey: "request-0004", phoneNumberId: "phone_789", number: "+14155550123",
    }), (error) => error.code === "vapi_template_unsupported");
  });

  it("rejects a mapping that belongs to a different requested template", async () => {
    let callCount = 0;
    const service = new VapiOutboundCallService({
      db: createIdempotencyDb(),
      client: { isConfigured: () => true, createCall: async () => { callCount += 1; return { id: "call" }; } },
      getMapping: async () => mapping,
      getTemplate: async () => ({ id: 5, version: 3 }),
    });
    await assert.rejects(service.createOutboundCall({
      templateId: 99, mappingId: 12, idempotencyKey: "request-0005", phoneNumberId: "phone_789", number: "+14155550123",
    }), (error) => error.code === "vapi_mapping_template_mismatch");
    assert.equal(callCount, 0);
  });

  it("rejects a requested template version that differs from the synced Vapi mapping", async () => {
    let callCount = 0;
    const service = new VapiOutboundCallService({
      db: createIdempotencyDb(),
      client: { isConfigured: () => true, createCall: async () => { callCount += 1; return { id: "call" }; } },
      getMapping: async () => mapping,
      getTemplate: async () => ({ id: 5, version: 3 }),
    });
    await assert.rejects(service.createOutboundCall({
      templateId: 5, templateVersion: 2, mappingId: 12, idempotencyKey: "request-version-01",
      phoneNumberId: "phone_789", number: "+14155550123",
    }), (error) => error.code === "vapi_mapping_stale");
    assert.equal(callCount, 0);
  });

  it("replays a completed request from durable idempotency state without placing a second call", async () => {
    const db = createIdempotencyDb();
    let providerCalls = 0;
    const service = new VapiOutboundCallService({
      db,
      client: { isConfigured: () => true, createCall: async () => { providerCalls += 1; return { id: "call_once", status: "queued" }; } },
      getMapping: async () => mapping,
      getTemplate: async () => ({ id: 5, version: 3 }),
    });
    const input = { mappingId: 12, idempotencyKey: "repeatable-key-01", phoneNumberId: "phone_789", number: "+14155550123" };
    const first = await service.createOutboundCall(input);
    const replay = await service.createOutboundCall(input);
    assert.equal(first.providerCallId, "call_once");
    assert.equal(replay.providerCallId, "call_once");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(providerCalls, 1);
  });

  it("requires an idempotency key before making a provider request", async () => {
    let providerCalls = 0;
    const service = new VapiOutboundCallService({
      db: createIdempotencyDb(),
      client: { isConfigured: () => true, createCall: async () => { providerCalls += 1; return { id: "call" }; } },
      getMapping: async () => mapping,
      getTemplate: async () => ({ id: 5, version: 3 }),
    });
    await assert.rejects(service.createOutboundCall({ mappingId: 12, phoneNumberId: "phone_789", number: "+14155550123" }), (error) => error.code === "vapi_idempotency_key_required");
    assert.equal(providerCalls, 0);
  });

  it("blocks a retry after a provider timeout because the remote call outcome is unknown", async () => {
    const db = createIdempotencyDb();
    let providerCalls = 0;
    const service = new VapiOutboundCallService({
      db,
      client: { isConfigured: () => true, createCall: async () => {
        providerCalls += 1;
        const error = new Error("timeout");
        error.code = "vapi_timeout";
        error.retryable = true;
        throw error;
      } },
      getMapping: async () => mapping,
      getTemplate: async () => ({ id: 5, version: 3 }),
    });
    const input = { mappingId: 12, idempotencyKey: "timeout-request-01", phoneNumberId: "phone_789", number: "+14155550123" };
    await assert.rejects(service.createOutboundCall(input), /timeout/);
    await assert.rejects(service.createOutboundCall(input), (error) => error.code === "vapi_call_outcome_unresolved");
    assert.equal(providerCalls, 1);
  });

  it("replays an already-created call even if the template mapping later becomes stale", async () => {
    const db = createIdempotencyDb();
    let templateVersion = 3;
    let providerCalls = 0;
    const service = new VapiOutboundCallService({
      db,
      client: { isConfigured: () => true, createCall: async () => { providerCalls += 1; return { id: "call_persisted", status: "queued" }; } },
      getMapping: async () => mapping,
      getTemplate: async () => ({ id: 5, version: templateVersion }),
    });
    const input = { mappingId: 12, idempotencyKey: "stale-replay-key-01", phoneNumberId: "phone_789", number: "+14155550123" };
    await service.createOutboundCall(input);
    templateVersion = 4;
    const replay = await service.createOutboundCall(input);
    assert.equal(replay.providerCallId, "call_persisted");
    assert.equal(replay.idempotentReplay, true);
    assert.equal(providerCalls, 1);
  });

  it("rejects reuse of an idempotency key for a different destination", async () => {
    const db = createIdempotencyDb();
    let providerCalls = 0;
    const service = new VapiOutboundCallService({
      db,
      client: { isConfigured: () => true, createCall: async () => { providerCalls += 1; return { id: "call_conflict", status: "queued" }; } },
      getMapping: async () => mapping,
      getTemplate: async () => ({ id: 5, version: 3 }),
    });
    await service.createOutboundCall({ mappingId: 12, idempotencyKey: "conflict-key-0001", phoneNumberId: "phone_789", number: "+14155550123" });
    await assert.rejects(service.createOutboundCall({ mappingId: 12, idempotencyKey: "conflict-key-0001", phoneNumberId: "phone_789", number: "+14155550124" }), (error) => error.code === "vapi_idempotency_conflict");
    assert.equal(providerCalls, 1);
  });
});
