const { isSpekoWebhookSecret } = require("./spekoWebhookSecurity");

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const DEFAULT_BASE_URL = "https://api.speko.dev";
const DEFAULT_TIMEOUT_MS = 30000;
const PHONE_SESSION_OPTION_KEYS = new Set([
  "constraints",
  "voice",
  "llm",
  "ttsOptions",
  "sttOptions",
  "turnHandling",
  "telephony",
  "timezone",
  "variables",
  "toolSecrets",
  "metadata",
  "webhookTags",
]);
const NESTED_PHONE_SESSION_OPTION_KEYS = Object.freeze({
  llm: new Set(["temperature", "maxTokens", "reasoningEffort"]),
  ttsOptions: new Set(["sampleRate", "speed"]),
  sttOptions: new Set(["keywords", "prompt", "language"]),
  turnHandling: new Set([
    "vad",
    "noiseCancellation",
    "profile",
    "endpointing",
    "interruption",
    "turnDetection",
    "contextThreshold",
    "heardBy",
    "keypad",
    "keypadAllowedKeys",
    "recordCallerKeypad",
    "greetFirst",
    "amdPrompt",
    "onMachine",
    "onHuman",
    "voicemailMessage",
    "voicemailSoundId",
    "holdTimeoutSeconds",
    "machineBudgetSeconds",
  ]),
  vad: new Set(["provider"]),
  noiseCancellation: new Set(["enabled", "model"]),
  endpointing: new Set(["minDelay", "maxDelay"]),
  interruption: new Set(["mode", "minDuration", "minWords"]),
  telephony: new Set(["region", "amd", "dtmf"]),
  amd: new Set(["mode", "timeoutSeconds"]),
});
const AGENT_DRAFT_FIELDS = new Set([
  "name",
  "systemPrompt",
  "voice",
  "voiceInstructions",
  "firstMessage",
  "inboundFirstMessage",
  "outboundFirstMessage",
  "timezone",
  "intent",
  "llmOptions",
  "stackPreferences",
  "sttOptions",
  "ttsOptions",
  "runMode",
  "runtime",
  "backgroundAudio",
  "audioOutput",
  "speechNormalization",
  "idleRePrompts",
  "sttMissRecovery",
  "turnHandling",
  "languageRouting",
]);

function validateNestedPhoneSessionOptions(options = {}) {
  for (const [key, value] of Object.entries(options)) {
    if (!NESTED_PHONE_SESSION_OPTION_KEYS[key]) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SpekoAdapterError(`Speko ${key} option must be an object`, {
        code: "speko_invalid_options",
        status: 400,
      });
    }
    for (const nestedKey of Object.keys(value)) {
      if (!NESTED_PHONE_SESSION_OPTION_KEYS[key].has(nestedKey)) {
        throw new SpekoAdapterError(
          `Unsupported Speko ${key} option: ${nestedKey}`,
          { code: "speko_unsupported_option", status: 400 },
        );
      }
    }
    if (key === "telephony" && value.amd !== undefined) {
      validateNestedPhoneSessionOptions({ amd: value.amd });
    }
    if (key === "turnHandling") {
      for (const nestedKey of ["endpointing", "interruption", "vad", "noiseCancellation"]) {
        if (value[nestedKey] !== undefined) {
          validateNestedPhoneSessionOptions({ [nestedKey]: value[nestedKey] });
        }
      }
    }
  }
}

class SpekoAdapterError extends Error {
  constructor(message, options = {}) {
    super(message || "Speko request failed");
    this.name = "SpekoAdapterError";
    this.code = options.code || "speko_request_failed";
    this.status = Number.isFinite(Number(options.status))
      ? Number(options.status)
      : null;
    this.uncertain = options.uncertain === true;
  }
}

function isE164(value) {
  return E164_PATTERN.test(String(value || "").trim());
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("SPEKO_BASE_URL must use HTTPS");
  }
  return url.toString().replace(/\/+$/, "");
}

