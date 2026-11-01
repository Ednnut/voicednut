const crypto = require('crypto');
const { previewCallETemplate } = require('../adapters/callETemplateAdapter');

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const OPERATOR_ROLES = new Set(['policy_manager', 'call_operator']);
const POLICY_MANAGER_ROLES = new Set(['policy_manager']);
const MAX_DESTINATIONS = 25;
const SAFE_REASON_CODES = new Set([
  'compatible', 'invalid_destination', 'duplicate_destination', 'consent_missing', 'consent_expired',
  'consent_not_effective', 'opted_out', 'policy_storage_unavailable', 'template_incompatible', 'preview_failed',
  'cooldown_active',
]);

function campaignError(code, message, status = 400) {
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

function keyedDigest(secret, value) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw campaignError('call_e_campaign_unavailable', 'Campaign idempotency protection is unavailable', 503);
  }
  return crypto.createHmac('sha256', secret).update(typeof value === 'string' ? value : JSON.stringify(stableValue(value))).digest('hex');
}

function maskDestination(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const tail = digits.slice(-4).padStart(4, '0');
  const hidden = Math.max(4, Math.min(14, digits.length - 4));
  return `${String(value || '').trim().startsWith('+') ? '+' : ''}${'•'.repeat(hidden)}${tail}`;
}

function safeCampaign(row, options = {}) {
  if (!row) return null;
  return {
    campaign_id: String(row.campaign_id || ''),
    business_id: String(row.business_id || ''),
    template_id: Number(row.template_id) || null,
    template_version: Number(row.template_version) || null,
    status: ['draft', 'approved', 'rejected'].includes(row.status) ? row.status : 'draft',
    recipient_count: Number(row.recipient_count) || 0,
    ready_count: Number(row.ready_count) || 0,
    blocked_count: Number(row.blocked_count) || 0,
    reviewed: row.reviewed_by != null,
    can_review: options.actorId != null && options.role === 'policy_manager' &&
      row.status === 'draft' && String(row.created_by || '') !== String(options.actorId),
    created_at: row.created_at || null,
    reviewed_at: row.reviewed_at || null,
  };
}

function safeRecipients(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    position: Number(row.position),
    destination_masked: /^\+?[•]{4,14}\d{4}$/.test(String(row.destination_masked || '')) ? row.destination_masked : '••••0000',
    status: row.status === 'ready' ? 'ready' : 'blocked',
    reason_code: SAFE_REASON_CODES.has(row.reason_code) ? row.reason_code : 'preview_failed',
  }));
}

function safeReviewHistory(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 10).map((row) => ({
    reviewed_by: /^\d{1,20}$/.test(String(row?.reviewed_by || '')) ? String(row.reviewed_by) : null,
    decision: ['approve', 'reject'].includes(row?.decision) ? row.decision : null,
    request_hash: /^[a-f0-9]{64}$/i.test(String(row?.request_hash || '')) ? String(row.request_hash).toLowerCase() : null,
    created_at: row?.created_at || null,
  }));
}

function consentReason(reason) {
  if (reason === 'cooldown_active') return 'policy_storage_unavailable';
  return new Set(['consent_missing', 'consent_expired', 'consent_not_effective', 'opted_out']).has(reason)
    ? reason
    : 'policy_storage_unavailable';
}

