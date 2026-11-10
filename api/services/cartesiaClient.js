<<<<<<< HEAD
"use strict";

const fetch = require("node-fetch");

const CARTESIA_API_BASE_URL = "https://api.cartesia.ai";
const CARTESIA_API_VERSION = "2026-08-14";

function cartesiaError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = Number(options.status) || null;
  error.providerSubmissionState = options.providerSubmissionState || "unknown";
  error.retryable = false;
  return error;
=======
const fetch = require('node-fetch');

const CARTESIA_BASE_URL = 'https://api.cartesia.ai';
const DEFAULT_API_VERSION = '2026-08-14';
const DEFAULT_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;

class CartesiaApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CartesiaApiError';
    this.code = String(details.code || 'cartesia_request_failed');
    this.status = Number.isFinite(details.status) ? details.status : null;
    this.retryable = details.retryable === true;
  }
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutMs)));
}

function normalizeProviderErrorCode(value) {
  const code = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : '';
}

function isStandardApiKey(apiKey) {
  return apiKey.startsWith('sk_car_') && !apiKey.startsWith('sk_car_admin_');
}

function isAgentListResponse(payload) {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Array.isArray(payload.data) &&
    typeof payload.has_more === 'boolean' &&
    (payload.next_page === null || typeof payload.next_page === 'string'),
  );
>>>>>>> 95a068c (updated)
}

