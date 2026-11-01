const assert = require('node:assert/strict');
const { VapiTemplateHealthService } = require('../services/vapiTemplateHealthService');

const fingerprint = 'b'.repeat(64);
const template = { id: 12, version: 3, lifecycle_state: 'live', name: 'Support', prompt: 'Answer using approved facts.', first_message: 'Hello.' };
const mapping = {
  id: 42,
  template_id: 12,
  template_version: 3,
  config_fingerprint: fingerprint,
  compatibility_status: 'compatible',
  mapping_status: 'provisioned',
  sync_status: 'synced',
  vapi_assistant_id: 'asst_health_1',
  vapi_assistant_version: 'v4',
  last_synced_at: '2026-10-30T10:00:00.000Z',
};
const assistant = {
  id: 'asst_health_1',
  latestVersion: 'v4',
  updatedAt: '2026-10-30T10:00:00.000Z',
  metadata: { voicednutTemplateMapping: { templateId: 12, templateVersion: 3, configFingerprint: fingerprint } },
  model: { provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'old local prompt' }] },
  voice: { provider: '11labs', voiceId: 'voice-health' },
};

function makeService(options = {}) {
  const calls = { getAssistant: 0, updateAssistant: 0, claimed: 0, completed: 0, failed: 0 };
  const db = {
    async getCallTemplateById() { return options.template || template; },
    async listVapiTemplateMappings() { return options.mappings || [mapping]; },
    async getVapiTemplateMappingById() { return options.mapping || mapping; },
    async claimVapiTemplateSync() { calls.claimed += 1; return true; },
    async completeVapiTemplateSync() { calls.completed += 1; return true; },
    async failVapiTemplateSync() { calls.failed += 1; },
  };
  const client = {
    isConfigured() { return options.configured !== false; },
    async getAssistant() { calls.getAssistant += 1; if (options.remoteError) throw options.remoteError; return options.assistant || assistant; },
    async updateAssistant(id, body) { calls.updateAssistant += 1; calls.payload = { id, body }; return { ...assistant, latestVersion: 'v4' }; },
  };
  return { service: new VapiTemplateHealthService({
    db,
    client,
    serverConfiguration: { url: 'https://api.example.test/webhook/vapi', credentialId: 'vapi-webhook' },
  }), calls };
}

describe('Vapi template health and confirmed resync service', () => {
  it('reports remote version and detects configuration changes since the last sync', async () => {
    const { service, calls } = makeService({ assistant: { ...assistant, latestVersion: 'v5', updatedAt: '2026-10-31T10:00:00.000Z' } });
    const result = await service.getHealth(12);
    assert.equal(result.template_version, 3);
    assert.equal(result.mappings[0].remote_assistant_version, 'v5');
    assert.ok(result.mappings[0].drift_flags.includes('published_version_changed'));
    assert.ok(result.mappings[0].drift_flags.includes('remote_updated_after_sync'));
    assert.equal(result.mappings[0].resync_available, true);
    assert.equal(calls.updateAssistant, 0);
    assert.equal(JSON.stringify(result).includes('old local prompt'), false);
  });

  it('does not contact Vapi for stale template mappings', async () => {
    const { service, calls } = makeService({ mappings: [{ ...mapping, template_version: 2 }] });
    const result = await service.getHealth(12);
    assert.ok(result.mappings[0].drift_flags.includes('template_version_outdated'));
    assert.equal(result.mappings[0].remote_status, 'not_checked');
    assert.equal(calls.getAssistant, 0);
  });

  it('resyncs only the exact mapped live assistant and does not publish or place calls', async () => {
    const { service, calls } = makeService();
    const result = await service.resync(12, 42);
    assert.deepEqual(result, { mapping_id: 42, assistant_id: 'asst_health_1', assistant_version: 'v4', sync_status: 'synced' });
    assert.equal(calls.claimed, 1);
    assert.equal(calls.updateAssistant, 1);
    assert.equal(calls.completed, 1);
    assert.equal(calls.payload.id, 'asst_health_1');
    assert.match(calls.payload.body.model.messages[0].content, /Answer using approved facts/);
    assert.equal(calls.payload.body.latestVersion, undefined);
  });

  it('rejects stale ownership markers and draft templates before remote writes', async () => {
    const mismatch = { ...assistant, metadata: { voicednutTemplateMapping: { templateId: 12, templateVersion: 2, configFingerprint: fingerprint } } };
    const state = makeService({ assistant: mismatch });
    await assert.rejects(state.service.resync(12, 42), (error) => error.code === 'vapi_assistant_mapping_mismatch');
    assert.equal(state.calls.updateAssistant, 0);

    const draft = makeService({ template: { ...template, lifecycle_state: 'draft' } });
    await assert.rejects(draft.service.resync(12, 42), (error) => error.code === 'vapi_template_not_live');
    assert.equal(draft.calls.updateAssistant, 0);
  });
});
