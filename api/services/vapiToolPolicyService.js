'use strict';

const {
  VAPI_BUSINESS_CONTEXT_TOOL_ID,
} = require('./vapiToolRegistry');

function parseAgentConfig(template) {
  const raw = template?.agent_config_json || template?.agent_config;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function policyError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

class VapiToolPolicyService {
  constructor(options = {}) {
    this.db = options.db;
    this.validateTemplateConfig = options.validateTemplateConfig;
    this.getAvailableToolNames = options.getAvailableToolNames;
    this.onTemplateUpdated = options.onTemplateUpdated;
  }

  async getTemplate(templateId) {
    const id = Number(templateId);
    if (!Number.isSafeInteger(id) || id <= 0) throw policyError('vapi_tool_template_invalid', 'A valid template ID is required');
    if (typeof this.db?.getCallTemplateById !== 'function') throw policyError('vapi_tool_policy_unavailable', 'Vapi tool policy storage is unavailable', 503);
    const template = await this.db.getCallTemplateById(id);
    if (!template) throw policyError('vapi_tool_template_not_found', 'Call template was not found', 404);
    return template;
  }

  summarize(template, config) {
    const approved = Array.isArray(config?.approved_tools) ? config.approved_tools : [];
    const context = config?.business_context;
    return {
      template_id: Number(template.id),
      template_version: Number(template.version) || 1,
      lifecycle_state: String(template.lifecycle_state || 'draft'),
      tool_id: VAPI_BUSINESS_CONTEXT_TOOL_ID,
      enabled: approved.includes(VAPI_BUSINESS_CONTEXT_TOOL_ID),
      business_context_available: Boolean(context && typeof context === 'object' && !Array.isArray(context) &&
        Array.isArray(context.facts) && context.facts.length > 0),
      reapproval_required_after_change: true,
    };
  }

  async getStatus(templateId) {
    const template = await this.getTemplate(templateId);
    const config = parseAgentConfig(template);
    return { tool: this.summarize(template, config) };
  }

  async setBusinessContextLookup(templateId, enabled, actor = 'admin_token') {
    if (enabled !== true && enabled !== false) throw policyError('vapi_tool_enabled_invalid', 'enabled must be a boolean');
    const template = await this.getTemplate(templateId);
    const currentConfig = parseAgentConfig(template);
    if (!currentConfig) throw policyError('vapi_tool_agent_config_required', 'A valid Call Agent configuration is required before enabling this tool', 409);
    const currentValidation = typeof this.validateTemplateConfig === 'function'
      ? this.validateTemplateConfig(template, currentConfig)
      : null;
    if (!currentValidation?.valid || !currentValidation.normalized) {
      throw policyError('vapi_tool_agent_config_invalid', 'The template Call Agent configuration must be valid before changing tool access', 409);
    }
    const normalized = currentValidation.normalized;
    const currentlyEnabled = Array.isArray(normalized.approved_tools) &&
      normalized.approved_tools.includes(VAPI_BUSINESS_CONTEXT_TOOL_ID);
    if (currentlyEnabled === enabled) {
      return { tool: this.summarize(template, normalized), changed: false };
    }
    const hasContext = normalized.business_context && typeof normalized.business_context === 'object' &&
      Array.isArray(normalized.business_context.facts) && normalized.business_context.facts.length > 0;
    if (enabled && !hasContext) {
      throw policyError('vapi_tool_business_context_required', 'Add validated business reference facts before enabling this read-only tool', 409);
    }

    const knownTools = typeof this.getAvailableToolNames === 'function'
      ? this.getAvailableToolNames(template)
      : [];
    const priorApproved = Array.isArray(normalized.approved_tools)
      ? normalized.approved_tools
      : knownTools;
    const nextApproved = Array.from(new Set([
      ...priorApproved.filter((name) => name !== VAPI_BUSINESS_CONTEXT_TOOL_ID),
      ...(enabled ? [VAPI_BUSINESS_CONTEXT_TOOL_ID] : []),
    ]));
    if (JSON.stringify(nextApproved) === JSON.stringify(normalized.approved_tools || [])) {
      return { tool: this.summarize(template, normalized), changed: false };
    }
    const candidateConfig = { ...normalized, approved_tools: nextApproved };
    const validation = typeof this.validateTemplateConfig === 'function'
      ? this.validateTemplateConfig(template, candidateConfig)
      : null;
    if (!validation?.valid || !validation.normalized) {
      throw policyError('vapi_tool_policy_invalid', 'The requested tool policy is not valid for this template', 409);
    }
    if (typeof this.db?.updateCallTemplate !== 'function') throw policyError('vapi_tool_policy_unavailable', 'Vapi tool policy storage is unavailable', 503);
    const updated = await this.db.updateCallTemplate(Number(template.id), { agent_config: validation.normalized });
    if (!updated) throw policyError('vapi_tool_template_not_found', 'Call template was not found', 404);
    if (['review', 'approved', 'live'].includes(String(template.lifecycle_state || '').toLowerCase()) &&
        typeof this.db.setCallTemplateLifecycle === 'function') {
      await this.db.setCallTemplateLifecycle(Number(template.id), {
        lifecycle_state: 'draft',
        submitted_for_review_at: null,
        reviewed_at: null,
        reviewed_by: null,
        review_note: null,
        live_at: null,
        live_by: null,
      });
    }
    const saved = await this.getTemplate(template.id);
    if (typeof this.onTemplateUpdated === 'function') await this.onTemplateUpdated(saved, actor);
    const savedConfig = parseAgentConfig(saved);
    return { tool: this.summarize(saved, savedConfig), changed: true };
  }
}

module.exports = { VapiToolPolicyService, VAPI_BUSINESS_CONTEXT_TOOL_ID, parseAgentConfig };
