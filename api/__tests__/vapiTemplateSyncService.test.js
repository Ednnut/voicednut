const assert = require("node:assert/strict");
const { VapiApiError } = require("../services/vapiClient");
const {
  MAPPING_METADATA_KEY,
  VapiTemplateSyncService,
} = require("../services/vapiTemplateSyncService");

function createHarness(options = {}) {
  const mappings = new Map();
  const remotes = [];
  let createCalls = 0;
  const keyOf = (templateId, version, fingerprint) => `${templateId}:${version}:${fingerprint}`;
  const db = {
    async upsertVapiTemplateMapping(record) {
      const key = keyOf(record.template_id, record.template_version, record.config_fingerprint);
      if (!mappings.has(key)) mappings.set(key, { ...record, sync_status: "not_synced", vapi_assistant_id: null });
      return mappings.get(key);
    },
    async listVapiTemplateMappings(templateId) {
      return [...mappings.values()]
        .filter((row) => row.template_id === templateId)
        .map((row) => ({ ...row }));
    },
    async claimVapiTemplateSync(templateId, version, fingerprint) {
      const row = mappings.get(keyOf(templateId, version, fingerprint));
      if (!row || row.sync_status === "syncing") return false;
      row.sync_status = "syncing";
      return true;
    },
    async completeVapiTemplateSync(record) {
      const row = mappings.get(keyOf(record.template_id, record.template_version, record.config_fingerprint));
      Object.assign(row, { sync_status: "synced", mapping_status: "provisioned", ...record });
      return true;
    },
    async failVapiTemplateSync(record) {
      const row = mappings.get(keyOf(record.template_id, record.template_version, record.config_fingerprint));
      if (row) Object.assign(row, record);
    },
  };
  const client = {
    isConfigured: () => true,
    async listAssistants() { return remotes; },
    async getAssistant(id) { return remotes.find((item) => item.id === id); },
    async createAssistant(payload) {
      createCalls += 1;
      if (options.createError) throw options.createError;
      const assistant = { id: `asst_${createCalls}`, latestVersion: "v1", ...payload };
      remotes.push(assistant);
      return assistant;
    },
    async updateAssistant(id, payload) {
      const assistant = remotes.find((item) => item.id === id);
      Object.assign(assistant, payload, { latestVersion: "v2" });
      return assistant;
    },
  };
  const service = new VapiTemplateSyncService({ db, client });
  return { service, mappings, remotes, getCreateCalls: () => createCalls };
}

const template = {
  id: 23,
  version: 4,
  name: "Existing template",
  prompt: "Follow the approved workflow.",
  first_message: "Hello.",
};
const candidates = {
  model: { provider: "openai", model: "gpt-4o" },
  voice: { provider: "11labs", voiceId: "voice-a" },
};

describe("VapiTemplateSyncService", () => {
  it("creates once, records the assistant ID, then updates the same mapped assistant", async () => {
    const harness = createHarness();
    const created = await harness.service.syncTemplate(template, candidates);
    const updated = await harness.service.syncTemplate(template, candidates);
    assert.equal(created.vapi_assistant_id, "asst_1");
    assert.equal(created.sync_status, "synced");
    assert.equal(updated.vapi_assistant_id, "asst_1");
    assert.equal(updated.vapi_assistant_version, "v2");
    assert.equal(harness.getCreateCalls(), 1);
    assert.equal(harness.remotes[0].metadata[MAPPING_METADATA_KEY].templateId, 23);
  });

  it("configures lifecycle webhook delivery only when a secured server config is supplied", async () => {
    const harness = createHarness();
    await harness.service.syncTemplate(template, {
      ...candidates,
      serverConfiguration: {
        url: "https://api.example.test/webhook/vapi",
        credentialId: "cred_vapi_webhook",
      },
    });
    assert.equal(harness.remotes[0].server.credentialId, "cred_vapi_webhook");
    assert.deepEqual(harness.remotes[0].serverMessages, ["assistant.started", "status-update", "end-of-call-report", "hang", "transfer-update"]);
  });

  it("reconciles a successful remote create after local completion failed", async () => {
    const harness = createHarness();
    const first = await harness.service.syncTemplate(template, candidates);
    const local = [...harness.mappings.values()][0];
    local.vapi_assistant_id = null;
    local.sync_status = "unknown";
    const retry = await harness.service.syncTemplate(template, candidates);
    assert.equal(retry.vapi_assistant_id, first.vapi_assistant_id);
    assert.equal(harness.getCreateCalls(), 1);
  });

  it("does not repeat an assistant create when the prior outcome is unknown", async () => {
    const harness = createHarness({ createError: new VapiApiError("timeout", { code: "vapi_timeout", retryable: true }) });
    await assert.rejects(harness.service.syncTemplate(template, candidates), /timeout/);
    assert.equal([...harness.mappings.values()][0].sync_status, "unknown");
    await assert.rejects(
      harness.service.syncTemplate(template, candidates),
      (error) => error.code === "vapi_create_outcome_unresolved",
    );
    assert.equal(harness.getCreateCalls(), 1);
    assert.equal([...harness.mappings.values()][0].sync_status, "unknown");
  });

  it("does not call the provider for incompatible templates", async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.service.syncTemplate({ ...template, supports_digit_capture: 1 }, candidates),
      (error) => error.code === "vapi_template_incompatible",
    );
    assert.equal(harness.getCreateCalls(), 0);
    assert.equal(harness.mappings.size, 0);
  });
});
