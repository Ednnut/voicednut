const assert = require("node:assert/strict");
const {
  VapiWebhookService,
  normalizeVapiCallEvent,
} = require("../services/vapiWebhookService");

describe("Vapi webhook event normalization", () => {
  it("routes assistant requests only to an explicitly mapped current synced assistant", async () => {
    const service = new VapiWebhookService({
      db: {
        async getVapiInboundAssistantByPhoneNumberId(id) {
          assert.equal(id, "pn_support_1");
          return { vapi_assistant_id: "asst_current_1" };
        },
      },
    });
    const result = await service.processEvent({
      message: { type: "assistant-request", call: { phoneNumberId: "pn_support_1" } },
    });
    assert.deepEqual(result, { assistantRequest: true, assistantId: "asst_current_1" });
  });

  it("returns a fast spoken error for an unmapped assistant request", async () => {
    const service = new VapiWebhookService({
      db: { async getVapiInboundAssistantByPhoneNumberId() { return null; } },
    });
    const result = await service.processEvent({
      message: { type: "assistant-request", call: { phoneNumberId: "pn_unknown" } },
    });
    assert.equal(result.assistantRequest, true);
    assert.equal(typeof result.error, "string");
    assert.equal(result.assistantId, undefined);
  });

  it("returns explicit unavailable results for tool requests without executing or storing arguments", async () => {
    let stored = 0;
    const service = new VapiWebhookService({
      db: { async recordVapiCallEvent() { stored += 1; return { inserted: true }; } },
    });
    const result = await service.processEvent({
      message: {
        type: "tool-calls",
        toolCallList: [
          { id: "tool-1", type: "function", function: { name: "lookupCustomer", arguments: { email: "private@example.test" } } },
          { id: "tool-2", type: "function", function: { name: "sendMessage", arguments: { body: "private message" } } },
        ],
      },
    });
    assert.deepEqual(result, {
      toolCallResponse: true,
      results: [
        { name: "lookupCustomer", toolCallId: "tool-1", result: "This tool is not enabled in VOICEDNUT." },
        { name: "sendMessage", toolCallId: "tool-2", result: "This tool is not enabled in VOICEDNUT." },
      ],
    });
    assert.equal(JSON.stringify(result).includes("private@example.test"), false);
    assert.equal(JSON.stringify(result).includes("private message"), false);
    assert.equal(stored, 0);
  });

  it("rejects malformed or oversized tool-call request lists", async () => {
    const service = new VapiWebhookService({ db: { async recordVapiCallEvent() { return { inserted: true }; } } });
    await assert.rejects(
      service.processEvent({ message: { type: "tool-calls", toolCallList: [{ type: "function" }] } }),
      (error) => error.code === "vapi_tool_calls_invalid",
    );
    await assert.rejects(
      service.processEvent({ message: { type: "tool-calls", toolCallList: Array.from({ length: 51 }, (_, index) => ({ id: `tool-${index}`, function: { name: "tool" } })) } }),
      (error) => error.code === "vapi_tool_calls_invalid",
    );
  });

  it("keeps lifecycle metadata and excludes transcripts and recordings", () => {
    const event = normalizeVapiCallEvent({
      message: {
        type: "end-of-call-report",
        timestamp: "2026-10-25T10:00:00.000Z",
        endedReason: "customer-ended-call",
        call: { id: "call_123", duration: 41, status: "ended" },
        assistant: {
          id: "assistant_123",
          metadata: {
            voicednutTemplateMapping: {
              templateId: 12,
              templateVersion: 3,
              configFingerprint: "a".repeat(64),
            },
          },
        },
        artifact: { transcript: "sensitive transcript", recording: { url: "https://example.test/audio" } },
      },
    });
    assert.equal(event.provider_call_id, "call_123");
    assert.equal(event.provider_status, "ended");
    assert.equal(event.ended_reason, "customer-ended-call");
    assert.equal(event.duration_seconds, 41);
    assert.equal(event.template_id, 12);
    assert.equal(JSON.stringify(event).includes("sensitive transcript"), false);
    assert.equal(JSON.stringify(event).includes("example.test/audio"), false);
  });

  it("ignores non-lifecycle events and rejects malformed tracked events", () => {
    assert.equal(normalizeVapiCallEvent({ message: { type: "transcript", transcript: "private" } }).ignored, true);
    assert.equal(normalizeVapiCallEvent({ message: { type: "status-update", status: "ended" } }), null);
  });

  it("records forwarding and transfer event destination types without storing destinations or transcript fields", () => {
    const forwarding = normalizeVapiCallEvent({
      message: {
        type: "status-update",
        timestamp: "2026-10-25T10:01:00.000Z",
        status: "forwarding",
        call: { id: "call_transfer_1" },
        destination: { type: "number", number: "+14155550111" },
        transcript: "must not be persisted",
      },
    });
    assert.equal(forwarding.provider_status, "forwarding");
    assert.equal(forwarding.destination_type, "number");
    assert.equal(JSON.stringify(forwarding).includes("+14155550111"), false);
    assert.equal(JSON.stringify(forwarding).includes("must not be persisted"), false);

    const handoff = normalizeVapiCallEvent({
      message: {
        type: "transfer-update",
        timestamp: "2026-10-25T10:02:00.000Z",
        call: { id: "call_transfer_1" },
        destination: { type: "assistant", assistantName: "Support" },
      },
    });
    assert.equal(handoff.event_type, "transfer-update");
    assert.equal(handoff.destination_type, "assistant");
    assert.equal(JSON.stringify(handoff).includes("Support"), false);
  });

  it("uses storage uniqueness to make duplicate delivery idempotent", async () => {
    const seen = new Set();
    const service = new VapiWebhookService({
      db: {
        async recordVapiCallEvent(event) {
          const inserted = !seen.has(event.event_key);
          seen.add(event.event_key);
          return { inserted };
        },
      },
    });
    const payload = {
      message: {
        type: "status-update",
        timestamp: "2026-10-25T10:00:00.000Z",
        status: "in-progress",
        call: { id: "call_123" },
      },
    };
    const first = await service.processEvent(payload);
    const duplicate = await service.processEvent(payload);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
  });
});
