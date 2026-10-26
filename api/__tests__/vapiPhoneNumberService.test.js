const assert = require("node:assert/strict");
let VapiPhoneNumberService;
try { ({ VapiPhoneNumberService } = require("../services/vapiPhoneNumberService")); } catch (_) {}

describe("VapiPhoneNumberService", () => {
  it("provides a phone-number inventory service", () => {
    assert.equal(typeof VapiPhoneNumberService, "function");
  });

  it("returns only routing-relevant phone fields and safe pagination metadata", async () => {
    const service = new VapiPhoneNumberService({
      client: {
        isConfigured: () => true,
        async listPhoneNumbers(options) {
          assert.deepEqual(options, { page: 2, limit: 25, search: "support" });
          return {
            results: [{
              id: "pn_1", name: "Support", number: "+14155550111", provider: "twilio",
              status: "active", assistantId: null, squadId: null, workflowId: null,
              server: { url: "https://secret.example.test", credentialId: "cred_private", headers: { Authorization: "secret" } },
              credentialId: "provider-credential",
            }],
            metadata: { currentPage: 2, totalPages: 5, totalItems: 110, hasNextPage: true, nextCursor: "cursor_1", private: "ignore" },
          };
        },
      },
    });
    const result = await service.list({ page: 2, limit: 25, search: "support" });
    assert.deepEqual(result, {
      phoneNumbers: [{
        id: "pn_1", name: "Support", number: "+14155550111", provider: "twilio",
        status: "active", assistantId: null, squadId: null, workflowId: null,
        serverConfigured: true, serverCredentialConfigured: true,
      }],
      pagination: { currentPage: 2, totalPages: 5, totalItems: 110, hasNextPage: true, nextCursor: "cursor_1" },
    });
    assert.equal(JSON.stringify(result).includes("secret.example.test"), false);
    assert.equal(JSON.stringify(result).includes("cred_private"), false);
    assert.equal(JSON.stringify(result).includes("Authorization"), false);
  });

  it("validates paging, search length, and malformed provider responses", async () => {
    const client = { isConfigured: () => true, async listPhoneNumbers() { return { results: "bad" }; } };
    const service = new VapiPhoneNumberService({ client });
    await assert.rejects(service.list({ page: 0 }), (error) => error.code === "vapi_phone_number_query_invalid");
    await assert.rejects(service.list({ search: "x".repeat(101) }), (error) => error.code === "vapi_phone_number_query_invalid");
    await assert.rejects(service.list({ page: ["2"] }), (error) => error.code === "vapi_phone_number_query_invalid");
    await assert.rejects(service.list({}), (error) => error.code === "vapi_invalid_phone_number_list");
  });

  it("rejects array-shaped pagination metadata from the provider", async () => {
    const service = new VapiPhoneNumberService({
      client: { isConfigured: () => true, async listPhoneNumbers() { return { results: [], metadata: [] }; } },
    });
    await assert.rejects(service.list({}), (error) => error.code === "vapi_invalid_phone_number_list");
  });
});
