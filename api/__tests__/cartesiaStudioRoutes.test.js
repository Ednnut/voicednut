'use strict';

const assert = require('node:assert/strict');
const { registerCartesiaStudioRoutes } = require('../services/cartesiaStudioRoutes');

function makeResponse() {
  return {
    statusCode: 200, body: null, contentType: null, headers: {}, writableEnded: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    type(type) { this.contentType = type; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    once() { return this; },
    flushHeaders() { this.headersSent = true; },
    send(body) { this.body = body; return this; },
  };
}

function makeHarness(overrides = {}) {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map((verb) => [verb, (path, ...handlers) => routes.set(`${verb.toUpperCase()} ${path}`, handlers)]));
  const limiter = () => {};
  const authorization = () => {};
  const actorAssertion = () => {};
  const methods = {
    async listVoices() { return { voices: [{ id: 'voice_1', name: 'Studio voice' }] }; },
    async createInstantVoiceClone(input) { return { voice: { id: 'voice_new', access: 'private' }, clipBytes: input.clip.length }; },
    async synthesizePreview() { return { audioBase64: 'bW9jaw==', contentType: 'audio/wav', byteLength: 4 }; },
    async localizeVoice(input) { return { voice: { id: 'voice_localized', name: input.name } }; },
    async updateVoice() { return { updated: true }; },
    async deleteVoice() { return { deleted: true }; },
    async streamSpeech() { return { stream: null, contentType: 'text/event-stream' }; },
    async transcribeAudio() { return { transcript: 'mock transcription' }; },
    async transcribeAudioRealtime(input) { return { transcript: 'mock realtime transcription', keyterms: input.keyterms }; },
    async infillSpeech() { const audio = Buffer.from('mock'); audio.contentType = 'audio/wav'; return audio; },
    async listAccents() { return { accents: [{ id: 'accent_1' }] }; },
    async listAgents() { return { agents: [] }; },
    async listAgentTemplates() { return { templates: [{ id: 'template_1', name: 'Support starter', repositoryUrl: 'https://github.com/cartesia-ai/starter' }] }; },
    async updateAgent() { return { agent: { id: 'agent_1', name: 'Support' } }; },
    async listDeployments() { return { deployments: [] }; },
    async listAgentVersions() { return { versions: [{ id: 'version_1' }] }; },
    async getAgentLanguageReadiness() { return { agentId: 'agent_1', languages: [] }; },
    async evaluateAgentVersionGate(_agentId, versionId, input) { return { passed: true, versionId, sampleCount: input.callIds.length }; },
    async getManagedAgentConfigSummary() { return { currentVersionId: 'version_2', configSummary: {} }; },
    async getAgentVersion() { return { version: { id: 'version_1', configSummary: { model: 'sonic-3.6' } } }; },
    async restoreAgentVersion() { return { restoredFromVersionId: 'version_1', agentId: 'agent_1', currentVersionId: 'version_2' }; },
    async listPhoneNumbers() { return { phoneNumbers: [] }; },
    async importPhoneNumber(input) { return { phoneNumber: { id: 'phone_imported', number: `••••${input.number.slice(-4)}` } }; },
    async provisionPhoneNumber() { return { phoneNumber: { id: 'phone_provisioned', number: '••••0123' } }; },
    async updatePhoneNumber() { return { updated: true }; },
    async getCreditUsage() { return { data: [] }; },
    async getAgentUsage() { return { data: [] }; },
    getEnterpriseDataReadiness() { return { providerConfigured: true, zeroDataRetention: { remotelyVerifiable: false } }; },
    async getReadiness() { return { configuration: { enabled: true }, webhookReceipts: { count: 0 } }; },
    async listVoiceGovernance() { return { consents: [] }; },
    async revokeVoiceConsent(id) { return { revoked: true, consentId: id }; },
    async deleteGovernedClone(id) { return { deleted: true, consentId: id, voiceId: 'voice_1' }; },
    async deleteGovernedProCloneData(id) { return { deleted: true, consentId: id, datasetId: 'dataset_1' }; },
    async createClientTool(input) { return { tool: { id: 'client_tool_1', type: 'client', name: input.name } }; },
    async createDataset(input) { return { datasetId: 'dataset_1', name: input.name }; },
    ...overrides.methods,
  };
  registerCartesiaStudioRoutes(app, {
    cartesiaApprovalLimiter: limiter, requireOutboundAuthorization: authorization,
    requireCallEActorAssertion: actorAssertion,
    async isCartesiaAdminActor(actorId) { return actorId === '7001'; },
    createCartesiaStudioService() { return methods; },
    sendApiError(res, status, code, message) { return res.status(status).json({ success: false, code, error: message }); },
  }, { raw(options) { return Object.assign(() => {}, { options }); } });
  return { routes, methods, limiter, authorization, actorAssertion };
}

