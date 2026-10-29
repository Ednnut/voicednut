const fetch = require("node-fetch");

const CALL_E_PRODUCTION_BASE_URL = "https://api.heycall-e.com";
const CALL_E_TEST_BASE_URL = "https://test-api.heycall-e.com";
const ALLOWED_BASE_URLS = new Set([CALL_E_PRODUCTION_BASE_URL, CALL_E_TEST_BASE_URL]);
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const KNOWN_NO_CALL_CODES = new Set([
  "input_incomplete",
  "unsupported_region",
  "unsupported_language",
  "result_schema_invalid",
]);
const CALL_E_PILOT_DISPATCH_BLOCKERS = Object.freeze([
  "dispatch_kill_switch_disabled",
  "exact_preview_pilot_approval_missing_or_expired",
  "pilot_external_readiness_review_required",
]);

class CallEApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CallEApiError";
    this.status = Number.isFinite(details.status) ? details.status : null;
    this.code = String(details.code || "call_e_request_failed");
    this.retryable = Boolean(details.retryable);
    this.noCallCreated = details.noCallCreated === true;
    this.providerCode = String(details.providerCode || "");
    this.reasonCode = String(details.reasonCode || "");
    this.recoveryAction = String(details.recoveryAction || "inspect_call_state");
  }
}

function isAllowedBaseUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && ALLOWED_BASE_URLS.has(url.origin) &&
      url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function normalizeCallEWebhookUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeCallId(value) {
  const callId = String(value || "").trim();
  return CALL_ID_PATTERN.test(callId) ? callId : null;
}

function readErrorCode(payload) {
  const raw = String(payload?.error?.code || payload?.code || "").trim();
  return /^[a-z][a-z0-9_]{0,79}$/.test(raw) ? raw : "";
}

function callEOperationName(method, pathname) {
  if (pathname === "/v2/calls" && method === "POST") return "call.create";
  if (/^\/v2\/calls\/[A-Za-z0-9_-]{1,200}\/cancel$/.test(pathname)) return "call.cancel";
  if (/^\/v2\/calls\/[A-Za-z0-9_-]{1,200}\/events$/.test(pathname)) return "call.events.read";
  if (/^\/v2\/calls\/[A-Za-z0-9_-]{1,200}$/.test(pathname)) return "call.read";
  return "unknown";
}

