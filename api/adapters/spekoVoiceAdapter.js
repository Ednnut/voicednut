const { isSpekoWebhookSecret } = require("./spekoWebhookSecurity");

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const DEFAULT_BASE_URL = "https://api.speko.dev";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_COMPLETION_MESSAGES = 100;
const MAX_COMPLETION_MESSAGE_CHARS = 64000;
const MAX_COMPLETION_TOTAL_CHARS = 256000;
const CHAT_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const PHONE_SESSION_OPTION_KEYS = new Set([
  "agentVersion",
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
    this.retryable = options.retryable === true;
    this.retryAfterSeconds = Number.isFinite(Number(options.retryAfterSeconds))
      ? Math.max(0, Number(options.retryAfterSeconds))
      : null;
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

function getRequestTimeoutMs(value) {
  const configured = Number(value);
  const timeout = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, timeout));
}

function normalizeOptionalNumber(value, options = {}) {
  const number = Number(value);
  const valid = Number.isFinite(number)
    && (!options.integer || Number.isInteger(number))
    && (options.min === undefined || number >= options.min)
    && (options.max === undefined || number <= options.max);
  if (!valid) {
    throw new SpekoAdapterError(`Speko ${options.label || "numeric option"} is invalid`, {
      code: options.code || "speko_invalid_numeric_option",
      status: 400,
    });
  }
  return number;
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
      this.config.agentVersion !== undefined &&
      this.config.agentVersion !== null &&
      (!Number.isInteger(Number(this.config.agentVersion)) || Number(this.config.agentVersion) < 1)
    ) {
      throw new SpekoAdapterError("Speko agent version must be a positive integer", {
        code: "speko_invalid_agent_version",
      });
    }
    if (
      options.requireAgent !== false &&
      !String(options.agentId || this.config.agentId || "").trim()
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
          timeout: getRequestTimeoutMs(this.config.requestTimeoutMs),
          brokerId: this.config.brokerId || undefined,
        });
      });
    }
    return this.clientPromise;
  }

  async dial(options = {}) {
    const agentId = String(options.agentId || this.config.agentId || "").trim();
    this.validateConfig({ agentId });
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
      agentId,
      metadata: { voicednut_call_id: String(options.callId || "") },
    };
    const agentVersion = options.agentVersion ?? this.config.agentVersion;
    if (agentVersion !== undefined && agentVersion !== null) {
      body.agentVersion = normalizeOptionalNumber(agentVersion, {
        label: "agent version",
        code: "speko_invalid_agent_version",
        integer: true,
        min: 1,
      });
    }
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
        } else if (key === "agentVersion") {
          body.agentVersion = normalizeOptionalNumber(value, {
            label: "agent version",
            code: "speko_invalid_agent_version",
            integer: true,
            min: 1,
          });
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
    const timeoutMs = getRequestTimeoutMs(this.config.requestTimeoutMs);
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
      const errorCode = code === "IDEMPOTENCY_KEY_REUSED"
        ? "idempotency_conflict"
        : code === "IDEMPOTENCY_KEY_IN_PROGRESS"
          ? "idempotency_in_progress"
          : code === "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN"
            ? "speko_idempotency_outcome_unknown"
            : code
              ? code.toLowerCase()
              : "speko_http_error";
      const isOutcomeUnknown = [
        "IDEMPOTENCY_KEY_IN_PROGRESS",
        "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN",
      ].includes(code);
      const retryable = responseBody?.retryable === true ||
        code === "IDEMPOTENCY_KEY_IN_PROGRESS";
      throw new SpekoAdapterError(
        `Speko rejected call creation (HTTP ${response.status})`,
        {
          code: errorCode,
          status: response.status,
          uncertain:
            response.status >= 500 ||
            isOutcomeUnknown ||
            (response.status === 409 && !code),
          retryable,
          retryAfterSeconds: responseBody?.retryAfterSeconds,
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

  async findCallByInternalId(callId, options = {}) {
    const internalCallId = String(callId || "").trim();
    if (!internalCallId) {
      throw new SpekoAdapterError("A Voicednut call ID is required to reconcile Speko", {
        code: "speko_reconciliation_call_id_required",
        uncertain: true,
      });
    }
    this.validateConfig({ requireAgent: false });
    const controller = new AbortController();
    const timeoutMs = getRequestTimeoutMs(this.config.requestTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const maxPages = Math.max(1, Math.min(20, Number(options.maxPages) || 10));
      const matches = [];
      const seenCursors = new Set();
      let cursor;
      let complete = false;
      for (let page = 0; page < maxPages; page += 1) {
        const url = new URL(`${normalizeBaseUrl(this.config.baseUrl)}/v1/sessions`);
        url.searchParams.set("metadata[voicednut_call_id]", internalCallId);
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("cursor", cursor);
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
              code: String(responseBody?.code || "speko_reconciliation_unavailable").toLowerCase(),
              status: response.status,
              uncertain: true,
              retryable: responseBody?.retryable === true,
              retryAfterSeconds: responseBody?.retryAfterSeconds,
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
        matches.push(...sessions.filter((session) =>
          String(session?.metadata?.voicednut_call_id || "") === internalCallId,
        ));
        const nextCursor = String(
          responseBody?.nextCursor || responseBody?.next_cursor || "",
        ).trim();
        if (!nextCursor) {
          complete = true;
          break;
        }
        if (seenCursors.has(nextCursor)) {
          throw new SpekoAdapterError(
            "Speko returned a repeated reconciliation cursor",
            { code: "speko_reconciliation_cursor_loop", uncertain: true },
          );
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      if (!complete) {
        throw new SpekoAdapterError(
          "Speko reconciliation reached its page limit before lookup completed",
          { code: "speko_reconciliation_incomplete", uncertain: true },
        );
      }
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
      const retryWindowStartedAt = Date.parse(options.retryWindowStartedAt || "");
      if (
        Number.isFinite(retryWindowStartedAt) &&
        Date.now() - retryWindowStartedAt >= 24 * 60 * 60 * 1000
      ) {
        throw new SpekoAdapterError(
          "Speko's idempotency window has expired and no matching session was found; operator review is required",
          { code: "speko_idempotency_window_expired", uncertain: true },
        );
      }
    }
    return this.dial(options);
  }

  async preflight(options = {}) {
    const agentId = String(options.agentId || this.config.agentId || "").trim();
    this.validateConfig({ requireAgent: Boolean(agentId), agentId });
    const client = await this.getClient();
    let availableAgentCount = null;
    if (agentId) {
      const agent = await client.agents.get(agentId);
      if (!agent || String(agent.id || "") !== agentId) {
        throw new SpekoAdapterError("Selected Speko agent was not found", {
          code: "speko_agent_not_found",
        });
      }
    } else {
      const listed = await client.agents.list();
      const agents = Array.isArray(listed)
        ? listed
        : Array.isArray(listed?.agents)
          ? listed.agents
          : [];
      availableAgentCount = agents.length;
      if (availableAgentCount < 1) {
        throw new SpekoAdapterError("No Speko agents are available in this workspace", {
          code: "speko_no_agents_available",
        });
      }
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
      agentId: agentId || null,
      agentSelectionRequired: !agentId,
      availableAgentCount,
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
    const timeoutMs = getRequestTimeoutMs(this.config.requestTimeoutMs);
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

  async listVoices(params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const provider = typeof params.provider === "string"
      ? params.provider.trim().slice(0, 64)
      : "";
    const client = await this.getClient();
    return client.voices.list(provider ? { provider } : undefined);
  }

  async listKnowledgeBases(agentId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const client = await this.getClient();
    const normalizedAgentId = String(agentId || "").trim();
    return client.knowledgeBases.list(normalizedAgentId ? { agentId: normalizedAgentId } : undefined);
  }

  async createKnowledgeBase(params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const agentId = String(params.agentId || "").trim();
    const name = String(params.name || "").trim();
    if (!agentId || !name || name.length > 200) {
      throw new SpekoAdapterError("Speko knowledge-base agent ID and name are required", {
        code: "speko_invalid_knowledge_base",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.knowledgeBases.create({
      agentId,
      name,
      ...(typeof params.description === "string" && params.description.trim()
        ? { description: params.description.trim().slice(0, 2000) }
        : {}),
    });
  }

  async getKnowledgeBase(kbId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedKbId = String(kbId || "").trim();
    if (!normalizedKbId) {
      throw new SpekoAdapterError("A Speko knowledge-base ID is required", {
        code: "speko_missing_knowledge_base_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.knowledgeBases.get(normalizedKbId);
  }

  async deleteKnowledgeBase(kbId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedKbId = String(kbId || "").trim();
    if (!normalizedKbId) {
      throw new SpekoAdapterError("A Speko knowledge-base ID is required", {
        code: "speko_missing_knowledge_base_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.knowledgeBases.delete(normalizedKbId);
  }

  async listKnowledgeBaseDocuments(kbId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedKbId = String(kbId || "").trim();
    if (!normalizedKbId) {
      throw new SpekoAdapterError("A Speko knowledge-base ID is required", {
        code: "speko_missing_knowledge_base_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.knowledgeBases.listDocuments(normalizedKbId);
  }

  async getKnowledgeBaseDocument(kbId, documentId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedKbId = String(kbId || "").trim();
    const normalizedDocumentId = String(documentId || "").trim();
    if (!normalizedKbId || !normalizedDocumentId) {
      throw new SpekoAdapterError("Speko knowledge-base and document IDs are required", {
        code: "speko_missing_knowledge_document_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.knowledgeBases.getDocument(normalizedKbId, normalizedDocumentId);
  }

  async createKnowledgeBaseDocument(kbId, params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedKbId = String(kbId || "").trim();
    const filename = String(params.filename || "").trim();
    const contentType = String(params.contentType || "").trim();
    const sizeBytes = Number(params.sizeBytes);
    if (!normalizedKbId || !filename || !Number.isInteger(sizeBytes) || sizeBytes < 1) {
      throw new SpekoAdapterError("Speko knowledge-document metadata is required", {
        code: "speko_invalid_knowledge_document",
        status: 400,
      });
    }
    if (!["text/plain", "text/markdown", "text/x-markdown", "application/x-markdown"].includes(contentType)) {
      throw new SpekoAdapterError("Unsupported Speko knowledge-document content type", {
        code: "speko_knowledge_document_content_type",
        status: 400,
      });
    }
    if (sizeBytes > 4 * 1024 * 1024) {
      throw new SpekoAdapterError("Speko knowledge document exceeds the 4 MiB limit", {
        code: "speko_knowledge_document_too_large",
        status: 413,
      });
    }
    const client = await this.getClient();
    return client.knowledgeBases.createDocument(normalizedKbId, {
      filename,
      contentType,
      sizeBytes,
      ...(params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { metadata: params.metadata }
        : {}),
    });
  }

  async finalizeKnowledgeBaseDocument(kbId, documentId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedKbId = String(kbId || "").trim();
    const normalizedDocumentId = String(documentId || "").trim();
    if (!normalizedKbId || !normalizedDocumentId) {
      throw new SpekoAdapterError("Speko knowledge-base and document IDs are required", {
        code: "speko_missing_knowledge_document_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.knowledgeBases.finalizeDocument(normalizedKbId, normalizedDocumentId);
  }

  async pollKnowledgeBaseDocument(kbId, documentId, options = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedKbId = String(kbId || "").trim();
    const normalizedDocumentId = String(documentId || "").trim();
    if (!normalizedKbId || !normalizedDocumentId) {
      throw new SpekoAdapterError("Speko knowledge-base and document IDs are required", {
        code: "speko_missing_knowledge_document_id",
        status: 400,
      });
    }
    const pollOptions = {};
    for (const key of ["intervalMs", "timeoutMs"]) {
      if (options[key] === undefined) continue;
      const value = Number(options[key]);
      if (!Number.isInteger(value) || value < 100 || value > 300000) {
        throw new SpekoAdapterError(`Speko document ${key} is out of range`, {
          code: "speko_invalid_knowledge_document_poll",
          status: 400,
        });
      }
      pollOptions[key] = value;
    }
    const client = await this.getClient();
    return client.knowledgeBases.pollDocumentReady(
      normalizedKbId,
      normalizedDocumentId,
      pollOptions,
    );
  }

  async uploadKnowledgeBaseDocument(kbId, params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedKbId = String(kbId || "").trim();
    const filename = String(params.filename || "").trim();
    const contentType = String(params.contentType || "").trim();
    const data = params.data instanceof Uint8Array
      ? params.data
      : typeof params.data === "string"
        ? new TextEncoder().encode(params.data)
        : null;
    if (!normalizedKbId || !filename || !data || data.byteLength < 1) {
      throw new SpekoAdapterError("A Speko knowledge-base document payload is required", {
        code: "speko_invalid_knowledge_document",
        status: 400,
      });
    }
    if (!["text/plain", "text/markdown", "text/x-markdown", "application/x-markdown"].includes(contentType)) {
      throw new SpekoAdapterError("Unsupported Speko knowledge-document content type", {
        code: "speko_knowledge_document_content_type",
        status: 400,
      });
    }
    if (data.byteLength > 4 * 1024 * 1024) {
      throw new SpekoAdapterError("Speko knowledge document exceeds the 4 MiB limit", {
        code: "speko_knowledge_document_too_large",
        status: 413,
      });
    }
    const client = await this.getClient();
    return client.knowledgeBases.uploadDocument(normalizedKbId, {
      filename,
      contentType,
      data,
      ...(params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { metadata: params.metadata }
        : {}),
    });
  }

  async deleteKnowledgeBaseDocument(kbId, documentId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedKbId = String(kbId || "").trim();
    const normalizedDocumentId = String(documentId || "").trim();
    if (!normalizedKbId || !normalizedDocumentId) {
      throw new SpekoAdapterError("Speko knowledge-base and document IDs are required", {
        code: "speko_missing_knowledge_document_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.knowledgeBases.deleteDocument(normalizedKbId, normalizedDocumentId);
  }

  async getCreditBalance() {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const client = await this.getClient();
    return client.credits.getBalance();
  }

  async getCreditLedger(params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const query = {};
    if (params.limit !== undefined) {
      const limit = Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new SpekoAdapterError("Speko credit ledger limit must be between 1 and 100", {
          code: "speko_invalid_credit_limit",
          status: 400,
        });
      }
      query.limit = limit;
    }
    if (typeof params.cursor === "string" && params.cursor.trim()) {
      query.cursor = params.cursor.trim().slice(0, 512);
    }
    const client = await this.getClient();
    return client.credits.getLedger(Object.keys(query).length ? query : undefined);
  }

  async transcribe(audio, params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const bytes = audio instanceof Uint8Array ? audio : null;
    const language = String(params.language || "").trim();
    if (!bytes || !bytes.byteLength || !language) {
      throw new SpekoAdapterError("Speko transcription requires audio and a language", {
        code: "speko_invalid_transcription",
        status: 400,
      });
    }
    if (bytes.byteLength > 25 * 1024 * 1024) {
      throw new SpekoAdapterError("Speko transcription audio exceeds the 25 MiB limit", {
        code: "speko_transcription_too_large",
        status: 413,
      });
    }
    const client = await this.getClient();
    return client.transcribe(bytes, {
      language,
      ...(typeof params.contentType === "string" && params.contentType.trim()
        ? { contentType: params.contentType.trim().slice(0, 128) }
        : {}),
      ...(params.region ? { region: String(params.region).trim() } : {}),
      ...(params.optimizeFor ? { optimizeFor: String(params.optimizeFor).trim() } : {}),
      ...(params.sessionId ? { sessionId: String(params.sessionId).trim() } : {}),
      ...(params.keywords !== undefined
        ? {
            keywords: Array.isArray(params.keywords) && params.keywords.every((keyword) => typeof keyword === "string")
              ? params.keywords.map((keyword) => keyword.trim()).filter(Boolean).slice(0, 100)
              : (() => {
                  throw new SpekoAdapterError("Speko transcription keywords must be strings", {
                    code: "speko_invalid_transcription_keywords",
                    status: 400,
                  });
                })(),
          }
        : {}),
      ...(params.sttOptions && typeof params.sttOptions === "object" && !Array.isArray(params.sttOptions)
        ? { sttOptions: { ...(params.sttOptions.language ? { language: String(params.sttOptions.language).trim() } : {}) } }
        : {}),
      ...(params.constraints && typeof params.constraints === "object" && !Array.isArray(params.constraints)
        ? { constraints: params.constraints }
        : {}),
    });
  }

  async synthesize(text, params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedText = String(text || "").trim();
    const language = String(params.language || "").trim();
    if (!normalizedText || !language) {
      throw new SpekoAdapterError("Speko synthesis requires text and a language", {
        code: "speko_invalid_synthesis",
        status: 400,
      });
    }
    if (normalizedText.length > 12000) {
      throw new SpekoAdapterError("Speko synthesis text is too long", {
        code: "speko_synthesis_too_long",
        status: 413,
      });
    }
    const client = await this.getClient();
    return client.synthesize(normalizedText, {
      language,
      ...(params.region ? { region: String(params.region).trim() } : {}),
      ...(params.optimizeFor ? { optimizeFor: String(params.optimizeFor).trim() } : {}),
      ...(params.voice ? { voice: String(params.voice).trim() } : {}),
      ...(params.model ? { model: String(params.model).trim() } : {}),
      ...(params.speed !== undefined
        ? {
            speed: normalizeOptionalNumber(params.speed, {
              label: "synthesis speed",
              code: "speko_invalid_synthesis_speed",
              min: 0.1,
              max: 4,
            }),
          }
        : {}),
      ...(typeof params.instructions === "string" ? { instructions: params.instructions.slice(0, 2000) } : {}),
      ...(typeof params.spokenForm === "boolean" ? { spokenForm: params.spokenForm } : {}),
      ...(params.sessionId ? { sessionId: String(params.sessionId).trim() } : {}),
      ...(params.constraints && typeof params.constraints === "object" && !Array.isArray(params.constraints)
        ? { constraints: params.constraints }
        : {}),
    });
  }

  async complete(params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    if (
      !Array.isArray(params.messages) ||
      !params.messages.length ||
      params.messages.length > MAX_COMPLETION_MESSAGES
    ) {
      throw new SpekoAdapterError("Speko completion requires messages", {
        code: "speko_invalid_completion",
        status: 400,
      });
    }
    let totalMessageChars = 0;
    const messages = params.messages.map((message) => {
      if (
        !message ||
        typeof message !== "object" ||
        !CHAT_MESSAGE_ROLES.has(message.role) ||
        typeof message.content !== "string" ||
        message.content.length > MAX_COMPLETION_MESSAGE_CHARS
      ) {
        throw new SpekoAdapterError("Speko completion message is invalid", {
          code: "speko_invalid_completion_message",
          status: 400,
        });
      }
      totalMessageChars += message.content.length;
      if (totalMessageChars > MAX_COMPLETION_TOTAL_CHARS) {
        throw new SpekoAdapterError("Speko completion messages are too large", {
          code: "speko_completion_too_large",
          status: 413,
        });
      }
      if (message.role === "tool" && !String(message.toolCallId || "").trim()) {
        throw new SpekoAdapterError("Speko tool messages require a tool-call ID", {
          code: "speko_invalid_completion_message",
          status: 400,
        });
      }
      if (message.toolCalls !== undefined) {
        if (
          message.role !== "assistant" ||
          !Array.isArray(message.toolCalls) ||
          message.toolCalls.length > 32 ||
          message.toolCalls.some((toolCall) =>
            !toolCall ||
            typeof toolCall.id !== "string" ||
            !toolCall.id.trim() ||
            typeof toolCall.name !== "string" ||
            !toolCall.name.trim() ||
            typeof toolCall.args !== "string"
          )
        ) {
          throw new SpekoAdapterError("Speko completion tool calls are invalid", {
            code: "speko_invalid_completion_message",
            status: 400,
          });
        }
      }
      return {
        role: message.role,
        content: message.content,
        ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
        ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
        ...(message.isError !== undefined ? { isError: message.isError === true } : {}),
      };
    });
    const language = String(params.intent?.language || "").trim();
    if (!language) {
      throw new SpekoAdapterError("Speko completion requires a routing language", {
        code: "speko_invalid_completion_intent",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.complete({
      messages,
      intent: {
        language,
        ...(params.intent.region ? { region: String(params.intent.region).trim() } : {}),
        ...(params.intent.optimizeFor ? { optimizeFor: String(params.intent.optimizeFor).trim() } : {}),
      },
      ...(params.sessionId ? { sessionId: String(params.sessionId).trim() } : {}),
      ...(typeof params.systemPrompt === "string" ? { systemPrompt: params.systemPrompt.slice(0, 32000) } : {}),
      ...(params.temperature !== undefined
        ? {
            temperature: normalizeOptionalNumber(params.temperature, {
              label: "completion temperature",
              code: "speko_invalid_completion_temperature",
              min: 0,
              max: 2,
            }),
          }
        : {}),
      ...(params.maxTokens !== undefined
        ? {
            maxTokens: normalizeOptionalNumber(params.maxTokens, {
              label: "completion max tokens",
              code: "speko_invalid_completion_max_tokens",
              integer: true,
              min: 1,
              max: 100000,
            }),
          }
        : {}),
      ...(params.reasoningEffort !== undefined
        ? (() => {
            const value = String(params.reasoningEffort);
            if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)) {
              throw new SpekoAdapterError("Speko completion reasoning effort is invalid", {
                code: "speko_invalid_completion_reasoning_effort",
                status: 400,
              });
            }
            return { reasoningEffort: value };
          })()
        : {}),
      ...(params.constraints && typeof params.constraints === "object" && !Array.isArray(params.constraints)
        ? { constraints: params.constraints }
        : {}),
      ...(Array.isArray(params.tools) ? { tools: params.tools } : {}),
      ...(params.toolChoice !== undefined ? { toolChoice: params.toolChoice } : {}),
      ...(typeof params.parallelToolCalls === "boolean" ? { parallelToolCalls: params.parallelToolCalls } : {}),
      ...(params.maxToolHops !== undefined
        ? {
            maxToolHops: normalizeOptionalNumber(params.maxToolHops, {
              label: "completion tool-hop limit",
              code: "speko_invalid_completion_tool_hops",
              integer: true,
              min: 1,
              max: 16,
            }),
          }
        : {}),
    });
  }

  async listPhoneNumbers() {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const client = await this.getClient();
    return client.phoneNumbers.list();
  }

  async searchAvailablePhoneNumbers(params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const query = {};
    for (const key of ["areaCode", "state", "locality", "country"]) {
      if (typeof params[key] === "string" && params[key].trim()) {
        query[key] = params[key].trim().slice(0, 64);
      }
    }
    if (params.limit !== undefined) {
      const limit = Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new SpekoAdapterError("Speko available-number limit must be between 1 and 100", {
          code: "speko_invalid_phone_number_limit",
          status: 400,
        });
      }
      query.limit = limit;
    }
    const client = await this.getClient();
    return client.phoneNumbers.searchAvailable(query);
  }

  async getPhoneNumber(phoneNumberId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedId = String(phoneNumberId || "").trim();
    if (!normalizedId) {
      throw new SpekoAdapterError("A Speko phone-number ID is required", {
        code: "speko_missing_phone_number_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.phoneNumbers.get(normalizedId);
  }

  async listCallbacks(params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const query = {};
    for (const [key, aliases] of Object.entries({
      status: ["status"],
      sourceSessionId: ["sourceSessionId", "source_session_id"],
    })) {
      const value = aliases.map((alias) => params[alias]).find((candidate) => candidate !== undefined);
      if (typeof value === "string" && value.trim()) query[key] = value.trim().slice(0, 128);
    }
    if (params.limit !== undefined) {
      const limit = Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new SpekoAdapterError("Speko callback limit must be between 1 and 100", {
          code: "speko_invalid_callback_limit",
          status: 400,
        });
      }
      query.limit = limit;
    }
    const client = await this.getClient();
    return client.callbacks.list(query);
  }

  async getCallback(callbackId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedId = String(callbackId || "").trim();
    if (!normalizedId) {
      throw new SpekoAdapterError("A Speko callback ID is required", {
        code: "speko_missing_callback_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.callbacks.get(normalizedId);
  }

  async cancelCallback(callbackId, params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedId = String(callbackId || "").trim();
    if (!normalizedId) {
      throw new SpekoAdapterError("A Speko callback ID is required", {
        code: "speko_missing_callback_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.callbacks.cancel(normalizedId, params);
  }

  async dispatchCallback(callbackId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedId = String(callbackId || "").trim();
    if (!normalizedId) {
      throw new SpekoAdapterError("A Speko callback ID is required", {
        code: "speko_missing_callback_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.callbacks.dispatch(normalizedId);
  }

  async listWebhooks() {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const client = await this.getClient();
    return client.webhooks.list();
  }

  async listWebhookDeliveries(params = {}) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const query = {};
    for (const key of [
      "endpointId", "event", "agentId", "status", "sessionId", "eventId", "from", "to", "cursor",
    ]) {
      if (typeof params[key] === "string" && params[key].trim()) {
        query[key] = params[key].trim().slice(0, 512);
      }
    }
    if (params.limit !== undefined) {
      const limit = Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new SpekoAdapterError("Speko webhook-delivery limit must be between 1 and 100", {
          code: "speko_invalid_webhook_delivery_limit",
          status: 400,
        });
      }
      query.limit = limit;
    }
    const client = await this.getClient();
    return client.webhooks.deliveries.list(query);
  }

  async getWebhookDelivery(deliveryId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedId = String(deliveryId || "").trim();
    if (!normalizedId) {
      throw new SpekoAdapterError("A Speko webhook delivery ID is required", {
        code: "speko_missing_webhook_delivery_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.webhooks.deliveries.get(normalizedId);
  }

  async redeliverWebhook(deliveryId) {
    this.validateConfig({ requireWebhook: false, requireAgent: false });
    const normalizedId = String(deliveryId || "").trim();
    if (!normalizedId) {
      throw new SpekoAdapterError("A Speko webhook delivery ID is required", {
        code: "speko_missing_webhook_delivery_id",
        status: 400,
      });
    }
    const client = await this.getClient();
    return client.webhooks.deliveries.redeliver(normalizedId);
  }

  async directGet(path, params = {}) {
    this.validateApiConfig();
    const url = new URL(`${normalizeBaseUrl(this.config.baseUrl)}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null && item !== "") {
            url.searchParams.append(key, String(item));
          }
        }
        continue;
      }
      if (typeof value === "object") {
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          if (nestedValue !== undefined && nestedValue !== null && nestedValue !== "") {
            url.searchParams.set(`${key}[${nestedKey}]`, String(nestedValue));
          }
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    const timeoutMs = getRequestTimeoutMs(this.config.requestTimeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new SpekoAdapterError(
          body?.error || `Speko GET ${path} failed`,
          {
            code: String(body?.code || "speko_http_error").toLowerCase(),
            status: response.status,
            uncertain: response.status >= 500,
          },
        );
      }
      return body;
    } catch (error) {
      if (error instanceof SpekoAdapterError) throw error;
      throw new SpekoAdapterError("Speko read request failed", {
        code: error?.name === "AbortError" ? "speko_read_timeout" : "speko_read_network_error",
        uncertain: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async listSessions(params = {}) {
    const query = {};
    for (const key of [
      "cursor", "status", "outcome", "kind", "agent", "from", "to", "channel",
      "phoneNumberId", "whatsappNumberId", "q", "qScope", "gate",
    ]) {
      if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
        query[key] = params[key];
      }
    }
    if (params.limit !== undefined) {
      const limit = Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new SpekoAdapterError("Speko session limit must be between 1 and 100", {
          code: "speko_invalid_session_limit",
          status: 400,
        });
      }
      query.limit = limit;
    }
    if (params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)) {
      query.metadata = params.metadata;
    }
    return this.directGet("/v1/sessions", query);
  }

  async getSession(sessionId) {
    const normalizedId = String(sessionId || "").trim();
    if (!normalizedId) {
      throw new SpekoAdapterError("A Speko session ID is required", {
        code: "speko_missing_session_id",
        status: 400,
      });
    }
    return this.directGet(`/v1/sessions/${encodeURIComponent(normalizedId)}`);
  }

  // Kept as an adapter-level alias for existing callers. The SDK's verified
  // catalogue endpoint is /v1/voices; there is no separate TTS-model endpoint
  // in @spekoai/sdk 0.5.7.
  async listTtsVoices(params = {}) {
    return this.listVoices(params);
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
  getRequestTimeoutMs,
  isE164,
  normalizeBaseUrl,
};