class CallECampaignService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.getTemplate = options.getTemplate || null;
    this.contactPolicy = options.contactPolicy || null;
    this.idempotencySecret = options.idempotencySecret || '';
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
  }

  async assertMembership(businessId, actorId, allowedRoles = OPERATOR_ROLES) {
    if (!BUSINESS_ID_PATTERN.test(businessId) || !ACTOR_ID_PATTERN.test(actorId)) {
      throw campaignError('call_e_campaign_invalid', 'Campaign business or actor scope is invalid');
    }
    if (typeof this.db?.getCallEBusinessOperator !== 'function') {
      throw campaignError('call_e_campaign_unavailable', 'Campaign operator authorization is unavailable', 503);
    }
    const membership = await this.db.getCallEBusinessOperator(businessId, actorId);
    if (!allowedRoles.has(membership?.role)) {
      throw campaignError('call_e_business_operator_access_denied', 'A current business operator membership is required', 403);
    }
    return membership;
  }

  async createDraft(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const templateId = Number(input.template_id);
    const actorId = String(input.actor_id || '').trim();
    const idempotencyKey = String(input.idempotency_key || '').trim();
    const destinations = Array.isArray(input.destinations) ? input.destinations : [];
    const resultSchema = input.result_schema;
    if (input.authorized !== true || !BUSINESS_ID_PATTERN.test(businessId) || !ACTOR_ID_PATTERN.test(actorId) ||
        !Number.isSafeInteger(templateId) || templateId < 1 || !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) ||
        !Array.isArray(destinations) || destinations.length < 1 || destinations.length > MAX_DESTINATIONS ||
        destinations.some((value) => typeof value !== 'string' || value.length > 80) ||
        !resultSchema || typeof resultSchema !== 'object' || Array.isArray(resultSchema) || Buffer.byteLength(JSON.stringify(resultSchema), 'utf8') > 16000) {
      throw campaignError('call_e_campaign_invalid', 'CALL-E campaign review input is invalid');
    }
    await this.assertMembership(businessId, actorId);
    if (typeof this.getTemplate !== 'function') throw campaignError('call_e_campaign_unavailable', 'Campaign template lookup is unavailable', 503);
    const template = await this.getTemplate(templateId);
    if (!template) throw campaignError('call_e_template_not_found', 'CALL-E template was not found', 404);
    if (String(template.lifecycle_state || '').trim().toLowerCase() !== 'live') {
      throw campaignError('call_e_template_not_live', 'Campaign review requires a live template', 409);
    }
    const templateBusinessId = String(template.business_id || template.businessId || '').trim();
    if (templateBusinessId !== businessId) throw campaignError('call_e_business_operator_access_denied', 'Template is outside the requested business scope', 403);
    const templateVersion = Number(template.version);
    if (!Number.isSafeInteger(templateVersion) || templateVersion < 1) throw campaignError('call_e_template_version_invalid', 'Template version is invalid', 409);
    const schemaFingerprint = keyedDigest(this.idempotencySecret, resultSchema);
    const normalizedInput = destinations.map((value) => String(value).trim());
    const requestHash = keyedDigest(this.idempotencySecret, { businessId, templateId, templateVersion, schemaFingerprint, destinations: normalizedInput });
    const campaignId = `campaign_${keyedDigest(this.idempotencySecret, `${businessId}:${idempotencyKey}`)}`;
    const seen = new Set();
    const recipients = [];
    for (let position = 0; position < normalizedInput.length; position += 1) {
      const destination = normalizedInput[position];
      const masked = maskDestination(destination);
      if (!E164_PATTERN.test(destination)) {
        recipients.push({ position, phone_masked: masked, status: 'blocked', reason_code: 'invalid_destination' });
        continue;
      }
      if (seen.has(destination)) {
        recipients.push({ position, phone_masked: masked, status: 'blocked', reason_code: 'duplicate_destination' });
        continue;
      }
      seen.add(destination);
      let eligibility;
      try {
        eligibility = await this.contactPolicy?.checkEligibility?.({ businessId, destination });
      } catch (_) {
        eligibility = { eligible: false, reason: 'policy_storage_unavailable' };
      }
      if (!eligibility?.eligible) {
        recipients.push({ position, phone_masked: masked, status: 'blocked', reason_code: consentReason(eligibility?.reason) });
        continue;
      }
      try {
        const preview = previewCallETemplate(template, { phone: destination, resultSchema });
        recipients.push({
          position,
          phone_masked: masked,
          status: preview.compatible === true ? 'ready' : 'blocked',
          reason_code: preview.compatible === true ? 'compatible' : 'template_incompatible',
        });
      } catch (_) {
        recipients.push({ position, phone_masked: masked, status: 'blocked', reason_code: 'preview_failed' });
      }
    }
    if (typeof this.db?.createCallECampaignReviewDraft !== 'function') {
      throw campaignError('call_e_campaign_unavailable', 'Campaign review storage is unavailable', 503);
    }
    const saved = await this.db.createCallECampaignReviewDraft({
      campaign_id: campaignId,
      business_id: businessId,
      template_id: templateId,
      template_version: templateVersion,
      schema_fingerprint: schemaFingerprint,
      request_hash: requestHash,
      created_by: actorId,
      recipients,
    });
    return { campaign: safeCampaign(saved?.campaign), recipients: safeRecipients(saved?.recipients), idempotentReplay: saved?.idempotentReplay === true };
  }

  async list(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const membership = await this.assertMembership(businessId, actorId);
    if (typeof this.db?.listCallECampaignReviewsForBusiness !== 'function') throw campaignError('call_e_campaign_unavailable', 'Campaign review storage is unavailable', 503);
    const rows = await this.db.listCallECampaignReviewsForBusiness(businessId, { limit: input.limit, offset: input.offset });
    return { campaigns: (Array.isArray(rows) ? rows : []).map((row) => safeCampaign(row, { actorId, role: membership.role })) };
  }

  async listApprovedSummaries(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const [campaignRows, rehearsalRows] = await Promise.all([
      this.db.listCallECampaignReviewsForBusiness(businessId, { limit: input.limit, status: 'approved' }),
      this.db.listCallECampaignExecutionRehearsalsForBusiness(businessId, input.limit),
    ]);
    const latestByCampaign = new Map((Array.isArray(rehearsalRows) ? rehearsalRows : []).map((row) => [row.campaign_id, row]));
    return {
      campaigns: (Array.isArray(campaignRows) ? campaignRows : [])
        .slice(0, 50)
        .map((row) => {
          const rehearsal = latestByCampaign.get(row.campaign_id);
          return {
            campaign_id: String(row.campaign_id),
            status: 'approved',
            template_id: Number(row.template_id) || null,
            recipient_count: Number(row.recipient_count) || 0,
            reviewed_at: row.reviewed_at || null,
            latest_rehearsal: rehearsal ? {
              rehearsal_id: String(rehearsal.rehearsal_id),
              status: String(rehearsal.status),
              recipient_count: Number(rehearsal.recipient_count) || 0,
              ready_count: Number(rehearsal.ready_count) || 0,
              blocked_count: Number(rehearsal.blocked_count) || 0,
              created_at: rehearsal.created_at || null,
            } : null,
          };
        }),
    };
  }

  async get(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const campaignId = String(input.campaign_id || '').trim();
    const membership = await this.assertMembership(businessId, actorId);
    if (!/^campaign_[a-f0-9]{64}$/.test(campaignId) || typeof this.db?.getCallECampaignReviewForBusiness !== 'function') {
      throw campaignError('call_e_campaign_not_found', 'Campaign review report was not found', 404);
    }
    const report = await this.db.getCallECampaignReviewForBusiness(campaignId, businessId);
    if (!report) throw campaignError('call_e_campaign_not_found', 'Campaign review report was not found', 404);
    return {
      campaign: safeCampaign(report.campaign, { actorId, role: membership.role }),
      recipients: safeRecipients(report.recipients),
      review_history: safeReviewHistory(report.reviewHistory),
    };
  }

  async review(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const campaignId = String(input.campaign_id || '').trim();
    const decision = String(input.decision || '').trim().toLowerCase();
    if (!/^campaign_[a-f0-9]{64}$/.test(campaignId) || !['approve', 'reject'].includes(decision)) {
      throw campaignError('call_e_campaign_invalid', 'Campaign review decision is invalid');
    }
    await this.assertMembership(businessId, actorId, POLICY_MANAGER_ROLES);
    if (typeof this.db?.reviewCallECampaignForBusiness !== 'function') throw campaignError('call_e_campaign_unavailable', 'Campaign review storage is unavailable', 503);
    const report = await this.db.reviewCallECampaignForBusiness({
      campaign_id: campaignId,
      business_id: businessId,
      reviewed_by: actorId,
      decision,
    });
    if (!report) throw campaignError('call_e_campaign_not_found', 'Campaign review report was not found', 404);
    return {
      campaign: safeCampaign(report.campaign),
      recipients: safeRecipients(report.recipients),
      review_history: safeReviewHistory(report.reviewHistory),
      idempotent_replay: report.idempotentReplay === true,
    };
  }

  async preflight(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const campaignId = String(input.campaign_id || '').trim();
    const destinations = Array.isArray(input.destinations) ? input.destinations : [];
    const resultSchema = input.result_schema;
    if (!/^campaign_[a-f0-9]{64}$/.test(campaignId) || input.authorized !== true ||
        destinations.length < 1 || destinations.length > MAX_DESTINATIONS ||
        destinations.some((value) => typeof value !== 'string' || value.length > 80) ||
        !resultSchema || typeof resultSchema !== 'object' || Array.isArray(resultSchema) ||
        Buffer.byteLength(JSON.stringify(resultSchema), 'utf8') > 16000) {
      throw campaignError('call_e_campaign_invalid', 'CALL-E campaign preflight input is invalid');
    }
    await this.assertMembership(businessId, actorId);
    const report = await this.db?.getCallECampaignReviewForBusiness?.(campaignId, businessId);
    if (!report) throw campaignError('call_e_campaign_not_found', 'Campaign review report was not found', 404);
    if (report.campaign.status !== 'approved') throw campaignError('call_e_campaign_not_approved', 'Only an approved campaign report can be preflighted', 409);
    const template = await this.getTemplate?.(Number(report.campaign.template_id));
    if (!template || String(template.lifecycle_state || '').trim().toLowerCase() !== 'live' ||
        String(template.business_id || template.businessId || '').trim() !== businessId ||
        Number(template.version) !== Number(report.campaign.template_version)) {
      throw campaignError('call_e_template_changed', 'The approved template version is no longer live', 409);
    }
    const schemaFingerprint = keyedDigest(this.idempotencySecret, resultSchema);
    const requestHash = keyedDigest(this.idempotencySecret, {
      businessId,
      templateId: Number(report.campaign.template_id),
      templateVersion: Number(report.campaign.template_version),
      schemaFingerprint,
      destinations: destinations.map((value) => String(value).trim()),
    });
    const storedHash = Buffer.from(String(report.campaign.request_hash || ''), 'hex');
    const suppliedHash = Buffer.from(requestHash, 'hex');
    if (storedHash.length !== suppliedHash.length || !crypto.timingSafeEqual(storedHash, suppliedHash)) {
      throw campaignError('call_e_campaign_destinations_mismatch', 'Re-entered destinations or result schema do not match the approved report', 409);
    }
    const rows = [];
    const seen = new Set();
    for (const [position, raw] of destinations.entries()) {
      const destination = String(raw).trim();
      let reason = 'compatible';
      if (!E164_PATTERN.test(destination)) reason = 'invalid_destination';
      else if (seen.has(destination)) reason = 'duplicate_destination';
      else {
        seen.add(destination);
        let eligibility;
        try { eligibility = await this.contactPolicy?.checkEligibility?.({ businessId, destination }); }
        catch (_) { eligibility = { eligible: false, reason: 'policy_storage_unavailable' }; }
        if (!eligibility?.eligible) reason = consentReason(eligibility?.reason);
        else {
          try {
            if (previewCallETemplate(template, { phone: destination, resultSchema }).compatible !== true) reason = 'template_incompatible';
          } catch (_) { reason = 'preview_failed'; }
        }
      }
      rows.push({ position, destination_masked: maskDestination(destination), status: reason === 'compatible' ? 'ready' : 'blocked', reason_code: reason });
    }
    return {
      campaign: safeCampaign(report.campaign),
      recipients: safeRecipients(rows),
      all_ready: rows.every((row) => row.status === 'ready'),
      dispatch_enabled: false,
    };
  }

  async rehearseExecution(input = {}) {
    const idempotencyKey = String(input.idempotency_key || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey)) {
      throw campaignError('call_e_campaign_invalid', 'A valid execution rehearsal idempotency key is required');
    }
    const checked = await this.preflight(input);
    const campaignId = String(checked.campaign.campaign_id);
    const requestHash = keyedDigest(this.idempotencySecret, {
      campaignId,
      destinations: input.destinations.map((value) => String(value).trim()),
      schema: input.result_schema,
      states: checked.recipients.map((row) => [row.status, row.reason_code]),
    });
    const rehearsalId = `rehearsal_${keyedDigest(this.idempotencySecret, `${campaignId}:${idempotencyKey}`)}`;
    const saved = await this.db.createCallECampaignExecutionRehearsal({
      rehearsal_id: rehearsalId,
      campaign_id: campaignId,
      business_id: String(input.business_id),
      request_hash: requestHash,
      started_by: String(input.actor_id),
      recipients: checked.recipients.map((row) => ({
        position: row.position,
        state: row.status === 'ready' ? 'simulated_ready' : 'blocked',
        reason_code: row.reason_code,
      })),
    });
    return {
      rehearsal: {
        rehearsal_id: String(saved.rehearsal.rehearsal_id),
        campaign_id: campaignId,
        status: 'completed',
        recipient_count: Number(saved.rehearsal.recipient_count) || 0,
        ready_count: Number(saved.rehearsal.ready_count) || 0,
        blocked_count: Number(saved.rehearsal.blocked_count) || 0,
        idempotent_replay: saved.idempotentReplay === true,
      },
      recipients: checked.recipients.map((row) => ({
        position: row.position,
        destination_masked: row.destination_masked,
        state: row.status === 'ready' ? 'simulated_ready' : 'blocked',
        reason_code: row.reason_code,
      })),
      dispatch_enabled: false,
      provider_requests: 0,
    };
  }
}

module.exports = { CallECampaignService, maskDestination, safeCampaign, safeRecipients, safeReviewHistory };
