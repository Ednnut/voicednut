'use strict';

const assert = require('node:assert/strict');
const { CallAgentSimulationService, SCENARIOS } = require('../services/callAgentSimulationService');

describe('offline call agent simulation lab', () => {
  const template = {
    id: 7, version: 2, name: 'Appointment helper', description: 'Confirm or change an appointment.',
    prompt: 'Confirm the caller appointment and use lookupInformation only when needed.',
    first_message: 'Hello, I am calling about your appointment today.',
    agent_config: {
      schema_version: 5, approved_tools: ['lookupInformation'], tool_timeout_ms: 5000,
      business_context: { business_name: 'Example', facts: [{ label: 'hours', value: 'Weekdays' }] },
      escalation_policy: { allowed_outcomes: ['review_case', 'secure_follow_up'], default_outcome: 'review_case' },
      tool_failure_policy: { on_tool_error: 'continue' }, handoff_policy: { enabled: false, confirmation: 'dtmf_1' },
    },
  };

  function setup(overrides = {}) {
    const stored = [];
    const db = {
      async getCallTemplateById() { return template; },
      async getCallTemplateVersion(_id, version) { return version === 1 ? { snapshot: JSON.stringify({ ...template, version: 1, prompt: 'Older prompt.', first_message: 'Are you ready? Are you there? Is that okay?' }) } : null; },
      async getLatestCallAgentSimulationRun() { return stored[0] || null; },
      async recordCallAgentSimulationRun(input) {
        const prior = stored.find((row) => row.idempotency_key === input.idempotency_key);
        if (prior) return { ...prior, results: prior.results, idempotent_replay: prior.request_hash === input.request_hash, conflict: prior.request_hash !== input.request_hash };
        const row = { ...input, results: input.results, results_json: JSON.stringify(input.results) };
        stored.unshift(row);
        return { ...row, idempotent_replay: false, conflict: false };
      },
      async listCallAgentSimulationRuns() { return stored; },
    };
    return { service: new CallAgentSimulationService({ db, ...overrides }), stored };
  }

  it('offers only fixed synthetic scenarios and reports zero model/provider requests', async () => {
    const { service, stored } = setup();
    const scenarios = service.listScenarios();
    assert.equal(scenarios.length, SCENARIOS.length);
    assert.equal(scenarios.some((scenario) => scenario.id === 'provider_isolation'), true);
    const result = await service.run({ script_id: 7, version: 2, actor_id: 'admin-1', idempotency_key: 'agent-sim-test-0001', scenario_ids: scenarios.map((row) => row.id) });
    assert.equal(result.provider_requests, 0);
    assert.equal(result.model_requests, 0);
    assert.equal(result.score, 100);
    assert.equal(result.failed_count, 0);
    assert.equal(result.evaluation_scope, 'full_suite');
    assert.equal(result.complete_suite, true);
    assert.equal(stored.length, 1);
    assert.equal(JSON.stringify(stored[0].results).includes(template.prompt), false);
  });

  it('loads an immutable historical version and compares regressions to the prior run', async () => {
    const { service, stored } = setup();
    const ids = ['task_readiness', 'prompt_quality', 'provider_isolation'];
    await service.run({ script_id: 7, version: 2, actor_id: 'admin-1', idempotency_key: 'agent-sim-current-01', scenario_ids: ids });
    const result = await service.run({ script_id: 7, version: 1, actor_id: 'admin-1', idempotency_key: 'agent-sim-older-0001', scenario_ids: ids });
    assert.equal(result.version, 1);
    assert.equal(result.comparison.baseline_version, 2);
    assert.equal(result.comparison.regressions.includes('prompt_quality'), true);
    assert.equal(stored.length, 2);
  });

  it('fails closed for missing tool safeguards and rejects unknown scenario or version input', async () => {
    const { service } = setup();
    const missingPolicyTemplate = { ...template, agent_config: null };
    service.db.getCallTemplateById = async () => missingPolicyTemplate;
    const result = await service.run({ script_id: 7, actor_id: 'admin-1', idempotency_key: 'agent-sim-no-policy-01', scenario_ids: ['tool_allowlist'] });
    assert.equal(result.failed_count, 1);
    assert.equal(result.scenarios[0].code, 'tool_allowlist_not_explicit');
    await assert.rejects(service.run({ script_id: 7, idempotency_key: 'agent-sim-unknown-01', scenario_ids: ['live_call'] }),
      (error) => error.code === 'call_agent_simulation_invalid');
    await assert.rejects(service.run({ script_id: 7, version: 8, idempotency_key: 'agent-sim-missing-v1', scenario_ids: ['provider_isolation'] }),
      (error) => error.code === 'call_agent_simulation_version_not_found');
  });

  it('replays fixed mock call and tool scripts without touching a real provider or model', async () => {
    const { service } = setup();
    const mockEvents = [];
    service.mockProvider = {
      startCall(input) { mockEvents.push(['start', input.scenario_id]); return { connected: true }; },
      finishCall(input) { mockEvents.push(['finish', input.scenario_id, input.outcome]); return { completed: true }; },
    };
    service.mockToolExecutor = {
      execute(input) {
        mockEvents.push(['tool', input.tool_name, input.scenario_id]);
        return {
          ok: true,
          result_code: input.scenario_id === 'task_completion'
            ? 'synthetic_appointment_confirmed'
            : 'synthetic_business_information_found',
        };
      },
    };
    const result = await service.run({
      script_id: 7, idempotency_key: 'agent-sim-scripted-0001',
      scenario_ids: ['task_completion', 'tool_use'],
    });
    assert.equal(result.score, 100);
    assert.deepEqual(result.scenarios.map((row) => row.task_completed), [true, true]);
    assert.equal(result.scenarios.every((row) => row.tool_calls === 1 && row.mock_call_status === 'completed'), true);
    assert.deepEqual(mockEvents.filter(([kind]) => kind === 'start').length, 2);
    assert.equal(mockEvents.filter(([kind]) => kind === 'tool').length, 2);
    assert.equal(result.provider_requests, 0);
    assert.equal(result.model_requests, 0);

    service.mockAgent = { respond: () => ({ outcome_code: 'task_incomplete' }) };
    const incomplete = await service.run({
      script_id: 7, idempotency_key: 'agent-sim-scripted-0002',
      scenario_ids: ['task_completion'],
    });
    assert.equal(incomplete.scenarios[0].status, 'failed');
    assert.equal(incomplete.scenarios[0].task_completed, false);
  });

  it('checks consent and unsafe-request boundaries with synthetic agent responses', async () => {
    const { service } = setup();
    const result = await service.run({
      script_id: 7, idempotency_key: 'agent-sim-safety-0001',
      scenario_ids: ['consent_boundary', 'refusal_boundary'],
    });
    assert.equal(result.failed_count, 0);
    assert.deepEqual(result.scenarios.map((row) => row.code), [
      'synthetic_safety_boundary_respected', 'synthetic_safety_boundary_respected',
    ]);

    service.mockAgent = { respond: ({ scenario_id }) => ({
      outcome_code: scenario_id === 'consent_boundary' ? 'request_consent_before_action' : 'refuse_unsafe_request',
      tool_calls: ['place_call'],
    }) };
    const unsafe = await service.run({
      script_id: 7, idempotency_key: 'agent-sim-safety-0002', scenario_ids: ['consent_boundary'],
    });
    assert.equal(unsafe.failed_count, 1);
    assert.equal(unsafe.scenarios[0].code, 'synthetic_safety_boundary_violated');
  });

  it('includes profile configuration in idempotency fingerprints and avoids mismatched score deltas', async () => {
    const { service, stored } = setup();
    const scenarioIds = ['task_readiness', 'provider_isolation'];
    await service.run({ script_id: 7, idempotency_key: 'agent-sim-profile-key-01', scenario_ids: scenarioIds });
    service.db.getCallTemplateById = async () => ({ ...template, default_profile: 'critical' });
    await assert.rejects(service.run({ script_id: 7, idempotency_key: 'agent-sim-profile-key-01', scenario_ids: scenarioIds }),
      (error) => error.code === 'call_agent_simulation_idempotency_conflict');
    const differentCoverage = await service.run({ script_id: 7, idempotency_key: 'agent-sim-profile-key-02', scenario_ids: ['provider_isolation'] });
    assert.equal(differentCoverage.comparison.same_scenario_coverage, false);
    assert.equal(differentCoverage.comparison.score_delta, null);
    assert.equal(stored.length, 2);
  });

  it('blocks promotion without a full passing run for the approved current version', async () => {
    const { service } = setup();
    service.db.getCallTemplateById = async () => ({ ...template, lifecycle_state: 'approved' });
    let readiness = await service.getPromotionReadiness({ script_id: 7 });
    assert.equal(readiness.eligible, false);
    assert.ok(readiness.reasons.includes('evaluation_required'));
    assert.equal(readiness.checks.length, SCENARIOS.length);
    assert.equal(readiness.checks.every((check) => check.status === 'missing'), true);
    assert.deepEqual(readiness.failed_scenarios, []);
    assert.equal(readiness.missing_scenarios.length, SCENARIOS.length);

    const scenarios = service.listScenarios().map((scenario) => scenario.id);
    await service.run({ script_id: 7, version: 2, actor_id: 'admin-1', idempotency_key: 'agent-sim-promote-0001', scenario_ids: scenarios });
    readiness = await service.getPromotionReadiness({ script_id: 7 });
    assert.equal(readiness.eligible, true);
    assert.equal(readiness.score, 100);
    assert.equal(readiness.fingerprint_matches, true);
    assert.equal(readiness.checks.length, SCENARIOS.length);
    assert.equal(readiness.checks.every((check) => ['passed', 'not_applicable'].includes(check.status)), true);

    const focused = await service.run({ script_id: 7, version: 2, actor_id: 'admin-1', idempotency_key: 'agent-sim-promote-focus-01', scenario_ids: ['task_readiness'] });
    assert.equal(focused.evaluation_scope, 'focused');
    assert.equal(focused.complete_suite, false);
    readiness = await service.getPromotionReadiness({ script_id: 7 });
    assert.equal(readiness.eligible, false);
    assert.equal(readiness.evaluation_scope, 'focused');
    assert.equal(readiness.complete_suite, false);
    assert.ok(readiness.reasons.includes('scenario_coverage_incomplete'));
  });

  it('rejects stale fingerprints, missing scenario coverage, and failed safety checks', async () => {
    const { service } = setup();
    let currentTemplate = { ...template, lifecycle_state: 'approved' };
    service.db.getCallTemplateById = async () => currentTemplate;
    await service.run({ script_id: 7, version: 2, actor_id: 'admin-1', idempotency_key: 'agent-sim-partial-0001', scenario_ids: ['task_readiness'] });
    let readiness = await service.getPromotionReadiness({ script_id: 7 });
    assert.equal(readiness.eligible, false);
    assert.ok(readiness.reasons.includes('scenario_coverage_incomplete'));

    const allScenarios = service.listScenarios().map((scenario) => scenario.id);
    service.mockAgent = { respond: () => ({ outcome_code: 'task_incomplete' }) };
    await service.run({ script_id: 7, version: 2, actor_id: 'admin-1', idempotency_key: 'agent-sim-failed-0001', scenario_ids: allScenarios });
    readiness = await service.getPromotionReadiness({ script_id: 7 });
    assert.equal(readiness.eligible, false);
    assert.ok(readiness.reasons.includes('required_scenario_failed'));
    assert.ok(readiness.failed_scenarios.includes('task_completion'));
    assert.equal(readiness.checks.find((check) => check.id === 'task_completion').status, 'failed');

    currentTemplate = { ...template, lifecycle_state: 'approved', prompt: 'A changed prompt invalidates the previous run.' };
    readiness = await service.getPromotionReadiness({ script_id: 7 });
    assert.ok(readiness.reasons.includes('evaluation_fingerprint_stale'));
  });
});
