const DEFAULT_BASE_URL = "https://api.vapi.ai";
const fetch = require("node-fetch");

function isValidVapiControlUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && url.hostname.endsWith(".vapi.ai") &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      url.pathname.endsWith("/control");
  } catch {
    return false;
  }
}

class VapiApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "VapiApiError";
    this.status = Number.isFinite(details.status) ? details.status : null;
    this.code = String(details.code || "vapi_request_failed");
    this.retryable = Boolean(details.retryable);
  }
}

class VapiClient {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.apiKey = String(options.apiKey || "").trim();
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 10000));
    this.fetch = options.fetchFn || fetch;
  }

  isConfigured() {
    return Boolean(this.enabled && this.apiKey && typeof this.fetch === "function");
  }

  async request(method, path, body) {
    if (!this.enabled) {
      throw new VapiApiError("Vapi integration is disabled", { code: "vapi_disabled" });
    }
    if (!this.apiKey || typeof this.fetch !== "function") {
      throw new VapiApiError("Vapi server credentials are not configured", {
        code: "vapi_not_configured",
      });
    }
    if (!String(path || "").startsWith("/") || String(path).startsWith("//")) {
      throw new VapiApiError("Vapi API path must be an absolute path", {
        code: "vapi_invalid_path",
      });
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method: String(method || "GET").toUpperCase(),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const status = Number(response.status) || null;
        throw new VapiApiError(`Vapi API request failed (${status || "unknown"})`, {
          status,
          code: "vapi_http_error",
          retryable: status === 429 || (status >= 500 && status <= 599),
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof VapiApiError) throw error;
      const timedOut = error?.name === "AbortError";
      throw new VapiApiError(timedOut ? "Vapi API request timed out" : "Vapi API request failed", {
        code: timedOut ? "vapi_timeout" : "vapi_network_error",
        retryable: true,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  createAssistant(configuration) {
    return this.request("POST", "/assistant", configuration);
  }

  listAssistants(options = {}) {
    const query = new URLSearchParams();
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) || 1000)));
    query.set("limit", String(limit));
    if (options.createdAtGe) query.set("createdAtGe", String(options.createdAtGe));
    return this.request("GET", `/assistant?${query.toString()}`);
  }

  getAssistant(assistantId) {
    const id = String(assistantId || "").trim();
    if (!id) throw new VapiApiError("Vapi assistant ID is required", { code: "vapi_invalid_assistant_id" });
    return this.request("GET", `/assistant/${encodeURIComponent(id)}`);
  }

  updateAssistant(assistantId, configuration) {
    const id = String(assistantId || "").trim();
    if (!id) throw new VapiApiError("Vapi assistant ID is required", { code: "vapi_invalid_assistant_id" });
    return this.request("PATCH", `/assistant/${encodeURIComponent(id)}`, configuration);
  }

  listPhoneNumbers(options = {}) {
    const page = Math.max(1, Math.min(100000, Math.floor(Number(options.page) || 1)));
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) || 100)));
    const search = String(options.search || "").trim().slice(0, 100);
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) query.set("search", search);
    return this.request("GET", `/v2/phone-number?${query.toString()}`);
  }

  getPhoneNumber(phoneNumberId) {
    const id = String(phoneNumberId || "").trim();
    if (!id) throw new VapiApiError("Vapi phone number ID is required", { code: "vapi_invalid_phone_number_id" });
    return this.request("GET", `/phone-number/${encodeURIComponent(id)}`);
  }

  updatePhoneNumber(phoneNumberId, configuration) {
    const id = String(phoneNumberId || "").trim();
    if (!id) throw new VapiApiError("Vapi phone number ID is required", { code: "vapi_invalid_phone_number_id" });
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      throw new VapiApiError("Vapi phone number update must be an object", { code: "vapi_invalid_phone_number_update" });
    }
    return this.request("PATCH", `/phone-number/${encodeURIComponent(id)}`, configuration);
  }

  createCall(configuration) {
    return this.request("POST", "/call", configuration);
  }

  getCall(callId) {
    const id = String(callId || "").trim();
    if (!id) throw new VapiApiError("Vapi call ID is required", { code: "vapi_invalid_call_id" });
    return this.request("GET", `/call/${encodeURIComponent(id)}`);
  }

  async endCall(controlUrl) {
    if (!this.isConfigured()) {
      throw new VapiApiError("Vapi calling is disabled or not configured", { code: "vapi_not_configured" });
    }
    if (!isValidVapiControlUrl(controlUrl)) {
      throw new VapiApiError("Vapi live control URL is invalid", { code: "vapi_invalid_control_url" });
    }
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetch(String(controlUrl), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ type: "end-call" }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        const status = Number(response.status) || null;
        throw new VapiApiError(`Vapi call control request failed (${status || "unknown"})`, {
          status,
          code: "vapi_control_http_error",
          retryable: status === 429 || (status >= 500 && status <= 599),
        });
      }
      return payload || { accepted: true };
    } catch (error) {
      if (error instanceof VapiApiError) throw error;
      const timedOut = error?.name === "AbortError";
      throw new VapiApiError(timedOut ? "Vapi call control request timed out" : "Vapi call control request failed", {
        code: timedOut ? "vapi_control_timeout" : "vapi_control_network_error",
        retryable: true,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async transferCall(controlUrl, destination, content) {
    if (!this.isConfigured()) {
      throw new VapiApiError("Vapi calling is disabled or not configured", { code: "vapi_not_configured" });
    }
    if (!isValidVapiControlUrl(controlUrl)) {
      throw new VapiApiError("Vapi live control URL is invalid", { code: "vapi_invalid_control_url" });
    }
    const body = { type: "transfer", destination };
    if (content !== undefined && content !== null && String(content).trim()) body.content = String(content).trim();
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetch(String(controlUrl), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        const status = Number(response.status) || null;
        throw new VapiApiError(`Vapi call control request failed (${status || "unknown"})`, {
          status,
          code: "vapi_control_http_error",
          retryable: status === 429 || (status >= 500 && status <= 599),
        });
      }
      return payload || { accepted: true };
    } catch (error) {
      if (error instanceof VapiApiError) throw error;
      const timedOut = error?.name === "AbortError";
      throw new VapiApiError(timedOut ? "Vapi call control request timed out" : "Vapi call control request failed", {
        code: timedOut ? "vapi_control_timeout" : "vapi_control_network_error",
        retryable: true,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function createVapiClientFromEnv(options = {}) {
  return new VapiClient({
    enabled: String(process.env.VAPI_ENABLED || "false").trim().toLowerCase() === "true",
    apiKey: process.env.VAPI_PRIVATE_API_KEY,
    timeoutMs: process.env.VAPI_API_TIMEOUT_MS,
    ...options,
  });
}

module.exports = { VapiApiError, VapiClient, createVapiClientFromEnv, isValidVapiControlUrl };
