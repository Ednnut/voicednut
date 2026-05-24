const assert = require("node:assert/strict");

const { CrmContactSyncService } = require("../services/crmContactSyncService");

describe("CrmContactSyncService", () => {
  it("normalizes provider contact sync into persisted records without a native adapter", async () => {
    const records = [];
    const activities = [];
    const service = new CrmContactSyncService({
      db: {
        upsertCrmContactSyncRecord: async (record) => {
          records.push(record);
          return 1;
        },
        recordCrmActivitySyncEvent: async (event) => {
          activities.push(event);
          return activities.length;
        },
      },
      config: { provider: "hubspot" },
      logger: { error: () => {}, warn: () => {}, log: () => {} },
    });

    const result = await service.syncPostCallRecord({
      contact: { email: "Ada@Example.com", first_name: "Ada" },
      call: { call_sid: "CA123", summary: "Payment completed" },
      context: { payment_state: "paid" },
    });

    assert.equal(result.provider, "hubspot");
    assert.equal(result.contact.status, "pending_provider_adapter");
    assert.equal(records.length, 1);
    assert.equal(records[0].provider, "hubspot");
    assert.equal(records[0].email, "ada@example.com");
    assert.equal(activities.length, 1);
    assert.equal(activities[0].activity_type, "call_note");
  });

  it("syncs contacts and post-call notes through a configured native HubSpot adapter", async () => {
    const records = [];
    const activities = [];
    const calls = [];
    const fetch = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/crm/v3/objects/contacts/batch/upsert")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ results: [{ id: "hs_contact_1" }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "hs_note_1" }),
      };
    };
    const service = new CrmContactSyncService({
      db: {
        upsertCrmContactSyncRecord: async (record) => {
          records.push(record);
          return 1;
        },
        recordCrmActivitySyncEvent: async (event) => {
          activities.push(event);
          return activities.length;
        },
      },
      config: {
        provider: "hubspot",
        requestTimeoutMs: 5000,
        hubspot: {
          apiKey: "test_hubspot_token",
          baseUrl: "https://api.hubapi.test",
        },
      },
      fetch,
      logger: { error: () => {}, warn: () => {}, log: () => {} },
    });

    const result = await service.syncPostCallRecord({
      contact: { email: "Ada@Example.com", first_name: "Ada" },
      call: { call_sid: "CA123", summary: "Payment completed" },
      context: { payment_state: "paid" },
    });

    assert.equal(result.provider, "hubspot");
    assert.equal(result.contact.mode, "native");
    assert.equal(result.contact.status, "synced");
    assert.equal(result.contact.contact_id, "hs_contact_1");
    assert.equal(result.activity.mode, "native");
    assert.equal(result.activity.status, "synced");
    assert.equal(result.activity.activity_id, "hs_note_1");
    assert.equal(records[0].status, "synced");
    assert.equal(activities[0].status, "synced");
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/crm\/v3\/objects\/contacts\/batch\/upsert$/);
    assert.match(calls[1].url, /\/crm\/v3\/objects\/notes$/);
    assert.equal(calls[0].options.headers.Authorization, "Bearer test_hubspot_token");
  });

  it("requires a stable contact identity", async () => {
    const service = new CrmContactSyncService({
      logger: { error: () => {}, warn: () => {}, log: () => {} },
    });

    await assert.rejects(
      () => service.upsertContact({ contact: { name: "No Identity" } }),
      /requires an email, phone, external_id, or contact_id/,
    );
  });
});
