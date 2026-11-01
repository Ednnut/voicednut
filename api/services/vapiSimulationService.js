'use strict';

const crypto = require('node:crypto');
const { MAPPING_METADATA_KEY } = require('./vapiTemplateSyncService');

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.suites)) return payload.suites;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

function isOwnedAssistant(assistant, mapping) {
  const marker = assistant?.metadata?.[MAPPING_METADATA_KEY];
  return Boolean(marker && Number(marker.templateId) === Number(mapping.template_id) &&
    Number(marker.templateVersion) === Number(mapping.template_version) &&
    String(marker.configFingerprint || '').toLowerCase() === String(mapping.config_fingerprint || '').toLowerCase());
}

function hasUnsafeWebhookConfiguration(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return false;
  for (const [key, child] of Object.entries(value)) {
    if (/^(hooks?|webhooks?|serverurl|servermessages)$/i.test(key) &&
        (Array.isArray(child) ? child.length > 0 : child !== null && child !== false && child !== '')) return true;
    if (hasUnsafeWebhookConfiguration(child, depth + 1)) return true;
  }
  return false;
}

function toolNames(assistant) {
  const tools = Array.isArray(assistant?.model?.tools) ? assistant.model.tools
    : Array.isArray(assistant?.tools) ? assistant.tools : [];
  return tools.map((tool) => String(tool?.function?.name || tool?.name || '').trim()).filter(Boolean);
}

function safetyForScenario(assistant, scenario) {
  if (!scenario || typeof scenario !== 'object') return { safe: false, code: 'scenario_unavailable' };
  const assistantServer = assistant?.server;
  const assistantServerConfigured = Boolean(assistant?.serverUrl ||
    (assistantServer && typeof assistantServer === 'object' && (assistantServer.url || assistantServer.credentialId || assistantServer.headers)));
  if (assistantServerConfigured || hasUnsafeWebhookConfiguration(assistant) || hasUnsafeWebhookConfiguration(scenario)) {
    return { safe: false, code: 'hooks_or_webhooks_configured' };
  }
  const required = toolNames(assistant);
  const mocks = Array.isArray(scenario.toolMocks) ? scenario.toolMocks : [];
  const enabledMocks = new Set(mocks.filter((mock) => mock?.enabled === true)
    .map((mock) => String(mock?.toolName || '').trim()).filter(Boolean));
  if (required.some((name) => !enabledMocks.has(name))) return { safe: false, code: 'external_tool_not_mocked' };
  if ((assistant?.model?.tools || assistant?.tools || []).some((tool) => !String(tool?.function?.name || tool?.name || '').trim())) {
    return { safe: false, code: 'assistant_tool_shape_unknown' };
  }
  return { safe: true, code: 'all_tools_mocked' };
}

function compactRun(run = {}) {
  const itemCounts = run.itemCounts && typeof run.itemCounts === 'object' ? run.itemCounts : {};
  const passed = Number(itemCounts.passed);
  const failed = Number(itemCounts.failed);
  const hasScore = Number.isFinite(passed) && passed >= 0 && Number.isFinite(failed) && failed >= 0 && passed + failed > 0;
  return {
    vapi_run_id: String(run.id || run.runId || '').slice(0, 200) || null,
    status: String(run.status || 'queued').slice(0, 40),
    filter_status: String(run.filterStatus || '').slice(0, 40) || null,
    started_at: run.startedAt || null,
    ended_at: run.endedAt || null,
    item_counts: Object.fromEntries(Object.entries(itemCounts).slice(0, 12)
      .map(([key, value]) => [String(key).slice(0, 40), Math.max(0, Math.floor(Number(value) || 0))])),
    pass_rate_percent: hasScore ? Math.round((passed / (passed + failed)) * 100) : null,
    dashboard_url: /^https:\/\/(dashboard\.)?vapi\.ai\//.test(String(run.url || '')) ? String(run.url).slice(0, 500) : null,
  };
}

class VapiSimulationService {
  constructor(options = {}) {
    this.db = options.db;
    this.client = options.client;
  }

