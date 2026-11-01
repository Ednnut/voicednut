'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { runCallAgentSimulationLabFlow, runCallScriptPromotionFlow, showCallScriptPromotionHistory, showCallScriptPromotionReadiness } = require('../commands/scripts');
const { buildCallbackData } = require('../utils/actions');

function createConversation({ confirmation = 'RUN OFFLINE SIMULATION', selections = ['agent-simulation-version:2', 'agent-simulation-scope:full'] } = {}) {
  const replies = [];
  let messageId = 0;
  let selectionIndex = 0;
  const ctx = {
    chat: { id: 44, type: 'private' },
    session: {},
    reply: async (text, options) => {
      replies.push(String(text));
      return { chat: { id: 44 }, message_id: ++messageId, text, options };
    },
    api: {
      deleteMessage: async () => true,
      editMessageReplyMarkup: async () => true,
    },
  };
  const conversation = {
    waitFor: async (_filter, predicate) => {
      const callbackData = buildCallbackData(ctx, selections[selectionIndex++] || 'agent-simulation-version:2');
      const callbackCtx = {
        callbackQuery: { data: callbackData },
        answerCallbackQuery: async () => true,
      };
      assert.equal(predicate(callbackCtx), true);
      return callbackCtx;
    },
    wait: async () => ({ message: { text: confirmation } }),
  };
  return { conversation, ctx, replies };
}

