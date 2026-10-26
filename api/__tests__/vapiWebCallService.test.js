const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { VapiWebCallService, isAllowedVapiWebOrigin, normalizeAllowedOrigins } = require("../services/vapiWebCallService");

describe("VapiWebCallService", () => {
  const assistant = {
    id: 4,
    template_id: 10,
    template_name: "Support",
    template_version: 3,
    vapi_assistant_id: "assistant-current",
    vapi_assistant_version: "7",
  };

  it("allows only exact secure origins (and localhost HTTP for development)", () => {
    const configured = "https://voicednut-miniapp.vercel.app, https://miniapp.example.test/path, http://localhost:5173, http://untrusted.example.test";
    assert.deepEqual(normalizeAllowedOrigins(configured), [
      "https://voicednut-miniapp.vercel.app",
      "http://localhost:5173",
    ]);
    assert.equal(isAllowedVapiWebOrigin("https://voicednut-miniapp.vercel.app", configured), true);
    assert.equal(isAllowedVapiWebOrigin("https://voicednut-miniapp.vercel.app.attacker.test", configured), false);
    assert.equal(isAllowedVapiWebOrigin("http://untrusted.example.test", configured), false);
    assert.equal(isAllowedVapiWebOrigin("", configured), false);
  });

  it("creates a server-configured web call for an eligible local mapping and returns only join data", async () => {
    const requests = [];
    const completed = [];
    const service = new VapiWebCallService({
      db: {
        getOutboundCallIdempotency: async () => null,
        reserveOutboundCallIdempotency: async () => ({ reserved: true }),
        completeOutboundCallIdempotency: async (record) => { completed.push(record); return 1; },
      },
      client: {
        isConfigured: () => true,
        createCall: async (body) => {
          requests.push(body);
          return {
            id: "call-web-1",
            status: "queued",
            webCallUrl: "https://room.daily.co/example",
            transport: { callUrl: "https://room.daily.co/example", callToken: "join-token", provider: "daily" },
            assistant: { voice: { provider: "11labs" } },
            artifact: { transcript: "must not be returned" },
          };
        },
      },
      listEligibleAssistants: async () => [assistant],
    });

    const result = await service.createWebCall({ mappingId: 4, idempotencyKey: "test-key-12345678" });
    assert.deepEqual(requests, [{
      assistantId: "assistant-current",
      assistantVersion: "7",
      transport: { type: "web" },
    }]);
    assert.deepEqual(result, {
      call: {
        id: "call-web-1",
        webCallUrl: "https://room.daily.co/example",
        transport: { callToken: "join-token" },
        assistant: { voice: { provider: "11labs" } },
      },
      template: { mappingId: 4, templateId: 10, templateName: "Support", templateVersion: 3 },
    });
    assert.equal(JSON.stringify(result).includes("transcript"), false);
    assert.equal(completed[0].provider, "vapi_web");
    assert.equal(completed[0].call_sid, "call-web-1");
    assert.equal(JSON.stringify(completed[0]).includes("join-token"), false);
  });

  it("rejects invalid and ineligible mappings before contacting Vapi", async () => {
    let creates = 0;
    const service = new VapiWebCallService({
      db: {
        getOutboundCallIdempotency: async () => null,
        reserveOutboundCallIdempotency: async () => ({ reserved: true }),
        completeOutboundCallIdempotency: async () => 1,
      },
      client: { isConfigured: () => true, createCall: async () => { creates += 1; } },
      listEligibleAssistants: async () => [assistant],
    });
    await assert.rejects(service.createWebCall({ mappingId: "bad", idempotencyKey: "test-key-12345678" }), (error) => error.code === "vapi_web_mapping_invalid");
    await assert.rejects(service.createWebCall({ mappingId: 99, idempotencyKey: "test-key-12345678" }), (error) => error.code === "vapi_web_mapping_not_found");
    assert.equal(creates, 0);
  });

  it("fails closed for unconfigured Vapi and malformed web-call responses", async () => {
    const unavailable = new VapiWebCallService({
      client: { isConfigured: () => false },
      listEligibleAssistants: async () => [assistant],
    });
    await assert.rejects(unavailable.createWebCall({ mappingId: 4, idempotencyKey: "test-key-12345678" }), (error) => error.code === "vapi_not_configured");

    const db = {
      getOutboundCallIdempotency: async () => null,
      reserveOutboundCallIdempotency: async () => ({ reserved: true }),
      completeOutboundCallIdempotency: async () => { throw new Error("local completion failed"); },
    };
    const malformed = new VapiWebCallService({
      db,
      client: { isConfigured: () => true, createCall: async () => ({ id: "call-web-2", status: "queued" }) },
      listEligibleAssistants: async () => [assistant],
    });
    await assert.rejects(malformed.createWebCall({ mappingId: 4, idempotencyKey: "test-key-12345678" }), (error) => error.code === "vapi_web_response_invalid");
  });

  it("does not create a second provider call after an ambiguous idempotent attempt", async () => {
    let providerCreates = 0;
    const existing = {
      idempotency_key: "vapi-web:test-key-12345678",
      provider: "vapi_web",
      request_hash: crypto.createHash("sha256").update(JSON.stringify({ mappingId: 4 })).digest("hex"),
      status: "pending",
    };
    const db = {
      getOutboundCallIdempotency: async () => existing,
      reserveOutboundCallIdempotency: async () => ({ reserved: false }),
      completeOutboundCallIdempotency: async () => {},
    };
    const service = new VapiWebCallService({
      db,
      client: { isConfigured: () => true, createCall: async () => { providerCreates += 1; } },
      listEligibleAssistants: async () => [assistant],
    });
    await assert.rejects(
      service.createWebCall({ mappingId: 4, idempotencyKey: "test-key-12345678" }),
      (error) => error.code === "vapi_web_call_outcome_unknown",
    );
    assert.equal(providerCreates, 0);
  });
});
