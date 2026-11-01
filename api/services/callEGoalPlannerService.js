'use strict';

const { previewCallETemplate } = require('../adapters/callETemplateAdapter');

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const OPERATOR_ROLES = new Set(['policy_manager', 'call_operator']);
const CLARIFICATION_PROMPTS = Object.freeze({
  valid_e164_phone: 'Enter a destination phone number in E.164 format.',
  result_schema: 'Provide a structured result schema for the information this call should capture.',
  valid_result_schema: 'Correct the result schema using a flat object with scalar fields and additionalProperties set to false.',
  valid_region_code: 'Provide a two-letter destination region code or leave it blank for inference.',
  valid_locale_tag: 'Provide a valid spoken locale or leave it blank for inference.',
  prompt: 'Update the approved template with a call goal before planning.',
  first_message: 'Update the approved template with an opening message before planning.',
});
const GOAL_STOP_WORDS = new Set(['about', 'after', 'before', 'from', 'have', 'into', 'need', 'that', 'their', 'them', 'then', 'this', 'through', 'with', 'would', 'your']);

function goalTokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.filter((token) => !GOAL_STOP_WORDS.has(token)) || []);
}

function plannerError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function safeConsentReason(reason) {
  return ['consent_missing', 'consent_expired', 'consent_not_effective', 'opted_out'].includes(reason)
    ? reason
    : 'policy_storage_unavailable';
}

class CallEGoalPlannerService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.getTemplate = options.getTemplate || null;
    this.contactPolicy = options.contactPolicy || null;
  }

  async requireOperator(businessId, actorId) {
    if (!BUSINESS_ID_PATTERN.test(businessId) || !ACTOR_ID_PATTERN.test(actorId)) {
      throw plannerError('call_e_plan_scope_invalid', 'Business and Telegram actor scope are required');
    }
    const membership = await this.db?.getCallEBusinessOperator?.(businessId, actorId);
    if (!OPERATOR_ROLES.has(membership?.role)) {
      throw plannerError('call_e_business_operator_access_denied', 'A current business operator membership is required', 403);
    }
  }

  async listTemplates(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.requireOperator(businessId, actorId);
    const rows = await this.db?.getCallTemplates?.();
    return {
      templates: (Array.isArray(rows) ? rows : [])
        .filter((row) => String(row.business_id || '').trim() === businessId &&
          String(row.lifecycle_state || '').trim().toLowerCase() === 'live')
        .slice(0, 50)
        .map((row) => ({
          template_id: Number(row.id) || null,
          name: String(row.name || '').slice(0, 120),
          description: String(row.description || '').slice(0, 240),
          version: Number(row.version) || 1,
        })),
    };
  }

  async suggestTemplates(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const goal = String(input.goal_text || '').trim();
    if (goal.length < 8 || goal.length > 500) {
      throw plannerError('call_e_goal_text_invalid', 'Describe the intended call outcome in 8 to 500 characters');
    }
    await this.requireOperator(businessId, actorId);
    const rows = await this.db?.getCallTemplates?.();
    const requestedTokens = goalTokens(goal);
    const candidates = (Array.isArray(rows) ? rows : [])
      .filter((row) => String(row.business_id || '').trim() === businessId &&
        String(row.lifecycle_state || '').trim().toLowerCase() === 'live')
      .map((row) => {
        const templateTokens = goalTokens([
          row.name, row.description, row.prompt, row.first_message, row.objective_tags,
        ].filter(Boolean).join(' '));
        let matched = 0;
        for (const token of requestedTokens) if (templateTokens.has(token)) matched += 1;
        const matchPercent = requestedTokens.size ? Math.round((matched / requestedTokens.size) * 100) : 0;
        return {
          template_id: Number(row.id) || null,
          name: String(row.name || '').slice(0, 120),
          description: String(row.description || '').slice(0, 240),
          version: Number(row.version) || 1,
          goal_match_percent: matchPercent,
        };
      })
      .sort((left, right) => right.goal_match_percent - left.goal_match_percent || left.name.localeCompare(right.name))
      .slice(0, 20);
    return { goal_text_length: goal.length, matching_method: 'deterministic_keyword_overlap', templates: candidates };
  }

  async plan(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    const templateId = Number(input.template_id);
    const phone = String(input.phone || '').trim();
    const region = input.region == null ? null : String(input.region).trim();
    const locale = input.locale == null ? null : String(input.locale).trim();
    const resultSchema = input.result_schema;
    if (!Number.isSafeInteger(templateId) || templateId < 1 || !phone || phone.length > 80 ||
        !resultSchema || typeof resultSchema !== 'object' || Array.isArray(resultSchema) ||
        Buffer.byteLength(JSON.stringify(resultSchema), 'utf8') > 16000) {
      throw plannerError('call_e_plan_invalid', 'Template, destination, and result schema are required');
    }
    await this.requireOperator(businessId, actorId);
    const template = await this.getTemplate?.(templateId);
    if (!template) throw plannerError('call_e_template_not_found', 'CALL-E template was not found', 404);
    if (String(template.business_id || template.businessId || '').trim() !== businessId) {
      throw plannerError('call_e_business_operator_access_denied', 'Template is outside the requested business scope', 403);
    }
    if (String(template.lifecycle_state || '').trim().toLowerCase() !== 'live') {
      throw plannerError('call_e_template_not_live', 'Goal planning requires a live, approved template', 409);
    }

    const preview = previewCallETemplate(template, { phone, region, locale, resultSchema });
    let consent = { eligible: false, reason: 'policy_storage_unavailable' };
    if (/^\+[1-9]\d{7,14}$/.test(phone)) {
      try { consent = await this.contactPolicy?.checkEligibility?.({ businessId, destination: phone }) || consent; }
      catch (_) { consent = { eligible: false, reason: 'policy_storage_unavailable' }; }
    }
    const questions = preview.missing
      .map((code) => CLARIFICATION_PROMPTS[code])
      .filter(Boolean);
    if (!consent?.eligible) questions.push(`Resolve contact eligibility: ${safeConsentReason(consent?.reason)}.`);
    const taskPreview = String(preview.requestSummary.taskPreview || '').slice(0, 500);
    return {
      plan: {
        template_id: templateId,
        template_version: Number(template.version) || null,
        template_name: String(template.name || '').slice(0, 120),
        goal_preview: taskPreview,
        destination_masked: preview.requestSummary.phoneMasked,
        result_fields: preview.requestSummary.resultProperties,
        compatible: preview.compatible,
        consent_eligible: consent?.eligible === true,
        unsupported: preview.unsupported,
        schema_errors: preview.schemaErrors,
        clarification_questions: questions,
        preview_fingerprint: preview.fingerprint,
        dispatch_enabled: false,
        persisted: false,
      },
    };
  }
}

module.exports = { CallEGoalPlannerService, CLARIFICATION_PROMPTS };
