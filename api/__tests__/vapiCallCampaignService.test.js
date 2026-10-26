const assert = require("node:assert/strict");
const { VapiCallCampaignService } = require("../services/vapiCallCampaignService");

describe("VapiCallCampaignService", () => {
  const input = {
    name: "Renewal follow-up",
    template_id: 12,
    template_version: 4,
    mapping_id: 8,
    phone_number_id: "pn_campaign_1",
    time_zone: "America/Los_Angeles",
    calling_window: { start: "09:00", end: "17:00" },
    calling_days: [1, 2, 3, 4, 5],
    max_concurrency: 3,
    max_retries: 1,
    retry_delay_minutes: 30,
    idempotency_key: "campaign-request-0001",
  };

  function createService(overrides = {}) {
    const records = new Map();
    let inserts = 0;
    const db = {
      async getVapiCallCampaignByIdempotencyKey(key) { return records.get(key) || null; },
      async insertVapiCallCampaign(record) {
        inserts += 1;
        if (records.has(record.idempotency_key)) return false;
        records.set(record.idempotency_key, record);
        return true;
      },
    };
    const service = new VapiCallCampaignService({
      db,
      getTemplate: async () => ({ id: 12, version: 4, lifecycle_state: "live" }),
      getMapping: async () => ({
        id: 8,
        template_id: 12,
        template_version: 4,
        compatibility_status: "compatible",
        mapping_status: "provisioned",
        sync_status: "synced",
        vapi_assistant_id: "assistant_12",
        summary: { unsupported: [] },
      }),
      ...overrides,
    });
    return { service, records, get inserts() { return inserts; } };
  }

  it("creates only a draft with an explicit current template and bounded call settings", async () => {
    const fixture = createService();
    const result = await fixture.service.createDraft(input);
    assert.equal(result.idempotentReplay, false);
    assert.equal(result.campaign.status, "draft");
    assert.equal(result.campaign.provider, "vapi");
    assert.equal(result.campaign.template_id, 12);
    assert.equal(result.campaign.template_version, 4);
    assert.equal(result.campaign.mapping_id, 8);
    assert.deepEqual(JSON.parse(result.campaign.calling_days_json), [1, 2, 3, 4, 5]);
    assert.equal(result.campaign.max_concurrency, 3);
    assert.equal("recipients" in result.campaign, false);
    assert.equal("idempotency_key" in result.campaign, false);
    assert.equal("request_hash" in result.campaign, false);
    assert.equal(fixture.inserts, 1);
  });

  it("replays an identical idempotent draft and rejects key reuse with changed settings", async () => {
    const fixture = createService();
    const first = await fixture.service.createDraft(input);
    const replay = await fixture.service.createDraft(input);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.campaign.campaign_id, first.campaign.campaign_id);
    assert.equal(fixture.inserts, 1);
    await assert.rejects(
      fixture.service.createDraft({ ...input, name: "Different campaign" }),
      (error) => error.code === "vapi_campaign_idempotency_conflict",
    );
  });

  it("requires a live current template and an exactly matching synced compatible mapping", async () => {
    const staleTemplate = createService({ getTemplate: async () => ({ id: 12, version: 3, lifecycle_state: "live" }) });
    await assert.rejects(staleTemplate.service.createDraft(input), (error) => error.code === "vapi_campaign_template_stale");

    const notLive = createService({ getTemplate: async () => ({ id: 12, version: 4, lifecycle_state: "draft" }) });
    await assert.rejects(notLive.service.createDraft(input), (error) => error.code === "vapi_campaign_template_stale");

    const staleMapping = createService({ getMapping: async () => ({ id: 8, template_id: 12, template_version: 3 }) });
    await assert.rejects(staleMapping.service.createDraft(input), (error) => error.code === "vapi_campaign_mapping_not_ready");

    const unsupported = createService({ getMapping: async () => ({
      id: 8, template_id: 12, template_version: 4, compatibility_status: "compatible",
      mapping_status: "provisioned", sync_status: "synced", vapi_assistant_id: "assistant_12",
      summary: { unsupported: ["payment_workflow"] },
    }) });
    await assert.rejects(unsupported.service.createDraft(input), (error) => error.code === "vapi_campaign_template_unsupported");
  });

  it("rejects unsafe schedules, invalid calling windows, and recipient data", async () => {
    const fixture = createService();
    await assert.rejects(
      fixture.service.createDraft({ ...input, calling_window: { start: "17:00", end: "09:00" } }),
      (error) => error.code === "vapi_campaign_invalid",
    );
    await assert.rejects(
      fixture.service.createDraft({ ...input, time_zone: "Not/A_Zone" }),
      (error) => error.code === "vapi_campaign_invalid",
    );
    await assert.rejects(
      fixture.service.createDraft({ ...input, recipients: [{ phone: "+14155550100", consent: true }] }),
      (error) => error.code === "vapi_campaign_invalid",
    );
    await assert.rejects(
      fixture.service.createDraft({ ...input, scheduled_start_at: "2020-01-01T00:00:00Z" }),
      (error) => error.code === "vapi_campaign_invalid",
    );
    assert.equal(fixture.inserts, 0);
  });
});
