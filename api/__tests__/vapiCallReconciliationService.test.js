const assert = require("node:assert/strict");
const { VapiCallReconciliationService } = require("../services/vapiCallReconciliationService");

describe("VapiCallReconciliationService", () => {
  it("records a sanitized, deduplicated snapshot for a locally correlated call", async () => {
    const rows = new Map();
    let fetches = 0;
    const service = new VapiCallReconciliationService({
      client: {
        isConfigured: () => true,
        getCall: async (id) => {
          fetches += 1;
          return {
            id, status: "ended", endedReason: "customer-ended-call", updatedAt: "2026-10-25T10:00:00.000Z",
            startedAt: "2026-10-25T09:59:00.000Z", endedAt: "2026-10-25T10:00:00.000Z",
            messages: [{ message: "private transcript" }], artifact: { recordingUrl: "https://private.test/audio" },
            destination: { number: "+14155550111" },
          };
        },
      },
      getLocalCall: async (id) => ({ provider_call_id: id, template_id: 8, template_version: 3 }),
      recordEvent: async (event) => {
        const inserted = !rows.has(event.event_key);
        rows.set(event.event_key, event);
        return { inserted };
      },
    });
    const first = await service.reconcile("call-123");
    const duplicate = await service.reconcile("call-123");
    assert.deepEqual(first, { providerCallId: "call-123", status: "ended", reconciled: true, duplicate: false });
    assert.equal(duplicate.duplicate, true);
    assert.equal(fetches, 2);
    const event = [...rows.values()][0];
    assert.equal(event.event_type, "reconciliation");
    assert.equal(event.provider_status, "ended");
    assert.equal(event.duration_seconds, 60);
    assert.equal(event.template_id, 8);
    assert.equal(JSON.stringify(event).includes("private transcript"), false);
    assert.equal(JSON.stringify(event).includes("private.test/audio"), false);
    assert.equal(JSON.stringify(event).includes("+14155550111"), false);
  });

  it("reconciles a browser call when the local correlation uses the vapi_web provider", async () => {
    let recorded = null;
    const service = new VapiCallReconciliationService({
      client: {
        isConfigured: () => true,
        getCall: async (id) => ({ id, status: "ended", updatedAt: "2026-10-26T00:00:00.000Z" }),
      },
      getLocalCall: async (id) => ({ provider: "vapi_web", provider_call_id: id, template_id: 12, template_version: 4 }),
      recordEvent: async (event) => { recorded = event; return { inserted: true }; },
    });
    const result = await service.reconcile("call_web_123");
    assert.equal(result.reconciled, true);
    assert.equal(recorded.provider_call_id, "call_web_123");
    assert.equal(recorded.template_id, 12);
    assert.equal(recorded.template_version, 4);
  });

  it("rejects uncorrelated calls before the provider read", async () => {
    let fetches = 0;
    const service = new VapiCallReconciliationService({
      client: { isConfigured: () => true, getCall: async () => { fetches += 1; } },
      getLocalCall: async () => null,
      recordEvent: async () => ({ inserted: true }),
    });
    await assert.rejects(service.reconcile("unknown"), (error) => error.code === "vapi_call_not_found");
    assert.equal(fetches, 0);
  });

  it("rejects provider identity mismatches and malformed provider status", async () => {
    const service = new VapiCallReconciliationService({
      client: { isConfigured: () => true, getCall: async () => ({ id: "other", status: "ended" }) },
      getLocalCall: async (id) => ({ provider_call_id: id }),
      recordEvent: async () => ({ inserted: true }),
    });
    await assert.rejects(service.reconcile("call-123"), (error) => error.code === "vapi_call_lookup_mismatch");

    const invalidStatus = new VapiCallReconciliationService({
      client: { isConfigured: () => true, getCall: async (id) => ({ id, status: "ended\nunsafe" }) },
      getLocalCall: async (id) => ({ provider_call_id: id }),
      recordEvent: async () => ({ inserted: true }),
    });
    await assert.rejects(invalidStatus.reconcile("call-123"), (error) => error.code === "vapi_call_snapshot_invalid");
  });
});
