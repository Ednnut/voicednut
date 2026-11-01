const assert = require('node:assert/strict');
const { VapiSimulationService } = require('../services/vapiSimulationService');

const fingerprint = 'c'.repeat(64);
const template = { id: 7, version: 2, lifecycle_state: 'live' };
const mapping = {
  id: 19, template_id: 7, template_version: 2, config_fingerprint: fingerprint,
  compatibility_status: 'compatible', mapping_status: 'provisioned', sync_status: 'synced',
  vapi_assistant_id: 'assistant-vapi-test', last_synced_at: '2026-10-30T00:00:00.000Z',
};
const assistant = {
  id: mapping.vapi_assistant_id,
  metadata: { voicednutTemplateMapping: { templateId: 7, templateVersion: 2, configFingerprint: fingerprint } },
  model: { tools: [] },
};

function makeService(overrides = {}) {
  const calls = { create: 0, record: 0, refresh: 0 };
  const db = {
    async getCallTemplateById() { return template; },
    async listVapiTemplateMappings() { return [mapping]; },
    async getLatestVapiSimulationRun() { return null; },
    async getLatestCallAgentSimulationRun() { return { run_id: 'offline-1', score: 75, passed_count: 9, failed_count: 2 }; },
    async recordVapiSimulationRun(record) { calls.record += 1; calls.recorded = record; return { idempotent_replay: false }; },
    async listVapiSimulationRuns() { return [{ run_id: 'run-1', summary: { status: 'queued' } }]; },
    async updateVapiSimulationRunSummary(templateId, runId, summary) { calls.refresh += 1; calls.updated = { templateId, runId, summary }; },
  };
  const suite = {
    id: 'suite-safe-1', simulationIds: ['simulation-1'],
    targetAssignments: [{ targetType: 'assistant', targetId: assistant.id }],
  };
  const scenario = { id: 'scenario-1', hooks: [], toolMocks: [] };
  const client = {
    isConfigured() { return true; },
    async getAssistant() { return overrides.assistant || assistant; },
    async listSimulationSuites() { return [suite]; },
    async getSimulationSuite() { return overrides.suite || suite; },
    async getSimulation() { return { id: 'simulation-1', scenarioId: 'scenario-1' }; },
    async getSimulationScenario() { return overrides.scenario || scenario; },
    async createSimulationRun(body, key) {
      calls.create += 1;
      calls.request = { body, key };
      return { id: 'run-1', status: 'queued', itemCounts: { passed: 4, failed: 1 }, url: 'https://dashboard.vapi.ai/simulations/run-1' };
    },
    async getSimulationRun() { return overrides.remoteRun || { id: 'run-1', status: 'ended', itemCounts: { passed: 4, failed: 1 } }; },
  };
  return { service: new VapiSimulationService({ db, client }), calls };
}

