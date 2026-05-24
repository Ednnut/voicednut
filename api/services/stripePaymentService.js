"use strict";

const crypto = require("crypto");
const { normalizePaymentEvent } = require("./paymentEventNormalizer");

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_API_VERSION = "2026-02-25.clover";
const STRIPE_CONNECTOR_NAMES = new Set([
  "stripe",
  "stripe_checkout",
  "stripe-checkout",
  "stripe_payments",
  "stripe-payments",
]);
const STRIPE_STATUS_RANK = Object.freeze({
  UNKNOWN: 0,
  OPEN: 10,
  REQUIRES_PAYMENT_METHOD: 10,
  REQUIRES_CONFIRMATION: 12,
  REQUIRES_ACTION: 15,
  PROCESSING: 20,
  PENDING: 20,
  COMPLETE: 30,
  PAID: 35,
  SUCCEEDED: 35,
  CANCELED: 40,
  CANCELLED: 40,
  EXPIRED: 40,
  FAILED: 40,
  REFUNDED: 45,
});
const STRIPE_TERMINAL_STATUSES = new Set([
  "CANCELED",
  "CANCELLED",
  "COMPLETE",
  "EXPIRED",
  "FAILED",
  "PAID",
  "REFUNDED",
  "SUCCEEDED",
]);

