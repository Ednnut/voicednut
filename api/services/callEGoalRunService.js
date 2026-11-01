'use strict';

const crypto = require('node:crypto');
const { validateGoalRunRequest } = require('./callEClient');
const { validateCallEResult } = require('../adapters/callETemplateAdapter');

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const GOAL_RUN_STATUSES = new Set(['queued', 'in_progress', 'completed', 'failed', 'canceled']);
const RESULT_STATUSES = new Set(['pending', 'available', 'unavailable', 'not_applicable']);

function goalRunError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function digest(secret, value) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw goalRunError('call_e_goal_run_unavailable', 'CALL-E Goal Run storage protection is unavailable', 503);
  }
  const source = typeof value === 'string' ? value : JSON.stringify(stableValue(value));
  return crypto.createHmac('sha256', secret).update(source).digest('hex');
}

function encryptionKey(keys, version) {
  const source = typeof keys === 'string' ? (version === 1 ? keys : '') : String(keys?.[version] || '');
  if (source.length < 32) throw goalRunError('call_e_goal_run_encryption_unavailable', 'CALL-E Goal Run encryption is not configured', 503);
  return crypto.createHash('sha256').update(`voicednut:call-e:goal-run:v${version}:`).update(source).digest();
}

function encryptPayload(payload, keys, recordId, version) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(keys, version), iv);
  cipher.setAAD(Buffer.from(`${recordId}:v${version}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `v${version}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptPayload(ciphertext, keys, recordId, version, options = {}) {
  const [prefix, iv, tag, encrypted, extra] = String(ciphertext || '').split('.');
  if (prefix !== `v${version}` || !iv || !tag || !encrypted || extra !== undefined) {
    throw goalRunError('call_e_goal_run_ciphertext_invalid', 'CALL-E Goal Run recovery data is invalid', 409);
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(keys, version), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${recordId}:v${version}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const clear = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
    const payload = JSON.parse(clear);
    return options.raw === true ? payload : validateGoalRunRequest(payload);
  } catch (error) {
    if (error?.code?.startsWith('call_e_goal_run_')) throw error;
    throw goalRunError('call_e_goal_run_decryption_failed', 'CALL-E Goal Run recovery data could not be decrypted', 409);
  }
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object' || schema.additionalProperties !== false ||
      !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties) || Object.keys(schema.properties).length > 100) {
    throw goalRunError('call_e_goal_schema_unsupported', 'The published CALL-E Goal schema is not supported by this integration', 409);
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some((key) => typeof key !== 'string' || !Object.hasOwn(schema.properties, key))) {
    throw goalRunError('call_e_goal_schema_unsupported', 'The published CALL-E Goal schema has invalid required fields', 409);
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!key || key.length > 120 || !property || typeof property !== 'object' || Array.isArray(property) ||
        !['string', 'number', 'integer', 'boolean'].includes(property.type) ||
        (property.enum !== undefined && (!Array.isArray(property.enum) || property.enum.length > 100))) {
      throw goalRunError('call_e_goal_schema_unsupported', 'The published CALL-E Goal schema uses unsupported input fields', 409);
    }
  }
  return { required, properties: schema.properties };
}

function validateGoalVariables(schema, variables) {
  const normalizedSchema = normalizeSchema(schema);
  const request = validateGoalRunRequest({ phone: '+14155550123', variables: variables === undefined ? {} : variables });
  const supplied = request.variables || {};
  for (const key of normalizedSchema.required) {
    if (!Object.hasOwn(supplied, key)) throw goalRunError('call_e_goal_variables_missing', 'Required CALL-E Goal variables are missing', 400);
  }
  for (const [key, value] of Object.entries(supplied)) {
    const property = normalizedSchema.properties[key];
    if (!property) throw goalRunError('call_e_goal_variables_unsupported', 'CALL-E Goal variables contain an unsupported field', 400);
    const validType = property.type === 'integer'
      ? Number.isSafeInteger(value)
      : property.type === 'number'
        ? typeof value === 'number'
        : typeof value === property.type;
    if (!validType || (property.enum && !property.enum.some((candidate) => candidate === value))) {
      throw goalRunError('call_e_goal_variables_invalid', 'A CALL-E Goal variable does not match its published schema', 400);
    }
  }
  return supplied;
}