describe('VapiSimulationService', () => {
  it('lists only suites assigned to the mapped Vapi assistant', async () => {
    const { service } = makeService();
    const result = await service.listSuites(7);
    assert.equal(result.template_version, 2);
    assert.deepEqual(result.suites.map((suite) => suite.id), ['suite-safe-1']);
  });

  it('requires the exact backend confirmation before starting a run', async () => {
    const { service, calls } = makeService();
    await assert.rejects(service.startRun({ template_id: 7, suite_id: 'suite-safe-1', confirmation: 'yes' }),
      (error) => error.code === 'vapi_simulation_confirmation_required');
    assert.equal(calls.create, 0);
  });

  it('fails closed when a scenario has hooks or an unmocked assistant tool', async () => {
    const hooked = makeService({ scenario: { hooks: [{ on: 'simulation.run.started', do: [{ type: 'webhook' }] },], toolMocks: [] } });
    await assert.rejects(hooked.service.startRun({
      template_id: 7, suite_id: 'suite-safe-1', confirmation: 'RUN VAPI SIMULATION TEMPLATE 7 SUITE suite-safe-1 WITH WEBHOOKS DISABLED',
    }), (error) => error.code === 'vapi_simulation_safety_gate_blocked');
    assert.equal(hooked.calls.create, 0);

    const tools = [{ function: { name: 'lookup_business_context' }, server: { url: 'https://api.example.test/tool' } }];
    const unmocked = makeService({ assistant: { ...assistant, model: { tools } } });
    await assert.rejects(unmocked.service.startRun({
      template_id: 7, suite_id: 'suite-safe-1', confirmation: 'RUN VAPI SIMULATION TEMPLATE 7 SUITE suite-safe-1 WITH WEBHOOKS DISABLED',
    }), (error) => error.code === 'vapi_simulation_safety_gate_blocked');
    assert.equal(unmocked.calls.create, 0);
  });

  it('starts an approved webchat simulation with idempotency and stores only a compact result', async () => {
    const { service, calls } = makeService();
    const result = await service.startRun({
      template_id: 7,
      suite_id: 'suite-safe-1',
      confirmation: 'RUN VAPI SIMULATION TEMPLATE 7 SUITE suite-safe-1 WITH WEBHOOKS DISABLED',
      iterations: 5,
      idempotency_key: 'voicednut-test-run-0001',
      actor_id: 'admin-test',
    });
    assert.equal(calls.create, 1);
    assert.equal(calls.request.key, 'voicednut-test-run-0001');
    assert.deepEqual(calls.request.body.target, { type: 'assistant', assistantId: assistant.id });
    assert.deepEqual(calls.request.body.transport, { provider: 'vapi.webchat' });
    assert.equal(result.simulation_count, 5);
    assert.equal(result.safety, 'tools_mocked_assistant_and_scenario_hooks_clear_org_webhooks_operator_attested');
    assert.equal(calls.record, 1);
    assert.equal(result.local_baseline.score, 75);
    assert.equal(result.score_delta_vs_local_baseline, 5);
    assert.equal(JSON.stringify(calls.recorded).includes('transcript'), false);
  });

  it('blocks assistants with a configured assistant-level webhook server', async () => {
    const service = makeService({ assistant: { ...assistant, server: { url: 'https://example.test/vapi-hook' } } });
    await assert.rejects(service.service.startRun({
      template_id: 7,
      suite_id: 'suite-safe-1',
      confirmation: 'RUN VAPI SIMULATION TEMPLATE 7 SUITE suite-safe-1 WITH WEBHOOKS DISABLED',
    }), (error) => error.code === 'vapi_simulation_safety_gate_blocked');
    assert.equal(service.calls.create, 0);
  });

  it('blocks suites with an external Slack notification webhook', async () => {
    const service = makeService({ suite: {
      id: 'suite-safe-1', simulationIds: ['simulation-1'],
      targetAssignments: [{ targetType: 'assistant', targetId: assistant.id }],
      slackWebhookUrl: 'https://hooks.slack.com/services/test',
    } });
    await assert.rejects(service.service.startRun({
      template_id: 7,
      suite_id: 'suite-safe-1',
      confirmation: 'RUN VAPI SIMULATION TEMPLATE 7 SUITE suite-safe-1 WITH WEBHOOKS DISABLED',
    }), (error) => error.code === 'vapi_simulation_safety_gate_blocked');
    assert.equal(service.calls.create, 0);
  });

  it('recovers persisted remote run status and compares its pass rate with the local offline baseline', async () => {
    const { service, calls } = makeService();
    const result = await service.listRuns(7, 5);
    assert.equal(calls.refresh, 1);
    assert.equal(calls.updated.summary.status, 'ended');
    assert.equal(result.local_baseline.score, 75);
    assert.equal(result.runs[0].summary.pass_rate_percent, 80);
    assert.equal(result.runs[0].score_delta_vs_local_baseline, 5);
  });
});
