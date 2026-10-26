const crypto = require("node:crypto");
const { previewCallETemplate } = require("../adapters/callETemplateAdapter");

const OPERATOR_ROLES = new Set(["policy_manager", "call_operator"]);

function confirmationError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

class CallEOperatorConfirmationService {
  constructor(options = {}) {
    this.db = options.db;
    this.getTemplate = options.getTemplate;
  }

  async confirm(input = {}) {
    const templateId = Number(input.template_id);
    const destination = String(input.destination || "").trim();
    const fingerprint = String(input.preview_fingerprint || "").trim().toLowerCase();
    const confirmationKey = String(input.confirmation_key || "").trim();
    const telegramId = String(input.recorded_by_telegram_id || "").trim();
    if (!Number.isSafeInteger(templateId) || templateId <= 0 || !/^\+[1-9]\d{7,14}$/.test(destination) ||
        !/^[a-f0-9]{64}$/.test(fingerprint) || !/^[A-Za-z0-9._:-]{8,180}$/.test(confirmationKey) ||
        !/^\d{1,20}$/.test(telegramId)) {
      throw confirmationError("call_e_confirmation_invalid", "CALL-E preview confirmation is invalid", 400);
    }
    if (typeof this.getTemplate !== "function" || typeof this.db?.getCallEBusinessOperator !== "function" ||
        typeof this.db?.recordCallEOperatorConfirmation !== "function") {
      throw confirmationError("call_e_confirmation_unavailable", "CALL-E confirmation storage or authorization is unavailable", 503);
    }
    const template = await this.getTemplate(templateId);
    if (!template) throw confirmationError("call_e_template_not_found", "Call template was not found", 404);
    if (String(template.lifecycle_state || "").trim().toLowerCase() !== "live") {
      throw confirmationError("call_e_template_not_live", "CALL-E preview confirmation requires a live, pinned template", 409);
    }
    const businessId = String(template.business_id || template.businessId || "").trim();
    if (!businessId) throw confirmationError("call_e_business_scope_required", "Template has no business scope", 409);
    const membership = await this.db.getCallEBusinessOperator(businessId, telegramId);
    if (!OPERATOR_ROLES.has(membership?.role)) {
      throw confirmationError("call_e_business_operator_access_denied", "A CALL-E business operator membership is required", 403);
    }

    const preview = previewCallETemplate(template, {
      phone: destination,
      region: input.region,
      locale: input.locale,
      resultSchema: input.result_schema,
    });
    if (!preview.compatible) {
      throw confirmationError("call_e_template_incompatible", "The current template preview is not compatible with CALL-E", 409);
    }
    if (preview.fingerprint !== fingerprint) {
      throw confirmationError("call_e_confirmation_mismatch", "The preview has changed; create a new preview before confirming", 409);
    }
    const templateVersion = Number(preview.source?.templateVersion);
    if (!Number.isSafeInteger(templateVersion) || templateVersion <= 0) {
      throw confirmationError("call_e_template_version_required", "A pinned template version is required", 409);
    }
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({
      businessId,
      templateId,
      templateVersion,
      fingerprint,
      telegramId,
    })).digest("hex");
    const result = await this.db.recordCallEOperatorConfirmation({
      confirmation_key: confirmationKey,
      request_hash: requestHash,
      business_id: businessId,
      template_id: templateId,
      template_version: templateVersion,
      preview_fingerprint: fingerprint,
      recorded_by_telegram_id: telegramId,
    });
    if (result?.conflict) {
      throw confirmationError("call_e_confirmation_idempotency_conflict", "Confirmation key was already used for a different preview or operator", 409);
    }
    return { confirmed: result?.recorded === true || result?.replay === true, idempotentReplay: result?.replay === true, fingerprint };
  }
}

module.exports = { CallEOperatorConfirmationService };
