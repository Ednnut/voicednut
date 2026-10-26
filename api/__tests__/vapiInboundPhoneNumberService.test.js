const assert = require("node:assert/strict");
let VapiInboundPhoneNumberService;
try { ({ VapiInboundPhoneNumberService } = require("../services/vapiInboundPhoneNumberService")); } catch (_) {}

const PHONE_ID = "550e8400-e29b-41d4-a716-446655440000";
const WEBHOOK = { url: "https://api.example.test/webhook/vapi", credentialId: "credential-1" };

describe("VapiInboundPhoneNumberService", () => {
  it("provides explicit, reversible-in-provider inbound configuration", () => {
    assert.equal(typeof VapiInboundPhoneNumberService, "function");
  });

  it("configures only a locally routed number and preserves its existing server settings", async () => {
    const updates = [];
    const service = new VapiInboundPhoneNumberService({
      client: {
        isConfigured: () => true,
        async getPhoneNumber(id) {
          assert.equal(id, PHONE_ID);
          return {
            id: PHONE_ID,
            server: { timeoutSeconds: 18, headers: { "X-Region": "west" } },
          };
        },
        async updatePhoneNumber(id, body) { updates.push({ id, body }); return { id }; },
      },
      getInboundRoute: async () => ({ vapi_assistant_id: "asst_selected" }),
      serverConfiguration: WEBHOOK,
    });
    const result = await service.configure(PHONE_ID);
    assert.deepEqual(updates, [{
      id: PHONE_ID,
      body: {
        server: {
          timeoutSeconds: 18,
          headers: { "X-Region": "west" },
          url: WEBHOOK.url,
          credentialId: WEBHOOK.credentialId,
        },
      },
    }]);
    assert.deepEqual(result, {
      phone_number_id: PHONE_ID,
      configured: true,
      server_url_configured: true,
      server_credential_configured: true,
      already_configured: false,
    });
    assert.equal(JSON.stringify(result).includes(WEBHOOK.url), false);
  });

  it("does not overwrite a different phone-number server URL or workflow assignment", async () => {
    for (const phone of [
      { id: PHONE_ID, server: { url: "https://other.example.test/hook" } },
      { id: PHONE_ID, workflowId: "workflow_1" },
      { id: PHONE_ID, assistantId: "asst_existing" },
      { id: PHONE_ID, squadId: "squad_existing" },
    ]) {
      let updates = 0;
      const service = new VapiInboundPhoneNumberService({
        client: {
          isConfigured: () => true,
          async getPhoneNumber() { return phone; },
          async updatePhoneNumber() { updates += 1; },
        },
        getInboundRoute: async () => ({ vapi_assistant_id: "asst_selected" }),
        serverConfiguration: WEBHOOK,
      });
      await assert.rejects(service.configure(PHONE_ID), (error) => error.code === "vapi_phone_number_configuration_conflict");
      assert.equal(updates, 0);
    }
  });

  it("does not send a second provider update when routing is already configured", async () => {
    let updates = 0;
    const service = new VapiInboundPhoneNumberService({
      client: {
        isConfigured: () => true,
        async getPhoneNumber() { return { id: PHONE_ID, server: { ...WEBHOOK } }; },
        async updatePhoneNumber() { updates += 1; },
      },
      getInboundRoute: async () => ({ vapi_assistant_id: "asst_selected" }),
      serverConfiguration: WEBHOOK,
    });
    const result = await service.configure(PHONE_ID);
    assert.equal(result.already_configured, true);
    assert.equal(updates, 0);
  });

  it("requires an active local inbound mapping and a secure configured webhook", async () => {
    let providerCalls = 0;
    const options = {
      client: {
        isConfigured: () => true,
        async getPhoneNumber() { providerCalls += 1; return { id: PHONE_ID }; },
        async updatePhoneNumber() { providerCalls += 1; },
      },
      getInboundRoute: async () => null,
      serverConfiguration: WEBHOOK,
    };
    await assert.rejects(new VapiInboundPhoneNumberService(options).configure(PHONE_ID), (error) => error.code === "vapi_inbound_route_missing");
    assert.equal(providerCalls, 0);
    await assert.rejects(new VapiInboundPhoneNumberService({
      ...options,
      getInboundRoute: async () => ({ vapi_assistant_id: "asst_selected" }),
      serverConfiguration: { ...WEBHOOK, url: "http://127.0.0.1/webhook/vapi" },
    }).configure(PHONE_ID), (error) => error.code === "vapi_webhook_configuration_invalid");
    assert.equal(providerCalls, 0);
  });
});
