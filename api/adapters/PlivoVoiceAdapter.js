const fetch = require("node-fetch");
const { runWithTimeout } = require("../utils/asyncControl");

function isValidHttpsUrl(value) {
  if (!value || typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function maskPhoneForLog(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length <= 4) return "*".repeat(digits.length);
  return `${"*".repeat(Math.max(2, digits.length - 4))}${digits.slice(-4)}`;
}

function normalizePositiveInteger(value, fallback, { min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  if (normalized < min) return fallback;
  return normalized;
}

function sanitizePhoneNumber(value, label) {
  const normalized = String(value || "")
    .trim()
    .replace(/[\s()-]/g, "");
  if (!normalized || !/^\+?[0-9]{7,15}$/.test(normalized)) {
    throw new Error(`PlivoVoiceAdapter requires a valid ${label} number`);
  }
  return normalized;
}

function isRetriableStatus(statusCode) {
  if (!Number.isFinite(Number(statusCode))) return false;
  const normalized = Number(statusCode);
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(normalized);
}

function isRetriableNetworkCode(code) {
  const normalized = String(code || "").trim().toLowerCase();
  if (!normalized) return false;
  return new Set([
    "operation_timeout",
    "plivo_provider_timeout",
    "etimedout",
    "esockettimedout",
    "econnreset",
    "econnaborted",
    "econnrefused",
    "enotfound",
    "eai_again",
    "network_error",
    "fetcherror",
  ]).has(normalized);
}

function buildRetryDelayMs(baseMs, maxDelayMs, jitterMs, retryNumber) {
  const exponent = Math.max(0, Number(retryNumber) - 1);
  const withoutJitter = baseMs * (2 ** exponent);
  const jitter = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs + 1)) : 0;
  return Math.max(0, Math.min(maxDelayMs, withoutJitter + jitter));
}

function sleepMs(delayMs) {
  const normalized = normalizePositiveInteger(delayMs, 0);
  if (!normalized) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, normalized);
    if (typeof timer?.unref === "function") {
      timer.unref();
    }
  });
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractPlivoCallUuid(response) {
  const candidates = [
    response?.call_uuid,
    response?.uuid,
    Array.isArray(response?.call_uuid) ? response.call_uuid[0] : null,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }
  return null;
}

class PlivoVoiceAdapter {
  constructor(config = {}, logger = console) {
    const { authId, authToken, apiBaseUrl, voice = {} } = config;
    if (!authId || !authToken) {
      throw new Error("PlivoVoiceAdapter requires authId and authToken");
    }

    this.logger = logger;
    this.authId = String(authId || "").trim();
    this.authToken = String(authToken || "").trim();
    this.apiBaseUrl = String(apiBaseUrl || "https://api.plivo.com").replace(/\/+$/, "");
    this.fetch = config.fetch || fetch;
    this.fromNumber = String(voice.fromNumber || "").trim();
    this.answerUrlOverride = voice.answerUrl;
    this.eventUrlOverride = voice.eventUrl;
    const timeoutMs = Number(voice.requestTimeoutMs || config.requestTimeoutMs);
    this.requestTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
    this.retryAttempts = normalizePositiveInteger(
      voice.retryAttempts ?? config.retryAttempts,
      1,
      { min: 0 },
    );
    this.createRetryAttempts = normalizePositiveInteger(
      voice.createRetryAttempts ?? config.createRetryAttempts,
      0,
      { min: 0 },
    );
    this.retryBaseMs = normalizePositiveInteger(
      voice.retryBaseMs ?? config.retryBaseMs,
      250,
      { min: 0 },
    );
    this.retryMaxDelayMs = normalizePositiveInteger(
      voice.retryMaxDelayMs ?? config.retryMaxDelayMs,
      2000,
      { min: 0 },
    );
    this.retryJitterMs = normalizePositiveInteger(
      voice.retryJitterMs ?? config.retryJitterMs,
      120,
      { min: 0 },
    );
  }

  isConfigured() {
    return !!(this.authId && this.authToken && this.fromNumber);
  }

  buildAuthHeader() {
    const token = Buffer.from(`${this.authId}:${this.authToken}`).toString("base64");
    return `Basic ${token}`;
  }

