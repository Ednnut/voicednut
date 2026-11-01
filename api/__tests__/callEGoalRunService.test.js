'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { CallEGoalRunService } = require('../services/callEGoalRunService');

const goal = {
  object: 'goal', id: 'goal_delivery', title: 'Delivery check', description: 'Confirm a delivery window', status: 'active',
  published_run_spec: {
    id: 'rspec_delivery_v7', version: 7,
    input_schema: { type: 'object', additionalProperties: false, required: ['order_reference', 'confirm'], properties: {
      order_reference: { type: 'string' }, confirm: { type: 'boolean' },
    } },
    result_schema: { type: 'object', additionalProperties: false, required: ['outcome'], properties: { outcome: { type: 'string', enum: ['confirmed', 'declined'] } } },
  },
};
const encryptionKeys = { 1: 'goal-run-encryption-secret-which-is-longer-than-32-bytes' };
const idempotencySecret = 'goal-run-idempotency-secret-which-is-longer-than-32-bytes';
const baseInput = { business_id: 'business-a', actor_id: '12345', goal_id: 'goal_delivery', phone: '+14155550123',
  variables: { order_reference: 'ORD-42', confirm: true }, authorized: true, idempotency_key: 'goal-request-0001' };

function makeHarness(options = {}) {
  const rows = new Map();
  const keys = new Map();
  const calls = [];
  const database = {
    async getCallEGoalRunRequestByIdempotency(businessId, keyHash) { return keys.get(`${businessId}:${keyHash}`) || null; },
    async createCallEGoalRunRequest(input) {
      const existing = keys.get(`${input.business_id}:${input.idempotency_hash}`);
      if (existing) return { ...existing, idempotentReplay: true };
      const row = { ...input, status: 'pending_approval' };
      rows.set(input.goal_run_request_id, row);
      keys.set(`${input.business_id}:${input.idempotency_hash}`, row);
      return row;
    },
    async getCallEGoalRunRequest(id, businessId) { const row = rows.get(id); return row?.business_id === businessId ? row : null; },
    async listCallEGoalRunRequests(businessId) { return [...rows.values()].filter((row) => row.business_id === businessId); },
    async reviewCallEGoalRunRequest(input) {
      const row = rows.get(input.goal_run_request_id);
      if (!row || row.business_id !== input.business_id || row.status !== 'pending_approval' || row.created_by === input.reviewed_by) return null;
      Object.assign(row, { status: input.decision === 'approve' ? 'approved' : 'rejected', reviewed_by: input.reviewed_by });
      return row;
    },
    async markCallEGoalRunSubmitting(id) { const row = rows.get(id); row.status = 'submitting'; return row; },
    async saveCallEGoalRunProviderState(input) { const row = rows.get(input.goal_run_request_id); Object.assign(row, input); return row; },
    rows, calls,
  };
  let currentGoal = options.goal || goal;
  const client = {
    isConfigured: () => true,
    getProviderHealth: () => ({ dispatchAllowed: true }),
    async getGoal(id) { calls.push({ action: 'getGoal', id }); return currentGoal; },
    async listGoals() { return { object: 'list', data: [currentGoal], next_cursor: null }; },
    async createGoalRun(id, request, key) { calls.push({ action: 'createGoalRun', id, request, key }); return { object: 'goal_run', id: 'opaque-run-1', goal_id: id, status: 'queued', result_status: 'pending' }; },
    async getGoalRun(id, runId) { calls.push({ action: 'getGoalRun', id, runId }); return { object: 'goal_run', id: runId, goal_id: id, status: 'completed', call_outcome: 'completed', result_status: 'available', result: { outcome: 'confirmed' }, error: null }; },
  };
  const service = new CallEGoalRunService({
    client, db: database,
    workflowService: options.workflowService,
    campaignService: { async assertMembership(businessId, actorId) {
      calls.push({ action: 'membership', businessId, actorId });
      if (businessId !== 'business-a') throw Object.assign(new Error('scope denied'), { code: 'call_e_business_operator_access_denied', status: 403 });
      return { role: actorId === '54321' ? 'policy_manager' : 'call_operator' };
    } },
    contactPolicy: { async checkEligibility(input) { calls.push({ action: 'consent', input }); return { eligible: options.consentValid !== false }; } },
    idempotencySecret, encryptionKeys, allowedDestinations: ['+14155550123'],
    env: { CALLE_ENABLED: 'true', CALLE_DISPATCH_ENABLED: 'true', CALLE_GOAL_RUN_DISPATCH_ENABLED: 'true', CALLE_PILOT_READINESS_REVIEWED: 'true' },
  });
  return { service, database, calls, setGoal(value) { currentGoal = value; } };
}

