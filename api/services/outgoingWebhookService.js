const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const https = require("node:https");
const ipaddr = require("ipaddr.js");

const SUPPORTED_EVENTS = new Set(["post_call_completed", "post_call_outcome_classified", "post_call_automation_failed"]);
const OUTCOME_CLASSIFICATIONS = new Set(["completed", "not_connected", "failed", "canceled", "unknown"]);
const FAILURE_STAGES = new Set(["workflow_trigger", "automation_execution"]);
const DEFAULT_POLL_MS = 3000;
const MAX_BODY_BYTES = 8192;
const SECRET_REF_PATTERN = /^env:\/\/([A-Z][A-Z0-9_]{2,127})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

function fail(message, code = "validation_error") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizeTarget(value) {
  let url;
  try { url = new URL(String(value || "")); } catch (_) { fail("Webhook target URL is invalid"); }
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password ||
      url.search || url.hash || url.hostname.endsWith(".") || url.hostname.includes("%")) {
    fail("Webhook target must be a public HTTPS URL on port 443 without credentials, query, or fragment");
  }
  const host = url.hostname.toLowerCase();
  if (host.length > 253 || !host.includes(".") || netIsIp(host) ||
      host.split(".").some((label) => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
    fail("Webhook target hostname is invalid");
  }
  url.hostname = host;
  url.port = "";
  return url;
}

function netIsIp(host) {
  try { ipaddr.parse(host); return true; } catch (_) { return false; }
}

async function resolvePublicAddress(host, resolver = dns.lookup) {
  const rows = await resolver(host, { all: true, order: "verbatim" });
  if (!Array.isArray(rows) || rows.length === 0) fail("Webhook target DNS could not be resolved", "webhook_destination_rejected");
  for (const row of rows) {
    try {
      const address = ipaddr.parse(row.address);
      if (address.range() !== "unicast") fail("Webhook target resolves to a restricted network", "webhook_destination_rejected");
    } catch (error) {
      if (error?.code === "webhook_destination_rejected") throw error;
      fail("Webhook target resolves to an invalid address", "webhook_destination_rejected");
    }
  }
  return rows[0];
}

function safePayload(event) {
  const input = event?.payload || {};
  const eventType = SUPPORTED_EVENTS.has(event?.trigger_event) ? event.trigger_event : "post_call_completed";
  const callIdValue = event?.call_sid || input.call_sid || input.local_call_id || input.call?.call_sid;
  const callId = typeof callIdValue === "string" && SAFE_ID.test(callIdValue) ? callIdValue : null;
  if (eventType === "post_call_outcome_classified") {
    const classification = String(input.outcome_classification || input.context?.outcome_classification || "").toLowerCase();
    const data = {};
    if (callId) data.call_id = callId;
    if (OUTCOME_CLASSIFICATIONS.has(classification)) data.outcome_classification = classification;
    return {
      id: String(event?.event_id || crypto.randomUUID()), type: eventType, version: 1,
      occurred_at: event?.occurred_at && Number.isFinite(Date.parse(event.occurred_at))
        ? new Date(event.occurred_at).toISOString()
        : new Date().toISOString(),
      business_id: String(event?.business_id || input.business_id || ""), data,
    };
  }
  if (eventType === "post_call_automation_failed") {
    const stage = String(input.failure_stage || "").toLowerCase();
    const errorCode = String(input.error_code || "").toLowerCase();
    const data = {};
    if (callId) data.call_id = callId;
    if (FAILURE_STAGES.has(stage)) data.failure_stage = stage;
    if (/^[a-z][a-z0-9_.-]{0,79}$/.test(errorCode)) data.error_code = errorCode;
    return {
      id: String(event?.event_id || crypto.randomUUID()), type: eventType, version: 1,
      occurred_at: event?.occurred_at && Number.isFinite(Date.parse(event.occurred_at))
        ? new Date(event.occurred_at).toISOString()
        : new Date().toISOString(),
      business_id: String(event?.business_id || input.business_id || ""), data,
    };
  }
  const durationValue = input.duration_seconds ?? input.duration ?? input.metadata?.duration_seconds;
  const duration = Number(durationValue);
  const outcomeValue = String(input.outcome || input.outcome_class || input.call_outcome || "").toLowerCase().replace(/[ -]+/g, "_");
  const outcomes = new Set(["answered", "voicemail", "busy", "no_answer", "failed", "completed", "unknown"]);
  const data = { status: "completed" };
  if (callId) data.call_id = callId;
  if (Number.isFinite(duration) && duration >= 0 && duration <= 86400) data.duration_seconds = Math.floor(duration);
  if (outcomes.has(outcomeValue)) data.outcome = outcomeValue;
  return {
    id: String(event?.event_id || crypto.randomUUID()),
    type: eventType,
    version: 1,
    occurred_at: event?.occurred_at && Number.isFinite(Date.parse(event.occurred_at))
      ? new Date(event.occurred_at).toISOString()
      : new Date().toISOString(),
    business_id: String(event?.business_id || input.business_id || ""),
    data,
  };
}