  async executeVoiceRequest(operationName, method, path, body = null, options = {}) {
    const maxRetries = normalizePositiveInteger(options.retryAttempts, 0, {
      min: 0,
    });
    const maxAttempts = Math.max(1, maxRetries + 1);
    const url = `${this.apiBaseUrl}${path}`;
    let attempt = 0;

    while (attempt < maxAttempts) {
      const attemptNumber = attempt + 1;
      try {
        return await runWithTimeout(
          (async () => {
            const response = await this.fetch(url, {
              method,
              headers: {
                Authorization: this.buildAuthHeader(),
                "Content-Type": "application/json",
              },
              body: body ? JSON.stringify(body) : undefined,
            });
            const parsedBody = response.status === 204 ? null : await parseResponseBody(response);
            if (!response.ok) {
              const error = new Error(
                parsedBody?.error ||
                  parsedBody?.message ||
                  `Plivo ${operationName} failed with HTTP ${response.status}`,
              );
              error.statusCode = response.status;
              error.provider = "plivo";
              error.operation = operationName;
              error.providerResponse = parsedBody;
              error.retryable = isRetriableStatus(response.status);
              throw error;
            }
            return parsedBody || { ok: true };
          })(),
          {
            timeoutMs: this.requestTimeoutMs,
            label: `plivo_${operationName}_timeout`,
            timeoutCode: "plivo_provider_timeout",
            logger: this.logger,
            meta: {
              provider: "plivo",
              operation: operationName,
              attempt: attemptNumber,
              max_attempts: maxAttempts,
              ...(options.meta || {}),
            },
            warnAfterMs: Math.min(
              5000,
              Math.max(1000, Math.floor(this.requestTimeoutMs / 2)),
            ),
          },
        );
      } catch (error) {
        const code = String(error?.code || "").trim();
        const statusCode = Number(error?.statusCode || error?.status);
        const retriable =
          error?.retryable === true ||
          isRetriableStatus(statusCode) ||
          isRetriableNetworkCode(code);
        const willRetry = retriable && attemptNumber < maxAttempts;
        this.logger?.warn?.("plivo_voice_operation_failed", {
          provider: "plivo",
          operation: operationName,
          attempt: attemptNumber,
          max_attempts: maxAttempts,
          retriable,
          will_retry: willRetry,
          status_code: Number.isFinite(statusCode) ? statusCode : null,
          code: code || null,
          error: error?.message || String(error || "unknown_error"),
          ...(options.meta || {}),
        });
        if (!willRetry) {
          if (error && typeof error === "object") {
            error.provider = "plivo";
            error.operation = operationName;
          }
          throw error;
        }
        const delayMs = buildRetryDelayMs(
          this.retryBaseMs,
          this.retryMaxDelayMs,
          this.retryJitterMs,
          attemptNumber,
        );
        await sleepMs(delayMs);
      }
      attempt += 1;
    }

    throw new Error(`PlivoVoiceAdapter ${operationName} exceeded retry budget`);
  }

  async createOutboundCall(options = {}) {
    const { to, callSid, answerUrl, eventUrl, from } = options;
    if (!to) {
      throw new Error("PlivoVoiceAdapter.createOutboundCall requires destination number");
    }
    if (!callSid) {
      throw new Error("PlivoVoiceAdapter.createOutboundCall requires callSid");
    }
    const normalizedFrom = sanitizePhoneNumber(from || this.fromNumber, "from");
    const normalizedTo = sanitizePhoneNumber(to, "destination");
    const finalAnswerUrl = this.answerUrlOverride || answerUrl;
    const finalEventUrl = this.eventUrlOverride || eventUrl;

    if (!isValidHttpsUrl(finalAnswerUrl)) {
      throw new Error(
        "PlivoVoiceAdapter.createOutboundCall requires a valid HTTPS answerUrl",
      );
    }
    if (finalEventUrl && !isValidHttpsUrl(finalEventUrl)) {
      throw new Error(
        "PlivoVoiceAdapter.createOutboundCall requires eventUrl to be a valid HTTPS URL",
      );
    }

    const payload = {
      from: normalizedFrom,
      to: normalizedTo,
      answer_url: finalAnswerUrl,
      answer_method: "GET",
      request_uuid: callSid,
    };
    if (finalEventUrl) {
      payload.ring_url = finalEventUrl;
      payload.ring_method = "POST";
      payload.hangup_url = finalEventUrl;
      payload.hangup_method = "POST";
    }

    this.logger.info?.("PlivoVoiceAdapter: creating outbound call", {
      to: maskPhoneForLog(normalizedTo),
      callSid,
      from: maskPhoneForLog(normalizedFrom),
      answerUrl: finalAnswerUrl,
      eventUrl: finalEventUrl || null,
    });

    const response = await this.executeVoiceRequest(
      "create_outbound_call",
      "POST",
      `/v1/Account/${encodeURIComponent(this.authId)}/Call/`,
      payload,
      {
        retryAttempts: this.createRetryAttempts,
        meta: {
          callSid,
          to: maskPhoneForLog(normalizedTo),
        },
      },
    );
    if (!extractPlivoCallUuid(response)) {
      this.logger.warn?.("plivo_create_call_missing_uuid", {
        provider: "plivo",
        operation: "create_outbound_call",
        callSid,
      });
    }
    return response;
  }

  async hangupCall(callUuid) {
    const normalized = String(callUuid || "").trim();
    if (!normalized) {
      throw new Error("PlivoVoiceAdapter.hangupCall requires call UUID");
    }
    await this.executeVoiceRequest(
      "hangup",
      "DELETE",
      `/v1/Account/${encodeURIComponent(this.authId)}/Call/${encodeURIComponent(normalized)}/`,
      null,
      {
        retryAttempts: this.retryAttempts,
        meta: { call_uuid: normalized },
      },
    );
  }
}

PlivoVoiceAdapter.extractPlivoCallUuid = extractPlivoCallUuid;

module.exports = PlivoVoiceAdapter;