describe('CALL-E Goal Run orchestration', () => {
  it('lists and reads only scoped published Goals with bounded schemas', async () => {
    const { service } = makeHarness();
    const list = await service.listGoals({ business_id: 'business-a', actor_id: '12345', limit: 10 });
    assert.equal(list.goals[0].id, 'goal_delivery');
    const detail = await service.getGoal({ business_id: 'business-a', actor_id: '12345', goal_id: 'goal_delivery' });
    assert.equal(detail.goal.published_run_spec.version, 7);
    await assert.rejects(service.getGoal({ business_id: 'other', actor_id: '12345', goal_id: 'goal_delivery' }), (error) => error.code === 'call_e_business_operator_access_denied');
  });

  it('stages consent-checked, encrypted Goal Run drafts with business-scoped idempotency', async () => {
    const { service, database } = makeHarness();
    const created = await service.createDraft(baseInput);
    const row = [...database.rows.values()][0];
    assert.equal(created.goal_run.status, 'pending_approval');
    assert.equal(row.encrypted_payload.includes(baseInput.phone), false);
    assert.equal(JSON.stringify(created).includes(baseInput.phone), false);
    assert.equal(row.published_run_spec_version, 7);
    assert.equal(row.destination_masked.endsWith('0123'), true);
    const replay = await service.createDraft(baseInput);
    assert.equal(replay.idempotent_replay, true);
    await assert.rejects(service.createDraft({ ...baseInput, variables: { order_reference: 'ORD-43', confirm: true } }), (error) => error.code === 'call_e_goal_run_idempotency_conflict');
    await assert.rejects(service.createDraft({ ...baseInput, variables: { order_reference: 'x', confirm: 'yes' }, idempotency_key: 'goal-request-0002' }), (error) => error.code === 'call_e_goal_variables_invalid');
  });

  it('requires a separate policy manager and rechecks schema, consent, and dispatch gates before starting one run', async () => {
    const { service, database, calls } = makeHarness();
    const draft = await service.createDraft(baseInput);
    const requestId = draft.goal_run.goal_run_request_id;
    await assert.rejects(service.review({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '12345', decision: 'approve' }), (error) => error.code === 'call_e_goal_run_review_forbidden');
    await service.review({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '54321', decision: 'approve' });
    const accepted = await service.advance({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '12345' });
    assert.equal(accepted.goal_run.status, 'running');
    assert.equal(accepted.goal_run.provider_goal_run_id, 'opaque-run-1');
    const submitted = calls.find((entry) => entry.action === 'createGoalRun');
    assert.equal(submitted.key, `voicednut:${requestId}`);
    assert.deepEqual(submitted.request, { phone: baseInput.phone, variables: baseInput.variables });
    assert.equal(calls.filter((entry) => entry.action === 'consent').length, 2);
    assert.equal(JSON.stringify(accepted).includes(baseInput.phone), false);
    const result = await service.reconcile({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '12345' });
    assert.equal(result.goal_run.result_status, 'available');
    assert.deepEqual(result.result, { outcome: 'confirmed' });
    const stored = await service.get({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '12345' });
    assert.deepEqual(stored.result, { outcome: 'confirmed' });
    assert.equal(database.rows.get(requestId).encrypted_result.includes('confirmed'), false);
  });

  it('sends validated Goal Run results to existing post-call workflows with a stable event key', async () => {
    const triggers = [];
    const { service } = makeHarness({ workflowService: { async triggerCallEResultReady(payload, schema, result) {
      triggers.push({ payload, schema, result });
      return { skipped: false, matched: 1, runs: [{ run_id: 'workflow-run-1', status: 'queued', deduped: triggers.length > 1 }] };
    } } });
    const draft = await service.createDraft(baseInput);
    const requestId = draft.goal_run.goal_run_request_id;
    await service.review({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '54321', decision: 'approve' });
    await service.advance({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '12345' });
    await service.reconcile({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '12345' });
    await service.reconcile({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '12345' });
    assert.equal(triggers.length, 2);
    assert.equal(triggers[0].payload.business_id, 'business-a');
    assert.equal(triggers[0].payload.goal_run_request_id, requestId);
    assert.equal(triggers[0].payload.idempotency_key, `call_e_goal_run:${requestId}:rspec_delivery_v7:7`);
    assert.deepEqual(triggers[0].result, { outcome: 'confirmed' });
    assert.deepEqual(triggers[0].schema.required, ['outcome']);
  });

  it('stops dispatch when current consent or the published Goal version changes', async () => {
    const noConsent = makeHarness({ consentValid: false });
    await assert.rejects(noConsent.service.createDraft(baseInput), (error) => error.code === 'call_e_consent_required');
    const changed = makeHarness();
    const draft = await changed.service.createDraft(baseInput);
    const requestId = draft.goal_run.goal_run_request_id;
    await changed.service.review({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '54321', decision: 'approve' });
    changed.setGoal({ ...goal, published_run_spec: { ...goal.published_run_spec, id: 'rspec-delivery-v8', version: 8 } });
    await assert.rejects(changed.service.advance({ goal_run_request_id: requestId, business_id: 'business-a', actor_id: '12345' }), (error) => error.code === 'call_e_goal_version_changed');
    assert.equal(changed.calls.some((entry) => entry.action === 'createGoalRun'), false);
  });
});