class CallEClient {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.apiKey = String(options.apiKey || "").trim();
    this.baseUrl = String(options.baseUrl || CALL_E_PRODUCTION_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 10000));
    this.fetch = options.fetchFn || fetch;
    this.onMetric = typeof options.onMetric === "function" ? options.onMetric : (metric) => {
      console.info("call_e_request_metric", metric);
    };
  }

  isConfigured() {
    return Boolean(this.enabled && this.apiKey && isAllowedBaseUrl(this.baseUrl) && typeof this.fetch === "function");
  }

  async request(method, path, options = {}) {
    if (!this.enabled) {
      throw new CallEApiError("CALL-E integration is disabled", { code: "call_e_disabled" });
    }
    if (!this.apiKey || !isAllowedBaseUrl(this.baseUrl) || typeof this.fetch !== "function") {
      throw new CallEApiError("CALL-E server credentials or endpoint are not configured", { code: "call_e_not_configured" });
    }
    const pathname = typeof path === "string" ? path.split("?", 1)[0] : "";
    const validPath = pathname === "/v2/calls" ||
      /^\/v2\/calls\/[A-Za-z0-9_-]{1,200}(?:\/(?:cancel|events))?$/.test(pathname);
    if (!validPath || path.startsWith("//")) {
      throw new CallEApiError("CALL-E API path is invalid", { code: "call_e_invalid_path" });
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    const startedAt = Date.now();
    const requestMethod = String(method || "GET").toUpperCase();
    const operation = callEOperationName(requestMethod, pathname);
    let outcome = "error";
    let statusCode = null;
    let errorCode = null;
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method: requestMethod,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        const status = Number(response.status) || null;
        statusCode = status;
        const providerCode = readErrorCode(payload);
        const rawReasonCode = String(payload?.error?.details?.reason_code || "").trim();
        const reasonCode = /^[a-z][a-z0-9_]{0,79}$/.test(rawReasonCode) ? rawReasonCode : "";
        const noCallCreated = (status === 422 && KNOWN_NO_CALL_CODES.has(providerCode)) ||
          (status === 400 && providerCode === "result_schema_invalid");
        const recoveryAction = providerCode === "unauthorized" || providerCode === "forbidden"
          ? "check_server_credentials_or_access"
          : providerCode === "insufficient_balance"
            ? "resolve_provider_billing"
            : providerCode === "rate_limit_exceeded"
              ? "backoff_same_request_and_idempotency_key"
              : providerCode === "idempotency_conflict" && reasonCode === "creation_in_progress"
                ? "backoff_same_request_and_idempotency_key"
                : providerCode === "idempotency_conflict"
                  ? "inspect_original_request_and_idempotency_key"
                  : noCallCreated
                    ? "correct_rejected_input_and_reuse_key"
                    : "inspect_call_state_before_retry";
        errorCode = providerCode ? `call_e_${providerCode}` : "call_e_http_error";
        throw new CallEApiError("CALL-E API request failed", {
          status,
          code: errorCode,
          noCallCreated,
          providerCode,
          reasonCode,
          recoveryAction,
          retryable: status === 429 || (status !== null && status >= 500),
        });
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        errorCode = "call_e_invalid_response";
        throw new CallEApiError("CALL-E returned an invalid response", { code: "call_e_invalid_response" });
      }
      outcome = "success";
      statusCode = Number(response.status) || null;
      return payload;
    } catch (error) {
      if (error instanceof CallEApiError) errorCode = error.code;
      if (error instanceof CallEApiError) throw error;
      const timedOut = error?.name === "AbortError";
      errorCode = timedOut ? "call_e_timeout" : "call_e_network_error";
      throw new CallEApiError(
        timedOut ? "CALL-E API request timed out" : "CALL-E API request failed",
        { code: errorCode, retryable: true },
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      try {
        this.onMetric({
          operation,
          method: requestMethod,
          outcome,
          statusCode,
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(errorCode ? { errorCode } : {}),
        });
      } catch {
        // Metrics must never alter provider request behavior.
      }
    }
  }

  createCall(request, idempotencyKey) {
    if (!idempotencyKey || String(idempotencyKey).length > 255) {
      throw new CallEApiError("A valid CALL-E idempotency key is required", { code: "call_e_idempotency_key_required" });
    }
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new CallEApiError("CALL-E call request is invalid", { code: "call_e_request_invalid" });
    }
    return this.request("POST", "/v2/calls", { body: request, idempotencyKey: String(idempotencyKey) });
  }

  getCall(callId) {
    const id = normalizeCallId(callId);
    if (!id) throw new CallEApiError("CALL-E Call ID is invalid", { code: "call_e_invalid_call_id" });
    return this.request("GET", `/v2/calls/${encodeURIComponent(id)}`);
  }

  cancelCall(callId) {
    const id = normalizeCallId(callId);
    if (!id) throw new CallEApiError("CALL-E Call ID is invalid", { code: "call_e_invalid_call_id" });
    return this.request("POST", `/v2/calls/${encodeURIComponent(id)}/cancel`);
  }

  listCallEvents(callId, options = {}) {
    const id = normalizeCallId(callId);
    if (!id) throw new CallEApiError("CALL-E Call ID is invalid", { code: "call_e_invalid_call_id" });
    const query = new URLSearchParams();
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 50)));
    query.set("limit", String(limit));
    if (options.cursor) {
      const cursor = String(options.cursor);
      if (cursor.length > 512) throw new CallEApiError("CALL-E event cursor is invalid", { code: "call_e_invalid_cursor" });
      query.set("cursor", cursor);
    }
    return this.request("GET", `/v2/calls/${encodeURIComponent(id)}/events?${query.toString()}`);
  }
}

function createCallEClientFromEnv(options = {}) {
  return new CallEClient({
    enabled: String(process.env.CALLE_ENABLED || "false").trim().toLowerCase() === "true",
    apiKey: process.env.CALLE_API_KEY,
    baseUrl: process.env.CALLE_BASE_URL || CALL_E_PRODUCTION_BASE_URL,
    timeoutMs: process.env.CALLE_API_TIMEOUT_MS,
    ...options,
  });
}

function buildCallEDeploymentStatus(client, options = {}) {
  const integrationEnabled = client?.enabled === true;
  const dispatchAvailable = options.dispatchEnabled === true && Boolean(client?.isConfigured?.()) &&
    options.destinationAllowlistReady === true && options.pilotApprovalReady === true &&
    options.pilotReadinessReviewed === true;
  const blockers = [
    ...(options.dispatchEnabled === true ? [] : ["dispatch_kill_switch_disabled"]),
    ...(options.pilotApprovalReady === true ? [] : ["exact_preview_pilot_approval_missing_or_expired"]),
    ...(options.pilotReadinessReviewed === true ? [] : ["pilot_external_readiness_review_required"]),
  ];
  return {
    integrationEnabled,
    providerAccessReady: Boolean(client?.isConfigured?.()),
    destinationAllowlistReady: options.destinationAllowlistReady === true,
    dispatchKillSwitchEnabled: options.dispatchEnabled === true,
    pilotApprovalReady: options.pilotApprovalReady === true,
    pilotReadinessReviewed: options.pilotReadinessReviewed === true,
    previewAvailable: true,
    dispatchAvailable,
    pilotReady: dispatchAvailable,
    dispatchBlocker: blockers[0] || null,
    dispatchBlockers: blockers,
  };
}

module.exports = {
  CALL_E_PRODUCTION_BASE_URL,
  CALL_E_TEST_BASE_URL,
  CallEApiError,
  CallEClient,
  CALL_E_PILOT_DISPATCH_BLOCKERS,
  buildCallEDeploymentStatus,
  createCallEClientFromEnv,
  isAllowedBaseUrl,
  normalizeCallEWebhookUrl,
  normalizeCallId,
};