  async loadCurrent(templateId) {
    const id = Number(templateId);
    if (!Number.isSafeInteger(id) || id < 1) throw fail('vapi_simulation_template_invalid', 'A valid call template ID is required');
    const template = await this.db?.getCallTemplateById?.(id);
    if (!template) throw fail('vapi_simulation_template_not_found', 'Call template was not found', 404);
    const version = Number(template.version) || 1;
    const mappings = await this.db?.listVapiTemplateMappings?.(id) || [];
    const current = mappings.filter((row) => Number(row.template_version) === version && row.vapi_assistant_id);
    if (current.length !== 1) throw fail('vapi_simulation_mapping_unavailable', 'Exactly one current Vapi assistant mapping is required', 409);
    const mapping = current[0];
    if (String(template.lifecycle_state || '').toLowerCase() !== 'live' || mapping.compatibility_status !== 'compatible' ||
        mapping.mapping_status !== 'provisioned' || mapping.sync_status !== 'synced' || !mapping.last_synced_at) {
      throw fail('vapi_simulation_mapping_not_ready', 'The current live template must have a synced compatible Vapi assistant mapping', 409);
    }
    if (!this.client?.isConfigured?.()) throw fail('vapi_not_configured', 'Vapi server credentials are not configured', 503);
    const assistant = await this.client.getAssistant(mapping.vapi_assistant_id);
    if (String(assistant?.id || '') !== String(mapping.vapi_assistant_id) || !isOwnedAssistant(assistant, mapping)) {
      throw fail('vapi_simulation_assistant_mapping_mismatch', 'The mapped Vapi assistant ownership could not be verified', 409);
    }
    return { template, mapping, assistant, version };
  }

  async listSuites(templateId) {
    const { template, mapping, version } = await this.loadCurrent(templateId);
    const response = await this.client.listSimulationSuites({ assistantId: mapping.vapi_assistant_id, limit: 100 });
    const suites = rowsFrom(response).filter((suite) =>
      (Array.isArray(suite?.targetAssignments) ? suite.targetAssignments : []).some((assignment) =>
        assignment?.targetType === 'assistant' && String(assignment.targetId || '') === String(mapping.vapi_assistant_id)))
      .slice(0, 100).map((suite) => ({
        id: String(suite.id || '').slice(0, 200),
        name: String(suite.name || 'Unnamed suite').slice(0, 80),
        simulation_count: Array.isArray(suite.simulationIds) ? suite.simulationIds.length : 0,
        template_id: Number(template.id),
        template_version: version,
        mapping_id: Number(mapping.id),
      })).filter((suite) => suite.id);
    return { template_id: Number(template.id), template_version: version, assistant_id: mapping.vapi_assistant_id, suites };
  }

  async inspectSuite(suiteId, assistant) {
    const suite = await this.client.getSimulationSuite(suiteId);
    if (String(suite?.id || '') !== String(suiteId)) throw fail('vapi_simulation_suite_not_found', 'Vapi simulation suite was not found', 404);
    if (!(Array.isArray(suite.targetAssignments) ? suite.targetAssignments : []).some((assignment) =>
      assignment?.targetType === 'assistant' && String(assignment.targetId || '') === String(assistant.id))) {
      throw fail('vapi_simulation_suite_not_assigned', 'The suite is not assigned to this mapped assistant', 409);
    }
    if (String(suite.slackWebhookUrl || '').trim()) {
      throw fail('vapi_simulation_safety_gate_blocked', 'Vapi simulation suite notifications must be disabled before running', 409);
    }
    const ids = Array.isArray(suite.simulationIds) ? suite.simulationIds.map(String) : [];
    if (!ids.length || ids.length > 50) throw fail('vapi_simulation_suite_empty', 'The Vapi suite must contain between 1 and 50 simulations', 409);
    const checks = await Promise.all(ids.map(async (id) => {
      const simulation = await this.client.getSimulation(id);
      if (String(simulation?.id || '') !== id || !simulation.scenarioId) return { safe: false, code: 'simulation_unavailable' };
      const scenario = await this.client.getSimulationScenario(simulation.scenarioId);
      return safetyForScenario(assistant, scenario);
    }));
    const blocked = checks.find((check) => !check.safe);
    if (blocked) throw fail('vapi_simulation_safety_gate_blocked', `Vapi simulation safety validation failed: ${blocked.code}`, 409);
    return { suite, simulation_count: ids.length, safety: 'tools_mocked_assistant_and_scenario_hooks_clear' };
  }