function postHttps(url, address, headers, body, requestImpl = https.request) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = requestImpl({
      protocol: "https:",
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname || "/"}${url.search}`,
      method: "POST",
      headers: { ...headers, host: url.host, "content-length": Buffer.byteLength(body) },
      servername: url.hostname,
      rejectUnauthorized: true,
      agent: false,
      timeout: 8000,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    }, (response) => {
      let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > MAX_BODY_BYTES) request.destroy(new Error("response_too_large")); });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ status: Number(response.statusCode) || 0 });
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.end(body);
  });
}

class OutgoingWebhookService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.enabled = options.enabled === true;
    this.logger = options.logger || console;
    this.resolveDns = options.resolveDns || dns.lookup;
    this.request = options.request || https.request;
    this.pollMs = Math.max(1000, Math.min(30000, Number(options.pollMs) || DEFAULT_POLL_MS));
    this.timer = null;
    this.busy = false;
  }

  async createSubscription(input, businessId, actor) {
    if (!this.enabled) fail("Outgoing webhooks are disabled", "service_unavailable");
    const parsed = this.normalizeSubscription(input);
    const url = normalizeTarget(parsed.target_url);
    await resolvePublicAddress(url.hostname, this.resolveDns);
    const row = await this.db.createOutgoingWebhookSubscription({
      ...parsed, subscription_id: crypto.randomUUID(), business_id: businessId, created_by: actor,
    });
    return this.presentSubscription(row);
  }

  async updateSubscription(subscriptionId, businessId, input, actor) {
    if (!this.enabled) fail("Outgoing webhooks are disabled", "service_unavailable");
    const existing = await this.db.getOutgoingWebhookSubscription(subscriptionId, businessId);
    if (!existing) fail("Webhook subscription was not found", "not_found");
    const parsed = this.normalizeSubscription(input);
    const url = normalizeTarget(parsed.target_url);
    await resolvePublicAddress(url.hostname, this.resolveDns);
    await this.db.updateOutgoingWebhookSubscription(subscriptionId, businessId, parsed, actor);
    return this.presentSubscription(await this.db.getOutgoingWebhookSubscription(subscriptionId, businessId));
  }

  normalizeSubscription(input = {}) {
    const allowed = new Set(["name", "target_url", "secret_ref", "event_types", "enabled", "failure_threshold"]);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) {
      fail("Webhook subscription fields are invalid");
    }
    const name = String(input.name || "").trim();
    const secretMatch = SECRET_REF_PATTERN.exec(String(input.secret_ref || ""));
    if (!name || name.length > 80 || !secretMatch || typeof process.env[secretMatch[1]] !== "string" ||
        Buffer.byteLength(process.env[secretMatch[1]]) < 32) fail("Webhook name or signing secret reference is invalid");
    const eventTypes = input.event_types;
    if (!Array.isArray(eventTypes) || eventTypes.length < 1 || eventTypes.length > SUPPORTED_EVENTS.size || eventTypes.some((type) => !SUPPORTED_EVENTS.has(type))) {
      fail("Webhook event types are invalid");
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") fail("Webhook enabled flag is invalid");
    const threshold = input.failure_threshold === undefined ? 10 : Number(input.failure_threshold);
    if (!Number.isInteger(threshold) || threshold < 3 || threshold > 50) fail("Webhook failure threshold is invalid");
    return {
      name, target_url: normalizeTarget(input.target_url).toString(), secret_env_ref: `env://${secretMatch[1]}`,
      event_types: [...new Set(eventTypes)], enabled: input.enabled !== false, failure_threshold: threshold,
    };
  }

  presentSubscription(row) {
    if (!row) return null;
    let eventTypes = [];
    try { eventTypes = JSON.parse(row.event_types_json || "[]"); } catch (_) { /* invalid stored list is not exposed */ }
    return {
      subscription_id: row.subscription_id, business_id: row.business_id, name: row.name,
      target_url: row.target_url, event_types: eventTypes, enabled: row.enabled === 1,
      config_revision: Number(row.config_revision) || null,
      failure_count: row.failure_count, failure_threshold: row.failure_threshold,
      signing_secret_configured: Boolean(row.secret_env_ref && process.env[row.secret_env_ref.slice(6)]),
      created_at: row.created_at, updated_at: row.updated_at, disabled_at: row.disabled_at || null,
    };
  }

  async listSubscriptions(businessId) {
    const rows = await this.db.listOutgoingWebhookSubscriptions(businessId);
    return rows.map((row) => this.presentSubscription(row));
  }

  async enqueueEvent(event) {
    const eventType = event?.trigger_event;
    if (!this.enabled || !SUPPORTED_EVENTS.has(eventType) || !event?.business_id) return 0;
    const subscriptions = await this.db.listOutgoingWebhookSubscriptions(event.business_id);
    const sourceKey = String(event.idempotency_key || event.call_sid || event.call?.call_sid || "").trim();
    if (!sourceKey) return 0;
    const eventId = `evt_${crypto.createHash("sha256").update(`${event.business_id}:${sourceKey}`).digest("hex")}`;
    const sourcePayload = event.payload && typeof event.payload === "object"
      ? event.payload
      : event.payload_json ? parseJson(event.payload_json) : event;
    if (eventType === "post_call_outcome_classified" &&
        !OUTCOME_CLASSIFICATIONS.has(String(sourcePayload.outcome_classification || sourcePayload.context?.outcome_classification || "").toLowerCase())) return 0;
    const payload = safePayload({ ...event, event_id: eventId, payload: sourcePayload });
    const serialized = JSON.stringify(payload);
    let queued = 0;
    for (const row of subscriptions) {
      if (row.enabled !== 1) continue;
      let eventTypes = [];
      try { eventTypes = JSON.parse(row.event_types_json || "[]"); } catch (_) { continue; }
      if (!eventTypes.includes(eventType)) continue;
      await this.db.enqueueOutgoingWebhookDelivery({
        delivery_id: crypto.randomUUID(), subscription_id: row.subscription_id,
        event_id: eventId, event_type: eventType, payload_json: serialized, max_attempts: 8,
        config_revision: row.config_revision,
      });
      queued += 1;
    }
    return queued;
  }

  async listDeliveries(subscriptionId, businessId, limit) {
    const subscription = await this.db.getOutgoingWebhookSubscription(subscriptionId, businessId);
    if (!subscription) fail("Webhook subscription was not found", "not_found");
    return this.db.listOutgoingWebhookDeliveries(subscriptionId, businessId, limit);
  }

  async listRevisions(subscriptionId, businessId, limit) {
    const subscription = await this.db.getOutgoingWebhookSubscription(subscriptionId, businessId);
    if (!subscription) fail("Webhook subscription was not found", "not_found");
    const revisions = await this.db.listOutgoingWebhookSubscriptionRevisions(subscriptionId, businessId, limit);
    return revisions.map((row) => {
      let eventTypes = [];
      try { eventTypes = JSON.parse(row.event_types_json || "[]"); } catch (_) { /* invalid stored list is not exposed */ }
      const envName = SECRET_REF_PATTERN.exec(String(row.secret_env_ref || ""))?.[1];
      return {
        revision: row.revision, name: row.name, target_url: row.target_url,
        event_types: eventTypes, enabled: row.enabled === 1, failure_threshold: row.failure_threshold,
        signing_secret_configured: Boolean(envName && process.env[envName]),
        actor_id: row.actor_id, change_type: row.change_type, created_at: row.created_at,
      };
    });
  }

  async replay(deliveryId, subscriptionId, businessId) {
    const subscription = await this.db.getOutgoingWebhookSubscription(subscriptionId, businessId);
    if (!subscription) fail("Webhook subscription was not found", "not_found");
    if (!subscription.enabled) fail("Enable this webhook before replaying delivery", "conflict");
    const delivery = await this.db.getOutgoingWebhookDelivery(deliveryId, subscriptionId);
    if (!delivery) fail("Webhook delivery was not found", "not_found");
    const count = await this.db.replayOutgoingWebhookDelivery(deliveryId, subscriptionId);
    if (!count) fail("Only dead-lettered webhook deliveries can be replayed", "conflict");
    void this.drain().catch((error) => this.logError("webhook_replay_worker_failed", error));
    return { delivery_id: deliveryId, status: "pending" };
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => { void this.drain().catch((error) => this.logError("webhook_worker_failed", error)); }, this.pollMs);
    this.timer.unref?.();
    void this.drain().catch((error) => this.logError("webhook_worker_failed", error));
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async drain() {
    if (!this.enabled || this.busy || !this.db) return { processed: 0 };
    this.busy = true;
    let processed = 0;
    try {
      const rows = await this.db.listDueOutgoingWebhookDeliveries(10);
      for (const row of rows) {
        if (await this.db.claimOutgoingWebhookDelivery(row.delivery_id) !== 1) continue;
        await this.deliver(row);
        processed += 1;
      }
    } finally { this.busy = false; }
    return { processed };
  }

  async deliver(row) {
    let result;
    try {
      const url = normalizeTarget(row.target_url);
      const address = await resolvePublicAddress(url.hostname, this.resolveDns);
      const envName = SECRET_REF_PATTERN.exec(String(row.secret_env_ref || ""))?.[1];
      const secret = envName && process.env[envName];
      if (!secret || Buffer.byteLength(secret) < 32) throw Object.assign(new Error("secret_missing"), { code: "webhook_secret_unavailable" });
      const body = String(row.payload_json || "{}");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      const response = await postHttps(url, address, {
        "content-type": "application/json", "user-agent": "VOICEDNUT-Webhooks/1.0",
        "x-voicednut-delivery": row.delivery_id, "x-voicednut-event": row.event_id,
        "x-voicednut-timestamp": timestamp, "x-voicednut-signature": `v1=${signature}`,
        "idempotency-key": row.delivery_id,
      }, body, this.request);
      if (response.status >= 200 && response.status < 300) result = { delivered: true, response_status: response.status };
      else result = this.retryResult(row, "webhook_http_error", response.status);
    } catch (error) {
      const code = error?.code === "webhook_destination_rejected" ? "webhook_destination_rejected"
        : error?.code === "webhook_secret_unavailable" ? "webhook_secret_unavailable" : "webhook_delivery_failed";
      result = code === "webhook_destination_rejected" || code === "webhook_secret_unavailable"
        ? { error_code: code }
        : this.retryResult(row, code);
    }
    await this.db.finishOutgoingWebhookAttempt(row.delivery_id, { ...result, subscription_id: row.subscription_id });
  }

  retryResult(row, errorCode, responseStatus = null) {
    const attempt = Number(row.attempts) + 1;
    if (attempt >= Number(row.max_attempts)) return { error_code: errorCode, response_status: responseStatus };
    const delay = Math.min(3600, 5 * (2 ** Math.min(attempt - 1, 9)));
    return { retry: true, error_code: errorCode, response_status: responseStatus,
      next_attempt_at: new Date(Date.now() + delay * 1000).toISOString() };
  }

  logError(code, error) {
    this.logger.warn?.("Outgoing webhook worker issue", { code, error_code: error?.code || "worker_error" });
  }
}

function parseJson(value) {
  try { return JSON.parse(value || "{}"); } catch (_) { return {}; }
}

module.exports = { OutgoingWebhookService, normalizeTarget, resolvePublicAddress, safePayload };
