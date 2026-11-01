'use strict';

const assert = require('node:assert/strict');
const { VapiEvalService, summarizeEvalRun } = require('../services/vapiEvalService');

function createClient(overrides = {}) {
  return {
    isConfigured: () => true,
    listEvals: async () => ({ results: [{ id: 'eval-1', name: 'Timezone check', messages: [{ content: 'private' }] }] }),
    createEval: async (configuration) => ({ id: 'eval-created', name: configuration.name, type: configuration.type }),
    listEvalRuns: async () => ({ results: [{
      id: 'run-1', evalId: 'eval-1', status: 'ended', endedReason: 'mockConversation.done', cost: 0.02,
      results: [{ status: 'fail', messages: [{ content: 'private transcript', judge: { status: 'fail' } }] }],
    }] }),
    createEvalRun: async (configuration) => ({ id: 'run-created', status: 'queued', evalId: configuration.evalId }),
    getEvalRun: async (id) => ({ id, status: 'ended', results: [{ status: 'pass', messages: [{ content: 'private transcript' }] }] }),
    ...overrides,
  };
}

describe('VapiEvalService', () => {
  it('lists compact eval summaries without mock conversation messages', async () => {
    const result = await new VapiEvalService({ client: createClient() }).listEvals({ limit: 10 });
    assert.equal(result.evaluations[0].id, 'eval-1');
    assert.equal(result.evaluations[0].name, 'Timezone check');
    assert.equal('messages' in result.evaluations[0], false);
  });

  it('requires backend confirmation before creating an eval', async () => {
    let writes = 0;
    const service = new VapiEvalService({ client: createClient({ createEval: async () => { writes += 1; return { id: 'eval-1' }; } }) });
    await assert.rejects(service.createEval({ name: 'Test', messages: [{ role: 'system', content: 'prompt' }] }),
      (error) => error.code === 'vapi_eval_confirmation_required');
    assert.equal(writes, 0);
  });

  it('creates only bounded mock-conversation eval definitions', async () => {
    let saved;
    const service = new VapiEvalService({ client: createClient({ createEval: async (value) => { saved = value; return { id: 'eval-new', ...value }; } }) });
    const result = await service.createEval({
      name: 'Greeting behavior', description: 'Checks a greeting', messages: [{ role: 'user', content: 'Hi' }], confirmation: 'CREATE VAPI EVAL',
    });
    assert.equal(result.id, 'eval-new');
    assert.equal(saved.type, 'chat.mockConversation');
    assert.equal(saved.messages[0].content, 'Hi');
  });

  it('rejects credential-like keys in messages and never calls Vapi', async () => {
    let writes = 0;
    const service = new VapiEvalService({ client: createClient({ createEval: async () => { writes += 1; return { id: 'x' }; } }) });
    await assert.rejects(service.createEval({
      name: 'Unsafe', messages: [{ role: 'system', api_key: 'hidden' }], confirmation: 'CREATE VAPI EVAL',
    }), (error) => error.code === 'vapi_eval_credentials_rejected');
    assert.equal(writes, 0);
  });

  it('requires an exact confirmation and a valid assistant or squad before launching a run', async () => {
    let submitted;
    const service = new VapiEvalService({ client: createClient({ createEvalRun: async (body) => { submitted = body; return { id: 'run-new', ...body }; } }) });
    const input = { eval_id: 'eval-1', target_type: 'squad', target_id: 'squad-1' };
    await assert.rejects(service.startRun(input), (error) => error.code === 'vapi_eval_run_confirmation_required');
    const result = await service.startRun({ ...input, confirmation: 'RUN VAPI EVAL eval-1 AGAINST squad squad-1' });
    assert.equal(result.id, 'run-new');
    assert.deepEqual(submitted.target, { type: 'squad', squadId: 'squad-1' });
    assert.equal(submitted.type, 'eval');
  });

  it('summarizes run results without returning conversation content', async () => {
    const result = summarizeEvalRun({
      id: 'run-1', status: 'ended', cost: 0.02,
      results: [{ status: 'fail', messages: [{ content: 'private transcript', judge: { status: 'fail' } }] }],
    });
    assert.equal(result.results[0].failed_checkpoint_count, 1);
    assert.doesNotMatch(JSON.stringify(result), /private transcript/);
    assert.equal(result.cost_usd, 0.02);
  });

  it('requires Vapi run lookup to return the requested ID', async () => {
    const service = new VapiEvalService({ client: createClient({ getEvalRun: async () => ({ id: 'other-run' }) }) });
    await assert.rejects(service.getRun('run-1'), (error) => error.code === 'vapi_eval_run_not_found');
  });
});
