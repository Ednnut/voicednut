'use strict';

const crypto = require('node:crypto');
const { previewCallETemplate } = require('../adapters/callETemplateAdapter');

const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const MAX_RECIPIENTS = 25;
const DEFAULT_ENCRYPTION_KEY_VERSION = 1;

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

function missionError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function missionDigest(secret, value) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw missionError('call_e_mission_unavailable', 'Mission idempotency protection is unavailable', 503);
  }
  const stable = typeof value === 'string' ? value : JSON.stringify(stableValue(value));
  return crypto.createHmac('sha256', secret).update(stable).digest('hex');
}

function encryptionKey(encryptionKeys, keyVersion) {
  const version = Number(keyVersion);
  const secret = typeof encryptionKeys === 'string'
    ? (version === 1 ? encryptionKeys : '')
    : String(encryptionKeys?.[version] || '');
  if (typeof secret !== 'string' || secret.length < 32) {
    throw missionError('call_e_mission_encryption_unavailable', 'CALL-E mission encryption is not configured', 503);
  }
  return crypto.createHash('sha256').update(`voicednut:call-e:mission:recipients:v${version}:`).update(secret).digest();
}

function encryptDestination(destination, encryptionKeys, missionId, position, keyVersion = DEFAULT_ENCRYPTION_KEY_VERSION) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(encryptionKeys, keyVersion), iv);
  cipher.setAAD(Buffer.from(`${missionId}:${position}:v${keyVersion}`));
  const encrypted = Buffer.concat([cipher.update(destination, 'utf8'), cipher.final()]);
  return `v${keyVersion}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptDestination(payload, encryptionKeys, missionId, position, keyVersion = DEFAULT_ENCRYPTION_KEY_VERSION) {
  const version = Number(keyVersion);
  if (!Number.isSafeInteger(version) || version < 1 || typeof payload !== 'string') {
    throw missionError('call_e_mission_encryption_key_version_unsupported', 'Mission recipient encryption key version is unsupported', 503);
  }
  const [payloadVersion, ivText, tagText, encryptedText, extra] = payload.split('.');
  if (payloadVersion !== `v${version}` || !ivText || !tagText || !encryptedText || extra !== undefined) {
    throw missionError('call_e_mission_recipient_ciphertext_invalid', 'Mission recipient recovery data is invalid', 409);
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(encryptionKeys, version), Buffer.from(ivText, 'base64url'));
    decipher.setAAD(Buffer.from(`${missionId}:${position}:v${version}`));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const destination = Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
    if (!E164_PATTERN.test(destination)) throw new Error('invalid destination');
    return destination;
  } catch (error) {
    if (error?.code === 'call_e_mission_encryption_unavailable') throw error;
    throw missionError('call_e_mission_recipient_decryption_failed', 'Mission recipient recovery data could not be decrypted', 409);
  }
}

function maskDestination(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return `${String(value || '').startsWith('+') ? '+' : ''}${'•'.repeat(Math.max(4, Math.min(14, digits.length - 4)))}${digits.slice(-4).padStart(4, '0')}`;
}

function safeMission(row) {
  if (!row) return null;
  const statuses = new Set(['pending_approval', 'approved', 'rejected', 'running', 'paused', 'completed', 'canceled', 'needs_review']);
  return Object.freeze({
    mission_id: String(row.mission_id || ''),
    approval_fingerprint: /^[a-f0-9]{64}$/.test(String(row.request_hash || '').toLowerCase())
      ? String(row.request_hash).toLowerCase()
      : null,
    business_id: String(row.business_id || ''),
    campaign_id: String(row.campaign_id || ''),
    template_id: Number(row.template_id) || null,
    template_version: Number(row.template_version) || null,
    status: statuses.has(row.status) ? row.status : 'needs_review',
    scheduled_at: row.scheduled_at || null,
    budget_limit_minor: row.budget_limit_minor == null ? null : Number.isSafeInteger(Number(row.budget_limit_minor)) ? Number(row.budget_limit_minor) : null,
    budget_currency: /^[A-Z]{3}$/.test(String(row.budget_currency || '')) ? String(row.budget_currency) : null,
    per_call_cost_ceiling_minor: row.per_call_cost_ceiling_minor == null ? null : Number.isSafeInteger(Number(row.per_call_cost_ceiling_minor)) ? Number(row.per_call_cost_ceiling_minor) : null,
    budget_reserved_minor: Math.max(0, Number(row.budget_reserved_minor) || 0),
    recipient_count: Number(row.recipient_count) || 0,
    queued_count: Number(row.queued_count) || 0,
    active_count: Number(row.active_count) || 0,
    completed_count: Number(row.completed_count) || 0,
    attention_count: Number(row.attention_count) || 0,
    created_by: String(row.created_by || ''),
    reviewed_by: row.reviewed_by == null ? null : String(row.reviewed_by),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    reviewed_at: row.reviewed_at || null,
  });
}

class CallECampaignMissionService {
  constructor(options = {}) {
    this.db = options.db;
    this.campaignService = options.campaignService;
    this.idempotencySecret = options.idempotencySecret || '';
    this.encryptionKeys = options.encryptionKeys || (options.encryptionSecret ? { 1: options.encryptionSecret } : {});
    this.encryptionKeyVersion = options.encryptionKeyVersion === undefined
      ? DEFAULT_ENCRYPTION_KEY_VERSION
      : Number(options.encryptionKeyVersion);
    this.getTemplate = options.getTemplate || null;
    this.dispatchRecipient = options.dispatchRecipient || null;
    this.reconcileCall = options.reconcileCall || null;
    this.safetyService = options.safetyService || null;
    this.providerRoutingPreview = options.providerRoutingPreview || null;
    this.env = options.env || process.env;
    this.sensitiveDataRetentionDays = Math.max(1, Math.min(3650, Math.floor(Number(options.sensitiveDataRetentionDays) || 90)));
  }

  async assertMembership(businessId, actorId, roles) {
    if (typeof this.campaignService?.assertMembership !== 'function') {
      throw missionError('call_e_mission_unavailable', 'CALL-E mission authorization is unavailable', 503);
    }
    return this.campaignService.assertMembership(businessId, actorId, roles);
  }

  async create(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const campaignId = String(input.campaign_id || '').trim();
    const idempotencyKey = String(input.idempotency_key || '').trim();
    const destinations = Array.isArray(input.destinations) ? input.destinations.map((value) => String(value || '').trim()) : [];
    const scheduledAt = input.scheduled_at == null || String(input.scheduled_at).trim() === '' ? null : String(input.scheduled_at).trim();
    const budgetLimitMinor = input.budget_limit_minor == null || input.budget_limit_minor === '' ? null : Number(input.budget_limit_minor);
    const perCallCostCeilingMinor = input.per_call_cost_ceiling_minor == null || input.per_call_cost_ceiling_minor === '' ? null : Number(input.per_call_cost_ceiling_minor);
    const budgetCurrency = input.budget_currency == null || input.budget_currency === '' ? null : String(input.budget_currency).trim().toUpperCase();
    const scheduledAtMs = scheduledAt === null ? null : Date.parse(scheduledAt);
    if (!ACTOR_ID_PATTERN.test(actorId) || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) ||
        !/^campaign_[a-f0-9]{64}$/.test(campaignId) || !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) ||
        destinations.length < 1 || destinations.length > MAX_RECIPIENTS || destinations.some((value) => !E164_PATTERN.test(value)) ||
        !input.result_schema || typeof input.result_schema !== 'object' || Array.isArray(input.result_schema) ||
        Buffer.byteLength(JSON.stringify(input.result_schema), 'utf8') > 16000 ||
        (scheduledAt !== null && (!Number.isFinite(scheduledAtMs) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(scheduledAt) ||
          scheduledAtMs < Date.now() + 60000 || scheduledAtMs > Date.now() + 365 * 86400000)) ||
        ((budgetLimitMinor === null) !== (perCallCostCeilingMinor === null)) ||
        ((budgetLimitMinor === null) !== (budgetCurrency === null)) || (budgetCurrency !== null && !/^[A-Z]{3}$/.test(budgetCurrency)) ||
        (budgetLimitMinor !== null && (!Number.isSafeInteger(budgetLimitMinor) || budgetLimitMinor < 1 || budgetLimitMinor > 1000000000 ||
          !Number.isSafeInteger(perCallCostCeilingMinor) || perCallCostCeilingMinor < 1 || perCallCostCeilingMinor > budgetLimitMinor))) {
      throw missionError('call_e_mission_invalid', 'CALL-E mission request is invalid');
    }
    if (!this.campaignService || typeof this.db?.createCallECampaignMission !== 'function' ||
        typeof this.db?.getCallECampaignMission !== 'function') {
      throw missionError('call_e_mission_unavailable', 'CALL-E mission storage is unavailable', 503);
    }
    await this.assertMembership(businessId, actorId);
    if (!Number.isSafeInteger(this.encryptionKeyVersion) || this.encryptionKeyVersion < 1) {
      throw missionError('call_e_mission_encryption_unavailable', 'CALL-E mission encryption key version is invalid', 503);
    }
    encryptionKey(this.encryptionKeys, this.encryptionKeyVersion);
    const missionId = `mission_${missionDigest(this.idempotencySecret, `${businessId}:${idempotencyKey}`)}`;
    const resultSchemaJson = JSON.stringify(stableValue(input.result_schema));
    const requestHash = missionDigest(this.idempotencySecret, {
      businessId,
      campaignId,
      destinations,
      resultSchema: input.result_schema,
      ...(scheduledAt ? { scheduledAt: new Date(scheduledAtMs).toISOString() } : {}),
      ...(budgetLimitMinor !== null ? { budgetLimitMinor, perCallCostCeilingMinor, budgetCurrency } : {}),
    });
    const existing = await this.db.getCallECampaignMission(missionId, businessId);
    if (existing) {
      if (existing.request_hash !== requestHash || String(existing.created_by || '') !== actorId ||
          String(existing.campaign_id || '') !== campaignId || existing.result_schema_json !== resultSchemaJson ||
          Number(existing.recipient_count) !== destinations.length) {
        throw missionError('call_e_mission_idempotency_conflict', 'Mission idempotency key conflicts with an existing request', 409);
      }
      return Object.freeze({ mission: safeMission(existing), idempotent_replay: true });
    }
    const checked = await this.campaignService.preflight({
      ...input,
      authorized: true,
      business_id: businessId,
      campaign_id: campaignId,
      actor_id: actorId,
      destinations,
    });
    if (checked?.all_ready !== true || checked?.recipients?.length !== destinations.length ||
        checked.recipients.some((recipient) => recipient.status !== 'ready')) {
      throw missionError('call_e_mission_preflight_blocked', 'All mission recipients must pass the approved campaign preflight', 409);
    }

    const recipients = destinations.map((destination, position) => ({
      position,
      encrypted_destination: encryptDestination(destination, this.encryptionKeys, missionId, position, this.encryptionKeyVersion),
      destination_masked: maskDestination(destination),
      idempotency_key: `voicednut:call-e:${missionDigest(this.idempotencySecret, `${missionId}:${position}`).slice(0, 48)}`,
      status: 'queued',
    }));
    const saved = await this.db.createCallECampaignMission({
      mission_id: missionId,
      business_id: businessId,
      campaign_id: campaignId,
      template_id: checked.campaign.template_id,
      template_version: checked.campaign.template_version,
      created_by: actorId,
      request_hash: requestHash,
      result_schema_json: resultSchemaJson,
      encryption_key_version: this.encryptionKeyVersion,
      sensitive_data_expires_at: new Date(Date.now() + this.sensitiveDataRetentionDays * 86400000).toISOString(),
      scheduled_at: scheduledAt ? new Date(scheduledAtMs).toISOString() : null,
      budget_limit_minor: budgetLimitMinor,
      budget_currency: budgetCurrency,
      per_call_cost_ceiling_minor: perCallCostCeilingMinor,
      recipients,
    });
    return Object.freeze({
      mission: safeMission(saved?.mission),
      idempotent_replay: saved?.idempotentReplay === true,
    });
  }

  async list(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    if (typeof this.db?.listCallECampaignMissionsForBusiness !== 'function') {
      throw missionError('call_e_mission_unavailable', 'CALL-E mission storage is unavailable', 503);
    }
    const rows = await this.db.listCallECampaignMissionsForBusiness(businessId, input.limit);
    return Object.freeze({ missions: Object.freeze((Array.isArray(rows) ? rows : []).map(safeMission)) });
  }

  async get(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    await this.assertMembership(businessId, actorId);
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || typeof this.db?.getCallECampaignMission !== 'function') {
      throw missionError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    }
    const mission = await this.db.getCallECampaignMission(missionId, businessId);
    if (!mission) throw missionError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    const timelineRows = Array.isArray(mission.activity) && mission.activity.length
      ? mission.activity
      : [
        { event_type: 'mission_created', state: 'pending_approval', created_at: mission.created_at },
        ...(mission.reviewHistory || []).map((row) => ({ event_type: 'approval_recorded', actor_id: row.reviewed_by, state: row.decision, created_at: row.created_at })),
        ...(mission.resolutions || []).map((row) => ({ event_type: 'mission_resolved', actor_id: row.resolved_by, state: row.decision, created_at: row.created_at })),
        ...(mission.recipients || []).map((row) => ({ event_type: 'recipient_transition', recipient_position: row.position, state: row.status, error_code: row.error_code, created_at: row.updated_at })),
      ].filter((row) => row.state && row.created_at);
    return Object.freeze({ mission: safeMission(mission), recipients: Object.freeze((mission.recipients || []).map((row) => Object.freeze({
      position: Number(row.position),
      destination_masked: String(row.destination_masked || '••••0000'),
      status: String(row.status || 'needs_review'),
      local_call_id: row.local_call_id || null,
      error_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(row.error_code || '')) ? row.error_code : null,
    }))), review_history: Object.freeze((mission.reviewHistory || []).slice(0, 10).map((row) => Object.freeze({
      reviewed_by: /^\d{1,20}$/.test(String(row.reviewed_by || '')) ? String(row.reviewed_by) : null,
      decision: ['approve', 'reject'].includes(row.decision) ? row.decision : null,
      request_hash: /^[a-f0-9]{64}$/i.test(String(row.request_hash || '')) ? String(row.request_hash).toLowerCase() : null,
      created_at: row.created_at || null,
    }))), resolutions: Object.freeze((mission.resolutions || []).map((row) => Object.freeze({
      resolved_by: /^\d{1,20}$/.test(String(row.resolved_by || '')) ? String(row.resolved_by) : null,
      decision: ['continue', 'cancel'].includes(row.decision) ? row.decision : null,
      created_at: row.created_at || null,
    }))), timeline: Object.freeze(timelineRows.slice(0, 100).map((row) => Object.freeze({
      event_id: Number(row.event_id) || null,
      actor_id: /^\d{1,20}$/.test(String(row.actor_id || '')) ? String(row.actor_id) : null,
      event_type: ['mission_created', 'approval_recorded', 'mission_resolved', 'recipient_transition', 'recipient_retry_requested', 'mission_advanced'].includes(row.event_type)
        ? row.event_type : 'mission_advanced',
      recipient_position: Number.isSafeInteger(Number(row.recipient_position)) ? Number(row.recipient_position) : null,
      state: /^[a-z_]{1,40}$/.test(String(row.state || '')) ? row.state : 'unknown',
      error_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(row.error_code || '')) ? row.error_code : null,
      created_at: row.created_at || null,
    }))) });
  }

  async review(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    const decision = String(input.decision || '').trim().toLowerCase();
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !['approve', 'reject'].includes(decision)) {
      throw missionError('call_e_mission_invalid', 'CALL-E mission decision is invalid');
    }
    await this.assertMembership(businessId, actorId, new Set(['policy_manager']));
    if (typeof this.db?.reviewCallECampaignMission !== 'function') {
      throw missionError('call_e_mission_unavailable', 'CALL-E mission approval storage is unavailable', 503);
    }
    const result = await this.db.reviewCallECampaignMission({
      mission_id: missionId,
      business_id: businessId,
      reviewed_by: actorId,
      decision,
    });
    if (!result?.mission) throw missionError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    return Object.freeze({
      mission: safeMission(result.mission),
      review_history: Object.freeze((result.reviewHistory || []).slice(0, 10).map((row) => Object.freeze({
        reviewed_by: /^\d{1,20}$/.test(String(row.reviewed_by || '')) ? String(row.reviewed_by) : null,
        decision: ['approve', 'reject'].includes(row.decision) ? row.decision : null,
        request_hash: /^[a-f0-9]{64}$/i.test(String(row.request_hash || '')) ? String(row.request_hash).toLowerCase() : null,
        created_at: row.created_at || null,
      }))),
      idempotent_replay: result.idempotentReplay === true,
      awaiting_secondary_approval: result.awaitingSecondaryApproval === true,
    });
  }

  async retryRecipient(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    const position = Number(input.position);
    const idempotencyKey = String(input.idempotency_key || '').trim();
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !Number.isSafeInteger(position) || position < 0 || position > 24 ||
        !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
      throw missionError('call_e_mission_retry_invalid', 'Mission retry request is invalid');
    }
    await this.assertMembership(businessId, actorId, new Set(['policy_manager']));
    if (typeof this.db?.retryCallECampaignMissionRecipient !== 'function') {
      throw missionError('call_e_mission_unavailable', 'Mission retry storage is unavailable', 503);
    }
    const result = await this.db.retryCallECampaignMissionRecipient({
      mission_id: missionId, business_id: businessId, actor_id: actorId, position, idempotency_key: idempotencyKey,
    });
    if (!result?.mission) throw missionError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    return { mission: safeMission(result.mission), idempotent_replay: result.idempotentReplay === true };
  }

  async reconcileRecipient(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    const position = Number(input.position);
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !Number.isSafeInteger(position) || position < 0 || position > 24) {
      throw missionError('call_e_mission_recovery_invalid', 'Mission recovery request is invalid');
    }
    await this.assertMembership(businessId, actorId, new Set(['policy_manager']));
    const mission = await this.db.getCallECampaignMission(missionId, businessId);
    if (!mission) throw missionError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    const recipient = (mission.recipients || []).find((row) => Number(row.position) === position);
    if (!recipient) throw missionError('call_e_mission_recipient_not_found', 'Mission recipient was not found', 404);
    if (!['accepted', 'in_progress', 'needs_review'].includes(recipient.status) || !recipient.local_call_id) {
      return { mission: safeMission(mission), position, state: recipient.status, action: 'manual_review', provider_requests: 0 };
    }
    if (typeof this.reconcileCall !== 'function') throw missionError('call_e_mission_recovery_unavailable', 'Call reconciliation is unavailable', 503);
    let snapshot;
    try { snapshot = await this.reconcileCall(recipient.local_call_id); }
    catch (_) { return { mission: safeMission(mission), position, state: 'recovery_required', action: 'retry_reconcile', provider_requests: 0 }; }
    if (!['completed', 'failed', 'canceled'].includes(snapshot?.executionStatus) || snapshot?.resultStatus === 'pending') {
      return { mission: safeMission(mission), position, state: snapshot?.executionStatus || 'unknown', action: 'retry_reconcile', provider_requests: 0 };
    }
    const recipientStatus = snapshot.executionStatus === 'failed' ? 'failed'
      : snapshot.executionStatus === 'canceled' ? 'canceled'
        : snapshot.resultStatus === 'available' ? 'completed' : 'needs_review';
    const updated = await this.db.updateCallECampaignMissionRecipient({
      mission_id: missionId, business_id: businessId, position,
      status: recipientStatus, local_call_id: recipient.local_call_id,
      error_code: recipientStatus === 'needs_review' ? 'call_e_result_unavailable' : snapshot.errorCode || null,
    });
    return { mission: safeMission(updated?.mission || mission), position, state: recipientStatus,
      action: recipientStatus === 'failed' && snapshot.errorCode === 'call_e_request_rejected' ? 'retry_rejected' : 'none',
      provider_requests: 0 };
  }

  async resolve(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    const decision = String(input.decision || '').trim().toLowerCase();
    const idempotencyKey = String(input.idempotency_key || '').trim();
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !['continue', 'cancel'].includes(decision) ||
        !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
      throw missionError('call_e_mission_invalid', 'CALL-E mission resolution is invalid');
    }
    await this.assertMembership(businessId, actorId, new Set(['policy_manager']));
    if (typeof this.db?.resolveCallECampaignMission !== 'function') {
      throw missionError('call_e_mission_unavailable', 'CALL-E mission resolution storage is unavailable', 503);
    }
    const result = await this.db.resolveCallECampaignMission({
      mission_id: missionId,
      business_id: businessId,
      resolved_by: actorId,
      decision,
      idempotency_key: idempotencyKey,
    });
    if (!result?.mission) throw missionError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    return Object.freeze({ mission: safeMission(result.mission), idempotent_replay: result.idempotentReplay === true });
  }

  missionDispatchApproval(mission) {
    const env = this.env || {};
    const approvedMissionId = String(env.CALLE_MISSION_APPROVED_ID || '').trim();
    const fingerprint = String(env.CALLE_MISSION_APPROVED_FINGERPRINT || '').trim().toLowerCase();
    const reference = String(env.CALLE_MISSION_APPROVAL_REFERENCE || '').trim();
    const expiresAt = String(env.CALLE_MISSION_APPROVAL_EXPIRES_AT || '').trim();
    const maxRecipients = Number(env.CALLE_MISSION_MAX_RECIPIENTS || 0);
    if (String(env.CALLE_MISSION_DISPATCH_ENABLED || 'false').trim().toLowerCase() !== 'true' ||
        String(env.CALLE_DISPATCH_ENABLED || 'false').trim().toLowerCase() !== 'true' ||
        String(env.CALLE_PILOT_READINESS_REVIEWED || 'false').trim().toLowerCase() !== 'true') {
      throw missionError('call_e_mission_dispatch_disabled', 'CALL-E mission dispatch is disabled', 503);
    }
    if (approvedMissionId !== String(mission.mission_id || '') ||
        !/^[a-f0-9]{64}$/.test(fingerprint) || fingerprint !== String(mission.request_hash || '').toLowerCase() ||
        !/^[A-Za-z0-9._:-]{8,180}$/.test(reference) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(expiresAt) ||
        !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now() ||
        !Number.isSafeInteger(maxRecipients) || maxRecipients < 1 || maxRecipients > 25 ||
        Number(mission.recipient_count) > maxRecipients) {
      throw missionError('call_e_mission_approval_required', 'Current approval for this exact mission ID and recipient budget are required', 403);
    }
    return { reference };
  }

  async readinessReport(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    if (!/^mission_[a-f0-9]{64}$/.test(missionId)) throw missionError('call_e_mission_invalid', 'CALL-E mission ID is invalid');
    await this.assertMembership(businessId, actorId);
    const mission = await this.db.getCallECampaignMission(missionId, businessId);
    if (!mission) throw missionError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    const checks = [];
    const check = (key, ready, reason) => checks.push({ key, ready: ready === true, reason: ready === true ? null : reason });
    const hasCurrentReview = ['approved', 'running'].includes(mission.status);
    check('mission_approval', hasCurrentReview, hasCurrentReview ? null : 'mission_not_approved');
    let approval = { valid: false, reason: 'approval_incomplete' };
    if (typeof this.db.validateCallECampaignMissionApproval === 'function') approval = await this.db.validateCallECampaignMissionApproval(missionId, businessId);
    check('review_approval', approval.valid === true, approval.reason || 'approval_incomplete');
    let pilotApproved = false;
    try { this.missionDispatchApproval(mission); pilotApproved = true; } catch (error) { check('dispatch_gate', false, error.code || 'dispatch_gate_blocked'); }
    if (pilotApproved) check('dispatch_gate', true);
    let safetyPolicy = null;
    if (this.safetyService?.assertDispatchAllowed) {
      try {
        const safety = await this.safetyService.assertDispatchAllowed({ businessId, missionId, workerManaged: false });
        safetyPolicy = safety?.policy || null;
        check('quiet_hours_and_safety', true);
      } catch (error) { check('quiet_hours_and_safety', false, error.code || 'safety_policy_blocked'); }
    } else check('quiet_hours_and_safety', false, 'safety_policy_unavailable');
    let destinations = [];
    try {
      const resultSchema = JSON.parse(String(mission.result_schema_json || '{}'));
      destinations = (mission.recipients || []).map((row) => decryptDestination(row.encrypted_destination,
        this.encryptionKeys, missionId, Number(row.position), Number(mission.encryption_key_version)));
      const preflight = await this.campaignService.preflight({ business_id: businessId, campaign_id: mission.campaign_id,
        actor_id: actorId, destinations, result_schema: resultSchema, authorized: true });
      const consentReady = preflight.all_ready === true;
      check('consent_and_template', consentReady, consentReady ? null : 'consent_or_template_blocked');
    } catch (error) {
      check('consent_and_template', false, error.code || 'preflight_unavailable');
    }
    const budgetCurrency = String(mission.budget_currency || '').toUpperCase();
    const budgetCap = mission.budget_limit_minor == null ? null : Number(mission.budget_limit_minor);
    const reserved = Number(mission.budget_reserved_minor) || 0;
    const usage = await this.db.getCallEMissionUsageReport?.(businessId, missionId);
    const actual = Number(usage?.actual_by_currency?.[budgetCurrency] || 0);
    const budgetReady = budgetCap == null || actual + reserved + Number(mission.per_call_cost_ceiling_minor || 0) <= budgetCap;
    check('budget', budgetReady, budgetReady ? null : 'budget_reservation_would_exceed_cap');
    let routing = null;
    try {
      if (this.providerRoutingPreview) routing = await this.providerRoutingPreview({ businessId, preferredProvider: '', configuredOrder: [] });
      check('provider_readiness', Boolean(routing?.selected_provider), routing?.selected_provider ? null : 'no_provider_ready');
    } catch (error) { check('provider_readiness', false, error.code || 'provider_readiness_unavailable'); }
    const canAdvance = checks.every((item) => item.ready);
    return { mission_id: missionId, business_id: businessId, status: mission.status, checks,
      budget: { currency: /^[A-Z]{3}$/.test(budgetCurrency) ? budgetCurrency : null, cap_minor: budgetCap,
        actual_minor: actual, reserved_minor: reserved,
        per_call_ceiling_minor: mission.per_call_cost_ceiling_minor == null ? null : Number(mission.per_call_cost_ceiling_minor) },
      safety: safetyPolicy ? { timezone: safetyPolicy.timezone, quiet_hours_start: safetyPolicy.quiet_hours_start,
        quiet_hours_end: safetyPolicy.quiet_hours_end, emergency_stop: safetyPolicy.emergency_stop } : null,
      provider: routing ? { selected_provider: routing.selected_provider, eligible_order: routing.eligible_order || [],
        blocked_providers: routing.blocked_providers || [] } : null,
      ready: canAdvance, dispatch_performed: false };
  }

  async advance(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const missionId = String(input.mission_id || '').trim();
    await this.assertMembership(businessId, actorId);
    if (typeof this.db?.getCallECampaignMission !== 'function') {
      throw missionError('call_e_mission_unavailable', 'CALL-E mission dispatch dependencies are unavailable', 503);
    }
    const mission = await this.db.getCallECampaignMission(missionId, businessId);
    if (!mission) throw missionError('call_e_mission_not_found', 'CALL-E mission was not found', 404);
    const terminalStates = new Set(['completed', 'needs_review', 'canceled', 'rejected']);
    if (terminalStates.has(mission.status)) {
      return { mission: safeMission(mission), state: mission.status, provider_requests: 0 };
    }
    if (!['approved', 'running'].includes(mission.status)) {
      throw missionError('call_e_mission_not_approved', 'Mission is not approved for execution', 409);
    }
    if (mission.scheduled_at) {
      const scheduledAtMs = Date.parse(mission.scheduled_at);
      if (!Number.isFinite(scheduledAtMs)) throw missionError('call_e_mission_schedule_invalid', 'Mission launch schedule is invalid; no call was placed', 409);
      if (scheduledAtMs > Date.now()) return { mission: safeMission(mission), state: 'scheduled', scheduled_at: mission.scheduled_at, provider_requests: 0 };
    }
    this.missionDispatchApproval(mission);
    if (typeof this.db?.validateCallECampaignMissionApproval === 'function') {
      const approval = await this.db.validateCallECampaignMissionApproval(missionId, businessId);
      if (!approval?.valid) {
        const expired = approval?.reason === 'approval_expired';
        throw missionError(expired ? 'call_e_mission_approval_expired' : 'call_e_mission_second_approval_required',
          expired ? 'Mission approval expired; a policy manager must review it again' : 'Mission approval policy is not satisfied', 403);
      }
    }
    const workerManaged = input.source === 'worker';
    let safetyPolicy = null;
    if (this.safetyService) {
      if (!this.safetyService.assertDispatchAllowed || !this.safetyService.reserveDispatch) {
        throw missionError('call_e_safety_policy_required', 'CALL-E mission safety controls are unavailable', 503);
      }
      const safety = await this.safetyService.assertDispatchAllowed({ businessId, missionId, workerManaged });
      safetyPolicy = safety?.policy || null;
    }
    if (typeof this.db?.claimNextCallECampaignMissionRecipient !== 'function' ||
        typeof this.db?.updateCallECampaignMissionRecipient !== 'function' ||
        typeof this.getTemplate !== 'function' || typeof this.dispatchRecipient !== 'function') {
      throw missionError('call_e_mission_unavailable', 'CALL-E mission dispatch dependencies are unavailable', 503);
    }
    if (mission.status === 'approved' || mission.status === 'running') {
      if (String(mission.status) === 'running' && typeof this.reconcileCall === 'function') {
        const accepted = (mission.recipients || []).find((row) => row.status === 'accepted' && row.local_call_id);
        if (accepted) {
          try {
            const snapshot = await this.reconcileCall(accepted.local_call_id);
            if (['completed', 'failed', 'canceled'].includes(snapshot?.executionStatus) && snapshot?.resultStatus !== 'pending') {
              const recipientStatus = snapshot.executionStatus === 'failed'
                ? 'failed'
                : snapshot.executionStatus === 'canceled'
                  ? 'canceled'
                  : snapshot.resultStatus === 'available'
                    ? 'completed'
                    : 'needs_review';
              await this.db.updateCallECampaignMissionRecipient({
                mission_id: missionId,
                business_id: businessId,
                position: accepted.position,
                status: recipientStatus,
                local_call_id: accepted.local_call_id,
                error_code: recipientStatus === 'needs_review'
                  ? 'call_e_result_unavailable'
                  : snapshot.errorCode || null,
              });
            } else {
              const state = ['completed', 'failed', 'canceled'].includes(snapshot?.executionStatus)
                ? 'waiting_for_result'
                : 'waiting_for_call';
              return { mission: safeMission(mission), state, recipient_position: accepted.position, provider_requests: 0 };
            }
          } catch (_) {
            return { mission: safeMission(mission), state: 'recovery_required', recipient_position: accepted.position, provider_requests: 0 };
          }
        }
      }
    }
    const current = await this.db.getCallECampaignMission(missionId, businessId);
    if (!current || !['approved', 'running'].includes(current.status)) {
      throw missionError('call_e_mission_not_approved', 'Mission is not approved for execution', 409);
    }
    let resultSchema;
    try { resultSchema = JSON.parse(current.result_schema_json); }
    catch { throw missionError('call_e_mission_result_schema_invalid', 'Pinned mission result schema is invalid', 409); }
    const destinations = (current.recipients || []).map((row) => decryptDestination(
      row.encrypted_destination, this.encryptionKeys, missionId, Number(row.position), Number(current.encryption_key_version),
    ));
    const checked = await this.campaignService.preflight({
      business_id: businessId,
      campaign_id: current.campaign_id,
      actor_id: actorId,
      destinations,
      result_schema: resultSchema,
      authorized: true,
    });
    if (checked?.all_ready !== true) {
      throw missionError('call_e_mission_preflight_blocked', 'Mission recipients no longer pass current consent and template checks', 409);
    }
    const claimed = await this.db.claimNextCallECampaignMissionRecipient(missionId, businessId);
    if (!claimed) {
      const refreshed = await this.db.getCallECampaignMission(missionId, businessId);
      return { mission: safeMission(refreshed), state: refreshed?.status || 'complete', provider_requests: 0 };
    }
    if (claimed.waitingForAccepted) {
      return { mission: safeMission(claimed.mission), state: 'waiting_for_call', provider_requests: 0 };
    }
    const recipient = claimed.recipient;
    const destination = decryptDestination(recipient.encrypted_destination, this.encryptionKeys, missionId,
      Number(recipient.position), Number(claimed.mission.encryption_key_version));
    const template = await this.getTemplate(Number(claimed.mission.template_id));
    if (!template || String(template.lifecycle_state || '').trim().toLowerCase() !== 'live' ||
        Number(template.version) !== Number(claimed.mission.template_version) ||
        String(template.business_id || template.businessId || '').trim() !== businessId) {
      await this.db.updateCallECampaignMissionRecipient({
        mission_id: missionId, business_id: businessId, position: recipient.position,
        status: 'blocked', error_code: 'call_e_template_changed',
      });
      throw missionError('call_e_template_changed', 'The approved mission template is no longer current', 409);
    }
    const preview = previewCallETemplate(template, { phone: destination, resultSchema });
    if (preview.compatible !== true) {
      await this.db.updateCallECampaignMissionRecipient({
        mission_id: missionId, business_id: businessId, position: recipient.position,
        status: 'blocked', error_code: 'call_e_template_incompatible',
      });
      throw missionError('call_e_template_incompatible', 'The approved mission template is no longer compatible', 409);
    }
    let budgetReserved = false;
    let cooldownReserved = false;
    const position = Number(recipient.position);
    try {
      if (claimed.mission.budget_limit_minor != null && claimed.mission.per_call_cost_ceiling_minor != null &&
          Number.isSafeInteger(Number(claimed.mission.budget_limit_minor)) && Number.isSafeInteger(Number(claimed.mission.per_call_cost_ceiling_minor))) {
        const budget = await this.db.reserveCallECampaignMissionBudget({ mission_id: missionId, business_id: businessId, recipient_position: position });
        if (!budget?.allowed) throw missionError('call_e_mission_budget_exhausted', 'Mission budget limit would be exceeded; no call was placed', 409);
        budgetReserved = true;
      }
      const cooldownHours = Number(safetyPolicy?.contact_cooldown_hours) || 0;
      const destinationHash = this.idempotencySecret.length >= 32
        ? crypto.createHmac('sha256', this.idempotencySecret).update(`${businessId}:${destination}`).digest('hex')
        : '';
      if (cooldownHours > 0 && !/^[a-f0-9]{64}$/.test(destinationHash)) {
        throw missionError('call_e_contact_policy_unavailable', 'Contact cooldown protection is unavailable; no call was placed', 503);
      }
      if (typeof this.db.reserveCallEContactCooldown === 'function') {
        const cooldown = await this.db.reserveCallEContactCooldown({
          business_id: businessId, destination_hash: destinationHash || crypto.createHash('sha256').update(`${businessId}:${destination}`).digest('hex'),
          mission_id: missionId, recipient_position: position,
        });
        if (!cooldown?.allowed) throw missionError('call_e_contact_cooldown_active', 'This contact is inside the business cooldown window; no call was placed', 409);
        cooldownReserved = true;
      }
    } catch (error) {
      if (budgetReserved) await this.db.updateCallECampaignMissionBudgetReservation?.({ mission_id: missionId, recipient_position: position, status: 'released' });
      if (cooldownReserved) await this.db.updateCallEContactCooldownReservation?.({ mission_id: missionId, recipient_position: position, status: 'released' });
      await this.db.releaseCallECampaignMissionRecipientClaim?.({ mission_id: missionId, business_id: businessId, position });
      throw error;
    }
    if (this.safetyService) {
      try {
        await this.safetyService.reserveDispatch({ businessId, missionId, position: Number(recipient.position), workerManaged });
      } catch (error) {
        if (budgetReserved) await this.db.updateCallECampaignMissionBudgetReservation?.({ mission_id: missionId, recipient_position: position, status: 'released' });
        if (cooldownReserved) await this.db.updateCallEContactCooldownReservation?.({ mission_id: missionId, recipient_position: position, status: 'released' });
        await this.db.releaseCallECampaignMissionRecipientClaim?.({ mission_id: missionId, business_id: businessId, position: Number(recipient.position) });
        throw error;
      }
    }
    const rawKey = String(recipient.idempotency_key || '').replace(/^voicednut:call-e:/, '');
    try {
      const call = await this.dispatchRecipient({
        template,
        phone: destination,
        resultSchema,
        confirmedFingerprint: preview.fingerprint,
        idempotencyKey: rawKey,
        missionAuthorization: {
          mission_id: missionId,
          business_id: businessId,
          request_hash: String(claimed.mission.request_hash),
          position: Number(recipient.position),
          worker_managed: workerManaged,
        },
      });
      await this.db.updateCallECampaignMissionRecipient({
        mission_id: missionId, business_id: businessId, position: recipient.position,
        status: 'accepted', local_call_id: call.localCallId,
      });
      await this.db.updateCallEContactCooldownReservation?.({ mission_id: missionId, recipient_position: position, status: 'accepted' });
      const refreshed = await this.db.getCallECampaignMission(missionId, businessId);
      return { mission: safeMission(refreshed), state: 'call_accepted', recipient_position: recipient.position,
        local_call_id: call.localCallId, provider_requests: call.idempotentReplay === true ? 0 : 1 };
    } catch (error) {
      if (error?.code === 'call_e_request_rejected') {
        await this.db.releaseCallEBusinessDispatch?.({ mission_id: missionId, business_id: businessId, recipient_position: Number(recipient.position) });
        if (budgetReserved) await this.db.updateCallECampaignMissionBudgetReservation?.({ mission_id: missionId, recipient_position: position, status: 'released' });
        if (cooldownReserved) await this.db.updateCallEContactCooldownReservation?.({ mission_id: missionId, recipient_position: position, status: 'released' });
        await this.db.updateCallECampaignMissionRecipient({
          mission_id: missionId, business_id: businessId, position: recipient.position,
          status: 'failed', error_code: 'call_e_request_rejected',
        });
      } else if (error?.code !== 'call_e_call_outcome_unknown') {
        await this.db.updateCallECampaignMissionRecipient({
          mission_id: missionId, business_id: businessId, position: recipient.position,
          status: 'needs_review', error_code: /^[a-z][a-z0-9_]{0,79}$/.test(String(error?.code || '')) ? error.code : 'call_e_dispatch_failed',
        });
      }
      throw error;
    }
  }
}

module.exports = {
  CallECampaignMissionService,
  encryptDestination,
  decryptDestination,
  safeMission,
};
