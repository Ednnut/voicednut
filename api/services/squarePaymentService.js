"use strict";

const crypto = require("crypto");
const { normalizePaymentEvent } = require("./paymentEventNormalizer");

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_API_VERSION = "2026-05-20";
const SQUARE_CONNECTOR_NAMES = new Set([
  "square",
  "square_checkout",
  "square-checkout",
  "square_payments",
  "square-payments",
]);
const SQUARE_STATUS_RANK = Object.freeze({
  UNKNOWN: 0,
  OPEN: 10,
  DRAFT: 10,
  PENDING: 20,
  APPROVED: 25,
  COMPLETED: 40,
  PAID: 40,
  CANCELED: 50,
  CANCELLED: 50,
  FAILED: 50,
  REFUNDED: 55,
});
const SQUARE_TERMINAL_STATUSES = new Set([
  "CANCELED",
  "CANCELLED",
  "COMPLETED",
  "FAILED",
  "PAID",
  "REFUNDED",
]);

function readDefaultConfig() {
  try {
    const config = require("../config");
    return config?.payment?.square || {};
  } catch (_) {
    return {};
  }
}

function normalizeEnvironment(value) {
  const normalized = String(value || "sandbox").trim().toLowerCase();
  return normalized === "live" || normalized === "production" ? "production" : "sandbox";
}

function getBaseUrl(environment) {
  return normalizeEnvironment(environment) === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

function normalizeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeCurrency(value, fallback = "USD") {
  const currency = String(value || fallback || "USD").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "USD";
}

function normalizeAmountCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
}

function centsToAmount(cents) {
  const parsed = Number(cents);
  if (!Number.isFinite(parsed)) return null;
  return Number((parsed / 100).toFixed(2));
}

function normalizeLimit(value, fallback = 10) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(25, Math.floor(parsed)));
}

function parseJsonField(value) {
  if (!value || typeof value !== "string") return value || null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return value;
  }
}

function normalizeDbRow(row = {}) {
  if (!row || typeof row !== "object") return row;
  return {
    ...row,
    metadata: parseJsonField(row.metadata),
    payload: parseJsonField(row.payload),
  };
}