function readDefaultConfig() {
  try {
    const config = require("../config");
    return config?.payment?.stripe || {};
  } catch (_) {
    return {};
  }
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

function normalizeDbRow(row = {}) {
  if (!row || typeof row !== "object") return row;
  const parseJsonField = (value) => {
    if (!value || typeof value !== "string") return value || null;
    try {
      return JSON.parse(value);
    } catch (_) {
      return value;
    }
  };
  return {
    ...row,
    metadata: parseJsonField(row.metadata),
    payload: parseJsonField(row.payload),
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

function createRequestId(prefix = "stripe") {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function getHeader(headers = {}, name) {
  const normalizedName = String(name || "").toLowerCase();
  if (!normalizedName || !headers || typeof headers !== "object") return null;
  return (
    Object.entries(headers).find(
      ([key]) => String(key || "").toLowerCase() === normalizedName,
    )?.[1] || null
  );
}

function appendFormValue(params, key, value) {
  if (!key || value === undefined || value === null || value === "") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendFormValue(params, `${key}[${index}]`, entry));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([childKey, childValue]) => {
      appendFormValue(params, `${key}[${childKey}]`, childValue);
    });
    return;
  }
  params.append(key, String(value));
}

function toStripeFormBody(body = {}) {
  const params = new URLSearchParams();
  Object.entries(body || {}).forEach(([key, value]) => appendFormValue(params, key, value));
  return params.toString();
}

function parseStripeErrorBody(body) {
  if (!body || typeof body !== "object") return null;
  return body.error?.message || body.message || null;
}

function isStripeConnectorName(value) {
  return STRIPE_CONNECTOR_NAMES.has(String(value || "").trim().toLowerCase());
}

function normalizeStripeStatus(value, fallback = "UNKNOWN") {
  const status = String(value || fallback || "UNKNOWN").trim().toUpperCase();
  return status || "UNKNOWN";
}

function shouldApplyStripeWebhookStatus(currentStatus, nextStatus) {
  const current = normalizeStripeStatus(currentStatus, "");
  const next = normalizeStripeStatus(nextStatus, "");
  if (!next || next === "UNKNOWN") return !current;
  if (!current || current === "UNKNOWN") return true;
  if (current === next) return true;

  const currentRank = STRIPE_STATUS_RANK[current] ?? STRIPE_STATUS_RANK.UNKNOWN;
  const nextRank = STRIPE_STATUS_RANK[next] ?? STRIPE_STATUS_RANK.UNKNOWN;
  if (STRIPE_TERMINAL_STATUSES.has(current) && nextRank < currentRank) return false;
  return nextRank >= currentRank;
}

function getStripeWebhookStatus(eventType, resource = {}) {
  const explicitStatus = normalizeStripeStatus(
    resource.payment_status || resource.status || resource.refund_status,
    "",
  );
  if (explicitStatus) return explicitStatus;
  switch (String(eventType || "").toLowerCase()) {
    case "checkout.session.completed":
    case "payment_intent.succeeded":
    case "invoice.paid":
      return "SUCCEEDED";
    case "checkout.session.expired":
      return "EXPIRED";
    case "payment_intent.payment_failed":
    case "invoice.payment_failed":
      return "FAILED";
    case "charge.refunded":
    case "refund.succeeded":
    case "refund.updated":
      return "REFUNDED";
    default:
      return "UNKNOWN";
  }
}

function collectStripeWebhookSessionIds(resource = {}) {
  const ids = new Set();
  const add = (value) => {
    const normalized = normalizeText(value, 160);
    if (normalized) ids.add(normalized);
  };
  add(resource.id);
  add(resource.payment_intent);
  add(resource.checkout_session);
  add(resource.invoice);
  add(resource.charge);
  add(resource.refund);
  add(resource.metadata?.payment_intent_id);
  add(resource.metadata?.checkout_session_id);
  return Array.from(ids);
}

function getStripeWebhookAmount(resource = {}) {
  const cents =
    resource.amount_total ??
    resource.amount_received ??
    resource.amount_paid ??
    resource.amount_refunded ??
    resource.amount;
  return {
    amount: centsToAmount(cents),
    currency: normalizeCurrency(resource.currency, ""),
  };
}

function buildFailureSummary(provider, history = {}, nowIso) {
  const sessions = Array.isArray(history.sessions) ? history.sessions : [];
  const events = Array.isArray(history.events) ? history.events : [];
  const records = [...sessions, ...events];
  const failedStatuses = new Set(["CANCELED", "CANCELLED", "EXPIRED", "FAILED"]);
  const successStatuses = new Set(["COMPLETE", "PAID", "SUCCEEDED"]);
  const failed = records.filter((record) =>
    failedStatuses.has(normalizeStripeStatus(record.status || record.status_value, "")),
  );
  const successful = records.filter((record) =>
    successStatuses.has(normalizeStripeStatus(record.status || record.status_value, "")),
  );
  const latestFailure = failed[0] || null;
  return {
    provider,
    provider_action: "payment_failure_summary",
    payment_intent_id: history.payment_intent_id || history.query?.external_id || null,
    call_sid: history.query?.call_sid || null,
    failed_attempts: failed.length,
    successful_payments: successful.length,
    latest_failure: latestFailure,
    recommended_action: failed.length > 0 && successful.length === 0 ? "send_retry_link" : "none",
    updated_at: history.updated_at || nowIso,
  };
}

function toUnixDateTime(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return new Date(parsed * 1000).toISOString();
}

class StripePaymentService {
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
    return Boolean(this.config.secretKey);
  }

  baseUrl() {
    return this.config.baseUrl || "https://api.stripe.com";
  }

  async execute(action, args = {}, context = {}) {
    const actionName = normalizeText(action, 120) || "unknown";
    if (!this.isEnabled()) {
      const result = {
        error: "stripe_disabled",
        message: "Stripe connector is disabled. Set STRIPE_CONNECTOR_ENABLED=true to use it.",
      };
      await this.recordObservability("stripe_connector_execute", "blocked", {
        action: actionName,
        error: result.error,
      }, context);
      return result;
    }

    const isLocalHistoryAction = new Set([
      "payment_session_history",
      "payment_failure_summary",
      "customer_payment_profile",
    ]).has(actionName);
    if (!this.isConfigured() && !isLocalHistoryAction) {
      const result = {
        error: "stripe_not_configured",
        message: "Missing STRIPE_SECRET_KEY.",
      };
      await this.recordObservability("stripe_connector_execute", "blocked", {
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
      } else if (actionName === "invoice_create") {
        result = await this.createInvoice(args, context);
      } else if (actionName === "invoice_reminder_send") {
        result = await this.sendInvoiceReminder(args, context);
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
          error: "stripe_unsupported_action",
          message: `Unsupported Stripe payment action: ${action}`,
        };
      }

      await this.recordObservability(
        "stripe_connector_execute",
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
        error: "stripe_request_failed",
        message: String(error?.message || "Stripe request failed."),
      };
      await this.recordObservability("stripe_connector_execute", "error", {
        action: actionName,
        error: result.error,
        error_message: result.message,
      }, context);
      return result;
    }
  }

  async recordObservability(event, status, details = {}, context = {}) {
    const safeDetails = sanitizeTelemetryDetails({
      provider: "stripe",
      event,
      status,
      environment: normalizeText(this.config.environment || "test", 40),
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
          "stripe_connector",
          getTelemetryHealthStatus(status),
          safeDetails,
        ),
      );
    }
    const callSid = normalizeText(context?.callSid || details.call_sid, 160);
    if (callSid && typeof this.db?.addCallMetric === "function") {
      addTask(() => this.db.addCallMetric(callSid, "stripe_connector_event", 1, safeDetails));
    }
    if (tasks.length === 0) return;
    await Promise.allSettled(tasks);
  }

  async createPaymentLink(args = {}, context = {}, options = {}) {
    const amountCents = normalizeAmountCents(args.amount);
    if (!amountCents) {
      return { error: "invalid_amount", message: "amount must be a positive number." };
    }

    const successUrl = normalizeText(
      args.return_url || args.success_url || this.config.returnUrl,
      2048,
    );
    if (!successUrl) {
      return {
        error: "missing_stripe_return_url",
        message: "Stripe Checkout requires STRIPE_RETURN_URL or return_url.",
      };
    }

    const currency = normalizeCurrency(args.currency, this.config.defaultCurrency);
    const description =
      normalizeText(args.description, 255) ||
      normalizeText(context?.callConfig?.payment_description, 255) ||
      (options.recovery ? "Voice payment retry" : "Voice payment");
    const idempotencyKey = args.idempotency_key || args.idempotencyKey || createRequestId("checkout");
    const session = await this.request("/v1/checkout/sessions", {
      method: "POST",
      idempotencyKey,
      body: {
        mode: "payment",
        success_url: successUrl,
        cancel_url: normalizeText(args.cancel_url || this.config.cancelUrl, 2048) || undefined,
        client_reference_id: normalizeText(args.customer_ref || context.callSid, 255) || undefined,
        customer_email: normalizeText(args.customer_email || args.email, 254) || undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: amountCents,
              product_data: {
                name: description,
                description,
              },
            },
          },
        ],
        metadata: {
          connector: "stripe",
          call_sid: normalizeText(context.callSid, 160) || undefined,
          customer_ref: normalizeText(args.customer_ref, 120) || undefined,
        },
      },
    });

    await this.saveSession({
      call_sid: context.callSid || null,
      action: options.action || "payment_link_generate",
      external_id: session.id,
      status: session.payment_status || session.status || "open",
      amount: centsToAmount(amountCents),
      currency,
      approval_url: session.url || null,
      idempotency_key: idempotencyKey,
      metadata: {
        connector: "stripe",
        description,
        payment_intent_id: session.payment_intent || null,
      },
    });

    return {
      provider: "stripe",
      provider_action: options.recovery
        ? "create_recovery_checkout_session"
        : "create_checkout_session",
      payment_link_id: session.id,
      payment_intent_id: session.payment_intent || session.id,
      checkout_session_id: session.id,
      payment_url: session.url || null,
      approval_url: session.url || null,
      status_value: session.payment_status || session.status || "open",
      amount: centsToAmount(amountCents),
      currency,
      expires_at: toUnixDateTime(session.expires_at),
      recovery: Boolean(options.recovery),
    };
  }

  async createInvoice(args = {}, context = {}) {
    const amountCents = normalizeAmountCents(args.amount);
    if (!amountCents) {
      return { error: "invalid_amount", message: "amount must be a positive number." };
    }

    const customerId = normalizeText(args.customer_id || args.stripe_customer_id, 120);
    const customerEmail = normalizeText(args.customer_email || args.email, 254);
    if (!customerId && !customerEmail) {
      return {
        error: "missing_invoice_customer",
        message: "Stripe invoice creation requires customer_id or customer_email.",
      };
    }

    const currency = normalizeCurrency(args.currency, this.config.defaultCurrency);
    const description = normalizeText(args.description, 255) || "Voice invoice";
    const idempotencyBase = args.idempotency_key || args.idempotencyKey || createRequestId("invoice");
    let resolvedCustomerId = customerId;
    if (!resolvedCustomerId) {
      const customer = await this.request("/v1/customers", {
        method: "POST",
        idempotencyKey: `${idempotencyBase}-customer`,
        body: {
          email: customerEmail,
          metadata: {
            connector: "stripe",
            call_sid: normalizeText(context.callSid, 160) || undefined,
          },
        },
      });
      resolvedCustomerId = customer.id;
    }

    await this.request("/v1/invoiceitems", {
      method: "POST",
      idempotencyKey: `${idempotencyBase}-item`,
      body: {
        customer: resolvedCustomerId,
        amount: amountCents,
        currency,
        description,
      },
    });

    const invoice = await this.request("/v1/invoices", {
      method: "POST",
      idempotencyKey: idempotencyBase,
      body: {
        customer: resolvedCustomerId,
        collection_method: "send_invoice",
        days_until_due: Math.max(1, Math.min(365, Number(args.days_until_due) || 7)),
        description,
        metadata: {
          connector: "stripe",
          call_sid: normalizeText(context.callSid, 160) || undefined,
          customer_ref: normalizeText(args.customer_ref, 120) || undefined,
        },
      },
    });

    let finalInvoice = invoice;
    if (args.finalize !== false) {
      finalInvoice = await this.request(`/v1/invoices/${encodeURIComponent(invoice.id)}/finalize`, {
        method: "POST",
        idempotencyKey: `${idempotencyBase}-finalize`,
        body: {},
      });
    }
    if (args.send_invoice === true || args.send === true) {
      finalInvoice = await this.request(`/v1/invoices/${encodeURIComponent(invoice.id)}/send`, {
        method: "POST",
        idempotencyKey: `${idempotencyBase}-send`,
        body: {},
      });
    }

    await this.saveSession({
      call_sid: context.callSid || null,
      action: "invoice_create",
      external_id: finalInvoice.id || invoice.id,
      status: finalInvoice.status || invoice.status || "draft",
      amount: centsToAmount(amountCents),
      currency,
      approval_url: finalInvoice.hosted_invoice_url || null,
      idempotency_key: idempotencyBase,
      metadata: {
        connector: "stripe",
        customer_id: resolvedCustomerId,
        customer_email: customerEmail || null,
      },
    });

    return {
      provider: "stripe",
      provider_action: "create_invoice",
      invoice_id: finalInvoice.id || invoice.id,
      invoice_url: finalInvoice.hosted_invoice_url || null,
      customer_ref: normalizeText(args.customer_ref, 80),
      status_value: finalInvoice.status || invoice.status || "draft",
      amount: centsToAmount(amountCents),
      currency,
      due_date: finalInvoice.due_date ? toUnixDateTime(finalInvoice.due_date) : null,
    };
  }

  async sendInvoiceReminder(args = {}, context = {}) {
    const invoiceId = normalizeText(args.invoice_id || args.stripe_invoice_id, 160);
    if (!invoiceId) {
      return {
        error: "missing_stripe_invoice_id",
        message: "Stripe invoice reminders require invoice_id.",
      };
    }
    const idempotencyKey = args.idempotency_key || args.idempotencyKey || createRequestId("invoice-send");
    const invoice = await this.request(`/v1/invoices/${encodeURIComponent(invoiceId)}/send`, {
      method: "POST",
      idempotencyKey,
      body: {},
    });

    await this.saveSession({
      call_sid: context.callSid || null,
      action: "invoice_reminder_send",
      external_id: invoice.id || invoiceId,
      status: invoice.status || "sent",
      amount: centsToAmount(invoice.amount_due || invoice.amount_remaining),
      currency: normalizeCurrency(invoice.currency, this.config.defaultCurrency),
      approval_url: invoice.hosted_invoice_url || null,
      idempotency_key: idempotencyKey,
      metadata: {
        connector: "stripe",
        customer_id: invoice.customer || null,
      },
    });

    return {
      provider: "stripe",
      provider_action: "send_invoice_reminder",
      invoice_id: invoice.id || invoiceId,
      invoice_url: invoice.hosted_invoice_url || null,
      customer_ref: normalizeText(args.customer_ref, 80) || invoice.customer || null,
      reminder_sent: true,
      status_value: invoice.status || "sent",
      sent_at: this.now().toISOString(),
    };
  }

  async getPaymentStatus(args = {}) {
    const lookupId = normalizeText(
      args.payment_intent_id ||
        args.checkout_session_id ||
        args.payment_link_id ||
        args.invoice_id ||
        args.refund_id,
      160,
    );
    if (!lookupId) {
      return {
        error: "invalid_payment_intent_id",
        message:
          "payment_intent_id, checkout_session_id, payment_link_id, invoice_id, or refund_id is required.",
      };
    }

    if (lookupId.startsWith("cs_")) {
      const session = await this.request(`/v1/checkout/sessions/${encodeURIComponent(lookupId)}`);
      return {
        provider: "stripe",
        provider_action: "get_checkout_session",
        checkout_session_id: session.id || lookupId,
        payment_intent_id: session.payment_intent || session.id || lookupId,
        status_value: session.payment_status || session.status || "UNKNOWN",
        updated_at: this.now().toISOString(),
      };
    }
    if (lookupId.startsWith("in_")) {
      const invoice = await this.request(`/v1/invoices/${encodeURIComponent(lookupId)}`);
      return {
        provider: "stripe",
        provider_action: "get_invoice",
        invoice_id: invoice.id || lookupId,
        payment_intent_id: invoice.payment_intent || invoice.id || lookupId,
        status_value: invoice.status || "UNKNOWN",
        updated_at: this.now().toISOString(),
      };
    }
    if (lookupId.startsWith("re_")) {
      const refund = await this.request(`/v1/refunds/${encodeURIComponent(lookupId)}`);
      return {
        provider: "stripe",
        provider_action: "get_refund",
        refund_id: refund.id || lookupId,
        payment_intent_id: refund.payment_intent || refund.charge || lookupId,
        status_value: refund.status || "UNKNOWN",
        updated_at: this.now().toISOString(),
      };
    }

    const paymentIntent = await this.request(`/v1/payment_intents/${encodeURIComponent(lookupId)}`);
    return {
      provider: "stripe",
      provider_action: "get_payment_intent",
      payment_intent_id: paymentIntent.id || lookupId,
      status_value: paymentIntent.status || "UNKNOWN",
      amount: centsToAmount(paymentIntent.amount),
      currency: normalizeCurrency(paymentIntent.currency, ""),
      updated_at: this.now().toISOString(),
    };
  }

  async getPaymentSessionHistory(args = {}, context = {}) {
    const externalId = normalizeText(
      args.payment_intent_id ||
        args.checkout_session_id ||
        args.payment_link_id ||
        args.invoice_id ||
        args.refund_id ||
        args.external_id,
      160,
    );
    const callSid = normalizeText(args.call_sid || context.callSid, 160);
    if (!externalId && !callSid) {
      return {
        error: "invalid_payment_session_lookup",
        message:
          "payment_intent_id, checkout_session_id, invoice_id, refund_id, or call_sid is required.",
      };
    }

    if (
      typeof this.db?.listStripePaymentSessions !== "function" ||
      typeof this.db?.listStripePaymentEvents !== "function"
    ) {
      return {
        provider: "stripe",
        provider_action: "payment_session_history",
        status_value: "UNAVAILABLE",
        query: {
          external_id: externalId || null,
          call_sid: callSid || null,
        },
        sessions: [],
        events: [],
        message: "Stripe local payment history is unavailable because persistence helpers are not configured.",
      };
    }

    const limit = normalizeLimit(args.limit, 10);
    const query = {
      external_id: externalId || null,
      call_sid: callSid || null,
      limit,
    };
    const [sessions, events] = await Promise.all([
      this.db.listStripePaymentSessions(query),
      this.db.listStripePaymentEvents(query),
    ]);
    const normalizedSessions = (Array.isArray(sessions) ? sessions : []).map(normalizeDbRow);
    const normalizedEvents = (Array.isArray(events) ? events : []).map(normalizeDbRow);
    const latestSession = normalizedSessions[0] || null;
    const latestEvent = normalizedEvents[0] || null;

    return {
      provider: "stripe",
      provider_action: "payment_session_history",
      payment_intent_id: externalId || latestSession?.external_id || latestEvent?.resource_id || null,
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
    return buildFailureSummary("stripe", history, this.now().toISOString());
  }

  async getCustomerPaymentProfile(args = {}, context = {}) {
    const customerRef = normalizeText(
      args.customer_ref || args.customer_id || args.customer_email,
      160,
    );
    const history = await this.getPaymentSessionHistory(
      {
        ...args,
        call_sid: args.call_sid || context.callSid,
        limit: args.limit,
      },
      context,
    );
    if (history.error) return history;

    const sessions = Array.isArray(history.sessions) ? history.sessions : [];
    const failedStatuses = new Set(["CANCELED", "CANCELLED", "EXPIRED", "FAILED"]);
    const successStatuses = new Set(["COMPLETE", "PAID", "SUCCEEDED"]);
    const successfulPayments = sessions.filter((session) =>
      successStatuses.has(normalizeStripeStatus(session.status || session.status_value, "")),
    );
    const failedPayments = sessions.filter((session) =>
      failedStatuses.has(normalizeStripeStatus(session.status || session.status_value, "")),
    );
    return {
      provider: "stripe",
      provider_action: "customer_payment_profile",
      customer_ref: customerRef || null,
      call_sid: history.query?.call_sid || null,
      total_sessions: sessions.length,
      successful_payments: successfulPayments.length,
      failed_payments: failedPayments.length,
      payment_methods: [],
      latest_session: sessions[0] || null,
      updated_at: history.updated_at || this.now().toISOString(),
    };
  }

  async createRefund(args = {}, context = {}) {
    const paymentIntentId = normalizeText(args.payment_intent_id || args.stripe_payment_intent_id, 160);
    const chargeId = normalizeText(args.charge_id || args.stripe_charge_id, 160);
    if (!paymentIntentId && !chargeId) {
      return {
        error: "missing_stripe_refund_target",
        message: "Stripe refunds require payment_intent_id or charge_id.",
      };
    }

    const amountCents = args.amount == null || args.amount === "" ? null : normalizeAmountCents(args.amount);
    const idempotencyKey = args.idempotency_key || args.idempotencyKey || createRequestId("refund");
    const refund = await this.request("/v1/refunds", {
      method: "POST",
      idempotencyKey,
      body: {
        payment_intent: paymentIntentId || undefined,
        charge: chargeId || undefined,
        amount: amountCents || undefined,
        metadata: {
          connector: "stripe",
          reason_note: normalizeText(args.reason || args.note, 240) || undefined,
          call_sid: normalizeText(context.callSid, 160) || undefined,
        },
      },
    });

    await this.saveSession({
      call_sid: context.callSid || null,
      action: "refund_request_initiate",
      external_id: refund.id,
      status: refund.status || "pending",
      amount: centsToAmount(amountCents || refund.amount),
      currency: normalizeCurrency(refund.currency || args.currency, this.config.defaultCurrency),
      approval_url: null,
      idempotency_key: idempotencyKey,
      metadata: {
        connector: "stripe",
        payment_intent_id: paymentIntentId || refund.payment_intent || null,
        charge_id: chargeId || refund.charge || null,
      },
    });

    return {
      provider: "stripe",
      provider_action: "create_refund",
      refund_request_id: refund.id,
      refund_id: refund.id,
      payment_intent_id: refund.payment_intent || paymentIntentId || chargeId,
      state: String(refund.status || "pending").toLowerCase(),
      created_at: this.now().toISOString(),
    };
  }

  async verifyWebhookSignature(rawBody, headers = {}) {
    if (!this.config.webhookSecret) {
      const result = {
        ok: false,
        error: "stripe_webhook_not_configured",
        message: "Missing STRIPE_WEBHOOK_SECRET.",
      };
      await this.recordObservability("stripe_webhook_verification", "blocked", {
        error: result.error,
      });
      return result;
    }

    const signatureHeader = String(getHeader(headers, "stripe-signature") || "");
    const timestamp = signatureHeader
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.startsWith("t="))
      ?.slice(2);
    const signatures = signatureHeader
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("v1="))
      .map((part) => part.slice(3));

    if (!timestamp || signatures.length === 0) {
      const result = {
        ok: false,
        error: "missing_stripe_webhook_signature",
        message: "Missing Stripe webhook timestamp or v1 signature.",
      };
      await this.recordObservability("stripe_webhook_verification", "blocked", {
        error: result.error,
      });
      return result;
    }

    const timestampSeconds = Number(timestamp);
    if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
      const result = {
        ok: false,
        error: "stripe_webhook_timestamp_invalid",
        message: "Stripe webhook timestamp is invalid.",
      };
      await this.recordObservability("stripe_webhook_verification", "blocked", {
        error: result.error,
      });
      return result;
    }

    const toleranceSeconds = Math.max(30, Math.floor(Number(this.config.webhookToleranceSeconds) || 300));
    if (
      Math.abs(Math.floor(this.now().getTime() / 1000) - timestampSeconds) > toleranceSeconds
    ) {
      const result = {
        ok: false,
        error: "stripe_webhook_timestamp_out_of_tolerance",
        message: "Stripe webhook timestamp is outside the allowed tolerance.",
      };
      await this.recordObservability("stripe_webhook_verification", "blocked", {
        error: result.error,
      });
      return result;
    }

    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
    const expected = crypto
      .createHmac("sha256", this.config.webhookSecret)
      .update(`${timestamp}.${body}`, "utf8")
      .digest("hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    const ok = signatures.some((signature) => {
      try {
        const signatureBuffer = Buffer.from(signature, "hex");
        return (
          signatureBuffer.length === expectedBuffer.length &&
          crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
        );
      } catch (_) {
        return false;
      }
    });
    const result = ok
      ? { ok: true, verification_status: "SUCCESS" }
      : {
          ok: false,
          error: "stripe_webhook_signature_invalid",
          message: "Stripe webhook signature verification failed.",
          verification_status: "FAILURE",
        };
    await this.recordObservability("stripe_webhook_verification", ok ? "ok" : "blocked", {
      error: result.error,
      verification_status: result.verification_status,
    });
    return result;
  }

  async handleWebhookEvent(webhookEvent = {}) {
    if (!webhookEvent || typeof webhookEvent !== "object" || Array.isArray(webhookEvent)) {
      const result = {
        ok: false,
        error: "invalid_stripe_webhook",
        message: "Stripe webhook body must be a JSON object.",
      };
      await this.recordObservability("stripe_webhook_reconcile", "invalid", {
        error: result.error,
      });
      return result;
    }

    const eventId = normalizeText(webhookEvent.id, 160);
    const eventType = normalizeText(webhookEvent.type, 160);
    const resource =
      webhookEvent.data?.object &&
      typeof webhookEvent.data.object === "object" &&
      !Array.isArray(webhookEvent.data.object)
        ? webhookEvent.data.object
        : {};
    const resourceId = normalizeText(resource.id, 160);
    const status = getStripeWebhookStatus(eventType, resource);

    if (!eventId || !eventType) {
      const result = {
        ok: false,
        error: "invalid_stripe_webhook",
        message: "Stripe webhook body must include id and type.",
      };
      await this.recordObservability("stripe_webhook_reconcile", "invalid", {
        event_id: eventId,
        event_type: eventType,
        error: result.error,
      });
      return result;
    }

    const amount = getStripeWebhookAmount(resource);
    const sessionIds = collectStripeWebhookSessionIds(resource);
    const normalizedEvent = normalizePaymentEvent("stripe", webhookEvent, {
      resource,
      resource_id: resourceId || sessionIds[0] || null,
      status,
      amount: amount.amount,
      currency: amount.currency,
    });

    if (typeof this.db?.recordStripePaymentEvent === "function") {
      const eventRecord = await this.db.recordStripePaymentEvent({
        external_event_id: eventId,
        event_type: eventType,
        resource_id: resourceId || sessionIds[0] || null,
        status,
        normalized_event: normalizedEvent,
        payload: webhookEvent,
      });
      if (eventRecord?.inserted === false) {
        const result = {
          ok: true,
          duplicate: true,
          event_id: eventId,
          event_type: eventType,
          resource_id: resourceId || sessionIds[0] || null,
          status,
          normalized_event: normalizedEvent,
          updated_sessions: 0,
        };
        await this.recordObservability("stripe_webhook_reconcile", "duplicate", {
          event_id: eventId,
          event_type: eventType,
          resource_id: result.resource_id,
          stripe_status: status,
          updated_sessions: 0,
        });
        return result;
      }
    }

    let updatedSessions = 0;
    const ignoredSessionIds = [];
    for (const sessionId of sessionIds) {
      const updateResult = await this.updateSessionFromWebhook(sessionId, {
        status,
        amount: amount.amount,
        currency: amount.currency,
        metadata: {
          connector: "stripe",
          source: "webhook",
          event_id: eventId,
          event_type: eventType,
          resource_id: resourceId || null,
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
      resource_id: resourceId || sessionIds[0] || null,
      status,
      normalized_event: normalizedEvent,
      updated_sessions: updatedSessions,
      ...(ignoredSessionIds.length > 0 ? { ignored_sessions: ignoredSessionIds } : {}),
    };
    await this.recordObservability("stripe_webhook_reconcile", "ok", {
      event_id: eventId,
      event_type: eventType,
      resource_id: result.resource_id,
      stripe_status: status,
      updated_sessions: updatedSessions,
      ignored_sessions: ignoredSessionIds.length,
    });
    return result;
  }

  async saveSession(payload) {
    if (typeof this.db?.upsertStripePaymentSession !== "function") return;
    await this.db.upsertStripePaymentSession(payload);
  }

  async updateSessionFromWebhook(externalId, payload = {}) {
    const normalizedId = normalizeText(externalId, 160);
    if (!normalizedId) return { updated: 0, ignored: false };
    if (typeof this.db?.getStripePaymentSession === "function") {
      const existingSession = await this.db.getStripePaymentSession(normalizedId);
      if (
        existingSession?.external_id &&
        !shouldApplyStripeWebhookStatus(existingSession.status, payload.status)
      ) {
        return { updated: 0, ignored: true, retained_status: existingSession.status };
      }
    }
    if (typeof this.db?.updateStripePaymentSessionStatus === "function") {
      const changes = await this.db.updateStripePaymentSessionStatus(normalizedId, payload);
      if (changes > 0) return { updated: changes, ignored: false };
    }
    await this.saveSession({
      action: "stripe_webhook",
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
        authorization: `Bearer ${this.config.secretKey}`,
        accept: "application/json",
        "stripe-version": this.config.apiVersion || DEFAULT_API_VERSION,
        ...(method !== "GET" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": String(options.idempotencyKey) } : {}),
      },
      ...(method !== "GET" ? { body: toStripeFormBody(options.body || {}) } : {}),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(parseStripeErrorBody(body) || `Stripe request failed: ${response.status}`);
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

function createStripePaymentService(options = {}) {
  return new StripePaymentService(options);
}

module.exports = {
  DEFAULT_API_VERSION,
  STRIPE_CONNECTOR_NAMES,
  StripePaymentService,
  createStripePaymentService,
  isStripeConnectorName,
  shouldApplyStripeWebhookStatus,
};