describe('BOT offline agent simulation lab', () => {
it('requires typed offline confirmation and shows baseline results', async () => {
  const { conversation, ctx, replies } = createConversation();
  const calls = [];
  const apiClient = {
    listVersions: async () => [{ version: 1 }],
    listScenarios: async () => [{ id: 'task_readiness', label: 'Task readiness' }],
    listRuns: async () => [],
    run: async (id, body) => {
      calls.push({ id, body });
      return {
        version: 2, score: 100, passed_count: 1, failed_count: 0,
        scenarios: [{ id: 'task_readiness', status: 'passed', code: 'agent_definition_ready' }],
        comparison: { baseline_run_id: 'simrun_previous', baseline_version: 1, score_delta: 5, regressions: [] },
        model_requests: 0, provider_requests: 0,
      };
    },
  };

  await runCallAgentSimulationLabFlow(conversation, ctx, { id: 7, version: 2 }, () => {}, apiClient);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 7);
  assert.equal(calls[0].body.version, 2);
  assert.deepEqual(calls[0].body.scenario_ids, ['task_readiness']);
  assert.match(calls[0].body.idempotency_key, /^agent-sim:/);
  assert.ok(replies.some((text) => text.includes('Type RUN OFFLINE SIMULATION')));
  assert.ok(replies.some((text) => text.includes('Score: 100%')));
  assert.ok(replies.some((text) => text.includes('Mock model requests: 0 · provider requests: 0')));
});

it('reruns only prior failed checks and labels focused results as non-promotable', async () => {
  const { conversation, ctx, replies } = createConversation({
    selections: ['agent-simulation-version:2', 'agent-simulation-scope:failed'],
  });
  let request = null;
  await runCallAgentSimulationLabFlow(conversation, ctx, { id: 7, version: 2 }, () => {}, {
    listVersions: async () => [{ version: 1 }],
    listScenarios: async () => [
      { id: 'task_readiness', label: 'Task readiness' },
      { id: 'tool_allowlist', label: 'Tool allowlist' },
      { id: 'provider_isolation', label: 'Offline boundary' },
    ],
    listRuns: async () => [{
      version: 1, score: 67,
      results: { scenarios: [
        { id: 'task_readiness', status: 'passed' },
        { id: 'tool_allowlist', status: 'failed' },
        { id: 'provider_isolation', status: 'failed' },
      ] },
    }],
    async run(_id, body) {
      request = body;
      return {
        version: 2, evaluation_scope: 'focused', complete_suite: false,
        score: 100, passed_count: 2, failed_count: 0,
        scenarios: [
          { id: 'tool_allowlist', status: 'passed', code: 'unapproved_tool_blocked' },
          { id: 'provider_isolation', status: 'passed', code: 'zero_model_or_provider_requests' },
        ],
        model_requests: 0, provider_requests: 0,
      };
    },
  });
  assert.deepEqual(request.scenario_ids, ['tool_allowlist', 'provider_isolation']);
  assert.ok(replies.some((text) => text.includes('focused debug run cannot satisfy promotion')));
  assert.ok(replies.some((text) => text.includes('Focused debug run only. It cannot satisfy promotion')));
});

it('does not offer an obsolete failed check when the latest relevant run passed', async () => {
  const { conversation, ctx, replies } = createConversation({
    selections: ['agent-simulation-version:2'],
  });
  let request = null;
  await runCallAgentSimulationLabFlow(conversation, ctx, { id: 7, version: 2 }, () => {}, {
    listVersions: async () => [],
    listScenarios: async () => [{ id: 'task_readiness', label: 'Task readiness' }],
    listRuns: async () => [
      { version: 1, results: { scenarios: [{ id: 'task_readiness', status: 'passed' }] } },
      { version: 0, results: { scenarios: [{ id: 'task_readiness', status: 'failed' }] } },
    ],
    async run(_id, body) {
      request = body;
      return { version: 2, evaluation_scope: 'full_suite', complete_suite: true, score: 100,
        passed_count: 1, failed_count: 0, scenarios: [{ id: 'task_readiness', status: 'passed' }],
        model_requests: 0, provider_requests: 0 };
    },
  });
  assert.deepEqual(request.scenario_ids, ['task_readiness']);
  assert.equal(replies.some((text) => text.includes('Choose full suite or focused rerun')), false);
});

it('does not submit after confirmation is declined', async () => {
  const { conversation, ctx } = createConversation({ confirmation: 'cancel' });
  let submitted = false;
  const apiClient = {
    listVersions: async () => [],
    listScenarios: async () => [{ id: 'provider_isolation', label: 'Offline boundary' }],
    listRuns: async () => [],
    run: async () => { submitted = true; },
  };

  await runCallAgentSimulationLabFlow(conversation, ctx, { id: 7, version: 2 }, () => {}, apiClient);

  assert.equal(submitted, false);
});

it('shows promotion blockers and never submits promotion after a failed gate', async () => {
  const replies = [];
  let promotions = 0;
  let messageId = 0;
  const ctx = {
    session: {}, chat: { id: 44 }, from: { id: 12345 },
    reply: async (text) => { replies.push(String(text)); return { chat: { id: 44 }, message_id: ++messageId }; },
    api: { deleteMessage: async () => true, editMessageReplyMarkup: async () => true },
  };
  await runCallScriptPromotionFlow({ waitFor: async () => { throw new Error('confirmation must not be requested'); } }, ctx,
    { id: 7, version: 2, name: 'Appointment helper' }, () => {}, {
      getPromotionReadiness: async () => ({
        eligible: false, version: 2, minimum_score: 90, score: 78,
        run_id: 'simrun_failed', complete_suite: false, fingerprint_matches: true,
        reasons: ['required_scenario_failed', 'scenario_coverage_incomplete', 'score_below_threshold'],
        failed_scenarios: ['tool_allowlist'],
        missing_scenarios: ['consent_boundary'],
        checks: [
          { id: 'task_readiness', label: 'Task readiness', status: 'passed', code: 'agent_definition_ready' },
          { id: 'tool_allowlist', label: 'Tool allowlist', status: 'failed', code: 'tool_allowlist_violation' },
          { id: 'consent_boundary', label: 'Consent boundary', status: 'missing', code: 'scenario_not_run' },
        ],
      }),
      async promote() { promotions += 1; },
    });
  assert.equal(promotions, 0);
  assert.match(replies.join('\n'), /Promotion blocked/);
  assert.match(replies.join('\n'), /tool_allowlist/);
  assert.match(replies.join('\n'), /✅ Task readiness · passed/);
  assert.match(replies.join('\n'), /⛔ Tool allowlist · failed/);
  assert.match(replies.join('\n'), /▫️ Consent boundary · missing/);
  assert.match(replies.join('\n'), /simrun_failed/);
});

it('requires a separate BOT confirmation after the API reports a passing gate', async () => {
  const replies = [];
  let promotions = 0;
  let messageId = 0;
  const ctx = {
    session: {}, chat: { id: 44 }, from: { id: 12345 },
    reply: async (text) => { replies.push(String(text)); return { chat: { id: 44 }, message_id: ++messageId }; },
    api: { deleteMessage: async () => true, editMessageReplyMarkup: async () => true },
  };
  const conversation = {
    waitFor: async (_filter, predicate) => {
      const callbackCtx = {
        callbackQuery: { data: buildCallbackData(ctx, 'confirm:yes') },
        answerCallbackQuery: async () => true,
      };
      assert.equal(predicate(callbackCtx), true);
      return callbackCtx;
    },
  };
  let promotedActor = null;
  const promoted = await runCallScriptPromotionFlow(conversation, ctx,
    { id: 7, version: 2, name: 'Appointment helper' }, () => {}, {
      getPromotionReadiness: async () => ({
        eligible: true, version: 2, score: 100, minimum_score: 90, complete_suite: true, fingerprint_matches: true,
        run_id: 'simrun_passed', checks: [{ id: 'task_readiness', label: 'Task readiness', status: 'passed', code: 'agent_definition_ready' }],
      }),
      async promote(_id, actor) { promotions += 1; promotedActor = actor; return { id: 7, lifecycle_state: 'live' }; },
    });
  assert.equal(promotions, 1);
  assert.equal(promotedActor, 'telegram:12345');
  assert.equal(promoted.lifecycle_state, 'live');
  assert.match(replies.join('\n'), /separate live-promotion confirmation/);
  assert.match(replies.join('\n'), /✅ Task readiness · passed/);
});

it('shows a non-mutating readiness summary from the API', async () => {
  const replies = [];
  let messageId = 0;
  const ctx = {
    session: {}, chat: { id: 44 },
    reply: async (text) => { replies.push(String(text)); return { chat: { id: 44 }, message_id: ++messageId }; },
  };
  let promotions = 0;
  const readiness = await showCallScriptPromotionReadiness(ctx, { id: 7, version: 2 }, () => {}, {
    async getPromotionReadiness(id) {
      assert.equal(id, 7);
      return { eligible: false, version: 2, score: 0, minimum_score: 90, complete_suite: false,
        fingerprint_matches: false, run_id: null, reasons: ['evaluation_required'],
        checks: [{ id: 'task_readiness', label: 'Task readiness', status: 'missing', code: 'scenario_not_run' }] };
    },
    async promote() { promotions += 1; },
  });
  assert.equal(readiness.eligible, false);
  assert.equal(promotions, 0);
  assert.match(replies.join('\n'), /Promotion blocked/);
  assert.match(replies.join('\n'), /Evaluation run: none/);
  assert.match(replies.join('\n'), /Run Agent Lab for this version/);
});

it('shows sanitized promotion audit history with actor, test score, and prior live script', async () => {
  const replies = [];
  let messageId = 0;
  const ctx = {
    session: {}, chat: { id: 44 },
    reply: async (text) => { replies.push(String(text)); return { chat: { id: 44 }, message_id: ++messageId }; },
    api: { deleteMessage: async () => true, editMessageReplyMarkup: async () => true },
  };
  const events = await showCallScriptPromotionHistory({}, ctx, { id: 7, name: 'Appointment helper' }, () => {}, {
    async listPromotionHistory(id, limit) {
      assert.equal(id, 7);
      assert.equal(limit, 20);
      return [{
        version: 4, actor: 'telegram:12345', score: 100, created_at: '2026-10-31T00:00:00.000Z',
        simulation_run_id: 'simrun_123', previous_live_script_id: 6, previous_live_version: 2,
      }];
    },
  });
  assert.equal(events.length, 1);
  assert.match(replies.join('\n'), /v4 · 100% · telegram:12345/);
  assert.match(replies.join('\n'), /replaced script 6 v2/);
});
});