class CartesiaClient {
  constructor(options = {}) {
<<<<<<< HEAD
    this.apiKey = String(options.apiKey || "").trim();
    this.enabled = options.enabled === true;
    this.dispatchEnabled = options.dispatchEnabled === true;
    this.timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 12000));
    this.fetch = options.fetch || fetch;
    this.apiBaseUrl = String(options.apiBaseUrl || CARTESIA_API_BASE_URL).replace(/\/+$/, "");
    this.apiVersion = String(options.apiVersion || CARTESIA_API_VERSION).trim();
  }

  isConfigured() {
    return this.isReadConfigured() && this.dispatchEnabled;
  }

  isReadConfigured() {
    return this.enabled && Boolean(this.apiKey) &&
      this.apiVersion === CARTESIA_API_VERSION && typeof this.fetch === "function";
  }

  async createOutboundCall(input = {}) {
    if (!this.isConfigured()) {
      throw cartesiaError("cartesia_not_configured", "Cartesia outbound calling is disabled or not configured", {
        providerSubmissionState: "not_submitted",
      });
    }

    const payload = {
      from_number_id: input.fromNumberId,
      agent_id: input.agentId,
      outbound_calls: [{
        to_number: input.toNumber,
        dynamic_variables: input.dynamicVariables || {},
      }],
      ringing_timeout_seconds: input.ringingTimeoutSeconds,
      max_call_duration_minutes: input.maxCallDurationMinutes,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    let response;
    let body;
    try {
      response = await this.fetch(`${this.apiBaseUrl}/agents/calls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Cartesia-Version": this.apiVersion,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      try {
        body = await response.json();
      } catch {
        throw cartesiaError("cartesia_response_invalid", "Cartesia returned an invalid call response", {
          status: response.status,
          providerSubmissionState: response.ok ? "unknown" : "rejected",
        });
      }
    } catch (error) {
      if (error?.code === "cartesia_response_invalid") throw error;
      throw cartesiaError(
        error?.name === "AbortError" ? "cartesia_call_timeout" : "cartesia_call_transport_error",
        "Cartesia call submission outcome is unknown; reconcile before retrying",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw cartesiaError(
        response.status >= 500 ? "cartesia_provider_unavailable" : "cartesia_call_rejected",
        "Cartesia rejected the outbound call request",
        {
          status: response.status,
          providerSubmissionState: response.status >= 500 ? "unknown" : "rejected",
        },
      );
    }

    const calls = Array.isArray(body?.calls) ? body.calls : [];
    const result = calls.length === 1 ? calls[0] : null;
    if (result?.error && Object.keys(result.error).length > 0) {
      throw cartesiaError("cartesia_call_rejected", "Cartesia rejected the outbound call", {
        providerSubmissionState: "rejected",
      });
    }
    const providerCallId = String(result?.agent_call_id || "").trim();
    if (!providerCallId || providerCallId.length > 200) {
      throw cartesiaError("cartesia_call_id_missing", "Cartesia returned no usable call ID", {
        providerSubmissionState: "unknown",
      });
    }
    return { providerCallId, status: "queued" };
  }

  async createCallBatch(input = {}) {
    if (!this.isConfigured()) {
      throw cartesiaError("cartesia_not_configured", "Cartesia batch calling is disabled or not configured", {
        providerSubmissionState: "not_submitted",
      });
    }
    const payload = {
      name: input.name,
      agent_id: input.agentId,
      from_number_id: input.fromNumberId,
      recipients: input.recipients,
      target_concurrency_limit: input.targetConcurrencyLimit,
      ...(input.scheduledAt ? { scheduled_at: input.scheduledAt } : {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    let response;
    let body;
    try {
      response = await this.fetch(`${this.apiBaseUrl}/agents/calls/batches`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Cartesia-Version": this.apiVersion,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      try { body = await response.json(); }
      catch {
        throw cartesiaError("cartesia_batch_response_invalid", "Cartesia returned an invalid batch response", {
          status: response.status,
          providerSubmissionState: response.ok ? "unknown" : "rejected",
        });
      }
    } catch (error) {
      if (error?.code === "cartesia_batch_response_invalid") throw error;
      throw cartesiaError(
        error?.name === "AbortError" ? "cartesia_batch_timeout" : "cartesia_batch_transport_error",
        "Cartesia batch submission outcome is unknown; reconcile the existing campaign before retrying",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw cartesiaError(
        response.status >= 500 ? "cartesia_provider_unavailable" : "cartesia_batch_rejected",
        "Cartesia rejected the batch request",
        { status: response.status, providerSubmissionState: response.status >= 500 ? "unknown" : "rejected" },
      );
    }
    const batchId = String(body?.id || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(batchId)) {
      throw cartesiaError("cartesia_batch_id_missing", "Cartesia returned no usable batch ID", {
        providerSubmissionState: "unknown",
      });
    }
    return { batchId, status: String(body.status || "pending").slice(0, 40), createdAt: body.created_at || null };
  }

  async requestRead(path, errorPrefix) {
    if (!this.isReadConfigured()) {
      throw cartesiaError("cartesia_not_configured", "Cartesia call lookup is disabled or not configured", {
        providerSubmissionState: "not_submitted",
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(`${this.apiBaseUrl}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Cartesia-Version": this.apiVersion,
        },
        signal: controller.signal,
      });
      let body;
      try { body = await response.json(); }
      catch {
        throw cartesiaError(`${errorPrefix}_response_invalid`, "Cartesia returned an invalid call lookup response", {
          status: response.status,
        });
      }
      if (!response.ok) {
        throw cartesiaError(
          response.status === 404 ? "cartesia_call_not_found" : `${errorPrefix}_failed`,
          response.status === 404 ? "Cartesia call was not found" : "Cartesia call lookup failed",
          { status: response.status },
        );
      }
      return body;
    } catch (error) {
      if (String(error?.code || "").startsWith("cartesia_")) throw error;
      throw cartesiaError(
        error?.name === "AbortError" ? `${errorPrefix}_timeout` : `${errorPrefix}_transport_error`,
        "Cartesia call lookup is temporarily unavailable",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async getCall(callId) {
    const id = String(callId || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      throw cartesiaError("cartesia_call_id_invalid", "A valid Cartesia call ID is required", {
        providerSubmissionState: "not_submitted",
      });
    }
    return this.requestRead(`/agents/calls/${encodeURIComponent(id)}`, "cartesia_call_lookup");
  }

  async getCallAudio(callId) {
    const id = String(callId || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      throw cartesiaError("cartesia_call_id_invalid", "A valid Cartesia call ID is required", { providerSubmissionState: "not_submitted" });
    }
    if (!this.isReadConfigured()) throw cartesiaError("cartesia_not_configured", "Cartesia call recording access is disabled or not configured", { providerSubmissionState: "not_submitted" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(`${this.apiBaseUrl}/agents/calls/${encodeURIComponent(id)}/audio`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Cartesia-Version": this.apiVersion },
        signal: controller.signal,
      });
      if (!response.ok) throw cartesiaError(response.status === 404 ? "cartesia_call_audio_not_found" : "cartesia_call_audio_failed",
        response.status === 404 ? "Cartesia call recording is unavailable" : "Cartesia call recording could not be loaded", { status: response.status });
      const length = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(length) && length > 25 * 1024 * 1024) throw cartesiaError("cartesia_call_audio_too_large", "Cartesia call recording exceeds the download limit", { status: 413 });
      let audio;
      if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
        const chunks = [];
        let total = 0;
        for await (const chunk of response.body) {
          const bytes = Buffer.from(chunk);
          total += bytes.length;
          if (total > 25 * 1024 * 1024) throw cartesiaError("cartesia_call_audio_too_large", "Cartesia call recording exceeds the download limit", { status: 413 });
          chunks.push(bytes);
        }
        audio = Buffer.concat(chunks, total);
      } else {
        audio = Buffer.from(await response.arrayBuffer());
      }
      if (!audio.length || audio.length > 25 * 1024 * 1024) throw cartesiaError("cartesia_call_audio_invalid", "Cartesia returned an invalid call recording", { status: 502 });
      return { bytes: audio, contentType: "audio/wav" };
    } catch (error) {
      if (String(error?.code || "").startsWith("cartesia_")) throw error;
      throw cartesiaError(error?.name === "AbortError" ? "cartesia_call_audio_timeout" : "cartesia_call_audio_transport_error",
        "Cartesia call recording is temporarily unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  async deleteCall(callId) {
    const id = String(callId || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw cartesiaError("cartesia_call_id_invalid", "A valid Cartesia call ID is required", { providerSubmissionState: "not_submitted" });
    if (!this.isReadConfigured()) throw cartesiaError("cartesia_not_configured", "Cartesia call redaction is disabled or not configured", { providerSubmissionState: "not_submitted" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(`${this.apiBaseUrl}/agents/calls/${encodeURIComponent(id)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${this.apiKey}`, "Cartesia-Version": this.apiVersion }, signal: controller.signal,
      });
      if (!response.ok) throw cartesiaError(response.status === 404 ? "cartesia_call_not_found" : "cartesia_call_redaction_failed",
        response.status === 404 ? "Cartesia call was not found" : "Cartesia call data could not be deleted", { status: response.status });
      if (response.status === 204) return { deleted: true };
      let body = {};
      try { body = await response.json(); } catch { /* Successful DELETE may have no body. */ }
      return { deleted: body?.deleted !== false };
    } catch (error) {
      if (String(error?.code || "").startsWith("cartesia_")) throw error;
      throw cartesiaError(error?.name === "AbortError" ? "cartesia_call_redaction_timeout" : "cartesia_call_redaction_transport_error",
        "Cartesia call-data deletion outcome is unknown; refresh the call record before retrying");
    } finally {
      clearTimeout(timeout);
    }
  }

  async listCalls(input = {}) {
    const agentId = String(input.agentId || "").trim();
    const startTimeGte = String(input.startTimeGte || "").trim();
    const startTimeLte = String(input.startTimeLte || "").trim();
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 100));
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(agentId) || !Number.isFinite(Date.parse(startTimeGte)) ||
        (startTimeLte && !Number.isFinite(Date.parse(startTimeLte)))) {
      throw cartesiaError("cartesia_call_list_query_invalid", "A valid Cartesia agent and time window are required", {
        providerSubmissionState: "not_submitted",
      });
    }
    const params = new URLSearchParams({ agent_id: agentId, start_time_gte: startTimeGte, limit: String(limit) });
    if (startTimeLte) params.set("start_time_lte", startTimeLte);
    const startingAfter = String(input.startingAfter || "").trim();
    if (startingAfter) params.set("starting_after", startingAfter);
    if (input.expandTranscript === true) params.set("expand", "transcript");
    return this.requestRead(`/agents/calls?${params.toString()}`, "cartesia_call_list");
  }

  async listCallBatches(input = {}) {
    const agentId = String(input.agentId || '').trim();
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 100));
    if (agentId && !/^[A-Za-z0-9._:-]{1,200}$/.test(agentId)) {
      throw cartesiaError('cartesia_batch_list_query_invalid', 'A valid Cartesia agent is required', { providerSubmissionState: 'not_submitted' });
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (agentId) params.set('agent_id', agentId);
    for (const key of ['startingAfter', 'endingBefore']) {
      const value = String(input[key] || '').trim();
      if (value) params.set(key === 'startingAfter' ? 'starting_after' : 'ending_before', value);
    }
    return this.requestRead(`/agents/calls/batches?${params.toString()}`, 'cartesia_batch_list');
=======
    this.enabled = options.enabled === true;
    this.apiKey = String(options.apiKey || '').trim();
    this.apiVersion = String(options.apiVersion || DEFAULT_API_VERSION).trim();
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.fetch = options.fetchFn || fetch;
  }

  isConfigured() {
    return Boolean(
      this.enabled &&
      isStandardApiKey(this.apiKey) &&
      this.apiVersion &&
      typeof this.fetch === 'function',
    );
  }

  getConfigurationStatus() {
    return {
      enabled: this.enabled,
      configured: this.isConfigured(),
      apiVersion: this.apiVersion,
    };
  }

  async requestJson(method, path, body, options = {}) {
    if (!this.enabled) {
      throw new CartesiaApiError('Cartesia Managed Agents integration is disabled', {
        code: 'cartesia_disabled',
      });
    }
    if (this.apiKey.startsWith('sk_car_admin_')) {
      throw new CartesiaApiError('A standard Cartesia API key is required', {
        code: 'cartesia_invalid_key_type',
      });
    }
    if (!this.isConfigured()) {
      throw new CartesiaApiError('Cartesia server credentials are not configured', {
        code: 'cartesia_not_configured',
      });
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetch(`${CARTESIA_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          'Cartesia-Version': this.apiVersion,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        ...(controller ? { signal: controller.signal } : {}),
      });

      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (response.status === 204 && options.allowEmptyResponse === true) return { success: true };

      if (!response.ok) {
        const status = Number(response.status) || null;
        const providerCode = normalizeProviderErrorCode(payload?.error_code);
        const safeSuffix = providerCode ? `_${providerCode}` : '_http_error';
        throw new CartesiaApiError('Cartesia API request failed', {
          code: `cartesia${safeSuffix}`,
          status,
          retryable: status === 429 || (status !== null && status >= 500),
        });
      }
      if (!payload || typeof payload !== 'object' || (Array.isArray(payload) && options.allowArrayResponse !== true)) {
        throw new CartesiaApiError('Cartesia returned an invalid response', {
          code: 'cartesia_invalid_response',
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof CartesiaApiError) throw error;
      const timedOut = error?.name === 'AbortError';
      throw new CartesiaApiError(
        timedOut ? 'Cartesia API request timed out' : 'Cartesia API request failed',
        {
          code: timedOut ? 'cartesia_timeout' : 'cartesia_network_error',
          retryable: true,
        },
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async validateCredentials() {
    const payload = await this.requestJson('GET', '/v1/agents?limit=1');
    if (!isAgentListResponse(payload)) {
      throw new CartesiaApiError('Cartesia returned an invalid response', {
        code: 'cartesia_invalid_response',
      });
    }
    return { valid: true };
  }

  async createOutboundCall(payload) {
    return this.requestJson('POST', '/agents/calls', payload);
  }

  async createCallBatch(payload) {
    return this.requestJson('POST', '/agents/calls/batches', payload);
  }

  async listCallBatches(query = {}) {
    const params = new URLSearchParams();
    for (const key of ['limit', 'starting_after', 'ending_before', 'agent_id']) {
      const value = query[key];
      if (value === undefined || value === null || value === '') continue;
      if (key === 'limit' && (!Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 100)) {
        throw new CartesiaApiError('Cartesia batch page limit is invalid', { code: 'cartesia_invalid_batch_query' });
      }
      if (key !== 'limit' && !/^[A-Za-z0-9_-]{1,200}$/.test(String(value))) {
        throw new CartesiaApiError('Cartesia batch cursor is invalid', { code: 'cartesia_invalid_batch_query' });
      }
      params.set(key, String(value));
    }
    const queryString = params.toString();
    return this.requestJson('GET', `/agents/calls/batches${queryString ? `?${queryString}` : ''}`);
>>>>>>> 95a068c (updated)
  }

  async getCallBatch(batchId) {
    const id = String(batchId || '').trim();
<<<<<<< HEAD
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      throw cartesiaError('cartesia_batch_id_invalid', 'A valid Cartesia batch ID is required', { providerSubmissionState: 'not_submitted' });
    }
    return this.requestRead(`/agents/calls/batches/${encodeURIComponent(id)}`, 'cartesia_batch_lookup');
  }

  async mutateCallBatch(batchId, operation) {
    const id = String(batchId || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id) || !['cancel', 'retry'].includes(operation)) {
      throw cartesiaError('cartesia_batch_operation_invalid', 'A valid Cartesia batch operation is required', { providerSubmissionState: 'not_submitted' });
    }
    if (!this.isConfigured()) {
      throw cartesiaError('cartesia_not_configured', 'Cartesia batch operations are disabled or not configured', { providerSubmissionState: 'not_submitted' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(`${this.apiBaseUrl}/agents/calls/batches/${encodeURIComponent(id)}/${operation}`, {
        method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Cartesia-Version': this.apiVersion }, signal: controller.signal,
      });
      let body;
      try { body = await response.json(); }
      catch {
        throw cartesiaError(`cartesia_batch_${operation}_response_invalid`, 'Cartesia returned an invalid batch operation response', {
          status: response.status, providerSubmissionState: response.ok ? 'unknown' : 'rejected',
        });
      }
      if (!response.ok) throw cartesiaError(`cartesia_batch_${operation}_failed`, `Cartesia batch ${operation} failed`, {
        status: response.status, providerSubmissionState: response.status >= 500 ? 'unknown' : 'rejected',
      });
      return body;
    } catch (error) {
      if (String(error?.code || '').startsWith('cartesia_')) throw error;
      throw cartesiaError(`cartesia_batch_${operation}_${error?.name === 'AbortError' ? 'timeout' : 'transport_error'}`,
        `Cartesia batch ${operation} outcome is unknown; refresh batch status before taking further action`);
    } finally { clearTimeout(timeout); }
  }

  async cancelCallBatch(batchId) { return this.mutateCallBatch(batchId, 'cancel'); }
  async retryCallBatch(batchId) { return this.mutateCallBatch(batchId, 'retry'); }

  async cancelCall(callId) {
    const id = String(callId || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      throw cartesiaError("cartesia_call_id_invalid", "A valid Cartesia call ID is required", {
        providerSubmissionState: "not_submitted",
      });
    }
    if (!this.isConfigured()) {
      throw cartesiaError("cartesia_not_configured", "Cartesia outbound operations are disabled or not configured", {
        providerSubmissionState: "not_submitted",
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(`${this.apiBaseUrl}/agents/calls/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Cartesia-Version": this.apiVersion,
        },
        signal: controller.signal,
      });
      let body;
      try { body = await response.json(); }
      catch {
        throw cartesiaError("cartesia_call_cancel_response_invalid", "Cartesia returned an invalid cancellation response", {
          status: response.status,
        });
      }
      if (!response.ok) {
        throw cartesiaError(
          response.status === 404 ? "cartesia_call_not_found" : "cartesia_call_cancel_failed",
          response.status === 404 ? "Cartesia call was not found" : "Cartesia call cancellation failed",
          { status: response.status },
        );
      }
      return body;
    } catch (error) {
      if (String(error?.code || "").startsWith("cartesia_")) throw error;
      throw cartesiaError(
        error?.name === "AbortError" ? "cartesia_call_cancel_timeout" : "cartesia_call_cancel_transport_error",
        "Cartesia call cancellation outcome is unknown; refresh call status before taking further action",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async listAgents() {
    return this.requestRead("/v1/agents", "cartesia_agent_list");
  }

  async getAgent(agentId) {
    const id = String(agentId || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      throw cartesiaError("cartesia_agent_id_invalid", "A valid Cartesia agent ID is required", {
        providerSubmissionState: "not_submitted",
      });
    }
    return this.requestRead(`/agents/${encodeURIComponent(id)}`, "cartesia_agent_lookup");
  }

  async listAgentDeployments(agentId) {
    const id = String(agentId || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      throw cartesiaError("cartesia_agent_id_invalid", "A valid Cartesia agent ID is required", {
        providerSubmissionState: "not_submitted",
      });
    }
    return this.requestRead(`/agents/${encodeURIComponent(id)}/deployments`, "cartesia_deployment_list");
  }

  async getDeployment(deploymentId) {
    const id = String(deploymentId || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
      throw cartesiaError("cartesia_deployment_id_invalid", "A valid Cartesia deployment ID is required", {
        providerSubmissionState: "not_submitted",
      });
    }
    return this.requestRead(`/agents/deployments/${encodeURIComponent(id)}`, "cartesia_deployment_lookup");
  }
}

module.exports = { CartesiaClient, CARTESIA_API_BASE_URL, CARTESIA_API_VERSION, cartesiaError };
=======
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new CartesiaApiError('Cartesia call batch ID is invalid', { code: 'cartesia_invalid_batch_id' });
    }
    return this.requestJson('GET', `/agents/calls/batches/${encodeURIComponent(id)}`);
  }

  async cancelCallBatch(batchId) {
    const id = String(batchId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new CartesiaApiError('Cartesia call batch ID is invalid', { code: 'cartesia_invalid_batch_id' });
    }
    return this.requestJson('POST', `/agents/calls/batches/${encodeURIComponent(id)}/cancel`);
  }

  async getCall(providerCallId) {
    const callId = String(providerCallId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(callId)) {
      throw new CartesiaApiError('Cartesia call ID is invalid', { code: 'cartesia_invalid_call_id' });
    }
    return this.requestJson('GET', `/agents/calls/${encodeURIComponent(callId)}`);
  }

  async getAgent(agentId) {
    const id = String(agentId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new CartesiaApiError('Cartesia agent ID is invalid', { code: 'cartesia_invalid_agent_id' });
    }
    return this.requestJson('GET', `/agents/${encodeURIComponent(id)}`);
  }

  async getWebhook(webhookId) {
    const id = String(webhookId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new CartesiaApiError('Cartesia webhook ID is invalid', { code: 'cartesia_invalid_webhook_id' });
    }
    return this.requestJson('GET', `/agents/webhooks/${encodeURIComponent(id)}`);
  }

  async createWebhook(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some((key) => !['url', 'secret'].includes(key)) ||
        typeof payload.url !== 'string' || typeof payload.secret !== 'string' || !payload.secret.trim()) {
      throw new CartesiaApiError('Cartesia webhook creation request is invalid', { code: 'cartesia_webhook_create_invalid' });
    }
    let url;
    try {
      url = new URL(payload.url);
    } catch {
      throw new CartesiaApiError('Cartesia webhook creation request is invalid', { code: 'cartesia_webhook_create_invalid' });
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new CartesiaApiError('Cartesia webhook creation request is invalid', { code: 'cartesia_webhook_create_invalid' });
    }
    return this.requestJson('POST', '/agents/webhooks', payload);
  }

  async updateAgentWebhook(agentId, webhookId) {
    const id = String(agentId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
        (webhookId !== null && (typeof webhookId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(webhookId)))) {
      throw new CartesiaApiError('Cartesia agent webhook assignment is invalid', { code: 'cartesia_agent_webhook_assignment_invalid' });
    }
    return this.requestJson('PATCH', `/agents/${encodeURIComponent(id)}`, { webhook_id: webhookId });
  }

  async cancelCall(providerCallId) {
    const callId = String(providerCallId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(callId)) {
      throw new CartesiaApiError('Cartesia call ID is invalid', { code: 'cartesia_invalid_call_id' });
    }
    return this.requestJson('POST', `/agents/calls/${encodeURIComponent(callId)}/cancel`);
  }

  async listPhoneNumbers(query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.requestJson('GET', `/agents/phone-numbers${suffix}`);
  }

  async getPhoneNumber(phoneNumberId) {
    const id = String(phoneNumberId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new CartesiaApiError('Cartesia phone number ID is invalid', { code: 'cartesia_invalid_phone_number_id' });
    }
    return this.requestJson('GET', `/agents/phone-numbers/${encodeURIComponent(id)}`);
  }

  async updatePhoneNumber(phoneNumberId, update = {}) {
    const id = String(phoneNumberId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new CartesiaApiError('Cartesia phone number ID is invalid', { code: 'cartesia_invalid_phone_number_id' });
    }
    if (!update || typeof update !== 'object' || Array.isArray(update) ||
        Object.keys(update).length !== 1 || !Object.hasOwn(update, 'agent_id') ||
        (update.agent_id !== null && (typeof update.agent_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(update.agent_id)))) {
      throw new CartesiaApiError('Cartesia phone number update is invalid', { code: 'cartesia_phone_number_update_invalid' });
    }
    return this.requestJson('PATCH', `/agents/phone-numbers/${encodeURIComponent(id)}`, update);
  }

  async importPhoneNumber(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some((key) => !['label', 'number', 'provider', 'agent_id'].includes(key)) ||
        typeof payload.label !== 'string' || typeof payload.number !== 'string' ||
        !payload.provider || typeof payload.provider !== 'object' || Array.isArray(payload.provider) ||
        Object.keys(payload.provider).some((key) => key !== 'id') ||
        typeof payload.provider.id !== 'string' ||
        (payload.agent_id !== undefined && payload.agent_id !== null && typeof payload.agent_id !== 'string')) {
      throw new CartesiaApiError('Cartesia phone number import request is invalid', { code: 'cartesia_phone_number_import_invalid' });
    }
    return this.requestJson('POST', '/agents/phone-numbers', payload);
  }

  async provisionPhoneNumber(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some((key) => !['label', 'agent_id'].includes(key)) ||
        typeof payload.label !== 'string' ||
        (payload.agent_id !== undefined && payload.agent_id !== null && typeof payload.agent_id !== 'string')) {
      throw new CartesiaApiError('Cartesia phone number provisioning request is invalid', { code: 'cartesia_phone_number_provision_invalid' });
    }
    return this.requestJson('POST', '/agents/phone-numbers/provision', payload);
  }

  async deletePhoneNumber(phoneNumberId) {
    const id = String(phoneNumberId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new CartesiaApiError('Cartesia phone number ID is invalid', { code: 'cartesia_invalid_phone_number_id' });
    }
    return this.requestJson('DELETE', `/agents/phone-numbers/${encodeURIComponent(id)}`, undefined, { allowEmptyResponse: true });
  }

  async listTelephonyProviders() {
    return this.requestJson('GET', '/agents/phone-numbers/providers', undefined, { allowArrayResponse: true });
  }

  async getTelephonyProvider(providerId) {
    const id = String(providerId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new CartesiaApiError('Cartesia telephony provider ID is invalid', { code: 'cartesia_invalid_provider_id' });
    }
    return this.requestJson('GET', `/agents/phone-numbers/providers/${encodeURIComponent(id)}`);
  }

  async updateTwilioProvider(providerId, payload) {
    const id = String(providerId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.type !== 'twilio' || Object.keys(payload).some((key) => !['type', 'api_key_sid', 'api_key_secret', 'region'].includes(key)) ||
        typeof payload.api_key_sid !== 'string' || typeof payload.api_key_secret !== 'string' ||
        !['us1', 'ie1', 'au1'].includes(payload.region)) {
      throw new CartesiaApiError('Cartesia Twilio provider update request is invalid', { code: 'cartesia_twilio_provider_update_invalid' });
    }
    return this.requestJson('PATCH', `/agents/phone-numbers/providers/${encodeURIComponent(id)}`, payload);
  }

  async updateSipProvider(providerId, payload) {
    const id = String(providerId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.type !== 'sip_trunk' || Object.keys(payload).some((key) => !['type', 'inbound', 'outbound'].includes(key)) ||
        !payload.inbound || typeof payload.inbound !== 'object' || Array.isArray(payload.inbound) ||
        !payload.outbound || typeof payload.outbound !== 'object' || Array.isArray(payload.outbound)) {
      throw new CartesiaApiError('Cartesia SIP provider update request is invalid', { code: 'cartesia_sip_provider_update_invalid' });
    }
    return this.requestJson('PATCH', `/agents/phone-numbers/providers/${encodeURIComponent(id)}`, payload);
  }

  async deleteTelephonyProvider(providerId) {
    const id = String(providerId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
      throw new CartesiaApiError('Cartesia telephony provider ID is invalid', { code: 'cartesia_invalid_provider_id' });
    }
    return this.requestJson('DELETE', `/agents/phone-numbers/providers/${encodeURIComponent(id)}`, undefined, { allowEmptyResponse: true });
  }

  async createSipProvider(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.type !== 'sip_trunk') {
      throw new CartesiaApiError('Cartesia SIP provider request is invalid', { code: 'cartesia_sip_provider_request_invalid' });
    }
    return this.requestJson('POST', '/agents/phone-numbers/providers', payload);
  }

  async createTwilioProvider(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.type !== 'twilio' ||
        Object.keys(payload).some((key) => !['type', 'account_sid', 'api_key_sid', 'api_key_secret', 'region', 'label'].includes(key)) ||
        typeof payload.account_sid !== 'string' || typeof payload.api_key_sid !== 'string' ||
        typeof payload.api_key_secret !== 'string' || typeof payload.region !== 'string' || typeof payload.label !== 'string') {
      throw new CartesiaApiError('Cartesia Twilio provider request is invalid', { code: 'cartesia_twilio_provider_request_invalid' });
    }
    return this.requestJson('POST', '/agents/phone-numbers/providers', payload);
  }
}

function createCartesiaClient(config = {}, options = {}) {
  return new CartesiaClient({
    enabled: config.enabled,
    apiKey: config.apiKey,
    apiVersion: config.apiVersion,
    timeoutMs: config.timeoutMs,
    ...options,
  });
}

module.exports = {
  CARTESIA_BASE_URL,
  CartesiaApiError,
  CartesiaClient,
  createCartesiaClient,
};
>>>>>>> 95a068c (updated)
