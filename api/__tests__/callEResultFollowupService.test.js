'use strict';

const assert = require('node:assert/strict');
const { CallEResultFollowupService } = require('../services/callEResultFollowupService');

function definition() {
  return {
    schema_version: 1, workflow_id: 'result_ticket_rule', business_id: 'biz-a', name: 'Review validated result',
    trigger_event: 'call_e_result_ready', template_id: 7, template_version: 2, result_classifications: [],
    start_step_id: 'review', steps: [
      { id: 'review', type: 'approval', next_step_id: 'ticket' },
      { id: 'ticket', type: 'action', action_type: 'create_ticket', config: { provider: 'hubspot', summary: 'Review a validated call result' }, next_step_id: 'done' },
      { id: 'done', type: 'end' },
    ],
  };
}

describe('CALL-E result follow-up service', () => {
  it('requires a different policy manager to approve the allowed workflow action and each result run', async () => {
    const savedDrafts = [];
    let actionApproval = null;
    const db = {
      async listPostCallWorkflowDefinitions() { return [{ workflow_id: 'result_ticket_rule', version: 1, business_id: 'biz-a', trigger_event: 'call_e_result_ready', status: 'draft', name: 'Review validated result', created_by: '111', definition_json: JSON.stringify(definition()) }]; },
      async getPostCallWorkflowDefinition() { return { workflow_id: 'result_ticket_rule', version: 1, business_id: 'biz-a', trigger_event: 'call_e_result_ready', status: 'draft', created_by: '111', definition_json: JSON.stringify(definition()) }; },
      async getCallEResultWorkflowActionApproval() { return actionApproval; },
      async approveCallEResultWorkflowActions(input) { savedDrafts.push(input); actionApproval = { approved_by: input.approved_by }; return { approved: true, idempotent_replay: false }; },
      async listPostCallWorkflowRuns() { return [{ run_id: 'run_abc', workflow_id: 'result_ticket_rule', workflow_version: 1, status: 'waiting_approval', business_id: 'biz-a', trigger_event: 'call_e_result_ready' }]; },
      async getPostCallWorkflowRun() { return { run_id: 'run_abc', workflow_id: 'result_ticket_rule', workflow_version: 1, status: 'waiting_approval', business_id: 'biz-a', trigger_event: 'call_e_result_ready' }; },
    };
    const service = new CallEResultFollowupService({
      db,
      campaignService: { async assertMembership(_businessId, actorId, roles) { assert.ok(roles.has('policy_manager')); return { telegram_id: actorId }; } },
      definitionService: { async createDraft(value, actor) { savedDrafts.push({ value, actor }); return { ...value, version: 1, status: 'draft' }; } },
      workflowExecutionService: { async approveRun(runId, actor) { return { run_id: runId, status: 'queued', approved_by: actor }; } },
      idempotencySecret: 'x'.repeat(64),
    });

    const created = await service.createDraft({ business_id: 'biz-a', actor_id: '111', definition: definition() });
    assert.equal(created.workflow.needs_action_approval, true);
    await assert.rejects(service.approveActions({ business_id: 'biz-a', actor_id: '111', workflow_id: 'result_ticket_rule', version: 1, idempotency_key: 'action-approval-key-01' }),
      (error) => error.code === 'call_e_result_workflow_four_eyes_required');
    const approved = await service.approveActions({ business_id: 'biz-a', actor_id: '222', workflow_id: 'result_ticket_rule', version: 1, idempotency_key: 'action-approval-key-02' });
    assert.equal(approved.approved, true);
    assert.equal(savedDrafts.at(-1).approved_by, '222');
    const runs = await service.listPendingRuns({ business_id: 'biz-a', actor_id: '222' });
    assert.equal(runs.runs[0].run_id, 'run_abc');
    const runApproved = await service.approveRun({ business_id: 'biz-a', actor_id: '333', run_id: 'run_abc' });
    assert.equal(runApproved.status, 'queued');
  });
});