class SpekoVoiceAdapter {
  constructor(options = {}) {
    this.config = options.config || {};
    this.fetch = options.fetch || globalThis.fetch;
    this.clientFactory = options.clientFactory || null;
    this.sdkLoader = options.sdkLoader || (() => import("@spekoai/sdk"));
    this.clientPromise = null;
    if (typeof this.fetch !== "function") {
      throw new Error("A fetch implementation is required for Speko");
    }
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  validateApiConfig() {
    normalizeBaseUrl(this.config.baseUrl);
    if (!this.isEnabled()) {
      throw new SpekoAdapterError("Speko is disabled", {
        code: "speko_disabled",
      });
    }
    if (!String(this.config.apiKey || "").trim()) {
      throw new SpekoAdapterError("Speko API key is not configured", {
        code: "speko_missing_api_key",
      });
    }
    return true;
  }

  validateConfig(options = {}) {
    this.validateApiConfig();
    if (
      options.requireAgent !== false &&
      !String(this.config.agentId || "").trim()
    ) {
      throw new SpekoAdapterError("Speko agent ID is not configured", {
        code: "speko_missing_agent_id",
      });
    }
    if (this.config.phoneNumber && !isE164(this.config.phoneNumber)) {
      throw new SpekoAdapterError(
        "Speko caller number must be a valid E.164 number",
        { code: "speko_invalid_phone_number" },
      );
    }
    if (
      Number(this.config.maxDurationSeconds) < 30 ||
      Number(this.config.maxDurationSeconds) > 14400
    ) {
      throw new SpekoAdapterError(
        "Speko maximum duration must be between 30 and 14400 seconds",
        { code: "speko_invalid_max_duration" },
      );
    }
    if (
      Number(this.config.ringTimeoutSeconds) < 20 ||
      Number(this.config.ringTimeoutSeconds) > 45
    ) {
      throw new SpekoAdapterError(
        "Speko ring timeout must be between 20 and 45 seconds",
        { code: "speko_invalid_ring_timeout" },
      );
    }
    if (
      options.requireWebhook !== false &&
      !isSpekoWebhookSecret(this.config.webhookSecret)
    ) {
      throw new SpekoAdapterError("Speko webhook secret is not configured", {
        code: "speko_missing_webhook_secret",
      });
    }
    return true;
  }

  async getClient() {
    if (!this.clientPromise) {
      this.clientPromise = Promise.resolve().then(async () => {
        if (this.clientFactory) return this.clientFactory(this.config);
        const sdk = await this.sdkLoader();
        return new sdk.Speko({
          apiKey: this.config.apiKey,
          baseUrl: normalizeBaseUrl(this.config.baseUrl),
          timeout: this.config.requestTimeoutMs || DEFAULT_TIMEOUT_MS,
          brokerId: this.config.brokerId || undefined,
        });
      });
    }
    return this.clientPromise;
  }

  async dial(options = {}) {
    this.validateConfig();
    if (!isE164(options.to)) {
      throw new SpekoAdapterError("Destination must be a valid E.164 number", {
        code: "speko_invalid_destination",
        status: 400,
      });
    }
    const idempotencyKey = String(options.idempotencyKey || "").trim();
    if (!idempotencyKey) {
      throw new SpekoAdapterError(
        "An idempotency key is required for Speko calls",
        { code: "speko_idempotency_key_required", status: 400 },
      );
    }

    const body = {
      to: String(options.to).trim(),
      agentId: this.config.agentId,
      metadata: { voicednut_call_id: String(options.callId || "") },
    };
    const systemPrompt = String(options.systemPrompt || "").trim();
    const firstMessage = String(options.firstMessage || "").trim();
    if (systemPrompt) body.systemPrompt = systemPrompt;
    if (firstMessage) body.firstMessage = firstMessage;
    const phoneSessionOptions = options.spekoOptions;
    if (
      phoneSessionOptions !== undefined &&
      (!phoneSessionOptions ||
        typeof phoneSessionOptions !== "object" ||
        Array.isArray(phoneSessionOptions))
    ) {
      throw new SpekoAdapterError("Speko options must be an object", {
        code: "speko_invalid_options",
        status: 400,
      });
    }
    for (const [key, value] of Object.entries(phoneSessionOptions || {})) {
      if (!PHONE_SESSION_OPTION_KEYS.has(key)) {
        throw new SpekoAdapterError(`Unsupported Speko phone option: ${key}`, {
          code: "speko_unsupported_option",
          status: 400,
        });
      }
      if (value !== undefined && value !== null) {
        if (key === "metadata") {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new SpekoAdapterError("Speko metadata option must be an object", {
              code: "speko_invalid_options",
              status: 400,
            });
          }
          body.metadata = { ...(body.metadata || {}), ...value };
        } else {
          body[key] = value;
        }
      }
    }
    validateNestedPhoneSessionOptions(body);
    body.metadata = {
      ...(body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata
        : {}),
      voicednut_call_id: String(options.callId || ""),
    };
    if (this.config.phoneNumber) body.from = this.config.phoneNumber;
    if (Number.isFinite(Number(this.config.maxDurationSeconds))) {
      body.maxDurationSeconds = Math.floor(Number(this.config.maxDurationSeconds));
    }
    if (Number.isFinite(Number(this.config.ringTimeoutSeconds))) {
      body.ringTimeoutSeconds = Math.floor(Number(this.config.ringTimeoutSeconds));
    }
    const timeoutMs = Math.max(
      1000,
      Number(this.config.requestTimeoutMs) || DEFAULT_TIMEOUT_MS,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let responseBody;
    try {
      response = await this.fetch(
        `${normalizeBaseUrl(this.config.baseUrl)}/v1/sessions/phone`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      responseBody = await response.json().catch(() => null);
    } catch (error) {
      throw new SpekoAdapterError(
        "Speko call creation outcome is unknown; retry with the same idempotency key",
        {
          code: error?.name === "AbortError"
            ? "speko_dial_timeout"
            : "speko_dial_network_error",
          uncertain: true,
        },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const code = String(responseBody?.code || responseBody?.error || "")
        .trim()
        .toUpperCase();
      const errorCode =
        code === "IDEMPOTENCY_KEY_REUSED"
          ? "idempotency_conflict"
          : code || "speko_http_error";
      const isOutcomeUnknown = [
        "IDEMPOTENCY_KEY_IN_PROGRESS",
        "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN",
      ].includes(code);
      throw new SpekoAdapterError(
        `Speko rejected call creation (HTTP ${response.status})`,
        {
          code: errorCode,
          status: response.status,
          uncertain:
            response.status >= 500 ||
            isOutcomeUnknown ||
            (response.status === 409 && !code),
        },
      );
    }

    if (!responseBody?.sessionId) {
      throw new SpekoAdapterError(
        "Speko returned no session ID; call creation outcome is unknown",
        { code: "speko_missing_session_id", uncertain: true },
      );
    }

    return {
      sessionId: String(responseBody.sessionId),
      status: String(responseBody.status || "dialing"),
      raw: responseBody,
    };
  }

  async findCallByInternalId(callId) {
    const internalCallId = String(callId || "").trim();
    if (!internalCallId) {
      throw new SpekoAdapterError("A Voicednut call ID is required to reconcile Speko", {
        code: "speko_reconciliation_call_id_required",
        uncertain: true,
      });
    }
    this.validateConfig();
    const url = new URL(`${normalizeBaseUrl(this.config.baseUrl)}/v1/sessions`);
    url.searchParams.set("metadata[voicednut_call_id]", internalCallId);
    url.searchParams.set("limit", "100");
    const controller = new AbortController();
    const timeoutMs = Math.max(
      1000,
      Number(this.config.requestTimeoutMs) || DEFAULT_TIMEOUT_MS,
    );
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        signal: controller.signal,
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new SpekoAdapterError(
          `Speko call reconciliation failed (HTTP ${response.status})`,
          {
            code: "speko_reconciliation_unavailable",
            status: response.status,
            uncertain: true,
          },
        );
      }
      const sessions = Array.isArray(responseBody)
        ? responseBody
        : [responseBody?.sessions, responseBody?.items, responseBody?.data].find(
            Array.isArray,
          );
      if (!sessions) {
        throw new SpekoAdapterError(
          "Speko returned an unrecognized call reconciliation response",
          { code: "speko_reconciliation_invalid_response", uncertain: true },
        );
      }
      const matches = sessions.filter(
        (session) =>
          String(session?.metadata?.voicednut_call_id || "") === internalCallId,
      );
      if (matches.length > 1) {
        throw new SpekoAdapterError(
          "Multiple Speko sessions match this Voicednut call; manual reconciliation is required",
          { code: "speko_reconciliation_conflict", uncertain: true },
        );
      }
      if (!matches.length) return null;
      const session = matches[0];
      const sessionId = String(session?.sessionId || session?.session_id || session?.id || "").trim();
      if (!sessionId) {
        throw new SpekoAdapterError(
          "The matching Speko session has no session ID",
          { code: "speko_reconciliation_missing_session_id", uncertain: true },
        );
      }
      return {
        sessionId,
        status: String(session?.status || "dialing"),
        raw: session,
        recovered: true,
      };
    } catch (error) {
      if (error instanceof SpekoAdapterError) throw error;
      throw new SpekoAdapterError(
        "Speko call reconciliation outcome is unknown; retry the same request later",
        {
          code: error?.name === "AbortError"
            ? "speko_reconciliation_timeout"
            : "speko_reconciliation_network_error",
          uncertain: true,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async createOrRecoverCall(options = {}) {
    if (options.reconcile === true) {
      const recovered = await this.findCallByInternalId(options.callId);
      if (recovered) return recovered;
    }
    return this.dial(options);
  }

  async preflight() {
    this.validateConfig();
    const client = await this.getClient();
    const agent = await client.agents.get(this.config.agentId);
    if (!agent || String(agent.id || "") !== String(this.config.agentId)) {
      throw new SpekoAdapterError("Configured Speko agent was not found", {
        code: "speko_agent_not_found",
      });
    }
    const configuredNumber = this.config.phoneNumber;
    if (configuredNumber) {
      const phoneNumbers = await client.phoneNumbers.list();
      const ownedNumber = (Array.isArray(phoneNumbers) ? phoneNumbers : []).some(
        (number) => String(number?.e164 || "").trim() === configuredNumber,
      );
      if (!ownedNumber) {
        throw new SpekoAdapterError(
          "Configured Speko caller number is not available in the workspace",
          { code: "speko_phone_number_unavailable" },
        );
      }
    }
    return {
      agentId: this.config.agentId,
      phoneNumberConfigured: Boolean(configuredNumber),
    };
  }

  async getCall(sessionId) {
    const client = await this.getClient();
    return client.calls.get(String(sessionId));
  }

  async getCallEvents(sessionId) {
    const client = await this.getClient();
    const response = await client.calls.events(String(sessionId));
    if (!Array.isArray(response?.events)) {
      throw new SpekoAdapterError(
        "Speko returned an invalid call event history",
        { code: "speko_call_events_invalid_response", uncertain: true },
      );
    }
    return response.events;
  }

  async getUsage(options = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const params = {};
    if (options.from !== undefined) params.from = String(options.from).trim();
    if (options.to !== undefined) params.to = String(options.to).trim();
    const client = await this.getClient();
    return client.usage.get(Object.keys(params).length ? params : undefined);
  }

  async listAgents() {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const client = await this.getClient();
    return client.agents.list();
  }

  async getAgent(agentId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) {
      throw new SpekoAdapterError("Speko agent ID is required", {
        code: "speko_missing_agent_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.get(normalizedAgentId);
  }

  async listAgentTools(agentId, options = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) {
      throw new SpekoAdapterError("Speko agent ID is required", {
        code: "speko_missing_agent_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.tools.list(
      normalizedAgentId,
      options.signal,
      { available: options.available === true },
    );
  }

  async createAgent(params) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new SpekoAdapterError("Speko agent parameters are required", {
        code: "speko_invalid_agent_params",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.create(params);
  }

  async updateAgent(agentId, params) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) {
      throw new SpekoAdapterError("Speko agent ID is required", {
        code: "speko_missing_agent_id",
        status: 400,
      });
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new SpekoAdapterError("Speko agent parameters are required", {
        code: "speko_invalid_agent_params",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.update(normalizedAgentId, params);
  }

  async deleteAgent(agentId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) {
      throw new SpekoAdapterError("Speko agent ID is required", {
        code: "speko_missing_agent_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.delete(normalizedAgentId);
  }

  async requestAgentLifecycle(agentId, suffix, options = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) {
      throw new SpekoAdapterError("Speko agent ID is required", {
        code: "speko_missing_agent_id",
        status: 400,
      });
    }
    const method = String(options.method || "GET").toUpperCase();
    const timeoutMs = Math.min(
      Math.max(Number(this.config.requestTimeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
      120000,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(
        `${normalizeBaseUrl(this.config.baseUrl)}/v1/agents/${encodeURIComponent(normalizedAgentId)}/${suffix}`,
        {
          method,
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        },
      );
      let payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
      if (!response.ok) {
        throw new SpekoAdapterError(
          payload?.error || `Speko agent ${suffix} request failed`,
          {
            code: String(payload?.code || `speko_agent_${suffix}_failed`).toLowerCase(),
            status: response.status,
          },
        );
      }
      return payload;
    } catch (error) {
      if (error instanceof SpekoAdapterError) throw error;
      throw new SpekoAdapterError(`Speko agent ${suffix} request failed`, {
        code: error?.name === "AbortError"
          ? "speko_agent_request_timeout"
          : "speko_agent_request_failed",
        uncertain: method !== "GET" && method !== "DELETE",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAgentDraft(agentId) {
    return this.requestAgentLifecycle(agentId, "draft");
  }

  async updateAgentDraft(agentId, params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new SpekoAdapterError("Speko agent draft must be an object", {
        code: "speko_invalid_agent_draft",
        status: 400,
      });
    }
    const keys = Object.keys(params);
    if (!keys.length || keys.some((key) => !AGENT_DRAFT_FIELDS.has(key))) {
      throw new SpekoAdapterError("Speko agent draft contains unsupported fields", {
        code: "speko_unsupported_agent_draft_field",
        status: 400,
      });
    }
    return this.requestAgentLifecycle(agentId, "draft", {
      method: "PUT",
      body: params,
    });
  }

  async discardAgentDraft(agentId) {
    return this.requestAgentLifecycle(agentId, "draft", { method: "DELETE" });
  }

  async listAgentVersions(agentId) {
    return this.requestAgentLifecycle(agentId, "versions");
  }

  async deployAgentDraft(agentId) {
    return this.requestAgentLifecycle(agentId, "deploy", { method: "POST", body: {} });
  }

  async rollbackAgent(agentId, targetVersionNumber) {
    const version = Number(targetVersionNumber);
    if (!Number.isInteger(version) || version < 1) {
      throw new SpekoAdapterError("A valid Speko target version is required", {
        code: "speko_invalid_agent_version",
        status: 400,
      });
    }
    return this.requestAgentLifecycle(agentId, "rollback", {
      method: "POST",
      body: { target_version_number: version },
    });
  }

  async listAgentCalls(agentId, params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) {
      throw new SpekoAdapterError("Speko agent ID is required", {
        code: "speko_missing_agent_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.listCalls(normalizedAgentId, params);
  }

  async createAgentTool(agentId, params) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) {
      throw new SpekoAdapterError("Speko agent ID is required", {
        code: "speko_missing_agent_id",
        status: 400,
      });
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new SpekoAdapterError("Speko tool parameters are required", {
        code: "speko_invalid_tool_params",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.tools.create(normalizedAgentId, params);
  }

  async getAgentTool(agentId, toolId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    const normalizedToolId = String(toolId || "").trim();
    if (!normalizedAgentId || !normalizedToolId) {
      throw new SpekoAdapterError("Speko agent and tool IDs are required", {
        code: "speko_missing_tool_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.tools.get(normalizedAgentId, normalizedToolId);
  }

  async updateAgentTool(agentId, toolId, params) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    const normalizedToolId = String(toolId || "").trim();
    if (!normalizedAgentId || !normalizedToolId) {
      throw new SpekoAdapterError("Speko agent and tool IDs are required", {
        code: "speko_missing_tool_id",
        status: 400,
      });
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new SpekoAdapterError("Speko tool parameters are required", {
        code: "speko_invalid_tool_params",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.tools.update(
      normalizedAgentId,
      normalizedToolId,
      params,
    );
  }

  async deleteAgentTool(agentId, toolId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedAgentId = String(agentId || "").trim();
    const normalizedToolId = String(toolId || "").trim();
    if (!normalizedAgentId || !normalizedToolId) {
      throw new SpekoAdapterError("Speko agent and tool IDs are required", {
        code: "speko_missing_tool_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.agents.tools.delete(normalizedAgentId, normalizedToolId);
  }

  async endCall(sessionId) {
    const client = await this.getClient();
    return client.calls.end(String(sessionId));
  }

  async blindTransfer(sessionId, params = {}) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      throw new SpekoAdapterError("A Speko session ID is required", {
        code: "speko_missing_session_id",
        status: 400,
      });
    }
    if (!isE164(params.to)) {
      throw new SpekoAdapterError("Speko transfer destination must be E.164", {
        code: "speko_invalid_transfer_destination",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.calls.blindTransfer(normalizedSessionId, {
      to: String(params.to).trim(),
      ...(params.participantIdentity ? { participantIdentity: String(params.participantIdentity) } : {}),
      ...(typeof params.playDialtone === "boolean" ? { playDialtone: params.playDialtone } : {}),
      ...(Number.isInteger(params.ringingTimeout) ? { ringingTimeout: params.ringingTimeout } : {}),
      ...(params.headers && typeof params.headers === "object" ? { headers: params.headers } : {}),
    });
  }

  async warmTransfer(sessionId, params = {}) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) {
      throw new SpekoAdapterError("A Speko session ID is required", {
        code: "speko_missing_session_id",
        status: 400,
      });
    }
    if (!params.to && !Array.isArray(params.destinations)) {
      throw new SpekoAdapterError("Speko warm transfer requires a destination", {
        code: "speko_invalid_transfer_destination",
        status: 400,
      });
    }
    if (params.to && !isE164(params.to)) {
      throw new SpekoAdapterError("Speko transfer destination must be E.164", {
        code: "speko_invalid_transfer_destination",
        status: 400,
      });
    }
    if (Array.isArray(params.destinations)) {
      if (
        !params.destinations.length ||
        params.destinations.some((item) => !isE164(item?.to))
      ) {
        throw new SpekoAdapterError("Every Speko warm transfer destination must be E.164", {
          code: "speko_invalid_transfer_destination",
          status: 400,
        });
      }
    }
    const client = await this.getClient();
    return client.calls.warmTransfer(normalizedSessionId, params);
  }

  async completeWarmTransfer(sessionId, transferId, params = {}) {
    const normalizedSessionId = String(sessionId || "").trim();
    const normalizedTransferId = String(transferId || "").trim();
    if (!normalizedSessionId || !normalizedTransferId) {
      throw new SpekoAdapterError("Speko session and transfer IDs are required", {
        code: "speko_missing_transfer_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.calls.completeWarmTransfer(
      normalizedSessionId,
      normalizedTransferId,
      params,
    );
  }

  async cancelWarmTransfer(sessionId, transferId, params = {}) {
    const normalizedSessionId = String(sessionId || "").trim();
    const normalizedTransferId = String(transferId || "").trim();
    if (!normalizedSessionId || !normalizedTransferId) {
      throw new SpekoAdapterError("Speko session and transfer IDs are required", {
        code: "speko_missing_transfer_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.calls.cancelWarmTransfer(
      normalizedSessionId,
      normalizedTransferId,
      params,
    );
  }

  async getTranscript(sessionId) {
    const client = await this.getClient();
    return client.sessions.transcript(String(sessionId));
  }

  async getRecording(sessionId) {
    const client = await this.getClient();
    return client.calls.recording(String(sessionId));
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  SpekoAdapterError,
  SpekoVoiceAdapter,
  isE164,
  normalizeBaseUrl,
};
