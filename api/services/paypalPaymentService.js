"use strict";

const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = 7000;
const PAYPAL_AGENT_TOOLKIT_PACKAGE = "@paypal/agent-toolkit";
const PAYPAL_AGENT_TOOLKIT_ACTIONS = Object.freeze({
  invoices: { create: true, get: true, list: true, send: true },
  orders: { create: true, get: true },
  payments: { createRefund: true, getRefunds: true },
});
const PAYPAL_AGENT_TOOLKIT_READ_TOOLS = Object.freeze([
  "get_invoice",
  "get_order",
  "get_refund",
  "list_invoices",
]);
const PAYPAL_AGENT_TOOLKIT_BLOCKED_TOOLS = Object.freeze([
  "accept_dispute_claim",
  "create_invoice",
  "create_order",
  "create_refund",
  "pay_order",
  "send_invoice",
  "update_plan",
]);
const PAYPAL_CONNECTOR_NAMES = new Set([
  "paypal",
  "paypal_agent",
  "paypal-agent",
  "paypal_agent_toolkit",
  "paypal-agent-toolkit",
]);
const PAYPAL_STATUS_RANK = Object.freeze({
  UNKNOWN: 0,
  CREATED: 10,
  DRAFT: 10,
  SENT: 15,
  APPROVED: 20,
  PAYER_ACTION_REQUIRED: 20,
  PENDING: 30,
  COMPLETED: 40,
  PAID: 40,
  CANCELLED: 50,
  DENIED: 50,
  REFUNDED: 50,
  REVERSED: 50,
  VOIDED: 50,
});
const PAYPAL_TERMINAL_STATUSES = new Set([
  "CANCELLED",
  "COMPLETED",
  "DENIED",
  "PAID",
  "REFUNDED",
  "REVERSED",
  "VOIDED",
]);

function readDefaultConfig() {
  try {
    const config = require("../config");
    return config?.payment?.paypal || {};
  } catch (_) {
    return {};
  }
}

function normalizeEnvironment(value) {
  const normalized = String(value || "sandbox").trim().toLowerCase();
  if (normalized === "live" || normalized === "production") return "production";
  return "sandbox";
}