function publishedRunSpec(goal) {
  const spec = goal?.published_run_spec;
  const id = String(spec?.id || '').trim();
  const version = Number(spec?.version);
  if (!goal || goal.object !== 'goal' || goal.status !== 'active' || !id || !Number.isSafeInteger(version) || version < 1) {
    throw goalRunError('call_e_goal_unavailable', 'CALL-E Goal is not currently executable', 409);
  }
  normalizeSchema(spec.input_schema);
  normalizeSchema(spec.result_schema);
  return { id, version, inputSchema: spec.input_schema, resultSchema: spec.result_schema };
}

function safeGoalRun(row) {
  if (!row) return null;
  const status = ['pending_approval', 'approved', 'rejected', 'submitting', 'recovery_required', 'running', 'completed', 'failed', 'canceled', 'needs_review'].includes(row.status)
    ? row.status : 'needs_review';
  return Object.freeze({
    goal_run_request_id: String(row.goal_run_request_id || ''),
    business_id: String(row.business_id || ''),
    goal_id: String(row.goal_id || ''),
    goal_title: String(row.goal_title || 'CALL-E Goal').slice(0, 200),
    published_run_spec_id: String(row.published_run_spec_id || ''),
    published_run_spec_version: Number(row.published_run_spec_version) || null,
    destination_masked: /^\+?[•]{4,14}\d{4}$/.test(String(row.destination_masked || '')) ? row.destination_masked : '••••0000',
    status,
    provider_goal_run_id: /^[A-Za-z0-9_.:-]{1,255}$/.test(String(row.provider_goal_run_id || '')) ? row.provider_goal_run_id : null,
    execution_status: GOAL_RUN_STATUSES.has(row.execution_status) ? row.execution_status : null,
    call_outcome: ['completed', 'no_answer', 'busy', 'declined'].includes(row.call_outcome) ? row.call_outcome : null,
    result_status: RESULT_STATUSES.has(row.result_status) ? row.result_status : null,
    error_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(row.error_code || '')) ? row.error_code : null,
    created_by: String(row.created_by || ''),
    reviewed_by: row.reviewed_by == null ? null : String(row.reviewed_by),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    reviewed_at: row.reviewed_at || null,
  });
}

