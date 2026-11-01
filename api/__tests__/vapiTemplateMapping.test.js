const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sqlite3 = require("sqlite3").verbose();
const Database = require("../db/db");
const { mapCallTemplateToVapiAssistant } = require("../adapters/vapiTemplateAdapter");
const { VAPI_BUSINESS_CONTEXT_TOOL_ID } = require("../services/vapiToolRegistry");

describe("Vapi template mapping persistence", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-vapi-mappings-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => {
      try { fs.unlinkSync(file); } catch (_) {}
    });
  });

  it("maps only the explicitly approved read-only business context tool", () => {
    const preview = mapCallTemplateToVapiAssistant({
      id: 4,
      version: 2,
      prompt: "Answer callers using approved company information.",
      first_message: "Hello.",
      agent_config: {
        schema_version: 2,
        approved_tools: [VAPI_BUSINESS_CONTEXT_TOOL_ID],
        business_context: { facts: [{ label: "Hours", value: "Weekdays" }] },
      },
      configuration: {
        vapi: {
          model: { provider: "openai", model: "gpt-4o-mini" },
          voice: { provider: "11labs", voiceId: "voice-id" },
        },
      },
    }, {
      serverConfiguration: { url: "https://api.example.test/webhook/vapi", credentialId: "vapi-webhook" },
    });
    assert.equal(preview.compatible, true);
    assert.equal(preview.assistant.tools.length, 1);
    assert.equal(preview.assistant.tools[0].function.name, "lookup_business_context");
    assert.equal(preview.assistant.tools[0].server.credentialId, "vapi-webhook");

    const missingServer = mapCallTemplateToVapiAssistant({
      prompt: "Prompt", first_message: "Hello", agent_config: {
        schema_version: 2,
        approved_tools: [VAPI_BUSINESS_CONTEXT_TOOL_ID],
        business_context: { facts: [{ label: "Hours", value: "Weekdays" }] },
      },
    });
    assert.equal(missingServer.compatible, false);
    assert.ok(missingServer.unsupported.includes("agent_tool_webhook_unavailable"));
  });

  it("upserts a versioned audit record without storing submitted model configuration", async () => {
    const templateId = await db.createCallTemplate({
      name: "Vapi mapping test",
      prompt: "Use approved language",
      first_message: "Hello",
    });
    const input = {
      template_id: templateId,
      template_version: 1,
      config_fingerprint: "a".repeat(64),
      compatibility_status: "incompatible",
      summary: { mapped_fields: ["firstMessage"], unsupported: ["payment_workflow"], missing: ["vapi.model"] },
    };

    await db.upsertVapiTemplateMapping(input);
    await db.upsertVapiTemplateMapping({ ...input, compatibility_status: "compatible" });
    const mappings = await db.listVapiTemplateMappings(templateId);

    assert.equal(mappings.length, 1);
    assert.equal(mappings[0].template_version, 1);
    assert.equal(mappings[0].mapping_status, "previewed");
    assert.equal(mappings[0].compatibility_status, "compatible");
    assert.deepEqual(mappings[0].summary, input.summary);
    assert.equal(JSON.stringify(mappings[0]).includes("apiKey"), false);
  });

  it("rejects invalid fingerprints and template IDs", async () => {
    await assert.rejects(
      db.upsertVapiTemplateMapping({ template_id: 1, template_version: 1, config_fingerprint: "bad", compatibility_status: "compatible" }),
      /SHA-256 fingerprint/,
    );
    await assert.rejects(db.listVapiTemplateMappings("bad"), /valid template ID/);
  });

  it("claims a compatible mapping once and persists a synchronized assistant", async () => {
    const templateId = await db.createCallTemplate({
      name: "Vapi sync test",
      prompt: "Prompt",
      first_message: "Hello",
    });
    const fingerprint = "b".repeat(64);
    await db.upsertVapiTemplateMapping({
      template_id: templateId,
      template_version: 1,
      config_fingerprint: fingerprint,
      compatibility_status: "compatible",
      summary: { mapped_fields: ["model", "voice"] },
    });
    assert.equal(await db.claimVapiTemplateSync(templateId, 1, fingerprint), true);
    assert.equal(await db.claimVapiTemplateSync(templateId, 1, fingerprint), false);
    await db.completeVapiTemplateSync({
      template_id: templateId,
      template_version: 1,
      config_fingerprint: fingerprint,
      vapi_assistant_id: "asst_sync_test",
      vapi_assistant_version: "v2",
    });
    const [mapping] = await db.listVapiTemplateMappings(templateId);
    assert.equal(mapping.sync_status, "synced");
    assert.equal(mapping.mapping_status, "provisioned");
    assert.equal(mapping.vapi_assistant_id, "asst_sync_test");
    assert.equal(mapping.vapi_assistant_version, "v2");
    const byAssistantId = await db.listVapiTemplateMappingsByAssistantId("asst_sync_test");
    assert.equal(byAssistantId.length, 1);
    assert.equal(byAssistantId[0].template_id, templateId);
  });

  it("persists compact Vapi simulation summaries with per-template idempotency", async () => {
    const templateId = await db.createCallTemplate({ name: "Vapi simulation persistence", prompt: "Prompt", first_message: "Hello" });
    const fingerprint = "d".repeat(64);
    await db.upsertVapiTemplateMapping({
      template_id: templateId, template_version: 1, config_fingerprint: fingerprint,
      compatibility_status: "compatible", summary: { mapped_fields: ["model", "voice"] },
    });
    await db.completeVapiTemplateSync({
      template_id: templateId, template_version: 1, config_fingerprint: fingerprint,
      vapi_assistant_id: "assistant_sim_persist", vapi_assistant_version: "v2",
    });
    const [mapping] = await db.listVapiTemplateMappings(templateId);
    const input = {
      run_id: "vapi-run-persist-1", template_id: templateId, template_version: 1, mapping_id: mapping.id,
      assistant_id: "assistant_sim_persist", suite_id: "suite-persist", idempotency_key: "sim-persist-key-001",
      actor_id: "admin", summary: { status: "queued", item_counts: {} }, safety: "tools_mocked_assistant_and_scenario_hooks_clear",
    };
    const first = await db.recordVapiSimulationRun(input);
    const replay = await db.recordVapiSimulationRun(input);
    const latest = await db.getLatestVapiSimulationRun(templateId, 1);
    const rows = await db.listVapiSimulationRuns(templateId, 5);
    assert.equal(first.idempotent_replay, false);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(latest.run_id, "vapi-run-persist-1");
    assert.deepEqual(latest.summary, { status: "queued", item_counts: {} });
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows).includes("transcript"), false);
  });

  it("routes an inbound Vapi number only to an explicit current synced template mapping", async () => {
    const templateId = await db.createCallTemplate({ name: "Inbound Vapi", prompt: "Prompt", first_message: "Hi" });
    const fingerprint = "9".repeat(64);
    await db.upsertVapiTemplateMapping({
      template_id: templateId,
      template_version: 1,
      config_fingerprint: fingerprint,
      compatibility_status: "compatible",
      summary: {},
    });
    await db.claimVapiTemplateSync(templateId, 1, fingerprint);
    await db.completeVapiTemplateSync({
      template_id: templateId,
      template_version: 1,
      config_fingerprint: fingerprint,
      vapi_assistant_id: "asst_inbound_1",
    });
    const [mapping] = await db.listVapiTemplateMappings(templateId);

    await db.setVapiInboundAssistantRoute("pn_support_1", mapping.id);
    assert.equal((await db.getVapiInboundAssistantByPhoneNumberId("pn_support_1")).vapi_assistant_id, "asst_inbound_1");
    assert.equal(await db.getVapiInboundAssistantByPhoneNumberId("pn_unconfigured"), null);
    await db.updateCallTemplate(templateId, { prompt: "Changed prompt" });
    assert.equal(await db.getVapiInboundAssistantByPhoneNumberId("pn_support_1"), null);
  });

  it("lists only current, compatible, synced assistants for published templates", async () => {
    const liveTemplateId = await db.createCallTemplate({ name: "Live Web Voice", prompt: "Prompt", first_message: "Hello" });
    const draftTemplateId = await db.createCallTemplate({ name: "Draft Web Voice", prompt: "Prompt", first_message: "Hello" });
    await new Promise((resolve, reject) => db.db.run(
      "UPDATE call_templates SET lifecycle_state = 'live' WHERE id = ?",
      [liveTemplateId],
      (error) => error ? reject(error) : resolve(),
    ));
    for (const [templateId, fingerprint, assistantId] of [
      [liveTemplateId, "c".repeat(64), "asst_live_web"],
      [draftTemplateId, "d".repeat(64), "asst_draft_web"],
    ]) {
      await db.upsertVapiTemplateMapping({
        template_id: templateId,
        template_version: 1,
        config_fingerprint: fingerprint,
        compatibility_status: "compatible",
        summary: {},
      });
      await db.claimVapiTemplateSync(templateId, 1, fingerprint);
      await db.completeVapiTemplateSync({
        template_id: templateId,
        template_version: 1,
        config_fingerprint: fingerprint,
        vapi_assistant_id: assistantId,
      });
    }
    const assistants = await db.listVapiWebCallAssistants();
    assert.deepEqual(assistants.map((row) => row.vapi_assistant_id), ["asst_live_web"]);
    assert.equal(assistants[0].template_name, "Live Web Voice");
    await db.upsertVapiTemplateMapping({
      template_id: liveTemplateId,
      template_version: 1,
      config_fingerprint: "e".repeat(64),
      compatibility_status: "compatible",
      summary: {},
    });
    assert.deepEqual(await db.listVapiWebCallAssistants(), []);
  });

  it("stores deduplicated Vapi call lifecycle fields without event payload content", async () => {
    const event = {
      event_key: "c".repeat(64),
      provider_call_id: "call_event_test",
      event_type: "end-of-call-report",
      provider_status: "ended",
      ended_reason: "hangup",
      duration_seconds: 38,
      assistant_id: "asst_event_test",
      template_id: 9,
      template_version: 2,
      config_fingerprint: "d".repeat(64),
      event_timestamp: "2026-10-25T10:00:00.000Z",
    };
    assert.deepEqual(await db.recordVapiCallEvent(event), { inserted: true });
    assert.deepEqual(await db.recordVapiCallEvent(event), { inserted: false });
    const rows = await db.listVapiCallEvents({ template_id: 9 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider_call_id, "call_event_test");
    assert.equal(rows[0].duration_seconds, 38);
    assert.equal("payload" in rows[0], false);
  });

  it("persists only the transfer destination type for sanitized Vapi transfer events", async () => {
    await db.recordVapiCallEvent({
      event_key: "f".repeat(64),
      provider_call_id: "call_transfer_db",
      event_type: "status-update",
      provider_status: "forwarding",
      destination_type: "number",
    });
    const [event] = await db.listVapiCallEvents({ provider_call_id: "call_transfer_db" });
    assert.equal(event.destination_type, "number");
    assert.equal(Object.keys(event).some((key) => /number|sipUri|transcript|payload/i.test(key)), false);
  });

  it("adds the destination type column to an existing Vapi event table", async () => {
    await new Promise((resolve, reject) => db.db.close((err) => err ? reject(err) : resolve()));
    const legacy = new sqlite3.Database(dbPath);
    await new Promise((resolve, reject) => legacy.run(
      "ALTER TABLE vapi_call_events DROP COLUMN destination_type",
      (err) => err ? reject(err) : resolve(),
    ));
    await new Promise((resolve, reject) => legacy.close((err) => err ? reject(err) : resolve()));

    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    const columns = await new Promise((resolve, reject) => db.db.all(
      "PRAGMA table_info(vapi_call_events)",
      (err, rows) => err ? reject(err) : resolve(rows),
    ));
    assert.ok(columns.some((column) => column.name === "destination_type"));
  });

  it("correlates a Vapi provider call ID to its durable local outbound request", async () => {
    await db.reserveOutboundCallIdempotency({
      idempotency_key: "vapi:request-correlation-01",
      provider: "vapi",
      request_hash: "e".repeat(64),
    });
    await db.completeOutboundCallIdempotency({
      idempotency_key: "vapi:request-correlation-01",
      provider: "vapi",
      request_hash: "e".repeat(64),
      call_sid: "call_correlated_1",
      status: "completed",
      response_payload: { providerCallId: "call_correlated_1", templateId: 9, mappingId: 3 },
    });
    const call = await db.getVapiOutboundCallByProviderId("call_correlated_1");
    assert.equal(call.provider_call_id, "call_correlated_1");
    assert.equal(call.provider, "vapi");
    assert.equal(call.status, "completed");
    assert.equal(call.template_id, 9);
    assert.equal(call.mapping_id, 3);
  });

  it("correlates a Vapi web-call ID for inspection and reconciliation", async () => {
    await db.reserveOutboundCallIdempotency({
      idempotency_key: "vapi-web:request-correlation-01",
      provider: "vapi_web",
      request_hash: "f".repeat(64),
    });
    await db.completeOutboundCallIdempotency({
      idempotency_key: "vapi-web:request-correlation-01",
      provider: "vapi_web",
      request_hash: "f".repeat(64),
      call_sid: "call_web_correlated_1",
      status: "completed",
      response_payload: { templateId: 12, templateVersion: 4, mappingId: 8 },
    });
    const call = await db.getVapiOutboundCallByProviderId("call_web_correlated_1");
    assert.deepEqual({
      provider: call.provider,
      provider_call_id: call.provider_call_id,
      template_id: call.template_id,
      template_version: call.template_version,
      mapping_id: call.mapping_id,
    }, {
      provider: "vapi_web",
      provider_call_id: "call_web_correlated_1",
      template_id: 12,
      template_version: 4,
      mapping_id: 8,
    });
  });

  it("stores and lists a Vapi call campaign draft with its template version pinned", async () => {
    const templateId = await db.createCallTemplate({ name: "Campaign template", prompt: "Prompt", first_message: "Hello" });
    await new Promise((resolve, reject) => db.db.run(
      "UPDATE call_templates SET lifecycle_state = 'live' WHERE id = ?",
      [templateId],
      (error) => error ? reject(error) : resolve(),
    ));
    const fingerprint = "a".repeat(64);
    await db.upsertVapiTemplateMapping({
      template_id: templateId,
      template_version: 1,
      config_fingerprint: fingerprint,
      compatibility_status: "compatible",
      summary: {},
    });
    await db.claimVapiTemplateSync(templateId, 1, fingerprint);
    await db.completeVapiTemplateSync({
      template_id: templateId,
      template_version: 1,
      config_fingerprint: fingerprint,
      vapi_assistant_id: "asst_campaign_1",
    });
    const [mapping] = await db.listVapiTemplateMappings(templateId);
    const record = {
      campaign_id: "21234567-89ab-cdef-0123-456789abcdef",
      idempotency_key: "campaign-db-request-0001",
      request_hash: "b".repeat(64),
      name: "Weekday campaign",
      provider: "vapi",
      template_id: templateId,
      template_version: 1,
      mapping_id: mapping.id,
      phone_number_id: "pn_campaign_db_1",
      time_zone: "America/Los_Angeles",
      calling_window_start: "09:00",
      calling_window_end: "17:00",
      calling_days_json: "[1,2,3,4,5]",
      scheduled_start_at: null,
      max_concurrency: 1,
      max_retries: 0,
      retry_delay_minutes: 0,
    };
    assert.equal(await db.insertVapiCallCampaign(record), true);
    assert.equal(await db.insertVapiCallCampaign({ ...record, campaign_id: "31234567-89ab-cdef-0123-456789abcdef" }), false);
    const stored = await db.getVapiCallCampaignByIdempotencyKey(record.idempotency_key);
    const fetched = await db.getVapiCallCampaign(record.campaign_id);
    const listed = await db.listVapiCallCampaigns(10);
    assert.equal(stored.status, "draft");
    assert.equal(fetched.template_version, 1);
    assert.deepEqual(fetched.calling_days, [1, 2, 3, 4, 5]);
    assert.deepEqual(listed.map((campaign) => campaign.campaign_id), [record.campaign_id]);
  });
});