describe('Cartesia Studio API routes', () => {
  it('protects reads with limiter, API authorization, actor assertion, and admin verification', async () => {
    const { routes, limiter, authorization, actorAssertion } = makeHarness();
    const handlers = routes.get('GET /api/cartesia/studio/voices');
    assert.deepEqual(handlers.slice(0, 3), [limiter, authorization, actorAssertion]);
    const denied = makeResponse();
    await handlers[3]({ query: { actor_id: '7002' }, callEActorId: '7002', requestId: 'req_1' }, denied);
    assert.equal(denied.statusCode, 403);
    const allowed = makeResponse();
    await handlers[3]({ query: { actor_id: '7001' }, callEActorId: '7001' }, allowed);
    assert.deepEqual(allowed.body, { success: true, voices: [{ id: 'voice_1', name: 'Studio voice' }] });
  });

  it('protects readiness diagnostics with the same admin and API boundaries as other Studio reads', async () => {
    const { routes, limiter, authorization, actorAssertion } = makeHarness();
    const handlers = routes.get('GET /api/cartesia/studio/readiness');
    assert.deepEqual(handlers.slice(0, 3), [limiter, authorization, actorAssertion]);
    const denied = makeResponse();
    await handlers[3]({ callEActorId: '7002' }, denied);
    assert.equal(denied.statusCode, 403);
    const allowed = makeResponse();
    await handlers[3]({ callEActorId: '7001' }, allowed);
    assert.deepEqual(allowed.body, { success: true, configuration: { enabled: true }, webhookReceipts: { count: 0 } });
  });

  it('requires an exact provider-write confirmation before creating an Instant Voice Clone', async () => {
    let created = 0;
    let received;
    const { routes } = makeHarness({ methods: { async createInstantVoiceClone(input) { created += 1; received = input; return { voice: { id: 'voice_new' }, consentId: 'a'.repeat(32) }; } } });
    const handlers = routes.get('POST /api/cartesia/studio/voices/clone');
    const call = async (query) => {
      const res = makeResponse();
      await handlers.at(-1)({ query, params: {}, callEActorId: '7001', body: Buffer.from('mock audio') }, res);
      return res;
    };
    assert.equal(handlers[2].options.limit, '16mb');
    assert.equal((await call({ name: 'Support', language: 'en' })).statusCode, 400);
    assert.equal(created, 0);
    const allowed = await call({ name: 'Support', language: 'en', confirmation_phrase: 'I CONFIRM SPEAKER CONSENT AND CREATE CARTESIA CLONE SUPPORT' });
    assert.equal(allowed.statusCode, 201);
    assert.deepEqual(allowed.body, { success: true, voice: { id: 'voice_new' }, consentId: 'a'.repeat(32) });
    assert.equal(received.consentActorId, '7001');
    assert.equal(received.consentPhrase, 'I CONFIRM SPEAKER CONSENT AND CREATE CARTESIA CLONE SUPPORT');
    assert.equal(created, 1);
  });

  it('protects Cartesia lifecycle webhook management and requires exact confirmations for mutations', async () => {
    const received = [];
    const { routes, limiter, authorization, actorAssertion } = makeHarness({ methods: {
      async createAgentWebhook(input) { received.push(input); return { webhook: { id: 'agent_webhook_1' } }; },
      async deleteAgentWebhook(id) { received.push({ delete: id }); return { deleted: true }; },
      async listAgentWebhooks() { return { webhooks: [{ id: 'agent_webhook_1' }] }; },
    } });
    const list = routes.get('GET /api/cartesia/studio/webhooks');
    assert.deepEqual(list.slice(0, 3), [limiter, authorization, actorAssertion]);
    const created = routes.get('POST /api/cartesia/studio/webhooks');
    const denied = makeResponse();
    await created.at(-1)({ body: { display_name: 'Ops' }, callEActorId: '7001' }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(received.length, 0);
    const allowed = makeResponse();
    await created.at(-1)({ body: { display_name: 'Ops', confirmation_phrase: 'CREATE CARTESIA AGENT WEBHOOK OPS' }, callEActorId: '7001' }, allowed);
    assert.equal(allowed.statusCode, 201);
    assert.equal(received.length, 1);
    const deleted = routes.get('DELETE /api/cartesia/studio/webhooks/:webhookId');
    const badDelete = makeResponse();
    await deleted.at(-1)({ params: { webhookId: 'agent_webhook_1' }, body: { confirmation_phrase: 'delete' }, callEActorId: '7001' }, badDelete);
    assert.equal(badDelete.statusCode, 400);
    assert.equal(received.length, 1);
    const goodDelete = makeResponse();
    await deleted.at(-1)({ params: { webhookId: 'agent_webhook_1' }, body: { confirmation_phrase: 'DELETE CARTESIA AGENT WEBHOOK agent_webhook_1' }, callEActorId: '7001' }, goodDelete);
    assert.equal(goodDelete.body.deleted, true);
    assert.deepEqual(received[1], { delete: 'agent_webhook_1' });
  });

  it('gates paid speech generation and Pro clone training before provider service methods run', async () => {
    let previews = 0;
    let datasets = 0;
    const { routes } = makeHarness({ methods: {
      async synthesizePreview() { previews += 1; return { audioBase64: 'bW9jaw==' }; },
      async createDataset(input) { datasets += 1; assert.equal(input.consentActorId, '7001'); return { datasetId: 'dataset_1', consentId: 'b'.repeat(32) }; },
    } });
    const preview = routes.get('POST /api/cartesia/studio/tts-preview').at(-1);
    const deniedPreview = makeResponse();
    await preview({ body: { actor_id: '7001' }, callEActorId: '7001' }, deniedPreview);
    assert.equal(deniedPreview.statusCode, 400);
    assert.equal(previews, 0);
    const dataset = routes.get('POST /api/cartesia/studio/pro-clones/datasets').at(-1);
    const deniedDataset = makeResponse();
    await dataset({ body: { actor_id: '7001', name: 'PVC' }, callEActorId: '7001' }, deniedDataset);
    assert.equal(deniedDataset.statusCode, 400);
    assert.equal(datasets, 0);
    const allowedDataset = makeResponse();
    await dataset({ body: { actor_id: '7001', name: 'PVC', confirmation_phrase: 'CREATE CARTESIA PRO CLONE DATASET PVC' }, callEActorId: '7001' }, allowedDataset);
    assert.equal(allowedDataset.statusCode, 201);
    assert.equal(datasets, 1);
    assert.equal(allowedDataset.body.consentId, 'b'.repeat(32));
  });

  it('registers the expanded Cartesia admin routes and backend-gates resource mutations', async () => {
    let localized = 0;
    let voiceDeleted = 0;
    let phoneUpdated = 0;
    const { routes } = makeHarness({ methods: {
      async localizeVoice() { localized += 1; return { voice: { id: 'voice_localized' } }; },
      async deleteVoice() { voiceDeleted += 1; return { deleted: true }; },
      async updatePhoneNumber() { phoneUpdated += 1; return { updated: true }; },
    } });
    for (const route of [
      'GET /api/cartesia/studio/accents', 'POST /api/cartesia/studio/voices/localize',
      'PATCH /api/cartesia/studio/voices/:voiceId', 'DELETE /api/cartesia/studio/voices/:voiceId',
      'POST /api/cartesia/studio/tts-stream', 'POST /api/cartesia/studio/tts-continuations', 'POST /api/cartesia/studio/stt/transcribe',
      'POST /api/cartesia/studio/stt/realtime', 'POST /api/cartesia/studio/infill',
      'GET /api/cartesia/studio/agents/:agentId/deployments', 'GET /api/cartesia/studio/phone-numbers',
      'GET /api/cartesia/studio/agents/:agentId/versions', 'GET /api/cartesia/studio/agents/:agentId/versions/:versionId',
      'GET /api/cartesia/studio/agents/:agentId/config-summary',
      'GET /api/cartesia/studio/agent-templates',
      'GET /api/cartesia/studio/agents/:agentId/language-readiness',
      'GET /api/cartesia/studio/agent-profiles', 'POST /api/cartesia/studio/agent-profiles',
      'DELETE /api/cartesia/studio/agent-profiles/:profileId',
      'POST /api/cartesia/studio/agents/:agentId/profiles/:profileId/apply',
      'POST /api/cartesia/studio/agents/:agentId/versions/:versionId/evaluation-gate',
      'POST /api/cartesia/studio/agents/:agentId/versions/:versionId/restore',
      'PATCH /api/cartesia/studio/agents/:agentId',
      'POST /api/cartesia/studio/phone-numbers/import', 'POST /api/cartesia/studio/phone-numbers/provision',
      'PATCH /api/cartesia/studio/phone-numbers/:phoneNumberId', 'GET /api/cartesia/studio/usage/credits',
      'GET /api/cartesia/studio/usage/agents',
      'GET /api/cartesia/studio/privacy-readiness',
      'GET /api/cartesia/studio/voice-governance',
      'POST /api/cartesia/studio/voice-governance/:consentId/revoke',
      'POST /api/cartesia/studio/voice-governance/:consentId/delete-clone',
      'POST /api/cartesia/studio/voice-governance/:consentId/delete-pro-data',
      'POST /api/cartesia/studio/tools/client',
    ]) assert.ok(routes.has(route), `missing ${route}`);
    const localize = routes.get('POST /api/cartesia/studio/voices/localize').at(-1);
    const denied = makeResponse();
    await localize({ params: {}, callEActorId: '7001', body: { voice_id: 'voice_1', accent: 'fr-FR', name: 'French' } }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(localized, 0);
    const accepted = makeResponse();
    await localize({ params: {}, callEActorId: '7001', body: { voice_id: 'voice_1', accent: 'fr-FR', name: 'French', confirmation_phrase: 'LOCALIZE CARTESIA VOICE voice_1 TO fr-FR' } }, accepted);
    assert.equal(accepted.statusCode, 201);
    assert.equal(localized, 1);
    const removeVoice = routes.get('DELETE /api/cartesia/studio/voices/:voiceId').at(-1);
    const deniedDelete = makeResponse();
    await removeVoice({ params: { voiceId: 'voice_1' }, callEActorId: '7001', body: {} }, deniedDelete);
    assert.equal(deniedDelete.statusCode, 400);
    assert.equal(voiceDeleted, 0);
    const assign = routes.get('PATCH /api/cartesia/studio/phone-numbers/:phoneNumberId').at(-1);
    const deniedAssign = makeResponse();
    await assign({ params: { phoneNumberId: 'phone_1' }, callEActorId: '7001', body: { agent_id: 'agent_1' } }, deniedAssign);
    assert.equal(deniedAssign.statusCode, 400);
    assert.equal(phoneUpdated, 0);
  });

  it('backend-gates phone import and provisioning with confirmation phrases bound to the requested resource', async () => {
    let imported = 0;
    let provisioned = 0;
    const { routes } = makeHarness({ methods: {
      async importPhoneNumber() { imported += 1; return { phoneNumber: { id: 'phone_imported', number: '••••0123' } }; },
      async provisionPhoneNumber() { provisioned += 1; return { phoneNumber: { id: 'phone_provisioned', number: '••••0123' } }; },
    } });
    const importRoute = routes.get('POST /api/cartesia/studio/phone-numbers/import').at(-1);
    const importBody = { number: '+14155550123', provider: { id: 'provider_1' }, label: 'Support', agent_id: 'agent_1' };
    const deniedImport = makeResponse();
    await importRoute({ body: importBody, callEActorId: '7001' }, deniedImport);
    assert.equal(deniedImport.statusCode, 400);
    assert.equal(imported, 0);
    const acceptedImport = makeResponse();
    await importRoute({ body: { ...importBody, confirmation_phrase: 'IMPORT CARTESIA PHONE ENDING 0123 FROM PROVIDER provider_1 LABEL SUPPORT FOR AGENT agent_1' }, callEActorId: '7001' }, acceptedImport);
    assert.equal(acceptedImport.statusCode, 201);
    assert.equal(imported, 1);

    const provisionRoute = routes.get('POST /api/cartesia/studio/phone-numbers/provision').at(-1);
    const deniedProvision = makeResponse();
    await provisionRoute({ body: { label: 'Support', agent_id: 'agent_1', confirmation_phrase: 'PROVISION CARTESIA US PHONE SUPPORT' }, callEActorId: '7001' }, deniedProvision);
    assert.equal(deniedProvision.statusCode, 400);
    assert.equal(provisioned, 0);
    const acceptedProvision = makeResponse();
    await provisionRoute({ body: { label: 'Support', agent_id: 'agent_1', confirmation_phrase: 'PROVISION CARTESIA US PHONE SUPPORT FOR AGENT agent_1' }, callEActorId: '7001' }, acceptedProvision);
    assert.equal(acceptedProvision.statusCode, 201);
    assert.equal(provisioned, 1);
  });

  it('requires exact confirmation before updating a managed agent', async () => {
    let updates = 0;
    const { routes } = makeHarness({ methods: { async updateAgent() { updates += 1; return { agent: { id: 'agent_1' } }; } } });
    const route = routes.get('PATCH /api/cartesia/studio/agents/:agentId').at(-1);
    const denied = makeResponse();
    await route({ params: { agentId: 'agent_1' }, body: { name: 'Support' }, callEActorId: '7001' }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(updates, 0);
    const accepted = makeResponse();
    await route({ params: { agentId: 'agent_1' }, body: { name: 'Support', confirmation_phrase: 'UPDATE CARTESIA AGENT agent_1' }, callEActorId: '7001' }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(updates, 1);
  });

  it('backend-gates profile create, apply, and delete operations with resource-bound confirmation', async () => {
    let saved = 0; let applied = 0; let deleted = 0;
    const { routes } = makeHarness({ methods: {
      async saveAgentProfile(input, actorId) { saved += 1; assert.equal(input.name, 'Support'); assert.equal(actorId, '7001'); return { profile: { id: 'profile_1', name: 'Support' } }; },
      async applyAgentProfile(agentId, profileId) { applied += 1; return { profile: { id: profileId }, agent: { id: agentId } }; },
      async deleteAgentProfile(profileId) { deleted += 1; return { deleted: true, profileId }; },
    } });
    const create = routes.get('POST /api/cartesia/studio/agent-profiles').at(-1);
    const deniedCreate = makeResponse();
    await create({ body: { name: 'Support', config: { audio: {} } }, callEActorId: '7001' }, deniedCreate);
    assert.equal(deniedCreate.statusCode, 400); assert.equal(saved, 0);
    const acceptedCreate = makeResponse();
    await create({ body: { name: 'Support', config: { audio: {} }, confirmation_phrase: 'SAVE CARTESIA AGENT PROFILE SUPPORT' }, callEActorId: '7001' }, acceptedCreate);
    assert.equal(acceptedCreate.statusCode, 201); assert.equal(saved, 1);
    const apply = routes.get('POST /api/cartesia/studio/agents/:agentId/profiles/:profileId/apply').at(-1);
    const deniedApply = makeResponse();
    await apply({ params: { agentId: 'agent_1', profileId: 'profile_1' }, body: {}, callEActorId: '7001' }, deniedApply);
    assert.equal(deniedApply.statusCode, 400); assert.equal(applied, 0);
    const acceptedApply = makeResponse();
    await apply({ params: { agentId: 'agent_1', profileId: 'profile_1' }, body: { confirmation_phrase: 'APPLY CARTESIA AGENT PROFILE profile_1 TO AGENT agent_1' }, callEActorId: '7001' }, acceptedApply);
    assert.equal(acceptedApply.statusCode, 200); assert.equal(applied, 1);
    const remove = routes.get('DELETE /api/cartesia/studio/agent-profiles/:profileId').at(-1);
    const deniedDelete = makeResponse();
    await remove({ params: { profileId: 'profile_1' }, body: {}, callEActorId: '7001' }, deniedDelete);
    assert.equal(deniedDelete.statusCode, 400); assert.equal(deleted, 0);
    const acceptedDelete = makeResponse();
    await remove({ params: { profileId: 'profile_1' }, body: { confirmation_phrase: 'DELETE CARTESIA AGENT PROFILE profile_1' }, callEActorId: '7001' }, acceptedDelete);
    assert.equal(acceptedDelete.statusCode, 200); assert.equal(deleted, 1);
  });

  it('backend-gates consent revocation and tracked clone deletion', async () => {
    let revoked = 0;
    let deleted = 0;
    const { routes } = makeHarness({ methods: {
      async revokeVoiceConsent(id) { revoked += 1; return { revoked: true, consentId: id }; },
      async deleteGovernedClone(id) { deleted += 1; return { deleted: true, consentId: id }; },
    } });
    const revoke = routes.get('POST /api/cartesia/studio/voice-governance/:consentId/revoke').at(-1);
    const del = routes.get('POST /api/cartesia/studio/voice-governance/:consentId/delete-clone').at(-1);
    const params = { consentId: 'a'.repeat(32) };
    const denied = makeResponse();
    await revoke({ params, body: {}, callEActorId: '7001' }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(revoked, 0);
    const allowed = makeResponse();
    await revoke({ params, body: { confirmation_phrase: `REVOKE CARTESIA VOICE CONSENT ${params.consentId}` }, callEActorId: '7001' }, allowed);
    assert.equal(allowed.statusCode, 200);
    assert.equal(revoked, 1);
    const deniedDelete = makeResponse();
    await del({ params, body: {}, callEActorId: '7001' }, deniedDelete);
    assert.equal(deniedDelete.statusCode, 400);
    assert.equal(deleted, 0);
    const acceptedDelete = makeResponse();
    await del({ params, body: { confirmation_phrase: `DELETE CARTESIA CLONE LINKED TO CONSENT ${params.consentId}` }, callEActorId: '7001' }, acceptedDelete);
    assert.equal(acceptedDelete.statusCode, 200);
    assert.equal(deleted, 1);
  });

  it('requires an exact phrase before deleting tracked Pro Clone data', async () => {
    let deleted = 0;
    const { routes } = makeHarness({ methods: { async deleteGovernedProCloneData(id) { deleted += 1; return { deleted: true, consentId: id }; } } });
    const handler = routes.get('POST /api/cartesia/studio/voice-governance/:consentId/delete-pro-data').at(-1);
    const consentId = 'c'.repeat(32);
    const denied = makeResponse();
    await handler({ params: { consentId }, body: {}, callEActorId: '7001' }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(deleted, 0);
    const accepted = makeResponse();
    await handler({ params: { consentId }, body: { confirmation_phrase: `DELETE CARTESIA PRO CLONE DATA LINKED TO CONSENT ${consentId}` }, callEActorId: '7001' }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(deleted, 1);
  });

  it('requires an exact confirmation before registering a Cartesia client tool', async () => {
    let created = 0;
    const { routes } = makeHarness({ methods: { async createClientTool(input) { created += 1; assert.equal(input.name, 'lookup_order'); return { tool: { id: 'client_tool_1', type: 'client' } }; } } });
    const handler = routes.get('POST /api/cartesia/studio/tools/client').at(-1);
    const body = { name: 'lookup_order', parameters: { type: 'object', properties: {} } };
    const denied = makeResponse();
    await handler({ body, callEActorId: '7001' }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(created, 0);
    const accepted = makeResponse();
    await handler({ body: { ...body, confirmation_phrase: 'CREATE CARTESIA CLIENT TOOL LOOKUP_ORDER' }, callEActorId: '7001' }, accepted);
    assert.equal(accepted.statusCode, 201);
    assert.equal(created, 1);
  });

  it('requires test-version attestation and restore confirmation before restoring an agent snapshot', async () => {
    let restores = 0;
    let receivedEvaluation;
    const { routes } = makeHarness({ methods: {
      async restoreAgentVersion(agentId, versionId, evaluation) { restores += 1; receivedEvaluation = evaluation; return { restoredFromVersionId: versionId, agentId, currentVersionId: 'version_2' }; },
    } });
    const route = routes.get('POST /api/cartesia/studio/agents/:agentId/versions/:versionId/restore').at(-1);
    const params = { agentId: 'agent_1', versionId: 'version_1' };
    const denied = makeResponse();
    await route({ params, body: { confirmation_phrase: 'RESTORE CARTESIA AGENT agent_1' }, callEActorId: '7001' }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(restores, 0);
    const callIds = ['call_1', 'call_2', 'call_3'];
    const evaluation = { call_ids: callIds, metric_ids: ['metric_1'], minimum_samples: 3, minimum_pass_rate: 0.9,
      operator_attestation: `I ATTEST CARTESIA TEST CALLS ${callIds.join(',')} USED VERSION version_1` };
    const noAttestation = makeResponse();
    await route({ params, body: { confirmation_phrase: 'RESTORE CARTESIA AGENT agent_1 FROM VERSION version_1', evaluation: { ...evaluation, operator_attestation: '' } }, callEActorId: '7001' }, noAttestation);
    assert.equal(noAttestation.statusCode, 400);
    const accepted = makeResponse();
    await route({ params, body: { confirmation_phrase: 'RESTORE CARTESIA AGENT agent_1 FROM VERSION version_1', evaluation }, callEActorId: '7001' }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(restores, 1);
    assert.deepEqual(receivedEvaluation.callIds, callIds);
    assert.deepEqual(accepted.body, { success: true, restoredFromVersionId: 'version_1', agentId: 'agent_1', currentVersionId: 'version_2' });
  });

  it('requires an exact operator attestation before requesting an evaluation gate', async () => {
    let evaluations = 0;
    const { routes } = makeHarness({ methods: { async evaluateAgentVersionGate(agentId, versionId, input) { evaluations += 1; return { passed: true, agentId, versionId, sampleCount: input.callIds.length }; } } });
    const route = routes.get('POST /api/cartesia/studio/agents/:agentId/versions/:versionId/evaluation-gate').at(-1);
    const params = { agentId: 'agent_1', versionId: 'version_1' };
    const denied = makeResponse();
    await route({ params, body: { call_ids: ['call_1'], metric_ids: ['metric_1'] }, callEActorId: '7001' }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(evaluations, 0);
    const accepted = makeResponse();
    await route({ params, body: {
      call_ids: ['call_1'], metric_ids: ['metric_1'],
      operator_attestation: 'I ATTEST CARTESIA TEST CALLS call_1 USED VERSION version_1',
    }, callEActorId: '7001' }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(evaluations, 1);
  });

  it('streams confirmed TTS SSE to the API client without JSON-wrapping the provider stream', async () => {
    let piped = 0;
    let aborted = 0;
    const stream = { on() { return this; }, pipe(res) { piped += 1; return res; } };
    const { routes } = makeHarness({ methods: { async streamSpeech() { return { stream, contentType: 'text/event-stream', abort() { aborted += 1; } }; } } });
    const route = routes.get('POST /api/cartesia/studio/tts-stream').at(-1);
    const res = makeResponse();
    await route({ body: { actor_id: '7001', confirmation_phrase: 'STREAM CARTESIA TTS PREVIEW' }, callEActorId: '7001' }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.equal(piped, 1);
    assert.equal(aborted, 0);
  });

  it('requires an exact server-side confirmation before continuation TTS generation', async () => {
    let generated = 0;
    const { routes } = makeHarness({ methods: { async synthesizeContinuations() { generated += 1; return { audioBase64: 'AQID', byteLength: 3 }; } } });
    const route = routes.get('POST /api/cartesia/studio/tts-continuations').at(-1);
    const denied = makeResponse();
    await route({ body: { transcripts: ['one', 'two'] }, callEActorId: '7001' }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(generated, 0);
    const allowed = makeResponse();
    await route({ body: { confirmation_phrase: 'GENERATE CARTESIA TTS CONTINUATIONS', transcripts: ['one', 'two'] }, callEActorId: '7001' }, allowed);
    assert.equal(allowed.statusCode, 200);
    assert.equal(generated, 1);
  });

  it('keeps infill audio as audio bytes and rejects unsigned transcript metadata', async () => {
    let infills = 0;
    const { routes } = makeHarness({ methods: { async infillSpeech() { infills += 1; const audio = Buffer.from('mock'); audio.contentType = 'audio/wav'; return audio; } } });
    const route = routes.get('POST /api/cartesia/studio/infill').at(-1);
    const baseQuery = { actor_id: '7001', side: 'left', voice_id: 'voice_1', transcript_sha256: '0'.repeat(64), confirmation_phrase: 'GENERATE CARTESIA INFILL FOR VOICE voice_1' };
    const denied = makeResponse();
    await route({ query: baseQuery, headers: { 'x-cartesia-infill-transcript': 'Call me now.' }, params: {}, body: Buffer.from('mock audio'), callEActorId: '7001' }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(infills, 0);
    const transcript = 'Call me now.';
    const hash = require('node:crypto').createHash('sha256').update(transcript).digest('hex');
    const accepted = makeResponse();
    await route({ query: { ...baseQuery, transcript_sha256: hash }, headers: { 'x-cartesia-infill-transcript': transcript }, params: {}, body: Buffer.from('mock audio'), callEActorId: '7001' }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.contentType, 'audio/wav');
    assert.equal(Buffer.from(accepted.body).toString(), 'mock');
    assert.equal(infills, 1);
  });

  it('binds realtime STT keyterms and turn settings to a hash in the signed query', async () => {
    let received;
    const { routes } = makeHarness({ methods: { async transcribeAudioRealtime(input) { received = input; return { transcript: 'matched' }; } } });
    const route = routes.get('POST /api/cartesia/studio/stt/realtime').at(-1);
    const profileJson = JSON.stringify({ keyterms: ['Acme product'], turnSettings: { start_threshold: 0.8, eager_end_threshold: 0.6, end_threshold: 0.3, end_timeout_ms: 5600 } });
    const hash = require('node:crypto').createHash('sha256').update(profileJson).digest('hex');
    const base = { params: {}, body: Buffer.from([0, 0, 0, 0]), callEActorId: '7001', headers: { 'x-cartesia-stt-profile': Buffer.from(profileJson).toString('base64url') } };
    const denied = makeResponse();
    await route({ ...base, query: { actor_id: '7001', confirmation_phrase: 'TRANSCRIBE AUDIO WITH CARTESIA INK REALTIME', stt_profile_sha256: '0'.repeat(64) } }, denied);
    assert.equal(denied.statusCode, 400);
    assert.equal(received, undefined);
    const accepted = makeResponse();
    await route({ ...base, query: { actor_id: '7001', confirmation_phrase: 'TRANSCRIBE AUDIO WITH CARTESIA INK REALTIME', stt_profile_sha256: hash } }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(received.keyterms, ['Acme product']);
    assert.equal(received.turnSettings.end_timeout_ms, 5600);
  });

  it('requires the manual Ink confirmation phrase and routes manual mode without auto-turn settings', async () => {
    let received;
    let manualCalls = 0;
    const { routes } = makeHarness({ methods: {
      async transcribeAudioManual(input) { manualCalls += 1; received = input; return { transcript: 'manual transcript' }; },
    } });
    const route = routes.get('POST /api/cartesia/studio/stt/realtime').at(-1);
    const base = { params: {}, body: Buffer.from([0, 0, 0, 0]), callEActorId: '7001', headers: {} };
    const invalidMode = makeResponse();
    await route({ ...base, query: { actor_id: '7001', turn_mode: 'vad', confirmation_phrase: 'TRANSCRIBE AUDIO WITH CARTESIA INK MANUAL' } }, invalidMode);
    assert.equal(invalidMode.statusCode, 400);
    assert.equal(manualCalls, 0);

    const invalidConfirmation = makeResponse();
    await route({ ...base, query: { actor_id: '7001', turn_mode: 'manual', confirmation_phrase: 'TRANSCRIBE AUDIO WITH CARTESIA INK REALTIME' } }, invalidConfirmation);
    assert.equal(invalidConfirmation.statusCode, 400);
    assert.equal(manualCalls, 0);

    const oversized = makeResponse();
    await route({ ...base, body: Buffer.alloc(1_600_002), query: { actor_id: '7001', turn_mode: 'manual', confirmation_phrase: 'TRANSCRIBE AUDIO WITH CARTESIA INK MANUAL' } }, oversized);
    assert.equal(oversized.statusCode, 400);
    assert.equal(manualCalls, 0);

    const accepted = makeResponse();
    await route({ ...base, query: { actor_id: '7001', turn_mode: 'manual', confirmation_phrase: 'TRANSCRIBE AUDIO WITH CARTESIA INK MANUAL' } }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(manualCalls, 1);
    assert.deepEqual(received.audio, Buffer.from([0, 0, 0, 0]));
    assert.equal(received.encoding, 'pcm_s16le');
    assert.equal(received.sampleRate, 16000);
    assert.deepEqual(received.keyterms, []);
    assert.equal(Object.hasOwn(received, 'turnSettings'), false);
  });
});