function normalizeMetadataObject(value) {
  const parsed = parseJsonField(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function mergeSquareSessionMetadata(existingSession, nextMetadata) {
  return {
    ...normalizeMetadataObject(existingSession?.metadata),
    ...normalizeMetadataObject(nextMetadata),
  };
}

function normalizeTelemetryValue(value, maxLength = 240) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  return normalizeText(value, maxLength);
}

function sanitizeTelemetryDetails(details = {}) {
  const sanitized = {};
  Object.entries(details || {}).forEach(([key, value]) => {
    const normalizedKey = normalizeText(key, 80);
    if (!normalizedKey) return;
    if (Array.isArray(value)) {
      sanitized[normalizedKey] = value
        .map((entry) => normalizeTelemetryValue(entry, 160))
        .filter((entry) => entry !== null && entry !== "");
      return;
    }
    if (value && typeof value === "object") return;
    const normalizedValue = normalizeTelemetryValue(value);
    if (normalizedValue !== null && normalizedValue !== "") {
      sanitized[normalizedKey] = normalizedValue;
    }
  });
  return sanitized;
}

function getTelemetryHealthStatus(status) {
  const normalized = normalizeText(status, 40).toLowerCase();
  if (normalized === "ok" || normalized === "success") return "healthy";
  if (normalized === "blocked" || normalized === "duplicate" || normalized === "invalid") {
    return "degraded";
  }
  return "unhealthy";
}

function createRequestId(prefix = "square") {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function getHeader(headers = {}, name) {
  const normalizedName = String(name || "").toLowerCase();
  if (!normalizedName || !headers || typeof headers !== "object") return null;
  return Object.entries(headers).find(
    ([key]) => String(key || "").toLowerCase() === normalizedName,
  )?.[1] || null;
}

function parseSquareErrorBody(body) {
  if (!body || typeof body !== "object") return null;
  const errors = Array.isArray(body.errors) ? body.errors : [];
  return errors[0]?.detail || errors[0]?.code || body.message || null;
}

function isSquareConnectorName(value) {
  return SQUARE_CONNECTOR_NAMES.has(String(value || "").trim().toLowerCase());
}

function normalizeSquareStatus(value, fallback = "UNKNOWN") {
  const status = String(value || fallback || "UNKNOWN").trim().toUpperCase();
  return status || "UNKNOWN";
}

function shouldApplySquareWebhookStatus(currentStatus, nextStatus) {
  const current = normalizeSquareStatus(currentStatus, "");
  const next = normalizeSquareStatus(nextStatus, "");
  if (!next || next === "UNKNOWN") return !current;
  if (!current || current === "UNKNOWN") return true;
  if (current === next) return true;

  const currentRank = SQUARE_STATUS_RANK[current] ?? SQUARE_STATUS_RANK.UNKNOWN;
  const nextRank = SQUARE_STATUS_RANK[next] ?? SQUARE_STATUS_RANK.UNKNOWN;
  if (SQUARE_TERMINAL_STATUSES.has(current) && nextRank < currentRank) return false;
  return nextRank >= currentRank;
}

function getSquareWebhookStatus(eventType, resource = {}) {
  const explicitStatus = normalizeSquareStatus(
    resource.status || resource.payment?.status || resource.refund?.status || resource.order?.state,
    "",
  );
  if (explicitStatus) return explicitStatus;
  const normalizedType = String(eventType || "").toLowerCase();
  if (normalizedType.includes("payment.updated")) return "PENDING";
  if (normalizedType.includes("refund.updated")) return "REFUNDED";
  if (normalizedType.includes("order.updated")) return "PENDING";
  return "UNKNOWN";
}

function getSquareWebhookResource(webhookEvent = {}) {
  const object = webhookEvent.data?.object;
  if (object && typeof object === "object" && !Array.isArray(object)) return object;
  const data = webhookEvent.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return {};
}

function collectSquareWebhookSessionIds(resource = {}) {
  const ids = new Set();
  const add = (value) => {
    const normalized = normalizeText(value, 160);
    if (normalized) ids.add(normalized);
  };
  add(resource.id);
  add(resource.payment?.id);
  add(resource.payment?.order_id);
  add(resource.refund?.id);
  add(resource.refund?.payment_id);
  add(resource.order?.id);
  add(resource.order_id);
  add(resource.payment_link?.id);
  return Array.from(ids);
}

function collectSquareWebhookRelatedMetadata(resource = {}) {
  return {
    payment_id: normalizeText(resource.payment?.id, 160) || null,
    order_id:
      normalizeText(resource.payment?.order_id, 160) ||
      normalizeText(resource.order?.id, 160) ||
      normalizeText(resource.order_id, 160) ||
      null,
    refund_id: normalizeText(resource.refund?.id, 160) || null,
    payment_link_id: normalizeText(resource.payment_link?.id, 160) || null,
  };
}

function getSquareWebhookAmount(resource = {}) {
  const money =
    resource.amount_money ||
    resource.payment?.amount_money ||
    resource.refund?.amount_money ||
    resource.order?.total_money ||
    null;
  return {
    amount: centsToAmount(money?.amount),
    currency: normalizeCurrency(money?.currency, ""),
  };
}

class SquarePaymentService {
  constructor(options = {}) {
    this.config = {
      ...readDefaultConfig(),
      ...(options.config && typeof options.config === "object" ? options.config : {}),
    };
    this.db = options.db || null;
    this.fetchFn = options.fetchFn || require("node-fetch");
    this.now = typeof options.now === "function" ? options.now : () => new Date();
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  isConfigured() {
    return Boolean(this.config.accessToken && this.config.locationId);
  }

  baseUrl() {
    return this.config.baseUrl || getBaseUrl(this.config.environment);
  }

  async execute(action, args = {}, context = {}) {
    const actionName = normalizeText(action, 120) || "unknown";
    const localReadActions = new Set([
      "payment_session_history",
      "payment_failure_summary",
      "customer_payment_profile",
    ]);
    if (!this.isEnabled()) {
      const result = {
        error: "square_disabled",
        message: "Square connector is disabled. Set SQUARE_CONNECTOR_ENABLED=true to use it.",
      };
      await this.recordObservability("square_connector_execute", "blocked", {
        action: actionName,
        error: result.error,
      }, context);
      return result;
    }

    if (!this.isConfigured() && !localReadActions.has(actionName)) {
      const result = {
        error: "square_not_configured",
        message: "Missing SQUARE_ACCESS_TOKEN or SQUARE_LOCATION_ID.",
      };
      await this.recordObservability("square_connector_execute", "blocked", {
        action: actionName,
        error: result.error,
      }, context);
      return result;
    }

    try {
      let result;
      if (actionName === "payment_link_generate") {
        result = await this.createPaymentLink(args, context);
      } else if (actionName === "payment_retry_link_generate") {
        result = await this.createPaymentLink(args, context, {
          action: "payment_retry_link_generate",
          recovery: true,
        });
      } else if (actionName === "payment_intent_status") {
        result = await this.getPaymentStatus(args, context);
      } else if (actionName === "payment_session_history") {
        result = await this.getPaymentSessionHistory(args, context);
      } else if (actionName === "payment_failure_summary") {
        result = await this.getPaymentFailureSummary(args, context);
      } else if (actionName === "customer_payment_profile") {
        result = await this.getCustomerPaymentProfile(args, context);
      } else if (actionName === "refund_request_initiate") {
        result = await this.createRefund(args, context);
      } else {
        result = {
          error: "square_unsupported_action",
          message: `Unsupported Square payment action: ${action}`,
        };
      }

      await this.recordObservability(
        "square_connector_execute",
        result?.error ? "blocked" : "ok",
        {
          action: actionName,
          provider_action: result?.provider_action,
          error: result?.error,
        },
        context,
      );
      return result;
    } catch (error) {
      const result = {
        error: "square_request_failed",
        message: String(error?.message || "Square request failed."),
      };
      await this.recordObservability("square_connector_execute", "error", {
        action: actionName,
        error: result.error,
        error_message: result.message,
      }, context);
      return result;
    }
  }

  async recordObservability(event, status, details = {}, context = {}) {
    const safeDetails = sanitizeTelemetryDetails({
      provider: "square",
      event,
      status,
      environment: normalizeText(this.config.environment || "sandbox", 40),
      ...details,
    });
    const tasks = [];
    const addTask = (operation) => {
      try {
        const task = operation();
        if (task && typeof task.then === "function") tasks.push(task);
      } catch (_) {
        // Observability must never change payment behavior.
      }
    };
    if (typeof this.db?.logServiceHealth === "function") {
      addTask(() =>
        this.db.logServiceHealth(
          "square_connector",
          getTelemetryHealthStatus(status),
          safeDetails,
        ),
      );
    }
    const callSid = normalizeText(context?.callSid || details.call_sid, 160);
    if (callSid && typeof this.db?.addCallMetric === "function") {
      addTask(() => this.db.addCallMetric(callSid, "square_connector_event", 1, safeDetails));
    }
    if (tasks.length === 0) return;
    await Promise.allSettled(tasks);
  }

  async resolveWebhookSessionIds(sessionIds = []) {
    const uniqueIds = Array.from(
      new Set(sessionIds.map((id) => normalizeText(id, 160)).filter(Boolean)),
    );
    if (uniqueIds.length === 0) return [];

    const resolvedIds = new Set();
    const unresolvedIds = [];
    for (const sessionId of uniqueIds) {
      let matchedSession = null;
      if (typeof this.db?.getSquarePaymentSession === "function") {
        matchedSession = await this.db.getSquarePaymentSession(sessionId);
      }
      if (!matchedSession && typeof this.db?.findSquarePaymentSessionByRelatedId === "function") {
        matchedSession = await this.db.findSquarePaymentSessionByRelatedId(sessionId);
      }
      if (matchedSession?.external_id) {
        resolvedIds.add(matchedSession.external_id);
      } else {
        unresolvedIds.push(sessionId);
      }
    }

    return resolvedIds.size > 0 ? Array.from(resolvedIds) : unresolvedIds;
  }

  async createPaymentLink(args = {}, context = {}, options = {}) {
    const amountCents = normalizeAmountCents(args.amount);
    if (!amountCents) {
      return { error: "invalid_amount", message: "amount must be a positive number." };
    }
    const currency = normalizeCurrency(args.currency, this.config.defaultCurrency);
    const description =
      normalizeText(args.description, 255) ||
      normalizeText(context?.callConfig?.payment_description, 255) ||
      (options.recovery ? "Voice payment retry" : "Voice payment");
    const idempotencyKey =
      args.idempotency_key || args.idempotencyKey || createRequestId("square-checkout");
    const returnUrl = normalizeText(args.return_url || this.config.returnUrl, 2048);
    const customerEmail = normalizeText(args.customer_email || args.email, 254);
    const body = {
      idempotency_key: idempotencyKey,
      quick_pay: {
        name: description,
        price_money: {
          amount: amountCents,
          currency,
        },
        location_id: this.config.locationId,
      },
      checkout_options: returnUrl ? { redirect_url: returnUrl } : undefined,
      pre_populated_data: customerEmail ? { buyer_email: customerEmail } : undefined,
    };
    const response = await this.request("/v2/online-checkout/payment-links", {
      method: "POST",
      body,
    });
    const paymentLink = response.payment_link || {};
    const orderId = paymentLink.order_id || response.related_resources?.orders?.[0]?.id || null;
    const linkId = paymentLink.id || response.id || idempotencyKey;

    await this.saveSession({
      call_sid: context.callSid || null,
      action: options.action || "payment_link_generate",
      external_id: linkId,
      status: "OPEN",
      amount: centsToAmount(amountCents),
      currency,
      approval_url: paymentLink.url || null,
      idempotency_key: idempotencyKey,
      metadata: {
        connector: "square",
        description,
        order_id: orderId,
        recovery: Boolean(options.recovery),
      },
    });

    return {
      provider: "square",
      provider_action: options.recovery
        ? "create_recovery_payment_link"
        : "create_payment_link",
      payment_link_id: linkId,
      checkout_session_id: linkId,
      order_id: orderId,
      payment_url: paymentLink.url || null,
      approval_url: paymentLink.url || null,
      status_value: "OPEN",
      amount: centsToAmount(amountCents),
      currency,
      expires_at: null,
      recovery: Boolean(options.recovery),
    };
  }

  async getPaymentStatus(args = {}) {
    const paymentId = normalizeText(
      args.payment_id || args.payment_intent_id || args.square_payment_id,
      160,
    );
    const refundId = normalizeText(args.refund_id || args.square_refund_id, 160);
    const orderId = normalizeText(args.order_id || args.square_order_id, 160);
    const paymentLinkId = normalizeText(
      args.payment_link_id || args.checkout_session_id || args.square_payment_link_id,
      160,
    );

    if (paymentId) {
      const response = await this.request(`/v2/payments/${encodeURIComponent(paymentId)}`);
      const payment = response.payment || {};
      return {
        provider: "square",
        provider_action: "get_payment",
        payment_id: payment.id || paymentId,
        payment_intent_id: payment.id || paymentId,
        order_id: payment.order_id || null,
        status_value: payment.status || "UNKNOWN",
        amount: centsToAmount(payment.amount_money?.amount),
        currency: normalizeCurrency(payment.amount_money?.currency, ""),
        updated_at: this.now().toISOString(),
      };
    }
    if (refundId) {
      const response = await this.request(`/v2/refunds/${encodeURIComponent(refundId)}`);
      const refund = response.refund || {};
      return {
        provider: "square",
        provider_action: "get_refund",
        refund_id: refund.id || refundId,
        payment_id: refund.payment_id || null,
        status_value: refund.status || "UNKNOWN",
        updated_at: this.now().toISOString(),
      };
    }
    if (orderId) {
      const response = await this.request(`/v2/orders/${encodeURIComponent(orderId)}`);
      const order = response.order || {};
      return {
        provider: "square",
        provider_action: "get_order",
        order_id: order.id || orderId,
        status_value: order.state || "UNKNOWN",
        amount: centsToAmount(order.total_money?.amount),
        currency: normalizeCurrency(order.total_money?.currency, ""),
        updated_at: this.now().toISOString(),
      };
    }
    if (paymentLinkId) {
      const response = await this.request(
        `/v2/online-checkout/payment-links/${encodeURIComponent(paymentLinkId)}`,
      );
      const paymentLink = response.payment_link || {};
      return {
        provider: "square",
        provider_action: "get_payment_link",
        payment_link_id: paymentLink.id || paymentLinkId,
        checkout_session_id: paymentLink.id || paymentLinkId,
        order_id: paymentLink.order_id || null,
        status_value: paymentLink.version ? "OPEN" : "UNKNOWN",
        payment_url: paymentLink.url || null,
        updated_at: this.now().toISOString(),
      };
    }

    return {
      error: "invalid_square_payment_lookup",
      message:
        "payment_id, payment_intent_id, payment_link_id, checkout_session_id, order_id, or refund_id is required.",
    };
  }

  async getPaymentSessionHistory(args = {}, context = {}) {
    const externalId = normalizeText(
      args.payment_id ||
        args.payment_intent_id ||
        args.checkout_session_id ||
        args.payment_link_id ||
        args.order_id ||
        args.refund_id ||
        args.external_id,
      160,
    );
    const callSid = normalizeText(args.call_sid || context.callSid, 160);
    if (!externalId && !callSid) {
      return {
        error: "invalid_payment_session_lookup",
        message:
          "payment_id, payment_link_id, order_id, refund_id, or call_sid is required.",
      };
    }

    if (
      typeof this.db?.listSquarePaymentSessions !== "function" ||
      typeof this.db?.listSquarePaymentEvents !== "function"
    ) {
      return {
        provider: "square",
        provider_action: "payment_session_history",
        status_value: "UNAVAILABLE",
        query: {
          external_id: externalId || null,
          call_sid: callSid || null,
        },
        sessions: [],
        events: [],
        message: "Square local payment history is unavailable because persistence helpers are not configured.",
      };
    }

    const limit = normalizeLimit(args.limit, 10);
    const query = {
      external_id: externalId || null,
      call_sid: callSid || null,
      limit,
    };
    const [sessions, events] = await Promise.all([
      this.db.listSquarePaymentSessions(query),
      this.db.listSquarePaymentEvents(query),
    ]);
    const normalizedSessions = (Array.isArray(sessions) ? sessions : []).map(normalizeDbRow);
    const normalizedEvents = (Array.isArray(events) ? events : []).map(normalizeDbRow);
    const latestSession = normalizedSessions[0] || null;
    const latestEvent = normalizedEvents[0] || null;

    return {
      provider: "square",
      provider_action: "payment_session_history",
      payment_id: externalId || latestSession?.external_id || latestEvent?.resource_id || null,
      payment_intent_id:
        externalId || latestSession?.external_id || latestEvent?.resource_id || null,
      status_value: latestSession?.status || latestEvent?.status || "UNKNOWN",
      query,
      sessions: normalizedSessions,
      events: normalizedEvents,
      updated_at: latestSession?.updated_at || latestEvent?.created_at || this.now().toISOString(),
    };
  }

  async getPaymentFailureSummary(args = {}, context = {}) {
    const history = await this.getPaymentSessionHistory(args, context);
    if (history.error) return history;
    return buildFailureSummary("square", history, this.now());
  }

  async getCustomerPaymentProfile(args = {}, context = {}) {
    const customerRef = normalizeText(
      args.customer_ref || args.customer_id || args.customer_email || args.email,
      160,
    );
    const callSid = normalizeText(args.call_sid || context.callSid, 160);
    if (!customerRef && !callSid) {
      return {
        error: "invalid_customer_payment_profile_lookup",
        message: "customer_ref, customer_id, customer_email, or call_sid is required.",
      };
    }
    const history = await this.getPaymentSessionHistory(
      {
        ...args,
        call_sid: callSid,
        limit: args.limit || 10,
      },
      context,
    );
    if (history.error) return history;
    return {
      provider: "square",
      provider_action: "customer_payment_profile",
      customer_ref: customerRef || null,
      call_sid: callSid || null,
      latest_status: history.status_value || "UNKNOWN",
      session_count: Array.isArray(history.sessions) ? history.sessions.length : 0,
      event_count: Array.isArray(history.events) ? history.events.length : 0,
      sessions: history.sessions || [],
      events: history.events || [],
      updated_at: history.updated_at || this.now().toISOString(),
    };
  }

  async createRefund(args = {}, context = {}) {
    const paymentId = normalizeText(
      args.payment_id || args.payment_intent_id || args.square_payment_id,
      160,
    );
    if (!paymentId) {
      return {
        error: "missing_square_refund_target",
        message: "Square refunds require payment_id or payment_intent_id.",
      };
    }

    const amountCents =
      args.amount == null || args.amount === "" ? null : normalizeAmountCents(args.amount);
    const currency = normalizeCurrency(args.currency, this.config.defaultCurrency);
    const idempotencyKey = args.idempotency_key || args.idempotencyKey || createRequestId("refund");
    const response = await this.request("/v2/refunds", {
      method: "POST",
      body: {
        idempotency_key: idempotencyKey,
        payment_id: paymentId,
        reason: normalizeText(args.reason || args.note, 192) || undefined,
        amount_money: amountCents
          ? {
              amount: amountCents,
              currency,
            }
          : undefined,
      },
    });
    const refund = response.refund || {};

    await this.saveSession({
      call_sid: context.callSid || null,
      action: "refund_request_initiate",
      external_id: refund.id || idempotencyKey,
      status: refund.status || "PENDING",
      amount: centsToAmount(amountCents || refund.amount_money?.amount),
      currency: normalizeCurrency(refund.amount_money?.currency || currency, this.config.defaultCurrency),
      approval_url: null,
      idempotency_key: idempotencyKey,
      metadata: {
        connector: "square",
        payment_id: paymentId,
      },
    });

    return {
      provider: "square",
      provider_action: "refund_payment",
      refund_request_id: refund.id || idempotencyKey,
      refund_id: refund.id || idempotencyKey,
      payment_id: refund.payment_id || paymentId,
      payment_intent_id: refund.payment_id || paymentId,
      state: String(refund.status || "PENDING").toLowerCase(),
      created_at: this.now().toISOString(),
    };
  }

  async verifyWebhookSignature(rawBody, headers = {}) {
    if (!this.config.webhookSignatureKey || !this.config.webhookUrl) {
      const result = {
        ok: false,
        error: "square_webhook_not_configured",
        message: "Missing SQUARE_WEBHOOK_SIGNATURE_KEY or SQUARE_WEBHOOK_URL.",
      };
      await this.recordObservability("square_webhook_verification", "blocked", {
        error: result.error,
      });
      return result;
    }

    const signature = String(getHeader(headers, "x-square-hmacsha256-signature") || "");
    if (!signature) {
      const result = {
        ok: false,
        error: "missing_square_webhook_signature",
        message: "Missing Square webhook signature header.",
      };
      await this.recordObservability("square_webhook_verification", "blocked", {
        error: result.error,
      });
      return result;
    }

    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
    const expected = crypto
      .createHmac("sha256", this.config.webhookSignatureKey)
      .update(`${this.config.webhookUrl}${body}`, "utf8")
      .digest("base64");
    const ok = safeCompareBase64(signature, expected);
    const result = ok
      ? { ok: true, verification_status: "SUCCESS" }
      : {
          ok: false,
          error: "square_webhook_signature_invalid",
          message: "Square webhook signature verification failed.",
          verification_status: "FAILURE",
        };
    await this.recordObservability("square_webhook_verification", ok ? "ok" : "blocked", {
      error: result.error,
      verification_status: result.verification_status,
    });
    return result;
  }

  async handleWebhookEvent(webhookEvent = {}) {
    if (!webhookEvent || typeof webhookEvent !== "object" || Array.isArray(webhookEvent)) {
      const result = {
        ok: false,
        error: "invalid_square_webhook",
        message: "Square webhook body must be a JSON object.",
      };
      await this.recordObservability("square_webhook_reconcile", "invalid", {
        error: result.error,
      });
      return result;
    }

    const eventId = normalizeText(webhookEvent.event_id || webhookEvent.id, 160);
    const eventType = normalizeText(webhookEvent.type, 160);
    const resource = getSquareWebhookResource(webhookEvent);
    const resourceId = normalizeText(resource.id || resource.payment?.id || resource.refund?.id, 160);
    const status = getSquareWebhookStatus(eventType, resource);
    if (!eventId || !eventType) {
      const result = {
        ok: false,
        error: "invalid_square_webhook",
        message: "Square webhook body must include event_id/id and type.",
      };
      await this.recordObservability("square_webhook_reconcile", "invalid", {
        event_id: eventId,
        event_type: eventType,
        error: result.error,
      });
      return result;
    }

    const amount = getSquareWebhookAmount(resource);
    const sessionIds = collectSquareWebhookSessionIds(resource);
    const relatedMetadata = collectSquareWebhookRelatedMetadata(resource);
    const targetSessionIds = await this.resolveWebhookSessionIds(sessionIds);
    const preferredResourceId = targetSessionIds[0] || resourceId || sessionIds[0] || null;
    const normalizedEvent = normalizePaymentEvent("square", webhookEvent, {
      resource,
      resource_id: preferredResourceId,
      status,
      amount: amount.amount,
      currency: amount.currency,
    });

    if (typeof this.db?.recordSquarePaymentEvent === "function") {
      const eventRecord = await this.db.recordSquarePaymentEvent({
        external_event_id: eventId,
        event_type: eventType,
        resource_id: preferredResourceId,
        status,
        payload: webhookEvent,
        normalized_event: normalizedEvent,
      });
      if (eventRecord?.inserted === false) {
        const result = {
          ok: true,
          duplicate: true,
          event_id: eventId,
          event_type: eventType,
          resource_id: preferredResourceId,
          status,
          normalized_event: normalizedEvent,
          updated_sessions: 0,
        };
        await this.recordObservability("square_webhook_reconcile", "duplicate", {
          event_id: eventId,
          event_type: eventType,
          resource_id: result.resource_id,
          square_status: status,
          updated_sessions: 0,
        });
        return result;
      }
    }

    let updatedSessions = 0;
    const ignoredSessionIds = [];
    for (const sessionId of targetSessionIds) {
      const updateResult = await this.updateSessionFromWebhook(sessionId, {
        status,
        amount: amount.amount,
        currency: amount.currency,
        metadata: {
          connector: "square",
          source: "webhook",
          ...relatedMetadata,
          event_id: eventId,
          event_type: eventType,
          resource_id: preferredResourceId,
          square_resource_id: resourceId || null,
        },
      });
      updatedSessions += updateResult.updated;
      if (updateResult.ignored) ignoredSessionIds.push(sessionId);
    }

    const result = {
      ok: true,
      duplicate: false,
      event_id: eventId,
      event_type: eventType,
      resource_id: preferredResourceId,
      status,
      normalized_event: normalizedEvent,
      updated_sessions: updatedSessions,
      ...(ignoredSessionIds.length > 0 ? { ignored_sessions: ignoredSessionIds } : {}),
    };
    await this.recordObservability("square_webhook_reconcile", "ok", {
      event_id: eventId,
      event_type: eventType,
      resource_id: result.resource_id,
      square_status: status,
      updated_sessions: updatedSessions,
      ignored_sessions: ignoredSessionIds.length,
    });
    return result;
  }

  async saveSession(payload) {
    if (typeof this.db?.upsertSquarePaymentSession !== "function") return;
    await this.db.upsertSquarePaymentSession(payload);
  }

  async updateSessionFromWebhook(externalId, payload = {}) {
    const normalizedId = normalizeText(externalId, 160);
    if (!normalizedId) return { updated: 0, ignored: false };
    let existingSession = null;
    if (typeof this.db?.getSquarePaymentSession === "function") {
      existingSession = await this.db.getSquarePaymentSession(normalizedId);
      if (
        existingSession?.external_id &&
        !shouldApplySquareWebhookStatus(existingSession.status, payload.status)
      ) {
        return { updated: 0, ignored: true, retained_status: existingSession.status };
      }
    }
    if (typeof this.db?.updateSquarePaymentSessionStatus === "function") {
      const updatePayload = existingSession?.external_id
        ? { ...payload, metadata: mergeSquareSessionMetadata(existingSession, payload.metadata) }
        : payload;
      const changes = await this.db.updateSquarePaymentSessionStatus(normalizedId, updatePayload);
      if (changes > 0) return { updated: changes, ignored: false };
    }
    await this.saveSession({
      action: "square_webhook",
      external_id: normalizedId,
      status: payload.status || null,
      amount: payload.amount || null,
      currency: payload.currency || null,
      metadata: payload.metadata || null,
    });
    return { updated: 1, ignored: false };
  }

  async request(path, options = {}) {
    const method = options.method || "GET";
    const response = await this.fetchWithTimeout(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        accept: "application/json",
        "Square-Version": this.config.apiVersion || DEFAULT_API_VERSION,
        ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      },
      ...(method !== "GET" ? { body: JSON.stringify(options.body || {}) } : {}),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(parseSquareErrorBody(body) || `Square request failed: ${response.status}`);
    }
    return body || {};
  }

  async fetchWithTimeout(url, options = {}) {
    const timeoutMs = Math.max(
      1000,
      Math.min(30000, Number(this.config.timeoutMs) || DEFAULT_TIMEOUT_MS),
    );
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await this.fetchFn(url, {
        ...options,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

function safeCompareBase64(left, right) {
  try {
    const leftBuffer = Buffer.from(String(left || ""), "base64");
    const rightBuffer = Buffer.from(String(right || ""), "base64");
    return (
      leftBuffer.length === rightBuffer.length &&
      leftBuffer.length > 0 &&
      crypto.timingSafeEqual(leftBuffer, rightBuffer)
    );
  } catch (_) {
    return false;
  }
}

function buildFailureSummary(provider, history = {}, now = () => new Date()) {
  const rows = [
    ...(Array.isArray(history.sessions) ? history.sessions : []),
    ...(Array.isArray(history.events) ? history.events : []),
  ];
  const counts = rows.reduce(
    (acc, row = {}) => {
      const status = normalizeSquareStatus(row.status || row.status_value, "UNKNOWN");
      if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") acc.failed += 1;
      else if (status === "PAID" || status === "COMPLETED") acc.succeeded += 1;
      else if (status === "PENDING" || status === "OPEN" || status === "APPROVED") acc.pending += 1;
      else acc.unknown += 1;
      return acc;
    },
    { failed: 0, pending: 0, succeeded: 0, unknown: 0 },
  );
  return {
    provider,
    provider_action: "payment_failure_summary",
    status_value: counts.failed > 0 ? "FAILED" : history.status_value || "UNKNOWN",
    counts,
    recommended_action:
      counts.failed > 0 ? "payment_retry_link_generate" : "monitor_payment_status",
    query: history.query || null,
    updated_at: history.updated_at || now().toISOString(),
  };
}

function createSquarePaymentService(options = {}) {
  return new SquarePaymentService(options);
}

module.exports = {
  DEFAULT_API_VERSION,
  SQUARE_CONNECTOR_NAMES,
  SquarePaymentService,
  createSquarePaymentService,
  getBaseUrl,
  isSquareConnectorName,
  shouldApplySquareWebhookStatus,
};
