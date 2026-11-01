'use strict';

const crypto = require('node:crypto');
const { normalizeWorkflowDefinition } = require('./postCallWorkflowDefinitionService');

function followupError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function hasAllowedAction(definition) {
  return definition?.trigger_event === 'call_e_result_ready' && Array.isArray(definition.steps) &&
    definition.steps.some((step) => step.type === 'action' && step.action_type === 'create_ticket') &&
    definition.steps.every((step) => step.type !== 'action' || step.action_type === 'create_ticket');
}

const RESULT_ACTION_CRM_PROVIDERS = new Set(['hubspot', 'salesforce', 'airtable', 'gohighlevel', 'managed', 'stub']);

class CallEResultFollowupService {
  constructor(options = {}) {
    this.db = options.db;
    this.campaignService = options.campaignService;
    this.definitionService = options.definitionService;
    this.workflowExecutionService = options.workflowExecutionService;
    this.idempotencySecret = String(options.idempotencySecret || '');
  }

  async assertPolicyManager(businessId, actorId) {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actorId) ||
        typeof this.campaignService?.assertMembership !== 'function') {
      throw followupError('call_e_business_operator_access_denied', 'A current business policy manager is required', 403);
    }
    return this.campaignService.assertMembership(businessId, actorId, new Set(['policy_manager']));
  }

  async list(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertPolicyManager(businessId, actorId);
    const rows = await this.db.listPostCallWorkflowDefinitions({ limit: 200 });
    const workflows = [];
    for (const row of rows || []) {
      if (row.business_id !== businessId || row.trigger_event !== 'call_e_result_ready') continue;
      let definition;
      try { definition = normalizeWorkflowDefinition(JSON.parse(row.definition_json || '{}')); } catch (_) { continue; }
      const actionsAllowed = hasAllowedAction(definition);
      const approval = actionsAllowed
        ? await this.db.getCallEResultWorkflowActionApproval(row.workflow_id, row.version, businessId)
        : null;
      workflows.push({ workflow_id: row.workflow_id, version: Number(row.version), name: row.name,
        status: row.status, created_by: row.created_by, approved_by: row.approved_by || null,
        actions_allowed: actionsAllowed, actions_approved_by: approval?.approved_by || null,
        needs_action_approval: actionsAllowed && !approval });
    }
    return { business_id: businessId, workflows };
  }

  async listPendingRuns(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertPolicyManager(businessId, actorId);
    const rows = await this.db.listPostCallWorkflowRuns({ business_id: businessId, trigger_event: 'call_e_result_ready', status: 'waiting_approval', limit: 50 });
    return { business_id: businessId, runs: (rows || []).map((row) => ({
      run_id: row.run_id, workflow_id: row.workflow_id, workflow_version: Number(row.workflow_version),
      trigger_reference: row.trigger_reference || null, status: row.status, created_at: row.created_at,
    })) };
  }

  async approveRun(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const runId = String(input.run_id || '').trim();
    await this.assertPolicyManager(businessId, actorId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(runId)) throw followupError('call_e_result_workflow_run_invalid', 'Workflow run ID is invalid');
    const run = await this.db.getPostCallWorkflowRun(runId);
    if (!run || run.business_id !== businessId || run.trigger_event !== 'call_e_result_ready') throw followupError('not_found', 'Result follow-up run was not found', 404);
    const definition = await this.db.getPostCallWorkflowDefinition(run.workflow_id, run.workflow_version);
    let normalized;
    try { normalized = normalizeWorkflowDefinition(JSON.parse(definition?.definition_json || '{}')); }
    catch (_) { throw followupError('call_e_result_workflow_invalid', 'Result workflow definition is unavailable', 409); }
    if (hasAllowedAction(normalized)) {
      const approval = await this.db.getCallEResultWorkflowActionApproval(run.workflow_id, run.workflow_version, businessId);
      if (!approval) throw followupError('call_e_result_workflow_action_approval_required', 'A policy manager must approve this workflow action before run-level approval', 403);
    }
    if (typeof this.workflowExecutionService?.approveRun !== 'function') throw followupError('call_e_result_workflow_unavailable', 'Workflow run approval is unavailable', 503);
    const approved = await this.workflowExecutionService.approveRun(runId, actorId);
    return { run_id: runId, status: approved.status, approved_by: actorId };
  }

  async createDraft(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertPolicyManager(businessId, actorId);
    if (typeof this.definitionService?.createDraft !== 'function') throw followupError('call_e_result_workflow_unavailable', 'Workflow definition storage is unavailable', 503);
    const definition = normalizeWorkflowDefinition({ ...input.definition, business_id: businessId, trigger_event: 'call_e_result_ready' });
    if (!hasAllowedAction(definition)) throw followupError('call_e_result_workflow_action_invalid', 'A result follow-up must use the approved create_ticket action');
    if (definition.steps.some((step) => step.type === 'action' && !RESULT_ACTION_CRM_PROVIDERS.has(String(step.config?.provider || '').trim().toLowerCase()))) {
      throw followupError('call_e_result_workflow_action_invalid', 'Result follow-up ticket provider is not supported');
    }
    const version = await this.definitionService.createDraft(definition, actorId);
    return { workflow: { workflow_id: version.workflow_id, version: version.version, name: version.name,
      business_id: businessId, status: version.status, needs_action_approval: true,
      run_level_human_approval_required: true, action_type: 'create_ticket' } };
  }

  async approveActions(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const workflowId = String(input.workflow_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const version = Number(input.version);
    const idempotencyKey = String(input.idempotency_key || '').trim();
    await this.assertPolicyManager(businessId, actorId);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(workflowId) || !Number.isSafeInteger(version) || version < 1 ||
        !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
      throw followupError('call_e_result_workflow_approval_invalid', 'Workflow action approval input is invalid');
    }
    if (this.idempotencySecret.length < 32) throw followupError('call_e_result_workflow_unavailable', 'Workflow approval integrity is unavailable', 503);
    const row = await this.db.getPostCallWorkflowDefinition(workflowId, version);
    if (!row || row.business_id !== businessId || row.trigger_event !== 'call_e_result_ready') throw followupError('not_found', 'Result follow-up workflow was not found', 404);
    if (String(row.created_by) === actorId) throw followupError('call_e_result_workflow_four_eyes_required', 'The workflow creator cannot approve its external action', 403);
    let definition;
    try { definition = normalizeWorkflowDefinition(JSON.parse(row.definition_json || '{}')); }
    catch (_) { throw followupError('call_e_result_workflow_invalid', 'Stored result workflow is invalid', 409); }
    if (!hasAllowedAction(definition)) throw followupError('call_e_result_workflow_action_invalid', 'Workflow contains an unsupported result action', 409);
    if (definition.steps.some((step) => step.type === 'action' && !RESULT_ACTION_CRM_PROVIDERS.has(String(step.config?.provider || '').trim().toLowerCase()))) {
      throw followupError('call_e_result_workflow_action_invalid', 'Result follow-up ticket provider is not supported', 409);
    }
    const requestHash = crypto.createHmac('sha256', this.idempotencySecret).update(JSON.stringify({ businessId, workflowId, version, actorId, idempotencyKey })).digest('hex');
    const result = await this.db.approveCallEResultWorkflowActions({ workflow_id: workflowId, version, business_id: businessId, approved_by: actorId, request_hash: requestHash });
    if (result.not_found) throw followupError('not_found', 'Result follow-up workflow was not found', 404);
    if (result.conflict) throw followupError('call_e_result_workflow_approval_conflict', 'Workflow action approval was already recorded by another manager', 409);
    if (result.not_draft) throw followupError('conflict', 'Workflow version cannot be approved in its current state', 409);
    return { workflow_id: workflowId, version, approved: result.approved === true, idempotent_replay: result.idempotent_replay === true,
      approved_by: actorId, per_run_approval_required: true };
  }
}

module.exports = { CallEResultFollowupService, hasAllowedAction };
