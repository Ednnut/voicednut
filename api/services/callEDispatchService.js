const { previewCallETemplate } = require("../adapters/callETemplateAdapter");

const OPERATOR_ROLES = new Set(["policy_manager", "call_operator"]);

function dispatchError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function approvedFingerprintFromEnv(env = process.env) {
  const fingerprint = String(env.CALLE_PILOT_APPROVED_FINGERPRINT || "").trim().toLowerCase();
  const expiresAt = String(env.CALLE_PILOT_APPROVAL_EXPIRES_AT || "").trim();
  const reference = String(env.CALLE_PILOT_APPROVAL_REFERENCE || "").trim();
  if (!/^[a-f0-9]{64}$/.test(fingerprint) || !/^[A-Za-z0-9._:-]{8,180}$/.test(reference) ||
      !/(?:Z|[+-]\d{2}:\d{2})$/i.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now()) return null;
  return { fingerprint, reference };
}

class CallEDispatchService {
  constructor(options = {}) {
    this.db = options.db;
    this.getTemplate = options.getTemplate;
    this.outbound = options.outbound;
    this.env = options.env || process.env;
  }

  async dispatch(input = {}) {
    if (String(this.env.CALLE_DISPATCH_ENABLED || "false").trim().toLowerCase() !== "true") {
      throw dispatchError("call_e_dispatch_disabled", "CALL-E dispatch is disabled", 503);
    }
    if (String(this.env.CALLE_PILOT_READINESS_REVIEWED || "false").trim().toLowerCase() !== "true") {
      throw dispatchError("call_e_pilot_readiness_not_reviewed", "CALL-E pilot readiness has not been reviewed", 403);
    }
    const approval = approvedFingerprintFromEnv(this.env);
    if (!approval) throw dispatchError("call_e_pilot_approval_missing", "A current exact-preview pilot approval is required", 403);
    const templateId = Number(input.template_id);
    const destination = String(input.destination || "").trim();
    const fingerprint = String(input.preview_fingerprint || "").trim().toLowerCase();
    const telegramId = String(input.recorded_by_telegram_id || "").trim();
    const idempotencyKey = String(input.idempotency_key || "").trim();
    if (!Number.isSafeInteger(templateId) || templateId <= 0 || !/^\+[1-9]\d{7,14}$/.test(destination) ||
        !/^\d{1,20}$/.test(telegramId) || !/^[A-Za-z0-9._:-]{8,180}$/.test(idempotencyKey) ||
        !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw dispatchError("call_e_dispatch_invalid", "CALL-E dispatch request is invalid", 400);
    }
    if (fingerprint !== approval.fingerprint) {
      throw dispatchError("call_e_pilot_approval_mismatch", "The exact preview is not covered by current pilot approval", 403);
    }
    if (typeof this.getTemplate !== "function" || typeof this.db?.getCallEBusinessOperator !== "function" ||
        typeof this.db?.hasCallEOperatorConfirmation !== "function" || typeof this.outbound?.createOutboundCall !== "function") {
      throw dispatchError("call_e_dispatch_unavailable", "CALL-E dispatch dependencies are unavailable", 503);
    }
    const template = await this.getTemplate(templateId);
    if (!template) throw dispatchError("call_e_template_not_found", "Call template was not found", 404);
    if (String(template.lifecycle_state || "").trim().toLowerCase() !== "live") {
      throw dispatchError("call_e_template_not_live", "CALL-E dispatch requires a live pinned template", 409);
    }
    const businessId = String(template.business_id || template.businessId || "").trim();
    if (!businessId) throw dispatchError("call_e_business_scope_required", "Template has no business scope", 403);
    const membership = await this.db.getCallEBusinessOperator(businessId, telegramId);
    if (!OPERATOR_ROLES.has(membership?.role)) {
      throw dispatchError("call_e_business_operator_access_denied", "A CALL-E business operator membership is required", 403);
    }
    const preview = previewCallETemplate(template, {
      phone: destination,
      region: input.region,
      locale: input.locale,
      resultSchema: input.result_schema,
    });
    if (!preview.compatible || preview.fingerprint !== fingerprint) {
      throw dispatchError("call_e_confirmation_mismatch", "The current template preview does not match the approved preview", 409);
    }
    const templateVersion = Number(preview.source?.templateVersion);
    const confirmed = await this.db.hasCallEOperatorConfirmation({
      business_id: businessId,
      template_id: templateId,
      template_version: templateVersion,
      preview_fingerprint: fingerprint,
      recorded_by_telegram_id: telegramId,
    });
    if (!confirmed) throw dispatchError("call_e_operator_confirmation_required", "Confirm this exact preview before dispatch", 403);
    const result = await this.outbound.createOutboundCall({
      template,
      phone: destination,
      region: input.region,
      locale: input.locale,
      resultSchema: input.result_schema,
      confirmedFingerprint: fingerprint,
      idempotencyKey,
    });
    return {
      localCallId: result.localCallId,
      status: result.status,
      idempotentReplay: result.idempotentReplay === true,
    };
  }
}

module.exports = { CallEDispatchService, approvedFingerprintFromEnv };
