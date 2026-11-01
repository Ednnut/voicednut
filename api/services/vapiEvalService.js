'use strict';

const { containsCredentialLikeField } = require('../adapters/vapiTemplateAdapter');

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function summarizeEval(evaluation = {}) {
  return {
    id: String(evaluation.id || '').slice(0, 200),
    name: String(evaluation.name || 'Unnamed eval').slice(0, 80),
    description: String(evaluation.description || '').slice(0, 500),
    type: String(evaluation.type || 'chat.mockConversation').slice(0, 80),
    created_at: evaluation.createdAt || null,
    updated_at: evaluation.updatedAt || null,
  };
}

function summarizeEvalRun(run = {}) {
  const target = isRecord(run.target) ? run.target : {};
  const results = Array.isArray(run.results) ? run.results : [];
  return {
    id: String(run.id || '').slice(0, 200),
    eval_id: String(run.evalId || '').slice(0, 200) || null,
    status: String(run.status || 'unknown').slice(0, 40),
    ended_reason: String(run.endedReason || '').slice(0, 80) || null,
    created_at: run.createdAt || null,
    started_at: run.startedAt || null,
    ended_at: run.endedAt || null,
    cost_usd: run.cost !== null && run.cost !== undefined && Number.isFinite(Number(run.cost)) ? Number(run.cost) : null,
    target: {
      type: String(target.type || '').slice(0, 40) || null,
      id: String(target.assistantId || target.squadId || target.id || '').slice(0, 200) || null,
    },
    results: results.slice(0, 20).map((result) => ({
      status: String(result?.status || 'unknown').slice(0, 40),
      failed_checkpoint_count: Array.isArray(result?.messages)
        ? result.messages.filter((message) => String(message?.judge?.status || '').toLowerCase() === 'fail').length
        : null,
    })),
  };
}

class VapiEvalService {
  constructor(options = {}) {
    this.client = options.client;
  }

  assertConfigured() {
    if (!this.client?.isConfigured?.()) throw fail('vapi_not_configured', 'Vapi server credentials are not configured', 503);
  }

  async listEvals(options = {}) {
    this.assertConfigured();
    const page = Math.max(1, Math.min(100000, Math.floor(Number(options.page) || 1)));
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 20)));
    const response = await this.client.listEvals({ page, limit });
    return { page, limit, evaluations: rowsFrom(response).slice(0, limit).map(summarizeEval).filter((item) => item.id) };
  }

  async createEval(input = {}) {
    this.assertConfigured();
    const name = String(input.name || '').trim();
    const description = String(input.description || '').trim();
    const expectedConfirmation = 'CREATE VAPI EVAL';
    if (input.confirmation !== expectedConfirmation) throw fail('vapi_eval_confirmation_required', `Type ${expectedConfirmation} to confirm`);
    if (name.length < 1 || name.length > 80) throw fail('vapi_eval_name_invalid', 'Eval name must be between 1 and 80 characters');
    if (description.length > 500) throw fail('vapi_eval_description_invalid', 'Eval description must be 500 characters or fewer');
    const messages = input.messages;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100 || messages.some((message) => !isRecord(message))) {
      throw fail('vapi_eval_messages_invalid', 'Eval messages must be an array of 1 to 100 message objects');
    }
    let serialized;
    try { serialized = JSON.stringify(messages); } catch { throw fail('vapi_eval_messages_invalid', 'Eval messages must be valid JSON objects'); }
    if (serialized.length > 30000) throw fail('vapi_eval_messages_too_large', 'Eval messages must be 30 KB or smaller');
    if (containsCredentialLikeField(messages)) throw fail('vapi_eval_credentials_rejected', 'Eval messages must not contain credential-like fields');
    const response = await this.client.createEval({
      name,
      ...(description ? { description } : {}),
      messages,
      type: 'chat.mockConversation',
    });
    const result = summarizeEval(response || {});
    if (!result.id) throw fail('vapi_eval_response_invalid', 'Vapi did not return an eval ID', 502);
    return result;
  }

  async listRuns(options = {}) {
    this.assertConfigured();
    const page = Math.max(1, Math.min(100000, Math.floor(Number(options.page) || 1)));
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 20)));
    const response = await this.client.listEvalRuns({ page, limit });
    return { page, limit, runs: rowsFrom(response).slice(0, limit).map(summarizeEvalRun).filter((item) => item.id) };
  }

  async startRun(input = {}) {
    this.assertConfigured();
    const evalId = String(input.eval_id || '').trim();
    const targetType = String(input.target_type || '').trim().toLowerCase();
    const targetId = String(input.target_id || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(evalId)) throw fail('vapi_eval_id_invalid', 'A valid Vapi eval ID is required');
    if (!['assistant', 'squad'].includes(targetType)) throw fail('vapi_eval_target_type_invalid', 'Target type must be assistant or squad');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(targetId)) throw fail('vapi_eval_target_id_invalid', 'A valid assistant or squad ID is required');
    const expectedConfirmation = `RUN VAPI EVAL ${evalId} AGAINST ${targetType} ${targetId}`;
    if (input.confirmation !== expectedConfirmation) throw fail('vapi_eval_run_confirmation_required', `Type ${expectedConfirmation} to confirm`);
    const response = await this.client.createEvalRun({
      type: 'eval',
      evalId,
      target: targetType === 'assistant' ? { type: 'assistant', assistantId: targetId } : { type: 'squad', squadId: targetId },
    });
    const result = summarizeEvalRun(response || {});
    if (!result.id) throw fail('vapi_eval_run_response_invalid', 'Vapi did not return an eval run ID', 502);
    return result;
  }

  async getRun(runId) {
    this.assertConfigured();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(runId || '').trim())) throw fail('vapi_eval_run_id_invalid', 'A valid Vapi eval run ID is required');
    const run = await this.client.getEvalRun(runId);
    if (String(run?.id || '') !== String(runId)) throw fail('vapi_eval_run_not_found', 'Vapi eval run was not found', 404);
    return summarizeEvalRun(run);
  }
}

module.exports = { VapiEvalService, summarizeEval, summarizeEvalRun };
