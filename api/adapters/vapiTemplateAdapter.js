const crypto = require("node:crypto");

const SUPPORTED_FIELDS = ["prompt", "firstMessage", "voice"];

function stableSerialize(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprintVapiTemplateMapping(template, model, voice, serverConfiguration = null) {
  return crypto.createHash("sha256")
    .update(stableSerialize({
      template: {
        id: template?.id || null,
        version: template?.version || null,
        name: template?.name || null,
        description: template?.description ?? null,
        prompt: template?.prompt ?? null,
        first_message: template?.first_message ?? null,
        business_id: template?.business_id ?? null,
        voice_model: template?.voice_model ?? null,
        objective_tags: template?.objective_tags ?? null,
        supports_payment: template?.supports_payment ?? null,
        supports_digit_capture: template?.supports_digit_capture ?? null,
        requires_otp: template?.requires_otp ?? null,
        payment_enabled: template?.payment_enabled ?? null,
        payment_connector: template?.payment_connector ?? null,
        payment_amount: template?.payment_amount ?? null,
        payment_currency: template?.payment_currency ?? null,
        payment_description: template?.payment_description ?? null,
        payment_policy: template?.payment_policy ?? null,
        payment_start_message: template?.payment_start_message ?? null,
        payment_success_message: template?.payment_success_message ?? null,
        payment_failure_message: template?.payment_failure_message ?? null,
        payment_retry_message: template?.payment_retry_message ?? null,
        default_profile: template?.default_profile ?? null,
        expected_length: template?.expected_length ?? null,
        allow_terminator: template?.allow_terminator ?? null,
        terminator_char: template?.terminator_char ?? null,
      },
      model: model || null,
      voice: voice || null,
      server: serverConfiguration || null,
    }))
    .digest("hex");
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

function containsCredentialLikeField(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) =>
    /(?:api[_-]?key|secret|token|credential)/i.test(key) ||
    containsCredentialLikeField(nested),
  );
}

function mapCallTemplateToVapiAssistant(template = {}) {
  const configuration = readObject(template.configuration || template.config_json);
  const prompt = String(template.prompt || configuration.prompt || "").trim();
  const firstMessage = String(
    template.first_message || template.firstMessage || configuration.firstMessage || "",
  ).trim();
  const vapiSettings = readObject(configuration.vapi);
  const unsupported = [];
  const assistant = {};

  for (const key of ["tools", "knowledge", "transfer", "structuredOutput", "squad"]) {
    if (configuration[key] !== undefined && configuration[key] !== null) unsupported.push(key);
  }
  const understoodConfigurationKeys = new Set([
    "prompt",
    "firstMessage",
    "voice",
    "vapi",
    "tools",
    "knowledge",
    "transfer",
    "structuredOutput",
    "squad",
  ]);
  for (const key of Object.keys(configuration)) {
    if (!understoodConfigurationKeys.has(key)) unsupported.push(`configuration.${key}`);
  }
  if (template.call_flow || template.flow_type) unsupported.push("call_flow");
  if (template.voice_model) unsupported.push("voice_model_mapping");
  if (template.supports_payment || template.payment_enabled) unsupported.push("payment_workflow");
  if (template.supports_digit_capture || template.requires_otp) unsupported.push("digit_capture");
  if (template.payment_connector || template.payment_policy) unsupported.push("payment_configuration");
  if (template.default_profile) unsupported.push("conversation_profile");
  if (template.allow_terminator || template.terminator_char) unsupported.push("terminator_behavior");
  if (Array.isArray(template.objective_tags) && template.objective_tags.length) {
    unsupported.push("objective_flow");
  }
  const voice = readObject(vapiSettings.voice);
  if (configuration.voice || template.voice || vapiSettings.voice) {
    if (!voice.provider || !voice.voiceId) unsupported.push("voice_mapping");
    else {
      const unhandledVoiceFields = Object.keys(voice).filter(
        (key) => !["provider", "voiceId"].includes(key),
      );
      if (unhandledVoiceFields.length) unsupported.push("voice_settings_fields");
      assistant.voice = { provider: voice.provider, voiceId: voice.voiceId };
    }
  }
  if (template.provider && String(template.provider).toLowerCase() !== "vapi") {
    unsupported.push("provider_specific_behavior");
  }

  const model = readObject(vapiSettings.model);
  if (prompt && model.provider && model.model) {
    const unhandledModelFields = Object.keys(model).filter(
      (key) => !["provider", "model", "messages"].includes(key),
    );
    if (unhandledModelFields.length) unsupported.push("model_settings_fields");
    const validMessages = !Array.isArray(model.messages) || model.messages.every(
      (message) => message && typeof message === "object" && !Array.isArray(message) &&
        typeof message.role === "string" && typeof message.content === "string",
    );
    if (!validMessages) unsupported.push("model.messages");
    assistant.model = {
      provider: model.provider,
      model: model.model,
      messages: validMessages && Array.isArray(model.messages)
        ? [{ role: "system", content: prompt }, ...model.messages.filter((message) => message?.role !== "system")]
        : [{ role: "system", content: prompt }],
    };
  }
  if (firstMessage) assistant.firstMessage = firstMessage;

  return {
    compatible: unsupported.length === 0 && Boolean(prompt && firstMessage && assistant.model && assistant.voice),
    unsupported: [...new Set(unsupported)],
    missing: [
      !prompt ? "prompt" : null,
      !firstMessage ? "firstMessage" : null,
      prompt && !assistant.model ? "vapi.model" : null,
      !assistant.voice ? "vapi.voice" : null,
    ].filter(Boolean),
    assistant,
    mappedFields: Object.keys(assistant),
    sourceTemplateId: template.id || template.template_id || null,
    sourceTemplateVersion: template.version || template.template_version || null,
    supportedFields: SUPPORTED_FIELDS,
  };
}

module.exports = {
  containsCredentialLikeField,
  mapCallTemplateToVapiAssistant,
  fingerprintVapiTemplateMapping,
};