  async startRun(input = {}) {
    const templateId = Number(input.template_id);
    const suiteId = String(input.suite_id || '').trim();
    const expected = `RUN VAPI SIMULATION TEMPLATE ${templateId} SUITE ${suiteId} WITH WEBHOOKS DISABLED`;
    if (input.confirmation !== expected) throw fail('vapi_simulation_confirmation_required', `Type ${expected} to confirm`, 400);
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(suiteId)) throw fail('vapi_simulation_suite_id_invalid', 'A valid suite ID is required');
    const iterations = Number(input.iterations || 5);
    if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 5) throw fail('vapi_simulation_iterations_invalid', 'Simulation iterations must be between 1 and 5');
    const { template, mapping, assistant, version } = await this.loadCurrent(templateId);
    const { simulation_count, safety } = await this.inspectSuite(suiteId, assistant);
    const key = String(input.idempotency_key || `voicednut-vapi-sim-${crypto.randomUUID()}`).slice(0, 200);
    const request = {
      simulations: [{ type: 'simulationSuite', simulationSuiteId: suiteId }],
      target: { type: 'assistant', assistantId: String(mapping.vapi_assistant_id) },
      transport: { provider: 'vapi.webchat' },
      iterations,
    };
    const remote = await this.client.createSimulationRun(request, key);
    const summary = compactRun(remote);
    if (!summary.vapi_run_id) throw fail('vapi_simulation_run_response_invalid', 'Vapi did not return a simulation run ID', 502);
    const previous = await this.db.getLatestVapiSimulationRun?.(templateId, version);
    const localBaseline = await this.getLocalBaseline(templateId, version);
    const record = await this.db.recordVapiSimulationRun?.({
      run_id: summary.vapi_run_id,
      template_id: templateId,
      template_version: version,
      mapping_id: Number(mapping.id),
      assistant_id: mapping.vapi_assistant_id,
      suite_id: suiteId,
      idempotency_key: key,
      actor_id: String(input.actor_id || 'admin'),
      summary,
      safety,
    });
    if (record?.conflict) throw fail('vapi_simulation_idempotency_conflict', 'This idempotency key is already bound to a different Vapi run', 409);
    return {
      ...summary,
      template_id: Number(template.id),
      template_version: version,
      suite_id: suiteId,
      simulation_count: simulation_count * iterations,
      safety: `${safety}_org_webhooks_operator_attested`,
      previous_run_id: previous?.run_id || null,
      local_baseline: localBaseline,
      score_delta_vs_local_baseline: Number.isFinite(summary.pass_rate_percent) && Number.isFinite(localBaseline?.score)
        ? summary.pass_rate_percent - localBaseline.score : null,
      idempotent_replay: Boolean(record?.idempotent_replay),
    };
  }

  async getLocalBaseline(templateId, version) {
    const baseline = await this.db.getLatestCallAgentSimulationRun?.(templateId, version);
    if (!baseline) return null;
    return {
      run_id: String(baseline.run_id || '').slice(0, 100) || null,
      score: Math.max(0, Math.min(100, Number(baseline.score) || 0)),
      passed_count: Math.max(0, Number(baseline.passed_count) || 0),
      failed_count: Math.max(0, Number(baseline.failed_count) || 0),
    };
  }

  async listRuns(templateId, limit) {
    const { template, version } = await this.loadCurrent(templateId);
    const rows = await this.db.listVapiSimulationRuns?.(Number(template.id), Math.max(1, Math.min(20, Number(limit) || 10)), version) || [];
    const recent = rows.slice(0, 5);
    await Promise.all(recent.map(async (row) => {
      if (!row.run_id || typeof this.client.getSimulationRun !== 'function') return;
      try {
        const remote = await this.client.getSimulationRun(row.run_id);
        const summary = compactRun(remote);
        if (summary.vapi_run_id === row.run_id) {
          row.summary = summary;
          await this.db.updateVapiSimulationRunSummary?.(Number(template.id), row.run_id, summary);
        }
      } catch (_) { /* Preserve last known status when Vapi is temporarily unavailable. */ }
    }));
    const localBaseline = await this.getLocalBaseline(Number(template.id), version);
    const runs = rows.map((row) => {
      const passRate = Number(row.summary?.pass_rate_percent);
      return { ...row, score_delta_vs_local_baseline: Number.isFinite(passRate) && Number.isFinite(localBaseline?.score)
        ? passRate - localBaseline.score : null };
    });
    return { template_id: Number(template.id), template_version: version, local_baseline: localBaseline, runs };
  }
}

module.exports = { VapiSimulationService, safetyForScenario, hasUnsafeWebhookConfiguration, compactRun };