function getBaseUrl(environment) {
  return normalizeEnvironment(environment) === "production"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function normalizeCurrency(value, fallback = "USD") {
  const currency = String(value || fallback || "USD").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "USD";
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount.toFixed(2);
}

function normalizeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeAgentToolkitToolName(value) {
  return normalizeText(value, 120).toLowerCase();
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

function collectStringValues(value, bag = []) {
  if (value === null || value === undefined) return bag;
  if (typeof value === "string") {
    bag.push(value);
    return bag;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    bag.push(String(value));
    return bag;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStringValues(entry, bag));
    return bag;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((entry) => collectStringValues(entry, bag));
  }
  return bag;
}

function hasSensitivePaymentInput(payload = {}) {
  const forbiddenKeys = new Set([
    "card_number",
    "cardnumber",
    "cvv",
    "cvc",
    "expiry",
    "exp",
    "exp_month",
    "exp_year",
    "security_code",
  ]);
  const containsForbiddenKey = Object.keys(payload || {}).some((key) =>
    forbiddenKeys.has(String(key || "").trim().toLowerCase()),
  );
  if (containsForbiddenKey) return true;

  const values = collectStringValues(payload, []);
  const cardRegex = /\b\d{13,19}\b/;
  return values.some((entry) => cardRegex.test(String(entry || "").replace(/\s|-/g, "")));
}

function normalizeDbRow(row = {}) {
  if (!row || typeof row !== "object") return row;
  return {
    ...row,
    metadata: parseJsonField(row.metadata),
    payload: parseJsonField(row.payload),
  };
}

function createRequestId(prefix = "paypal") {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function parsePaypalErrorBody(body) {
  if (!body || typeof body !== "object") return null;
  return body.message || body.error_description || body.name || null;
}

function findLink(links = [], rel) {
  if (!Array.isArray(links)) return null;
  const match = links.find((link) => String(link?.rel || "").toLowerCase() === rel);
  return match?.href || null;
}

function getHeader(headers = {}, name) {
  const normalizedName = String(name || "").toLowerCase();
  if (!normalizedName || !headers || typeof headers !== "object") return null;
  return Object.entries(headers).find(
    ([key]) => String(key || "").toLowerCase() === normalizedName,
  )?.[1] || null;
}

function normalizePaypalStatus(value, fallback = "UNKNOWN") {
  const status = String(value || fallback || "UNKNOWN").trim().toUpperCase();
  return status || "UNKNOWN";
}

function shouldApplyPaypalWebhookStatus(currentStatus, nextStatus) {
  const current = normalizePaypalStatus(currentStatus, "");
  const next = normalizePaypalStatus(nextStatus, "");
  if (!next || next === "UNKNOWN") return !current;
  if (!current || current === "UNKNOWN") return true;
  if (current === next) return true;

  const currentRank = PAYPAL_STATUS_RANK[current] ?? PAYPAL_STATUS_RANK.UNKNOWN;
  const nextRank = PAYPAL_STATUS_RANK[next] ?? PAYPAL_STATUS_RANK.UNKNOWN;
  if (PAYPAL_TERMINAL_STATUSES.has(current) && nextRank < currentRank) return false;
  return nextRank >= currentRank;
}

function getPaypalWebhookStatus(eventType, resource = {}) {
  const explicitStatus = normalizePaypalStatus(resource.status, "");
  if (explicitStatus) return explicitStatus;
  switch (String(eventType || "").toUpperCase()) {
    case "CHECKOUT.ORDER.APPROVED":
      return "APPROVED";
    case "CHECKOUT.ORDER.COMPLETED":
    case "PAYMENT.CAPTURE.COMPLETED":
    case "PAYMENT.REFUND.COMPLETED":
    case "INVOICING.INVOICE.PAID":
      return "COMPLETED";
    case "PAYMENT.CAPTURE.PENDING":
      return "PENDING";
    case "PAYMENT.CAPTURE.DENIED":
      return "DENIED";
    case "PAYMENT.CAPTURE.REFUNDED":
      return "REFUNDED";
    case "PAYMENT.CAPTURE.REVERSED":
      return "REVERSED";
    case "INVOICING.INVOICE.CANCELLED":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}

function getPaypalWebhookAmount(resource = {}) {
  const amount =
    resource.amount ||
    resource.seller_receivable_breakdown?.gross_amount ||
    resource.purchase_units?.[0]?.amount ||
    null;
  if (!amount || typeof amount !== "object") return {};
  return {
    amount: amount.value != null ? String(amount.value) : null,
    currency: amount.currency_code || null,
  };
}

function collectPaypalWebhookSessionIds(resource = {}) {
  const ids = new Set();
  const add = (value) => {
    const id = normalizeText(value, 160);
    if (id) ids.add(id);
  };

  add(resource.id);
  add(resource.invoice_id);
  add(resource.parent_payment);
  add(resource.order_id);
  add(resource.capture_id);
  add(resource.sale_id);
  add(resource.refund_id);
  add(resource.billing_agreement_id);
  const relatedIds =
    resource.supplementary_data?.related_ids &&
    typeof resource.supplementary_data.related_ids === "object"
      ? resource.supplementary_data.related_ids
      : {};
  Object.values(relatedIds).forEach(add);
  return Array.from(ids);
}

async function findPreferredPaypalSessionId(db, sessionIds = [], fallbackId = null) {
  const normalizedFallback = normalizeText(fallbackId, 160);
  const ids = Array.from(
    new Set(
      sessionIds
        .map((sessionId) => normalizeText(sessionId, 160))
        .filter(Boolean),
    ),
  );
  if (typeof db?.getPaypalPaymentSession === "function") {
    for (const sessionId of ids) {
      const session = await db.getPaypalPaymentSession(sessionId);
      if (session?.external_id) return sessionId;
    }
  }
  return ids[0] || normalizedFallback || null;
}

function isPaypalConnectorName(value) {
  return PAYPAL_CONNECTOR_NAMES.has(String(value || "").trim().toLowerCase());
}

class PaypalPaymentService {
  constructor(options = {}) {
    this.config = {
      ...readDefaultConfig(),
      ...(options.config && typeof options.config === "object" ? options.config : {}),
    };
    this.db = options.db || null;
    this.fetchFn = options.fetchFn || require("node-fetch");
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.agentToolkitFactory =
      typeof options.agentToolkitFactory === "function" ? options.agentToolkitFactory : null;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  baseUrl() {
    return this.config.baseUrl || getBaseUrl(this.config.environment);
  }

  async execute(action, args = {}, context = {}) {
    const actionName = normalizeText(action, 120) || "unknown";
    if (!this.isEnabled()) {
      const result = {
        error: "paypal_disabled",
        message: "PayPal connector is disabled. Set PAYPAL_CONNECTOR_ENABLED=true to use it.",
      };
      await this.recordObservability("paypal_connector_execute", "blocked", {
        action: actionName,
        error: result.error,
      }, context);
      return result;
    }
    const isLocalHistoryAction = actionName === "payment_session_history";
    if (!this.isConfigured() && !isLocalHistoryAction) {
      const result = {
        error: "paypal_not_configured",
        message: "Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET.",
      };
      await this.recordObservability("paypal_connector_execute", "blocked", {
        action: actionName,
        error: result.error,
      }, context);
      return result;
    }

    try {
      let result;
      if (actionName === "payment_link_generate") {
        result = await this.createPaymentLink(args, context);
      } else if (actionName === "invoice_create") {
        result = await this.createInvoice(args, context);
      } else if (actionName === "payment_intent_status") {
        result = await this.getPaymentStatus(args, context);
      } else if (actionName === "payment_session_history") {
        result = await this.getPaymentSessionHistory(args, context);
      } else if (actionName === "agent_toolkit_manifest") {
        result = await this.getAgentToolkitManifest(args, context);
      } else if (actionName === "agent_toolkit_execute") {
        result = await this.executeAgentToolkitTool(args, context);
      } else if (actionName === "refund_request_initiate") {
        result = await this.createRefund(args, context);
      } else {
        result = {
          error: "paypal_unsupported_action",
          message: `Unsupported PayPal payment action: ${action}`,
        };
      }

      await this.recordObservability(
        "paypal_connector_execute",
        result?.error ? "blocked" : "ok",
        {
          action: actionName,
          provider_action: result?.provider_action,
          error: result?.error,
          tool_name: result?.tool_name || args?.tool_name || args?.tool || args?.name,
        },
        context,
      );
      return result;
    } catch (error) {
      const result = {
        error: "paypal_request_failed",
        message: String(error?.message || "PayPal request failed."),
      };
      await this.recordObservability("paypal_connector_execute", "error", {
        action: actionName,
        error: result.error,
        error_message: result.message,
      }, context);
      return result;
    }
  }

  async recordObservability(event, status, details = {}, context = {}) {
    const safeDetails = sanitizeTelemetryDetails({
      provider: "paypal",
      event,
      status,
      environment: normalizeEnvironment(this.config.environment),
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
          "paypal_connector",
          getTelemetryHealthStatus(status),
          safeDetails,
        ),
      );
    }
    const callSid = normalizeText(context?.callSid || details.call_sid, 160);
    if (callSid && typeof this.db?.addCallMetric === "function") {
      addTask(() => this.db.addCallMetric(callSid, "paypal_connector_event", 1, safeDetails));
    }
    if (tasks.length === 0) return;
    await Promise.allSettled(tasks);
  }

  async createPaymentLink(args = {}, context = {}) {
    const amount = normalizeAmount(args.amount);
    if (!amount) {
      return { error: "invalid_amount", message: "amount must be a positive number." };
    }

    const currency = normalizeCurrency(args.currency, this.config.defaultCurrency);
    const description =
      normalizeText(args.description, 127) ||
      normalizeText(context?.callConfig?.payment_description, 127) ||
      "Voice payment";
    const order = await this.request("/v2/checkout/orders", {
      method: "POST",
      idempotencyKey: args.idempotency_key || args.idempotencyKey || createRequestId("order"),
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            description,
            custom_id: normalizeText(args.customer_ref || context.callSid, 127) || undefined,
            amount: {
              currency_code: currency,
              value: amount,
            },
          },
        ],
        application_context: {
          brand_name: normalizeText(this.config.brandName, 127) || undefined,
          return_url: normalizeText(args.return_url || this.config.returnUrl, 2048) || undefined,
          cancel_url: normalizeText(args.cancel_url || this.config.cancelUrl, 2048) || undefined,
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      },
    });

    const approvalUrl = findLink(order.links, "approve");
    await this.saveSession({
      call_sid: context.callSid || null,
      action: "payment_link_generate",
      external_id: order.id,
      status: order.status || "CREATED",
      amount,
      currency,
      approval_url: approvalUrl,
      idempotency_key: args.idempotency_key || args.idempotencyKey || null,
      metadata: { description, connector: "paypal" },
    });

    return {
      provider: "paypal",
      provider_action: "create_order",
      payment_link_id: order.id,
      payment_intent_id: order.id,
      order_id: order.id,
      payment_url: approvalUrl,
      approval_url: approvalUrl,
      status_value: order.status || "CREATED",
      amount: Number(amount),
      currency,
      expires_at: null,
    };
  }

  async createInvoice(args = {}, context = {}) {
    const amount = normalizeAmount(args.amount);
    if (!amount) {
      return { error: "invalid_amount", message: "amount must be a positive number." };
    }

    const recipientEmail = normalizeText(args.customer_email || args.email, 254);
    if (!recipientEmail) {
      return {
        error: "missing_invoice_recipient",
        message: "customer_email is required when creating a PayPal invoice.",
      };
    }

    const currency = normalizeCurrency(args.currency, this.config.defaultCurrency);
    const description = normalizeText(args.description, 127) || "Voice invoice";
    const invoice = await this.request("/v2/invoicing/invoices", {
      method: "POST",
      idempotencyKey: args.idempotency_key || args.idempotencyKey || createRequestId("invoice"),
      body: {
        detail: {
          currency_code: currency,
          note: normalizeText(args.note, 4000) || undefined,
          memo: normalizeText(args.memo || description, 500) || undefined,
          invoice_number: normalizeText(args.invoice_number, 25) || undefined,
        },
        invoicer: {
          business_name: normalizeText(this.config.brandName, 300) || undefined,
        },
        primary_recipients: [
          {
            billing_info: {
              email_address: recipientEmail,
            },
          },
        ],
        items: [
          {
            name: description,
            quantity: "1",
            unit_amount: {
              currency_code: currency,
              value: amount,
            },
          },
        ],
      },
    });

    if (args.send_invoice === true || args.send === true) {
      await this.request(`/v2/invoicing/invoices/${encodeURIComponent(invoice.id)}/send`, {
        method: "POST",
        idempotencyKey: createRequestId("invoice-send"),
        body: {
          send_to_invoicer: false,
          send_to_recipient: true,
        },
      });
    }

    await this.saveSession({
      call_sid: context.callSid || null,
      action: "invoice_create",
      external_id: invoice.id,
      status: invoice.status || "DRAFT",
      amount,
      currency,
      approval_url: findLink(invoice.links, "payer-view") || findLink(invoice.links, "self"),
      idempotency_key: args.idempotency_key || args.idempotencyKey || null,
      metadata: { customer_email: recipientEmail, connector: "paypal" },
    });

    return {
      provider: "paypal",
      provider_action: "create_invoice",
      invoice_id: invoice.id,
      invoice_url: findLink(invoice.links, "payer-view") || findLink(invoice.links, "self"),
      customer_ref: normalizeText(args.customer_ref, 80),
      status_value: invoice.status || "DRAFT",
      amount: Number(amount),
      currency,
      due_date: args.due_date || null,
    };
  }

  async getPaymentStatus(args = {}) {
    const invoiceId = normalizeText(args.invoice_id, 120);
    const orderId = normalizeText(
      args.order_id || args.payment_intent_id || args.payment_link_id,
      120,
    );
    if (invoiceId) {
      const invoice = await this.request(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
      return {
        provider: "paypal",
        provider_action: "get_invoice",
        invoice_id: invoice.id || invoiceId,
        payment_intent_id: invoice.id || invoiceId,
        status_value: invoice.status || "UNKNOWN",
        updated_at: this.now().toISOString(),
      };
    }
    if (!orderId) {
      return {
        error: "invalid_payment_intent_id",
        message: "payment_intent_id, order_id, payment_link_id, or invoice_id is required.",
      };
    }
    const order = await this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    return {
      provider: "paypal",
      provider_action: "get_order",
      order_id: order.id || orderId,
      payment_intent_id: order.id || orderId,
      status_value: order.status || "UNKNOWN",
      updated_at: this.now().toISOString(),
    };
  }

  async getPaymentSessionHistory(args = {}, context = {}) {
    const externalId = normalizeText(
      args.payment_intent_id ||
        args.order_id ||
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
        message: "payment_intent_id, order_id, invoice_id, refund_id, or call_sid is required.",
      };
    }

    if (
      typeof this.db?.listPaypalPaymentSessions !== "function" ||
      typeof this.db?.listPaypalPaymentEvents !== "function"
    ) {
      return {
        provider: "paypal",
        provider_action: "payment_session_history",
        status_value: "UNAVAILABLE",
        query: {
          external_id: externalId || null,
          call_sid: callSid || null,
        },
        sessions: [],
        events: [],
        message: "PayPal local payment history is unavailable because persistence helpers are not configured.",
      };
    }

    const limit = normalizeLimit(args.limit, 10);
    const query = {
      external_id: externalId || null,
      call_sid: callSid || null,
      limit,
    };
    const [sessions, events] = await Promise.all([
      this.db.listPaypalPaymentSessions(query),
      this.db.listPaypalPaymentEvents(query),
    ]);
    const normalizedSessions = (Array.isArray(sessions) ? sessions : []).map(normalizeDbRow);
    const normalizedEvents = (Array.isArray(events) ? events : []).map(normalizeDbRow);
    const latestSession = normalizedSessions[0] || null;
    const latestEvent = normalizedEvents[0] || null;

    return {
      provider: "paypal",
      provider_action: "payment_session_history",
      payment_intent_id: externalId || latestSession?.external_id || latestEvent?.resource_id || null,
      status_value: latestSession?.status || latestEvent?.status || "UNKNOWN",
      query,
      sessions: normalizedSessions,
      events: normalizedEvents,
      updated_at: latestSession?.updated_at || latestEvent?.created_at || this.now().toISOString(),
    };
  }

  async createRefund(args = {}, context = {}) {
    const captureId = normalizeText(args.capture_id || args.payment_capture_id, 120);
    if (!captureId) {
      return {
        error: "missing_capture_id",
        message: "PayPal refunds require capture_id or payment_capture_id.",
      };
    }
    const amount = normalizeAmount(args.amount);
    const currency = normalizeCurrency(args.currency, this.config.defaultCurrency);
    const refund = await this.request(
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        method: "POST",
        idempotencyKey: args.idempotency_key || args.idempotencyKey || createRequestId("refund"),
        body: {
          ...(amount
            ? {
                amount: {
                  currency_code: currency,
                  value: amount,
                },
              }
            : {}),
          note_to_payer: normalizeText(args.reason || args.note, 255) || undefined,
        },
      },
    );

    await this.saveSession({
      call_sid: context.callSid || null,
      action: "refund_request_initiate",
      external_id: refund.id,
      status: refund.status || "PENDING",
      amount,
      currency,
      approval_url: null,
      idempotency_key: args.idempotency_key || args.idempotencyKey || null,
      metadata: { capture_id: captureId, connector: "paypal" },
    });

    return {
      provider: "paypal",
      provider_action: "refund_capture",
      refund_request_id: refund.id,
      refund_id: refund.id,
      payment_intent_id: normalizeText(args.payment_intent_id || captureId, 120),
      state: String(refund.status || "PENDING").toLowerCase(),
      created_at: this.now().toISOString(),
    };
  }

  getAgentToolkitConfiguration() {
    return {
      actions: this.config.agentToolkitActions || PAYPAL_AGENT_TOOLKIT_ACTIONS,
      context: {
        sandbox: normalizeEnvironment(this.config.environment) !== "production",
        ...(this.config.merchantId ? { merchant_id: this.config.merchantId } : {}),
        ...(this.config.debug === true ? { debug: true } : {}),
      },
    };
  }

  createAgentToolkit() {
    const options = {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      configuration: this.getAgentToolkitConfiguration(),
    };
    if (this.agentToolkitFactory) {
      return this.agentToolkitFactory(options);
    }
    const { PayPalAgentToolkit } = require("@paypal/agent-toolkit/ai-sdk");
    return new PayPalAgentToolkit(options);
  }

  getAgentToolkitReadToolNames() {
    const configured = Array.isArray(this.config.agentToolkitReadTools)
      ? this.config.agentToolkitReadTools
      : PAYPAL_AGENT_TOOLKIT_READ_TOOLS;
    const safeReadTools = new Set(PAYPAL_AGENT_TOOLKIT_READ_TOOLS);
    return Array.from(
      new Set(
        configured
          .map(normalizeAgentToolkitToolName)
          .filter((toolName) => toolName && safeReadTools.has(toolName)),
      ),
    );
  }

  getAgentToolkitToolEntries(toolkit) {
    const tools = typeof toolkit?.getTools === "function" ? toolkit.getTools() : {};
    if (Array.isArray(tools)) {
      return tools.map((tool, index) => [tool?.name || `tool_${index + 1}`, tool]);
    }
    if (!tools || typeof tools !== "object") return [];
    return Object.entries(tools);
  }

  serializeAgentToolkitTool(name, tool = {}) {
    const parameters = tool?.parameters || tool?.inputSchema || tool?.schema || null;
    const isPlainObject =
      parameters && typeof parameters === "object" && Object.getPrototypeOf(parameters) === Object.prototype;
    return {
      name: normalizeText(name || tool?.name, 120),
      description: normalizeText(tool?.description, 600),
      has_execute: typeof tool?.execute === "function",
      ...(isPlainObject
        ? { parameters }
        : parameters
          ? { parameter_schema_type: parameters.constructor?.name || typeof parameters }
          : {}),
    };
  }

  async getAgentToolkitManifest() {
    const toolkit = this.createAgentToolkit();
    const serializedTools = this.getAgentToolkitToolEntries(toolkit)
      .map(([name, tool]) => this.serializeAgentToolkitTool(name, tool))
      .filter((tool) => tool.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      provider: "paypal",
      provider_action: "agent_toolkit_manifest",
      package: PAYPAL_AGENT_TOOLKIT_PACKAGE,
      toolkit_surface: "ai-sdk",
      environment: normalizeEnvironment(this.config.environment),
      tool_count: serializedTools.length,
      tools: serializedTools,
    };
  }

  async executeAgentToolkitTool(args = {}) {
    const toolName = normalizeAgentToolkitToolName(args.tool_name || args.tool || args.name);
    if (!toolName) {
      return {
        error: "missing_paypal_agent_tool",
        message: "tool_name is required.",
      };
    }

    const input = args.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {
        error: "invalid_paypal_agent_tool_input",
        message: "input must be a JSON object passed to the PayPal Agent Toolkit tool.",
      };
    }
    if (hasSensitivePaymentInput(input)) {
      return {
        error: "pci_violation_blocked",
        message:
          "Direct card data input is blocked. Use PCI-safe tokenized payment flows only.",
      };
    }

    const allowedTools = this.getAgentToolkitReadToolNames();
    if (!allowedTools.includes(toolName)) {
      return {
        error: "paypal_agent_tool_not_allowed",
        message:
          "This PayPal Agent Toolkit tool is not enabled for direct agent execution. Use the existing approval-gated connector action for money-moving operations.",
        tool_name: toolName,
        allowed_tools: allowedTools.sort(),
        blocked_tools: PAYPAL_AGENT_TOOLKIT_BLOCKED_TOOLS,
      };
    }

    const toolkit = this.createAgentToolkit();
    const toolEntries = this.getAgentToolkitToolEntries(toolkit);
    const [, tool] =
      toolEntries.find(([name, entry]) => normalizeAgentToolkitToolName(name || entry?.name) === toolName) || [];
    if (!tool || typeof tool.execute !== "function") {
      return {
        error: "paypal_agent_tool_unavailable",
        message: "The requested PayPal Agent Toolkit tool is not available in the current configuration.",
        tool_name: toolName,
        available_tools: toolEntries
          .map(([name, entry]) => normalizeAgentToolkitToolName(name || entry?.name))
          .filter(Boolean)
          .sort(),
      };
    }

    const result = await tool.execute(input);
    return {
      provider: "paypal",
      provider_action: "agent_toolkit_execute",
      package: PAYPAL_AGENT_TOOLKIT_PACKAGE,
      toolkit_surface: "ai-sdk",
      tool_name: toolName,
      read_only: true,
      result,
    };
  }

  async verifyWebhookSignature(webhookEvent = {}, headers = {}) {
    if (!this.isConfigured()) {
      const result = {
        ok: false,
        error: "paypal_not_configured",
        message: "Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET.",
      };
      await this.recordObservability("paypal_webhook_verification", "blocked", {
        event_type: webhookEvent?.event_type,
        error: result.error,
      });
      return result;
    }
    if (!this.config.webhookId) {
      const result = {
        ok: false,
        error: "paypal_webhook_not_configured",
        message: "Missing PAYPAL_WEBHOOK_ID.",
      };
      await this.recordObservability("paypal_webhook_verification", "blocked", {
        event_type: webhookEvent?.event_type,
        error: result.error,
      });
      return result;
    }

    const payload = {
      auth_algo: getHeader(headers, "paypal-auth-algo"),
      cert_url: getHeader(headers, "paypal-cert-url"),
      transmission_id: getHeader(headers, "paypal-transmission-id"),
      transmission_sig: getHeader(headers, "paypal-transmission-sig"),
      transmission_time: getHeader(headers, "paypal-transmission-time"),
      webhook_id: this.config.webhookId,
      webhook_event: webhookEvent,
    };
    const missing = Object.entries(payload)
      .filter(([key, value]) => key !== "webhook_event" && !value)
      .map(([key]) => key);
    if (missing.length > 0) {
      const result = {
        ok: false,
        error: "missing_paypal_webhook_headers",
        message: `Missing PayPal webhook verification fields: ${missing.join(", ")}.`,
      };
      await this.recordObservability("paypal_webhook_verification", "blocked", {
        event_type: webhookEvent?.event_type,
        error: result.error,
        missing_headers: missing,
      });
      return result;
    }

    const result = await this.request("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: payload,
    });
    const verificationStatus = String(result.verification_status || "").toUpperCase();
    const verification = {
      ok: verificationStatus === "SUCCESS",
      verification_status: verificationStatus || "UNKNOWN",
      ...(verificationStatus === "SUCCESS"
        ? {}
        : {
            error: "paypal_webhook_signature_invalid",
            message: "PayPal webhook signature verification failed.",
          }),
    };
    await this.recordObservability(
      "paypal_webhook_verification",
      verification.ok ? "ok" : "blocked",
      {
        event_type: webhookEvent?.event_type,
        verification_status: verification.verification_status,
        error: verification.error,
      },
    );
    return verification;
  }

  async handleWebhookEvent(webhookEvent = {}) {
    if (!webhookEvent || typeof webhookEvent !== "object") {
      const result = {
        ok: false,
        error: "invalid_paypal_webhook",
        message: "PayPal webhook body must be a JSON object.",
      };
      await this.recordObservability("paypal_webhook_reconcile", "invalid", {
        error: result.error,
      });
      return result;
    }

    const eventId = normalizeText(webhookEvent.id, 160);
    const eventType = normalizeText(webhookEvent.event_type, 160);
    const resource =
      webhookEvent.resource &&
      typeof webhookEvent.resource === "object" &&
      !Array.isArray(webhookEvent.resource)
        ? webhookEvent.resource
        : {};
    const resourceId = normalizeText(resource.id || webhookEvent.resource_id, 160);
    const status = getPaypalWebhookStatus(eventType, resource);

    if (!eventId || !eventType) {
      const result = {
        ok: false,
        error: "invalid_paypal_webhook",
        message: "PayPal webhook body must include id and event_type.",
      };
      await this.recordObservability("paypal_webhook_reconcile", "invalid", {
        event_id: eventId,
        event_type: eventType,
        error: result.error,
      });
      return result;
    }

    const amount = getPaypalWebhookAmount(resource);
    const sessionIds = collectPaypalWebhookSessionIds(resource);
    const preferredResourceId = await findPreferredPaypalSessionId(
      this.db,
      sessionIds,
      resourceId || webhookEvent.resource_id,
    );

    if (typeof this.db?.recordPaypalPaymentEvent === "function") {
      const eventRecord = await this.db.recordPaypalPaymentEvent({
        external_event_id: eventId,
        event_type: eventType,
        resource_id: preferredResourceId || null,
        status,
        payload: webhookEvent,
      });
      if (eventRecord?.inserted === false) {
        const result = {
          ok: true,
          duplicate: true,
          event_id: eventId,
          event_type: eventType,
          resource_id: preferredResourceId || null,
          status,
          updated_sessions: 0,
        };
        await this.recordObservability("paypal_webhook_reconcile", "duplicate", {
          event_id: eventId,
          event_type: eventType,
          resource_id: preferredResourceId || null,
          paypal_status: status,
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
          connector: "paypal",
          source: "webhook",
          event_id: eventId,
          event_type: eventType,
          resource_id: preferredResourceId || resourceId || null,
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
      resource_id: preferredResourceId || resourceId || null,
      status,
      updated_sessions: updatedSessions,
      ...(ignoredSessionIds.length > 0 ? { ignored_sessions: ignoredSessionIds } : {}),
    };
    await this.recordObservability("paypal_webhook_reconcile", "ok", {
      event_id: eventId,
      event_type: eventType,
      resource_id: preferredResourceId || resourceId || null,
      paypal_status: status,
      updated_sessions: updatedSessions,
      ignored_sessions: ignoredSessionIds.length,
    });
    return result;
  }

  async saveSession(payload) {
    if (typeof this.db?.upsertPaypalPaymentSession !== "function") return;
    await this.db.upsertPaypalPaymentSession(payload);
  }

  async updateSessionFromWebhook(externalId, payload = {}) {
    const normalizedId = normalizeText(externalId, 160);
    if (!normalizedId) return { updated: 0, ignored: false };
    if (typeof this.db?.getPaypalPaymentSession === "function") {
      const existingSession = await this.db.getPaypalPaymentSession(normalizedId);
      if (
        existingSession?.external_id &&
        !shouldApplyPaypalWebhookStatus(existingSession.status, payload.status)
      ) {
        return { updated: 0, ignored: true, retained_status: existingSession.status };
      }
    }
    if (typeof this.db?.updatePaypalPaymentSessionStatus === "function") {
      const changes = await this.db.updatePaypalPaymentSessionStatus(normalizedId, payload);
      if (changes > 0) return { updated: changes, ignored: false };
    }
    await this.saveSession({
      action: "paypal_webhook",
      external_id: normalizedId,
      status: payload.status || null,
      amount: payload.amount || null,
      currency: payload.currency || null,
      metadata: payload.metadata || null,
    });
    return { updated: 1, ignored: false };
  }

  async getAccessToken() {
    const nowMs = this.now().getTime();
    if (this.accessToken && this.accessTokenExpiresAt > nowMs + 30000) {
      return this.accessToken;
    }

    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");
    const response = await this.fetchWithTimeout(`${this.baseUrl()}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(parsePaypalErrorBody(body) || `PayPal token request failed: ${response.status}`);
    }
    if (!body?.access_token) {
      throw new Error("PayPal token response missing access_token.");
    }
    const expiresInMs = Math.max(60, Number(body.expires_in || 300) - 60) * 1000;
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = nowMs + expiresInMs;
    return this.accessToken;
  }

  async request(path, options = {}) {
    const token = await this.getAccessToken();
    const method = options.method || "GET";
    const response = await this.fetchWithTimeout(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "paypal-request-id": String(options.idempotencyKey) } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(parsePaypalErrorBody(body) || `PayPal ${method} ${path} failed: ${response.status}`);
    }
    return body || {};
  }

  async fetchWithTimeout(url, options = {}) {
    const timeoutMs = Math.max(1000, Number(this.config.timeoutMs || DEFAULT_TIMEOUT_MS));
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

function createPaypalPaymentService(options = {}) {
  return new PaypalPaymentService(options);
}

module.exports = {
  PAYPAL_AGENT_TOOLKIT_ACTIONS,
  PAYPAL_AGENT_TOOLKIT_BLOCKED_TOOLS,
  PAYPAL_AGENT_TOOLKIT_PACKAGE,
  PAYPAL_AGENT_TOOLKIT_READ_TOOLS,
  PAYPAL_CONNECTOR_NAMES,
  PaypalPaymentService,
  createPaypalPaymentService,
  getBaseUrl,
  isPaypalConnectorName,
};
