const crypto = require("crypto");

const FINGERPRINT_FIELDS = Object.freeze([
  "name",
  "description",
  "prompt",
  "first_message",
  "voice_model",
  "objective_tags",
  "supports_payment",
  "supports_digit_capture",
  "requires_otp",
  "default_profile",
  "expected_length",
  "allow_terminator",
  "terminator_char",
  "payment_enabled",
  "payment_connector",
  "payment_amount",
  "payment_currency",
  "payment_description",
  "payment_policy",
  "payment_start_message",
  "payment_success_message",
  "payment_failure_message",
  "payment_retry_message",
]);

function normalizePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function stableSerialize(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprintTemplate(template) {
  if (!template || typeof template !== "object") return null;
  const content = {};
  for (const field of FINGERPRINT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(template, field)) {
      content[field] = template[field];
    }
  }
  return crypto
    .createHash("sha256")
    .update(stableSerialize(content))
    .digest("hex");
}

function buildCallTemplateExecutionContext(options = {}) {
  const template =
    options.template && typeof options.template === "object"
      ? options.template
      : null;
  const templateId = normalizePositiveInteger(
    options.templateId ?? template?.id ?? template?.template_id,
  );
  const templateVersion = normalizePositiveInteger(
    options.templateVersion ?? template?.version,
  );
  const provider = String(options.provider || "")
    .trim()
    .toLowerCase();
  const flow = String(options.flow || "")
    .trim()
    .toLowerCase();
  const providerResourceId = String(options.providerResourceId || "").trim();
  const fallbackProvider = String(options.fallbackProvider || "")
    .trim()
    .toLowerCase();

  if (!provider) {
    throw new Error("Call template execution context requires a provider");
  }
  if (!flow) {
    throw new Error("Call template execution context requires a flow");
  }

  return Object.freeze({
    contract_version: 1,
    template_id: templateId,
    template_version: templateVersion,
    template_source: templateId === null ? "inline" : "call_template",
    configuration_fingerprint: fingerprintTemplate(template),
    provider,
    provider_resource_id: providerResourceId || null,
    compatibility_status: String(options.compatibilityStatus || "unassessed")
      .trim()
      .toLowerCase(),
    deployment_status: String(options.deploymentStatus || "unmapped")
      .trim()
      .toLowerCase(),
    fallback_provider: fallbackProvider || null,
    flow,
  });
}

module.exports = {
  buildCallTemplateExecutionContext,
  fingerprintTemplate,
};
