const crypto = require("node:crypto");

const MAX_TASK_LENGTH = 12000;
const MAX_RESULT_PROPERTIES = 32;
const TOP_LEVEL_SCHEMA_KEYS = new Set(["type", "additionalProperties", "required", "properties"]);
const PROPERTY_SCHEMA_KEYS = new Set(["type", "description", "enum"]);
const SCALAR_TYPES = new Set(["string", "boolean", "integer", "number"]);

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function isEnabled(value) {
  return value === true || value === 1 || ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function maskPhone(value) {
  const phone = String(value || "").trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return null;
  return `${phone.slice(0, 3)}${"•".repeat(Math.max(0, phone.length - 7))}${phone.slice(-4)}`;
}

function validateCallEResultSchema(schema) {
  const errors = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { valid: false, errors: ["result_schema must be an object"] };
  }

  for (const key of Object.keys(schema)) {
    if (!TOP_LEVEL_SCHEMA_KEYS.has(key)) errors.push(`unsupported result_schema keyword: ${key}`);
  }
  if (schema.type !== "object") errors.push("result_schema.type must be object");
  if (schema.additionalProperties !== false) errors.push("result_schema.additionalProperties must be false");
  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    errors.push("result_schema.properties must be an object");
    return { valid: false, errors };
  }

  const propertyNames = Object.keys(schema.properties);
  if (propertyNames.length > MAX_RESULT_PROPERTIES) errors.push(`result_schema supports at most ${MAX_RESULT_PROPERTIES} properties`);
  const required = schema.required;
  if (!Array.isArray(required) || required.some((name) => typeof name !== "string") || new Set(required).size !== required.length) {
    errors.push("result_schema.required must be an array of unique property names");
  }

  for (const name of Array.isArray(required) ? required : []) {
    if (!Object.prototype.hasOwnProperty.call(schema.properties, name)) errors.push(`required property is missing from properties: ${name}`);
  }

  for (const [name, property] of Object.entries(schema.properties)) {
    if (!name.trim()) errors.push("result_schema property names must not be empty");
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      errors.push(`result_schema property must be an object: ${name}`);
      continue;
    }
    for (const key of Object.keys(property)) {
      if (!PROPERTY_SCHEMA_KEYS.has(key)) errors.push(`unsupported property keyword for ${name}: ${key}`);
    }
    if (!SCALAR_TYPES.has(property.type)) errors.push(`unsupported scalar type for ${name}`);
    if (property.description !== undefined && typeof property.description !== "string") {
      errors.push(`description must be a string for ${name}`);
    }
    if (property.enum !== undefined && (!Array.isArray(property.enum) || property.enum.length === 0)) {
      errors.push(`enum must be a non-empty array for ${name}`);
    }
    if (Array.isArray(property.enum)) {
      for (const value of property.enum) {
        const matchesType = property.type === "string" ? typeof value === "string"
          : property.type === "boolean" ? typeof value === "boolean"
            : property.type === "integer" ? Number.isSafeInteger(value)
              : property.type === "number" ? typeof value === "number" && Number.isFinite(value)
                : false;
        if (!matchesType) errors.push(`enum values must match the scalar type for ${name}`);
      }
    }
  }

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function validateCallEResult(schema, result) {
  const schemaValidation = validateCallEResultSchema(schema);
  if (!schemaValidation.valid) return schemaValidation;
  const errors = [];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { valid: false, errors: ["result must be an object"] };
  }
  const properties = schema.properties;
  for (const key of Object.keys(result)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`unexpected result property: ${key}`);
  }
  for (const key of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) errors.push(`required result property is missing: ${key}`);
  }
  for (const [key, value] of Object.entries(result)) {
    const property = properties[key];
    if (!property) continue;
    const matchesType = property.type === "string" ? typeof value === "string"
      : property.type === "boolean" ? typeof value === "boolean"
        : property.type === "integer" ? Number.isSafeInteger(value)
          : property.type === "number" ? typeof value === "number" && Number.isFinite(value)
            : false;
    if (!matchesType) {
      errors.push(`result property has an invalid scalar type: ${key}`);
      continue;
    }
    if (Array.isArray(property.enum) && !property.enum.some((entry) => entry === value)) {
      errors.push(`result property is outside its enum: ${key}`);
    }
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function readObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildTask(template) {
  const prompt = String(template?.prompt || "").trim();
  const firstMessage = String(template?.first_message || template?.firstMessage || "").trim();
  if (!prompt || !firstMessage) return "";
  const task = `${prompt}\n\nBegin with this opening message: ${firstMessage}`;
  return task.length <= MAX_TASK_LENGTH ? task : "";
}

function findUnsupportedTemplateBehavior(template) {
  const unsupported = [];
  if (template?.default_profile) unsupported.push("default_profile");
  if (template?.voice_model) unsupported.push("voice_model");
  if (isEnabled(template?.supports_payment) || isEnabled(template?.payment_enabled)) unsupported.push("payment_workflow");
  if (isEnabled(template?.supports_digit_capture) || isEnabled(template?.requires_otp)) unsupported.push("digit_capture_or_otp");
  if (isEnabled(template?.allow_terminator) || hasValue(template?.terminator_char)) unsupported.push("terminator_behavior");
  if (hasValue(template?.payment_connector) || hasValue(template?.payment_policy) || hasValue(template?.payment_amount)) {
    unsupported.push("payment_configuration");
  }
  if ((Array.isArray(template?.objective_tags) && template.objective_tags.length) ||
      (typeof template?.objective_tags === "string" && template.objective_tags.trim() && template.objective_tags.trim() !== "[]")) {
    unsupported.push("objective_tags_require_review");
  }

  const rawConfiguration = template?.configuration ?? template?.config_json;
  const configuration = readObject(rawConfiguration);
  if (typeof rawConfiguration === "string" && rawConfiguration.trim() && Object.keys(configuration).length === 0) {
    unsupported.push("configuration.invalid_json");
  }
  const knownNoOpKeys = new Set(["description"]);
  for (const key of Object.keys(configuration)) {
    if (!knownNoOpKeys.has(key)) unsupported.push(`configuration.${key}`);
  }
  return [...new Set(unsupported)];
}

/**
 * Build a no-call preview for the documented CALL-E Calls V2 request shape.
 * This module intentionally has no network client and never submits the request.
 */
function previewCallETemplate(template = {}, options = {}) {
  const templateId = normalizePositiveInteger(template.id ?? template.template_id);
  const templateVersion = normalizePositiveInteger(template.version ?? template.template_version);
  const number = String(options.phone || "").trim();
  const region = options.region === undefined || options.region === null || options.region === ""
    ? null
    : String(options.region).trim().toUpperCase();
  const locale = options.locale === undefined || options.locale === null || options.locale === ""
    ? null
    : String(options.locale).trim();
  const maskedPhone = maskPhone(number);
  const task = buildTask(template);
  const resultSchema = options.resultSchema;
  const schemaValidation = validateCallEResultSchema(resultSchema);
  const missing = [];
  if (!templateId) missing.push("template_id");
  if (!templateVersion) missing.push("template_version");
  if (!String(template.prompt || "").trim()) missing.push("prompt");
  if (!String(template.first_message || template.firstMessage || "").trim()) missing.push("first_message");
  if (!task && template.prompt && (template.prompt.length + String(template.first_message || template.firstMessage || "").length > MAX_TASK_LENGTH)) {
    missing.push("task_length_within_limit");
  }
  if (!maskedPhone) missing.push("valid_e164_phone");
  if (region && !/^[A-Z]{2}$/.test(region)) missing.push("valid_region_code");
  if (locale && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) missing.push("valid_locale_tag");
  if (!options.resultSchema) missing.push("result_schema");
  if (!schemaValidation.valid) missing.push("valid_result_schema");

  const unsupported = findUnsupportedTemplateBehavior(template);
  const compatible = missing.length === 0 && unsupported.length === 0;
  const fingerprint = crypto.createHash("sha256").update(stableSerialize({
    interface: "calls_v2",
    template_id: templateId,
    template_version: templateVersion,
    business_id: template.business_id ?? null,
    lifecycle_state: template.lifecycle_state ?? null,
    template_configuration: template.configuration ?? template.config_json ?? null,
    expected_length: template.expected_length ?? null,
    prompt: template.prompt ?? "",
    first_message: template.first_message ?? template.firstMessage ?? "",
    voice_model: template.voice_model ?? null,
    default_profile: template.default_profile ?? null,
    objective_tags: template.objective_tags ?? null,
    payment_enabled: template.payment_enabled ?? false,
    payment_connector: template.payment_connector ?? null,
    payment_amount: template.payment_amount ?? null,
    payment_currency: template.payment_currency ?? null,
    payment_description: template.payment_description ?? null,
    payment_policy: template.payment_policy ?? null,
    payment_start_message: template.payment_start_message ?? null,
    payment_success_message: template.payment_success_message ?? null,
    payment_failure_message: template.payment_failure_message ?? null,
    payment_retry_message: template.payment_retry_message ?? null,
    supports_payment: template.supports_payment ?? false,
    supports_digit_capture: template.supports_digit_capture ?? false,
    requires_otp: template.requires_otp ?? false,
    allow_terminator: template.allow_terminator ?? false,
    terminator_char: template.terminator_char ?? null,
    phone: number || null,
    region,
    locale,
    result_schema: resultSchema || null,
  })).digest("hex");

  return Object.freeze({
    interface: "calls_v2",
    source: Object.freeze({ templateId, templateVersion }),
    compatible,
    missing: Object.freeze([...new Set(missing)]),
    unsupported: Object.freeze(unsupported),
    schemaErrors: Object.freeze(schemaValidation.errors),
    requestSummary: Object.freeze({
      method: "POST",
      path: "/v2/calls",
      phoneMasked: maskedPhone,
      region,
      locale,
      taskPreview: task || null,
      resultProperties: Object.keys(readObject(resultSchema?.properties)),
      webhookConfigured: false,
    }),
    fingerprint,
    dispatchEnabled: false,
  });
}

module.exports = {
  buildTask,
  previewCallETemplate,
  validateCallEResult,
  validateCallEResultSchema,
};