class CallEGoalRunService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.campaignService = options.campaignService;
    this.contactPolicy = options.contactPolicy;
    this.workflowService = options.workflowService || null;
    this.idempotencySecret = options.idempotencySecret || '';
    this.encryptionKeys = options.encryptionKeys || {};
    this.encryptionKeyVersion = Number(options.encryptionKeyVersion) || 1;
    this.sensitiveDataRetentionDays = Math.max(1, Math.min(3650, Math.floor(Number(options.sensitiveDataRetentionDays) || 90)));
    this.allowedDestinations = new Set((Array.isArray(options.allowedDestinations) ? options.allowedDestinations : String(options.allowedDestinations || '').split(','))
      .map((value) => String(value || '').trim()).filter((value) => /^\+[1-9]\d{7,14}$/.test(value)));
    this.env = options.env || process.env;
  }

  async assertMembership(businessId, actorId) {
    if (!BUSINESS_ID_PATTERN.test(businessId) || !ACTOR_ID_PATTERN.test(actorId) || typeof this.campaignService?.assertMembership !== 'function') {
      throw goalRunError('call_e_business_operator_access_denied', 'CALL-E business operator access is required', 403);
    }
    return this.campaignService.assertMembership(businessId, actorId);
  }

  async listGoals(input = {}) {
    await this.assertMembership(String(input.business_id || '').trim(), String(input.actor_id || '').trim());
    if (!this.client?.isConfigured?.()) throw goalRunError('call_e_not_configured', 'CALL-E Goals are disabled or not configured', 503);
    const result = await this.client.listGoals({ limit: input.limit, after: input.after });
    if (result?.object !== 'list' || !Array.isArray(result.data)) throw goalRunError('call_e_goal_response_invalid', 'CALL-E returned an invalid Goal list', 502);
    const goals = result.data.slice(0, 100).filter((goal) => goal && typeof goal.id === 'string' && goal.id.length <= 255)
      .map((goal) => ({ id: goal.id, title: typeof goal.title === 'string' ? goal.title.slice(0, 200) : null,
        description: typeof goal.description === 'string' ? goal.description.slice(0, 1000) : '', status: goal.status === 'active' ? 'active' : 'unavailable' }));
    const nextCursor = typeof result.next_cursor === 'string' && result.next_cursor.length <= 512 ? result.next_cursor : null;
    return { goals, next_cursor: nextCursor };
  }

  async getGoal(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const goalId = String(input.goal_id || '').trim();
    await this.assertMembership(businessId, actorId);
    if (!goalId || goalId.length > 255 || /[\u0000-\u001f\u007f]/.test(goalId)) throw goalRunError('call_e_goal_invalid', 'CALL-E Goal ID is invalid', 400);
    if (!this.client?.isConfigured?.()) throw goalRunError('call_e_not_configured', 'CALL-E Goals are disabled or not configured', 503);
    const goal = await this.client.getGoal(goalId);
    const spec = publishedRunSpec(goal);
    return { goal: { id: goalId, title: String(goal.title || '').slice(0, 200), description: String(goal.description || '').slice(0, 1000), status: 'active',
      published_run_spec: { id: spec.id, version: spec.version, input_schema: spec.inputSchema, result_schema: spec.resultSchema } } };
  }

  assertStorage() {
    if (!this.db || typeof this.db.createCallEGoalRunRequest !== 'function' || typeof this.db.getCallEGoalRunRequest !== 'function') {
      throw goalRunError('call_e_goal_run_unavailable', 'CALL-E Goal Run persistence is unavailable', 503);
    }
  }

  async createDraft(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const goalId = String(input.goal_id || '').trim();
    const requestKey = String(input.idempotency_key || '').trim();
    const phone = String(input.phone || '').trim();
    if (input.authorized !== true) throw goalRunError('call_e_authorization_required', 'Explicit contact authorization is required', 403);
    if (!goalId || goalId.length > 255 || /[\u0000-\u001f\u007f]/.test(goalId) || !requestKey || requestKey.length > 255 || /[\u0000-\u001f\u007f]/.test(requestKey)) {
      throw goalRunError('call_e_goal_run_invalid', 'CALL-E Goal Run request is invalid', 400);
    }
    const normalizedRequest = validateGoalRunRequest({ phone, variables: input.variables === undefined ? {} : input.variables });
    if (!this.allowedDestinations.has(phone)) throw goalRunError('call_e_destination_not_allowlisted', 'CALL-E destination is not allowlisted', 403);
    this.assertStorage();
    await this.assertMembership(businessId, actorId);
    const consent = await this.contactPolicy?.checkEligibility?.({ businessId, destination: phone });
    if (consent?.eligible !== true) throw goalRunError(`call_e_consent_${consent?.reason || 'required'}`, 'Current recorded CALL-E contact consent is required', consent?.reason === 'policy_storage_unavailable' ? 503 : 403);
    if (!this.client?.isConfigured?.()) throw goalRunError('call_e_not_configured', 'CALL-E Goals are disabled or not configured', 503);
    const goal = await this.client.getGoal(goalId);
    const runSpec = publishedRunSpec(goal);
    normalizedRequest.variables = validateGoalVariables(runSpec.inputSchema, normalizedRequest.variables || {});
    const requestHash = digest(this.idempotencySecret, {
      business_id: businessId, actor_id: actorId, goal_id: goalId, run_spec_id: runSpec.id,
      run_spec_version: runSpec.version, phone, variables: normalizedRequest.variables,
    });
    const keyHash = digest(this.idempotencySecret, `${businessId}:${requestKey}`);
    const existing = await this.db.getCallEGoalRunRequestByIdempotency?.(businessId, keyHash);
    if (existing) {
      if (existing.request_hash !== requestHash) throw goalRunError('call_e_goal_run_idempotency_conflict', 'Idempotency key was already used for another CALL-E Goal Run request', 409);
      return { goal_run: safeGoalRun(existing), idempotent_replay: true };
    }
    const requestId = `goalrun_${crypto.randomUUID()}`;
    const ciphertext = encryptPayload(normalizedRequest, this.encryptionKeys, requestId, this.encryptionKeyVersion);
    const row = await this.db.createCallEGoalRunRequest({
      goal_run_request_id: requestId, business_id: businessId, goal_id: goalId,
      goal_title: String(goal.title || goal.description || 'CALL-E Goal').slice(0, 200),
      published_run_spec_id: runSpec.id, published_run_spec_version: runSpec.version,
      destination_masked: maskPhone(phone), encrypted_payload: ciphertext,
      encryption_key_version: this.encryptionKeyVersion, request_hash: requestHash, idempotency_hash: keyHash,
      result_schema_json: JSON.stringify(runSpec.resultSchema), status: 'pending_approval', created_by: actorId,
      sensitive_data_expires_at: new Date(Date.now() + this.sensitiveDataRetentionDays * 86400000).toISOString(),
    });
    return { goal_run: safeGoalRun(row), idempotent_replay: row?.idempotentReplay === true };
  }

  async review(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const requestId = String(input.goal_run_request_id || '').trim();
    const decision = String(input.decision || '').toLowerCase();
    const membership = await this.assertMembership(businessId, actorId);
    const row = await this.db.getCallEGoalRunRequest(requestId, businessId);
    if (!row) throw goalRunError('call_e_goal_run_not_found', 'CALL-E Goal Run request was not found', 404);
    if (membership?.role !== 'policy_manager' || String(row.created_by) === actorId || String(row.created_by) === String(membership?.original_approver || '')) {
      throw goalRunError('call_e_goal_run_review_forbidden', 'A separate policy manager must review this Goal Run request', 403);
    }
    if (!['approve', 'reject'].includes(decision)) throw goalRunError('call_e_goal_run_invalid_decision', 'Decision must be approve or reject', 400);
    const reviewed = await this.db.reviewCallEGoalRunRequest({ goal_run_request_id: requestId, business_id: businessId, reviewed_by: actorId, decision });
    if (!reviewed) throw goalRunError('call_e_goal_run_already_reviewed', 'CALL-E Goal Run request is no longer pending review', 409);
    return { goal_run: safeGoalRun(reviewed) };
  }

  async list(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const rows = await this.db.listCallEGoalRunRequests(businessId, { status: input.status, limit: input.limit });
    return { goal_runs: rows.map(safeGoalRun) };
  }

  async get(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const row = await this.db.getCallEGoalRunRequest(input.goal_run_request_id, businessId);
    if (!row) throw goalRunError('call_e_goal_run_not_found', 'CALL-E Goal Run request was not found', 404);
    if (row.result_status === 'available' && row.encrypted_result) {
      const saved = decryptPayload(row.encrypted_result, this.encryptionKeys, `${row.goal_run_request_id}:result`, Number(row.encryption_key_version), { raw: true });
      return { goal_run: safeGoalRun(row), result: saved.result };
    }
    return { goal_run: safeGoalRun(row) };
  }

  async advance(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const requestId = String(input.goal_run_request_id || '').trim();
    await this.assertMembership(businessId, actorId);
    let row = await this.db.getCallEGoalRunRequest(requestId, businessId);
    if (!row) throw goalRunError('call_e_goal_run_not_found', 'CALL-E Goal Run request was not found', 404);
    if (!['approved', 'submitting', 'recovery_required'].includes(row.status)) throw goalRunError('call_e_goal_run_not_approved', 'CALL-E Goal Run requires separate policy-manager approval', 409);
    if (String(this.env.CALLE_ENABLED || 'false').toLowerCase() !== 'true' ||
        String(this.env.CALLE_DISPATCH_ENABLED || 'false').toLowerCase() !== 'true' ||
        String(this.env.CALLE_GOAL_RUN_DISPATCH_ENABLED || 'false').toLowerCase() !== 'true' ||
        String(this.env.CALLE_PILOT_READINESS_REVIEWED || 'false').toLowerCase() !== 'true' ||
        !this.client?.isConfigured?.() || !this.allowedDestinations.size) {
      throw goalRunError('call_e_goal_run_dispatch_disabled', 'CALL-E Goal Run dispatch is disabled or not ready', 503);
    }
    const payload = decryptPayload(row.encrypted_payload, this.encryptionKeys, requestId, Number(row.encryption_key_version));
    if (!this.allowedDestinations.has(payload.phone)) throw goalRunError('call_e_destination_not_allowlisted', 'CALL-E destination is no longer allowlisted', 403);
    const consent = await this.contactPolicy?.checkEligibility?.({ businessId, destination: payload.phone });
    if (consent?.eligible !== true) throw goalRunError('call_e_consent_changed', 'Current consent is no longer valid; Goal Run was not started', 403);
    const latestGoal = await this.client.getGoal(row.goal_id);
    const currentSpec = publishedRunSpec(latestGoal);
    if (currentSpec.id !== row.published_run_spec_id || currentSpec.version !== Number(row.published_run_spec_version)) {
      throw goalRunError('call_e_goal_version_changed', 'Published CALL-E Goal changed after review; create a new request for review', 409);
    }
    const health = this.client.getProviderHealth?.();
    if (health && health.dispatchAllowed === false) {
      throw goalRunError('call_e_provider_circuit_open', 'CALL-E provider circuit is open; dispatch is paused', 503);
    }
    if (!row.provider_goal_run_id) {
      await this.db.markCallEGoalRunSubmitting(requestId, businessId);
      try {
        const run = await this.client.createGoalRun(row.goal_id, payload, `voicednut:${requestId}`);
        if (run?.object !== 'goal_run' || String(run.goal_id) !== row.goal_id || !String(run.id || '')) {
          throw goalRunError('call_e_goal_run_response_invalid', 'CALL-E returned an invalid Goal Run resource', 502);
        }
        row = await this.db.saveCallEGoalRunProviderState({
          goal_run_request_id: requestId, business_id: businessId, provider_goal_run_id: String(run.id),
          execution_status: validStatus(run.status, GOAL_RUN_STATUSES), call_outcome: validStatus(run.call_outcome, new Set(['completed', 'no_answer', 'busy', 'declined'])),
          result_status: validStatus(run.result_status, RESULT_STATUSES), status: 'running', error_code: null,
        });
      } catch (error) {
        await this.db.saveCallEGoalRunProviderState({ goal_run_request_id: requestId, business_id: businessId, status: 'recovery_required', error_code: safeErrorCode(error?.code) || 'call_e_goal_run_outcome_unknown' });
        throw goalRunError('call_e_goal_run_recovery_required', 'CALL-E Goal Run acceptance is uncertain; reconcile with the same request before retrying', 409);
      }
    }
    return { goal_run: safeGoalRun(row) };
  }

  async reconcile(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    let row = await this.db.getCallEGoalRunRequest(input.goal_run_request_id, businessId);
    if (!row) throw goalRunError('call_e_goal_run_not_found', 'CALL-E Goal Run request was not found', 404);
    let result = null;
    let workflowTrigger = null;
    if (row.provider_goal_run_id) {
      const run = await this.client.getGoalRun(row.goal_id, row.provider_goal_run_id);
      if (run.result_status === 'available') {
        let schema;
        try { schema = JSON.parse(row.result_schema_json); }
        catch { throw goalRunError('call_e_goal_run_schema_invalid', 'Pinned CALL-E Goal result schema is invalid', 409); }
        const validation = validateCallEResult(schema, run.result);
        if (!validation.valid) throw goalRunError('call_e_goal_run_result_invalid', 'CALL-E Goal Run result does not match its pinned schema', 409);
        result = run.result;
      }
      row = await this.db.saveCallEGoalRunProviderState({
        goal_run_request_id: row.goal_run_request_id, business_id: businessId,
        provider_goal_run_id: String(run.id || row.provider_goal_run_id),
        execution_status: validStatus(run.status, GOAL_RUN_STATUSES),
        call_outcome: validStatus(run.call_outcome, new Set(['completed', 'no_answer', 'busy', 'declined'])),
        result_status: validStatus(run.result_status, RESULT_STATUSES),
        status: ['completed', 'failed', 'canceled'].includes(run.status) && run.result_status !== 'pending' ? run.status : 'running',
        error_code: safeErrorCode(run.error?.code),
        encrypted_result: result === null ? null : encryptPayload({ result }, this.encryptionKeys, `${row.goal_run_request_id}:result`, Number(row.encryption_key_version)),
      });
      if (result !== null && typeof this.workflowService?.triggerCallEResultReady === 'function') {
        workflowTrigger = await this.workflowService.triggerCallEResultReady({
          business_id: businessId,
          goal_run_request_id: row.goal_run_request_id,
          goal_id: row.goal_id,
          published_run_spec_id: row.published_run_spec_id,
          published_run_spec_version: Number(row.published_run_spec_version),
          execution_status: validStatus(run.status, GOAL_RUN_STATUSES),
          call_outcome: validStatus(run.call_outcome, new Set(['completed', 'no_answer', 'busy', 'declined'])),
          result_status: 'available',
          idempotency_key: `call_e_goal_run:${row.goal_run_request_id}:${row.published_run_spec_id}:${row.published_run_spec_version}`,
        }, JSON.parse(row.result_schema_json), result);
      }
    }
    return { goal_run: safeGoalRun(row), ...(result === null ? {} : { result }), ...(workflowTrigger ? { workflow_trigger: workflowTrigger } : {}) };
  }
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return `${String(value || '').startsWith('+') ? '+' : ''}${'•'.repeat(Math.max(4, Math.min(14, digits.length - 4)))}${digits.slice(-4).padStart(4, '0')}`;
}

function validStatus(value, allowed) { return allowed.has(value) ? value : null; }
function safeErrorCode(value) { return /^[a-z][a-z0-9_]{0,79}$/.test(String(value || '')) ? String(value) : null; }

module.exports = { CallEGoalRunService, publishedRunSpec, validateGoalVariables, safeGoalRun, encryptPayload, decryptPayload };
