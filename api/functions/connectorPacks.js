const crypto = require("crypto");
const {
  PAYPAL_AGENT_TOOLKIT_PACKAGE,
  PAYPAL_AGENT_TOOLKIT_READ_TOOLS,
} = require("../services/paypalPaymentService");
const {
  createPaymentProviderSwitchboard,
} = require("../services/paymentProviderSwitchboard");
const {
  evaluatePaymentConnectorPolicy,
} = require("../services/paymentConnectorPolicy");

const DEFAULT_TRUSTED_DOMAINS = Object.freeze([
  "openrouter.ai",
  "developers.deepgram.com",
  "www.twilio.com",
  "developer.vonage.com",
  "platform.openai.com",
  "developers.openai.com",
  "support.google.com",
  "learn.microsoft.com",
]);

const DEFAULT_QUOTE_WORD_LIMIT = 25;
const DEFAULT_MIN_SOURCE_CONFIDENCE = 0.65;
const DEFAULT_FRESHNESS_HOURS = 72;
const DEFAULT_STALE_DOC_HOURS = 24 * 30;
const PAYMENT_WRITE_ACTIONS = new Set([
  "payment_link_generate",
  "payment_retry_link_generate",
  "invoice_create",
  "invoice_reminder_send",
  "refund_request_initiate",
]);

function normalizeText(value, maxLength = 240) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, maxLength);
}

function normalizeEmailAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function isLikelyEmailAddress(value) {
  const email = normalizeEmailAddress(value);
  if (!email || !email.includes("@")) return false;
  const parts = email.split("@");
  return parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]);
}

function getEmailDomain(value) {
  const email = normalizeEmailAddress(value);
  const parts = email.split("@");
  return parts.length === 2 ? parts[1] : "";
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseCsvDomains(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function toIsoTimestamp(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function createId(prefix) {
  const randomSuffix = crypto.randomBytes(3).toString("hex");
  return `${prefix}_${Date.now().toString(36)}_${randomSuffix}`;
}

function sanitizeDomain(raw = "") {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

function extractDomainFromUrl(raw = "") {
  try {
    const parsed = new URL(String(raw || "").trim());
    return sanitizeDomain(parsed.hostname || "");
  } catch (_) {
    return sanitizeDomain(raw);
  }
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function isTruthyFlag(value) {
  return value === true || String(value || "").trim().toLowerCase() === "true";
}

function truncateWords(value = "", maxWords = DEFAULT_QUOTE_WORD_LIMIT) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, Math.max(1, Math.floor(maxWords))).join(" ");
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

function hasSensitiveCardData(payload = {}) {
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

function makeConnectorTools() {
  const connector = (id, className, riskClass, capabilityTags, approvalRequired = false) => ({
    id,
    class: className,
    risk_class: riskClass,
    capability_tags: capabilityTags,
    approval: { required: approvalRequired, mode: approvalRequired ? "explicit" : "none" },
  });

  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Deep research web search using trusted domains only. Auto-invoke when caller asks for latest updates, comparisons, or best options.",
        connector: connector(
          "deep_research_web_search",
          "read",
          "low",
          ["research", "web", "knowledge"],
        ),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query (required)." },
            domains: {
              type: "array",
              items: { type: "string" },
              description: "Optional trusted domains to constrain results.",
            },
            freshness_hours: {
              type: "integer",
              description: "Recency window in hours.",
              minimum: 1,
              maximum: 336,
            },
            max_results: {
              type: "integer",
              description: "Maximum number of sources to return.",
              minimum: 1,
              maximum: 8,
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "news_lookup",
        description:
          "Look up recent news with freshness timestamps and source confidence. Best for latest/what-changed requests.",
        connector: connector(
          "deep_research_news_lookup",
          "read",
          "low",
          ["research", "news", "knowledge"],
        ),
        parameters: {
          type: "object",
          properties: {
            topic: { type: "string", description: "News topic to search." },
            domains: { type: "array", items: { type: "string" } },
            freshness_hours: { type: "integer", minimum: 1, maximum: 336 },
            max_results: { type: "integer", minimum: 1, maximum: 8 },
          },
          required: ["topic"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "docs_lookup",
        description:
          "Look up official documentation and policy references. Useful for support troubleshooting and compliance checks.",
        connector: connector(
          "deep_research_docs_lookup",
          "read",
          "low",
          ["research", "docs", "knowledge", "compliance"],
        ),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            product: { type: "string" },
            domains: { type: "array", items: { type: "string" } },
            max_results: { type: "integer", minimum: 1, maximum: 8 },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "site_crawl_summary",
        description:
          "Crawl and summarize a trusted site URL for quick comparison/changes analysis.",
        connector: connector(
          "deep_research_site_crawl",
          "read",
          "low",
          ["research", "web", "knowledge"],
        ),
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Trusted URL to summarize." },
            max_pages: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "crm_lookup_account",
        description:
          "Business connector: fetch account status from CRM (HubSpot/Salesforce style). Auto-invoke for account-status inquiries.",
        connector: connector(
          "business_crm_lookup",
          "read",
          "medium",
          ["crm", "business_ops", "support"],
        ),
        parameters: {
          type: "object",
          properties: {
            account_id: { type: "string" },
            email: { type: "string" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "crm_create_lead",
        description:
          "Business connector: create CRM lead with write confirmation and audit trail.",
        connector: connector(
          "business_crm_create_lead",
          "side_effect",
          "medium",
          ["crm", "business_ops", "sales"],
        ),
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            interest: { type: "string" },
            confirm_write: { type: "boolean" },
          },
          required: ["name", "confirm_write"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ticket_create",
        description:
          "Business connector: create support ticket (Zendesk/Jira/Freshdesk style) with write confirmation.",
        connector: connector(
          "business_ticket_create",
          "side_effect",
          "medium",
          ["ticketing", "business_ops", "support"],
        ),
        parameters: {
          type: "object",
          properties: {
            subject: { type: "string" },
            description: { type: "string" },
            priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
            confirm_write: { type: "boolean" },
          },
          required: ["subject", "description", "confirm_write"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "email_send_followup",
        description:
          "SendGrid connector: queue a post-call follow-up email through the configured SendGrid provider with write confirmation and audit trail.",
        connector: connector(
          "business_sendgrid_followup",
          "side_effect",
          "medium",
          ["email", "sendgrid", "follow_up", "business_ops"],
          true,
        ),
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient email address." },
            from: {
              type: "string",
              description: "Optional sender email. Falls back to EMAIL_DEFAULT_FROM.",
            },
            subject: { type: "string" },
            text: { type: "string", description: "Plain-text email body." },
            html: { type: "string", description: "HTML email body." },
            script_id: {
              type: "string",
              description: "Optional stored email template/script id.",
            },
            template_id: {
              type: "string",
              description: "Alias for script_id.",
            },
            select_template: {
              type: "boolean",
              description:
                "Select an approved email template from call/payment/booking/support context.",
            },
            call_intent: { type: "string" },
            customer_status: { type: "string" },
            booking_state: { type: "string" },
            payment_state: { type: "string" },
            call_outcome: { type: "string" },
            transcript_summary: { type: "string" },
            variables: {
              type: "object",
              additionalProperties: true,
              description: "Template variables when script_id/template_id is used.",
            },
            send_at: {
              type: "string",
              description: "Optional future ISO timestamp for scheduled send.",
            },
            is_marketing: { type: "boolean" },
            tenant_id: { type: "string" },
            idempotency_key: { type: "string" },
            confirm_write: { type: "boolean" },
          },
          required: ["to", "confirm_write"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "calendar_check_availability",
        description:
          "Business connector: check calendar availability for scheduling.",
        connector: connector(
          "business_calendar_availability",
          "read",
          "low",
          ["scheduling", "calendar", "business_ops"],
        ),
        parameters: {
          type: "object",
          properties: {
            window_start: { type: "string" },
            window_end: { type: "string" },
            duration_min: { type: "integer", minimum: 15, maximum: 240 },
          },
          required: ["window_start", "window_end"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "order_lookup_status",
        description:
          "Business connector: check ERP/order-system status. Auto-invoke for order update requests.",
        connector: connector(
          "business_order_lookup",
          "read",
          "low",
          ["erp", "orders", "business_ops", "support"],
        ),
        parameters: {
          type: "object",
          properties: {
            order_id: { type: "string" },
            account_id: { type: "string" },
          },
          required: ["order_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "payment_connector_health",
        description:
          "Payment connector: inspect PayPal, Stripe, Square, managed endpoint, and scoped-key readiness without exposing secrets.",
        connector: connector(
          "billing_payment_connector_health",
          "read",
          "medium",
          ["payment", "billing", "business_ops", "audit"],
        ),
        parameters: {
          type: "object",
          properties: {
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "payment_connector_policy_evaluate",
        description:
          "Payment connector: evaluate connector routing and amount guardrails before attempting payment writes.",
        connector: connector(
          "billing_payment_connector_policy",
          "read",
          "medium",
          ["payment", "billing", "business_ops", "audit"],
        ),
        parameters: {
          type: "object",
          properties: {
            action: { type: "string" },
            amount: { type: "number" },
            currency: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
          },
          required: ["action"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "payment_link_generate",
        description:
          "Payment connector: generate a PCI-safe payment link. Never capture raw card data in model output.",
        connector: connector(
          "billing_payment_link",
          "side_effect",
          "high",
          ["payment", "billing", "business_ops"],
          true,
        ),
        parameters: {
          type: "object",
          properties: {
            amount: { type: "number" },
            currency: { type: "string" },
            description: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
            confirm_write: { type: "boolean" },
            dry_run: { type: "boolean" },
            live_mode: { type: "boolean" },
            idempotency_key: { type: "string" },
          },
          required: ["amount", "confirm_write"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "payment_retry_link_generate",
        description:
          "Payment connector: generate a retry/recovery checkout link for a failed or abandoned payment. Never capture raw card data in model output.",
        connector: connector(
          "billing_payment_retry_link",
          "side_effect",
          "high",
          ["payment", "billing", "business_ops", "risk"],
          true,
        ),
        parameters: {
          type: "object",
          properties: {
            amount: { type: "number" },
            currency: { type: "string" },
            description: { type: "string" },
            customer_ref: { type: "string" },
            customer_email: { type: "string" },
            payment_intent_id: { type: "string" },
            checkout_session_id: { type: "string" },
            payment_link_id: { type: "string" },
            order_id: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
            confirm_write: { type: "boolean" },
            dry_run: { type: "boolean" },
            live_mode: { type: "boolean" },
            idempotency_key: { type: "string" },
          },
          required: ["amount", "confirm_write"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "invoice_create",
        description:
          "Payment connector: create invoice with billing metadata and audit trail.",
        connector: connector(
          "billing_invoice_create",
          "side_effect",
          "high",
          ["billing", "payment", "business_ops"],
          true,
        ),
        parameters: {
          type: "object",
          properties: {
            amount: { type: "number" },
            currency: { type: "string" },
            due_date: { type: "string" },
            customer_ref: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
            confirm_write: { type: "boolean" },
            dry_run: { type: "boolean" },
            live_mode: { type: "boolean" },
            idempotency_key: { type: "string" },
          },
          required: ["amount", "customer_ref", "confirm_write"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "invoice_reminder_send",
        description:
          "Payment connector: send an invoice reminder through the selected billing provider with audit trail.",
        connector: connector(
          "billing_invoice_reminder",
          "side_effect",
          "high",
          ["billing", "payment", "business_ops"],
          true,
        ),
        parameters: {
          type: "object",
          properties: {
            invoice_id: { type: "string" },
            customer_ref: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal or stripe.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
            confirm_write: { type: "boolean" },
            dry_run: { type: "boolean" },
            live_mode: { type: "boolean" },
            idempotency_key: { type: "string" },
          },
          required: ["invoice_id", "confirm_write"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "payment_intent_status",
        description:
          "Payment connector: fetch payment intent status for billing follow-up.",
        connector: connector(
          "billing_payment_intent_status",
          "read",
          "medium",
          ["payment", "billing", "business_ops"],
        ),
        parameters: {
          type: "object",
          properties: {
            payment_intent_id: { type: "string" },
            checkout_session_id: { type: "string" },
            payment_link_id: { type: "string" },
            invoice_id: { type: "string" },
            refund_id: { type: "string" },
            order_id: { type: "string" },
            payment_id: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "payment_session_history",
        description:
          "Payment connector: inspect local payment session and webhook history for checkout, order, invoice, refund, or call follow-up.",
        connector: connector(
          "billing_payment_session_history",
          "read",
          "medium",
          ["payment", "billing", "business_ops", "audit"],
        ),
        parameters: {
          type: "object",
          properties: {
            payment_intent_id: { type: "string" },
            checkout_session_id: { type: "string" },
            payment_link_id: { type: "string" },
            order_id: { type: "string" },
            payment_id: { type: "string" },
            invoice_id: { type: "string" },
            refund_id: { type: "string" },
            call_sid: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
            limit: { type: "integer", minimum: 1, maximum: 25 },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "payment_failure_summary",
        description:
          "Payment connector: summarize recent failed, expired, or canceled checkout attempts for recovery follow-up.",
        connector: connector(
          "billing_payment_failure_summary",
          "read",
          "medium",
          ["payment", "billing", "business_ops", "audit", "risk"],
        ),
        parameters: {
          type: "object",
          properties: {
            payment_intent_id: { type: "string" },
            checkout_session_id: { type: "string" },
            payment_link_id: { type: "string" },
            order_id: { type: "string" },
            payment_id: { type: "string" },
            invoice_id: { type: "string" },
            refund_id: { type: "string" },
            call_sid: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
            limit: { type: "integer", minimum: 1, maximum: 25 },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "customer_payment_profile",
        description:
          "Payment connector: summarize locally known customer payment history without exposing raw payment credentials.",
        connector: connector(
          "billing_customer_payment_profile",
          "read",
          "medium",
          ["payment", "billing", "business_ops", "audit"],
        ),
        parameters: {
          type: "object",
          properties: {
            customer_ref: { type: "string" },
            customer_id: { type: "string" },
            customer_email: { type: "string" },
            call_sid: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
            limit: { type: "integer", minimum: 1, maximum: 25 },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "paypal_agent_toolkit_manifest",
        description:
          "Payment connector: inspect official PayPal Agent Toolkit tools configured for this deployment.",
        connector: connector(
          "billing_paypal_agent_toolkit_manifest",
          "read",
          "medium",
          ["payment", "billing", "business_ops", "audit"],
        ),
        parameters: {
          type: "object",
          properties: {
            payment_connector: { type: "string" },
            connector: { type: "string" },
          },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "paypal_agent_toolkit_execute",
        description:
          "Payment connector: execute an allowlisted read-only official PayPal Agent Toolkit tool.",
        connector: connector(
          "billing_paypal_agent_toolkit_execute",
          "read",
          "medium",
          ["payment", "billing", "business_ops", "audit"],
        ),
        parameters: {
          type: "object",
          properties: {
            tool_name: {
              type: "string",
              enum: PAYPAL_AGENT_TOOLKIT_READ_TOOLS,
              description: "Read-only PayPal Agent Toolkit tool name.",
            },
            input: {
              type: "object",
              additionalProperties: true,
              description: "JSON input passed directly to the selected PayPal toolkit tool.",
            },
            payment_connector: { type: "string" },
            connector: { type: "string" },
          },
          required: ["tool_name", "input"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "refund_request_initiate",
        description:
          "Payment connector: initiate refund request with double confirmation before execution.",
        connector: connector(
          "billing_refund_request",
          "side_effect",
          "high",
          ["payment", "billing", "business_ops", "risk"],
          true,
        ),
        parameters: {
          type: "object",
          properties: {
            payment_intent_id: { type: "string" },
            charge_id: { type: "string" },
            capture_id: { type: "string" },
            order_id: { type: "string" },
            payment_id: { type: "string" },
            amount: { type: "number" },
            currency: { type: "string" },
            reason: { type: "string" },
            payment_connector: {
              type: "string",
              description: "Optional payment connector override, for example paypal, stripe, or square.",
            },
            connector: {
              type: "string",
              description: "Alias for payment_connector when a connector-specific payment path is required.",
            },
            confirm_primary: { type: "boolean" },
            confirm_secondary: { type: "boolean" },
            confirm_write: { type: "boolean" },
            dry_run: { type: "boolean" },
            live_mode: { type: "boolean" },
            idempotency_key: { type: "string" },
          },
          required: ["reason", "confirm_primary", "confirm_secondary", "confirm_write"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "kyc_verify_identity",
        description:
          "Identity connector: perform KYC identity checks for account recovery/high-value actions.",
        connector: connector(
          "risk_kyc_verify",
          "read",
          "medium",
          ["identity", "risk", "verification"],
        ),
        parameters: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
            verification_level: { type: "string", enum: ["basic", "enhanced", "step_up"] },
          },
          required: ["customer_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fraud_score_assess",
        description:
          "Risk connector: calculate fraud score and recommend allow/step-up/block action.",
        connector: connector(
          "risk_fraud_score",
          "read",
          "high",
          ["risk", "fraud", "verification"],
          true,
        ),
        parameters: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
            amount: { type: "number" },
            velocity_count: { type: "integer" },
            list_hit: { type: "boolean" },
          },
          required: ["customer_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "velocity_check",
        description:
          "Risk connector: evaluate request velocity and trigger step-up if threshold exceeded.",
        connector: connector(
          "risk_velocity_check",
          "read",
          "medium",
          ["risk", "fraud", "verification"],
        ),
        parameters: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
            window_minutes: { type: "integer", minimum: 1, maximum: 1440 },
            events_count: { type: "integer", minimum: 0, maximum: 5000 },
          },
          required: ["customer_id", "events_count"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "risk_list_check",
        description:
          "Risk connector: check allowlist/denylist for suspicious identity or destination.",
        connector: connector(
          "risk_list_check",
          "read",
          "medium",
          ["risk", "fraud", "verification"],
        ),
        parameters: {
          type: "object",
          properties: {
            identifier: { type: "string" },
            list_type: { type: "string", enum: ["allow", "deny", "both"] },
          },
          required: ["identifier"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "kb_search",
        description:
          "Knowledge connector: query internal KB with citations and staleness metadata.",
        connector: connector(
          "knowledge_kb_search",
          "read",
          "low",
          ["knowledge", "kb", "support"],
        ),
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            max_results: { type: "integer", minimum: 1, maximum: 8 },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "runbook_lookup",
        description: "Knowledge connector: fetch operational runbook guidance with version metadata.",
        connector: connector(
          "knowledge_runbook_lookup",
          "read",
          "low",
          ["knowledge", "runbook", "support"],
        ),
        parameters: {
          type: "object",
          properties: {
            incident_type: { type: "string" },
          },
          required: ["incident_type"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "policy_lookup",
        description:
          "Knowledge connector: fetch policy/compliance docs. Requires citations for high-risk policy responses.",
        connector: connector(
          "knowledge_policy_lookup",
          "read",
          "medium",
          ["knowledge", "policy", "compliance"],
        ),
        parameters: {
          type: "object",
          properties: {
            policy_name: { type: "string" },
          },
          required: ["policy_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "product_doc_lookup",
        description:
          "Knowledge connector: fetch product documentation references for factual troubleshooting.",
        connector: connector(
          "knowledge_product_docs",
          "read",
          "low",
          ["knowledge", "docs", "support"],
        ),
        parameters: {
          type: "object",
          properties: {
            product: { type: "string" },
            query: { type: "string" },
          },
          required: ["product", "query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "contract_lookup",
        description:
          "Knowledge connector: fetch contract clauses with citation requirement for compliance-sensitive responses.",
        connector: connector(
          "knowledge_contract_lookup",
          "read",
          "medium",
          ["knowledge", "contract", "compliance"],
        ),
        parameters: {
          type: "object",
          properties: {
            contract_id: { type: "string" },
            query: { type: "string" },
          },
          required: ["contract_id", "query"],
        },
      },
    },
  ];
}

const connectorPackTools = Object.freeze(makeConnectorTools());

function buildConnectorPackImplementations(options = {}) {
  const callSid = String(options.callSid || "").trim();
  const getCallConfig =
    typeof options.getCallConfig === "function" ? options.getCallConfig : () => ({});
  const setCallConfig =
    typeof options.setCallConfig === "function" ? options.setCallConfig : () => {};
  const db = options.db || null;
  const webhookService = options.webhookService || null;
  const getPaymentFeatureConfig =
    typeof options.getPaymentFeatureConfig === "function"
      ? options.getPaymentFeatureConfig
      : () => ({ enabled: true });
  const isPaymentFeatureEnabledForProvider =
    typeof options.isPaymentFeatureEnabledForProvider === "function"
      ? options.isPaymentFeatureEnabledForProvider
      : () => true;
  const currentProviderResolver =
    typeof options.getCurrentProvider === "function"
      ? options.getCurrentProvider
      : () => "twilio";
  const fetchFn = options.fetchFn;
  const emailService = options.emailService || null;
  const crmContactSyncService = options.crmContactSyncService || null;
  let paymentProviderSwitchboard = null;

  const getPaymentProviderSwitchboard = () => {
    if (!paymentProviderSwitchboard) {
      paymentProviderSwitchboard = createPaymentProviderSwitchboard({
        callSid,
        db,
        fetchFn,
        getCallConfig,
        managedInvoker: maybeInvokeManagedEndpoint,
        hasPaymentScopedKey: () => Boolean(getScopedKey("payment")),
        hasManagedEndpoint: () => Boolean(getManagedEndpoint("payment")),
        paypalAgentToolkitFactory: options.paypalAgentToolkitFactory,
        paypalConfig: options.paypalConfig,
        squareConfig: options.squareConfig,
        stripeConfig: options.stripeConfig,
      });
    }
    return paymentProviderSwitchboard;
  };

  const logAudit = async (action, status, payload = {}) => {
    const safePayload =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : { value: payload };
    await db?.updateCallState?.(callSid, "connector_action", {
      action,
      status,
      ...safePayload,
      at: new Date().toISOString(),
    });
    webhookService?.addLiveEvent?.(callSid, `🔌 ${action} (${status})`, { force: false });
  };

  const getPolicy = () => {
    const callConfig = getCallConfig() || {};
    const trustedFromConfig = Array.isArray(callConfig?.connector_policy?.trusted_domains)
      ? callConfig.connector_policy.trusted_domains
      : parseCsvDomains(process.env.CONNECTOR_TRUSTED_DOMAINS);
    const trustedDomains = Array.from(
      new Set(
        (trustedFromConfig.length ? trustedFromConfig : DEFAULT_TRUSTED_DOMAINS)
          .map((entry) => sanitizeDomain(entry))
          .filter(Boolean),
      ),
    );
    return {
      trusted_domains: trustedDomains,
      quote_word_limit: clampNumber(
        callConfig?.connector_policy?.quote_word_limit,
        8,
        60,
        clampNumber(process.env.CONNECTOR_QUOTE_WORD_LIMIT, 8, 60, DEFAULT_QUOTE_WORD_LIMIT),
      ),
      min_source_confidence: clampNumber(
        callConfig?.connector_policy?.min_source_confidence,
        0.1,
        1,
        clampNumber(
          process.env.CONNECTOR_MIN_SOURCE_CONFIDENCE,
          0.1,
          1,
          DEFAULT_MIN_SOURCE_CONFIDENCE,
        ),
      ),
      freshness_hours: clampNumber(
        callConfig?.connector_policy?.freshness_hours,
        1,
        336,
        clampNumber(process.env.CONNECTOR_FRESHNESS_HOURS, 1, 336, DEFAULT_FRESHNESS_HOURS),
      ),
      stale_doc_hours: clampNumber(
        callConfig?.connector_policy?.stale_doc_hours,
        1,
        24 * 365,
        clampNumber(process.env.CONNECTOR_STALE_DOC_HOURS, 1, 24 * 365, DEFAULT_STALE_DOC_HOURS),
      ),
      require_write_confirmation:
        callConfig?.connector_policy?.require_write_confirmation !== false,
    };
  };

  const getScopedKey = (scope) => {
    const callConfig = getCallConfig() || {};
    const fromConfig =
      callConfig?.connector_api_keys &&
      typeof callConfig.connector_api_keys === "object"
        ? callConfig.connector_api_keys[scope]
        : null;
    if (fromConfig) return String(fromConfig || "").trim();
    const envKeyMap = {
      research: process.env.CONNECTOR_RESEARCH_API_KEY,
      business: process.env.CONNECTOR_BUSINESS_API_KEY,
      payment: process.env.CONNECTOR_PAYMENT_API_KEY,
      risk: process.env.CONNECTOR_RISK_API_KEY,
      knowledge: process.env.CONNECTOR_KNOWLEDGE_API_KEY,
    };
    return String(envKeyMap[scope] || "").trim();
  };

  const getManagedEndpoint = (scope) => {
    const callConfig = getCallConfig() || {};
    return (
      (callConfig?.connector_endpoints &&
        typeof callConfig.connector_endpoints === "object" &&
        callConfig.connector_endpoints[scope]) ||
      process.env[`CONNECTOR_${String(scope || "").toUpperCase()}_ENDPOINT`] ||
      ""
    );
  };

  const assertTrustedDomains = (domains = []) => {
    const policy = getPolicy();
    const requested = Array.isArray(domains)
      ? domains.map((entry) => sanitizeDomain(entry)).filter(Boolean)
      : [];
    if (!requested.length) {
      return {
        ok: true,
        requested: [],
        trusted: policy.trusted_domains,
      };
    }
    const untrusted = requested.filter((entry) => !policy.trusted_domains.includes(entry));
    if (untrusted.length) {
      return {
        ok: false,
        error: "untrusted_domain_requested",
        untrusted,
        trusted: policy.trusted_domains,
      };
    }
    return { ok: true, requested, trusted: policy.trusted_domains };
  };

  const requireWriteConfirmation = (args = {}, actionName = "connector_write") => {
    const policy = getPolicy();
    if (policy.require_write_confirmation !== true) {
      return { ok: true };
    }
    if (args.confirm_write === true) {
      return { ok: true };
    }
    return {
      ok: false,
      error: "write_confirmation_required",
      message: `${actionName} requires confirm_write=true.`,
    };
  };

  const blockedResult = async (action, result = {}, payload = {}) => {
    await logAudit(action, "blocked", {
      ...payload,
      error: normalizeText(result?.error || "blocked", 80) || "blocked",
    });
    return result;
  };

  const buildConnectorIdempotencyKey = (action, args = {}) => {
    const provided = normalizeText(args.idempotency_key || args.idempotencyKey, 180);
    if (provided) {
      return { key: provided, generated: false };
    }
    const digest = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          call_sid: callSid || null,
          action,
          to: normalizeEmailAddress(args.to || args.email || args.recipient_email),
          subject: normalizeText(args.subject, 180),
          script_id: normalizeText(args.script_id || args.template_id, 120),
          select_template: args.select_template === true,
          call_intent: normalizeText(args.call_intent || args.intent, 120),
          customer_status: normalizeText(args.customer_status, 120),
          booking_state: normalizeText(args.booking_state, 120),
          payment_state: normalizeText(args.payment_state || args.payment_status, 120),
          call_outcome: normalizeText(args.call_outcome || args.outcome, 120),
        }),
      )
      .digest("hex")
      .slice(0, 24);
    return { key: `connector_${action}_${digest}`, generated: true };
  };

  const buildSourceRecord = (
    url,
    title,
    snippet,
    confidence = 0.75,
    quoteWords = DEFAULT_QUOTE_WORD_LIMIT,
    publishedAt = Date.now(),
  ) => ({
    title: normalizeText(title, 120),
    url: String(url || "").trim(),
    snippet: normalizeText(snippet, 280),
    quote: truncateWords(snippet, quoteWords),
    source_confidence: Number(clampNumber(confidence, 0, 1, 0.75).toFixed(2)),
    published_at: toIsoTimestamp(publishedAt),
    fetched_at: new Date().toISOString(),
  });

  const maybeInvokeManagedEndpoint = async (scope, action, payload = {}) => {
    const endpoint = getManagedEndpoint(scope);
    if (!endpoint || typeof fetchFn !== "function") {
      return null;
    }
    const apiKey = getScopedKey(scope);
    const controller = new AbortController();
    const timeoutMs = clampNumber(process.env.CONNECTOR_HTTP_TIMEOUT_MS, 2000, 20000, 7000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(String(endpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { "x-connector-key": apiKey } : {}),
        },
        body: JSON.stringify({
          action,
          call_sid: callSid || null,
          payload,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          error: "connector_http_error",
          status: response.status,
        };
      }
      const data = await response.json().catch(() => null);
      if (!data || typeof data !== "object") {
        return { ok: false, error: "connector_invalid_json" };
      }
      return { ok: true, data, mode: "managed" };
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || "connector_request_failed"),
      };
    } finally {
      clearTimeout(timeout);
    }
  };

  const maybeInvokePaypalConnector = async (action, args = {}) => {
    return getPaymentProviderSwitchboard().invokeProvider("paypal", action, args);
  };

  const requireScopedKey = (scope, mode = "read") => {
    const key = getScopedKey(scope);
    if (mode === "read") {
      return { ok: true, key_present: Boolean(key) };
    }
    if (!key) {
      return {
        ok: false,
        error: "connector_api_key_missing",
        message: `Missing scoped API key for ${scope} connector.`,
      };
    }
    return { ok: true, key_present: true };
  };

  const buildResearchResponse = (action, queryValue, args = {}) => {
    const query = normalizeText(queryValue, 220);
    if (!query) {
      return { error: "invalid_query", message: "Query is required." };
    }
    const policy = getPolicy();
    const domainCheck = assertTrustedDomains(args.domains || []);
    if (!domainCheck.ok) {
      return {
        error: "untrusted_domain_requested",
        message: "Requested domains are not in the trusted allowlist.",
        untrusted_domains: domainCheck.untrusted,
        trusted_domains: domainCheck.trusted,
      };
    }
    const domains =
      domainCheck.requested.length > 0
        ? domainCheck.requested
        : policy.trusted_domains.slice(0, 3);
    const maxResults = clampNumber(args.max_results, 1, 8, 3);
    const quoteLimitWords = clampNumber(
      args.quote_word_limit_words,
      8,
      60,
      policy.quote_word_limit,
    );
    const freshnessHours = clampNumber(
      args.freshness_hours,
      1,
      336,
      policy.freshness_hours,
    );
    const now = Date.now();
    const sources = domains.slice(0, maxResults).map((domain, index) =>
      buildSourceRecord(
        `https://${domain}/search?q=${encodeURIComponent(query)}`,
        `${action.toUpperCase()} result ${index + 1} for "${query}"`,
        `Trusted source ${domain} indicates updated guidance related to "${query}".`,
        Math.max(policy.min_source_confidence, 0.68 - index * 0.04),
        quoteLimitWords,
        now - index * 3600 * 1000,
      ),
    );

    return {
      status: "ok",
      connector_mode: "stub",
      action,
      query,
      trusted_domains: policy.trusted_domains,
      freshness_window_hours: freshnessHours,
      freshness_checked_at: new Date().toISOString(),
      source_confidence_min: policy.min_source_confidence,
      quote_word_limit: quoteLimitWords,
      sources,
    };
  };

  const ensurePaymentSafety = (args = {}) => {
    if (hasSensitiveCardData(args)) {
      return {
        ok: false,
        error: "pci_violation_blocked",
        message:
          "Direct card data input is blocked. Use PCI-safe tokenized payment flows only.",
      };
    }
    return { ok: true };
  };

  const ensurePaymentFeatureEnabled = () => {
    const callConfig = getCallConfig() || {};
    const provider = String(currentProviderResolver() || "twilio").trim().toLowerCase();
    const feature = getPaymentFeatureConfig();
    const enabled = isPaymentFeatureEnabledForProvider(provider, {
      hasScript: callConfig?.script_id != null,
      smsFallbackEnabled: feature.allow_sms_fallback !== false,
      smsServiceReady: true,
    });
    if (!enabled) {
      return {
        ok: false,
        error: "payment_connector_disabled",
        message: "Payment connector is disabled by runtime feature policy.",
      };
    }
    return { ok: true };
  };

  const hasExplicitPaymentConnector = (args = {}) => {
    const callConfig = getCallConfig() || {};
    return Boolean(
      normalizeText(args.payment_connector || args.connector, 80) ||
        normalizeText(callConfig.payment_connector || callConfig?.payment?.connector, 80),
    );
  };

  const isPaymentDryRun = (args = {}) => {
    const callConfig = getCallConfig() || {};
    return (
      isTruthyFlag(args.dry_run) ||
      isTruthyFlag(callConfig.payment_dry_run) ||
      isTruthyFlag(process.env.PAYMENT_CONNECTOR_DRY_RUN)
    );
  };

  const isPaymentLiveMode = (args = {}) => {
    const callConfig = getCallConfig() || {};
    const environment = normalizeText(
      args.payment_environment ||
        callConfig.payment_environment ||
        callConfig?.payment?.environment ||
        "",
      40,
    ).toLowerCase();
    return (
      isTruthyFlag(args.live_mode) ||
      isTruthyFlag(callConfig.payment_live_mode) ||
      isTruthyFlag(process.env.PAYMENT_LIVE_MODE) ||
      environment === "live" ||
      environment === "production"
    );
  };

  const buildPaymentIdempotencyKey = (action, args = {}) => {
    const existing = normalizeText(args.idempotency_key || args.idempotencyKey, 180);
    if (existing) return { key: existing, generated: false };
    const basis = {
      call_sid: callSid || "no-call",
      action,
      connector: getPaymentProviderSwitchboard().getRequestedConnector(args) || null,
      amount: args.amount ?? null,
      currency: normalizeText(args.currency, 12).toUpperCase() || null,
      customer_ref:
        normalizeText(args.customer_ref || args.customer_id || args.customer_email, 120) ||
        null,
      payment_intent_id:
        normalizeText(args.payment_intent_id || args.charge_id || args.capture_id, 160) ||
        null,
      reason: normalizeText(args.reason, 80) || null,
    };
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify(basis))
      .digest("hex")
      .slice(0, 24);
    return { key: `vp_${normalizeText(action, 40)}_${digest}`, generated: true };
  };

  const preparePaymentWriteArgs = (action, args = {}) => {
    if (!PAYMENT_WRITE_ACTIONS.has(action)) {
      return { ok: true, args, dryRun: false, liveMode: false, idempotencyGenerated: false };
    }
    const dryRun = isPaymentDryRun(args);
    const liveMode = isPaymentLiveMode(args) && !dryRun;
    if (liveMode && !hasExplicitPaymentConnector(args)) {
      return {
        ok: false,
        error: "payment_live_connector_required",
        message:
          "Live payment writes require an explicit payment_connector or connector selection.",
      };
    }
    const switchboard = getPaymentProviderSwitchboard();
    const policy = evaluatePaymentConnectorPolicy(action, args, {
      callConfig: getCallConfig() || {},
      requestedProvider: switchboard.getRequestedProvider(args),
      requestedConnector: switchboard.getRequestedConnector(args),
    });
    if (!policy.ok) {
      return policy;
    }
    const idempotency = buildPaymentIdempotencyKey(action, args);
    return {
      ok: true,
      args: {
        ...args,
        idempotency_key: idempotency.key,
      },
      dryRun,
      liveMode,
      idempotencyGenerated: idempotency.generated,
    };
  };

  const defaultDocs = [
    {
      id: "kb-reset-password",
      title: "Reset Password Runbook",
      version: "v3.4",
      updated_at: toIsoTimestamp(Date.now() - 7 * 24 * 3600 * 1000),
      url: "https://internal.example/kb/reset-password",
      body: "Reset password by verifying identity, issuing secure reset link, and confirming completion.",
      tags: ["kb", "support", "account"],
    },
    {
      id: "policy-refund-standard",
      title: "Refund Policy Standard",
      version: "v2.1",
      updated_at: toIsoTimestamp(Date.now() - 2 * 24 * 3600 * 1000),
      url: "https://internal.example/policy/refund",
      body: "Refunds require original payment reference, reason code, and dual confirmation for high-risk flows.",
      tags: ["policy", "billing", "compliance"],
    },
    {
      id: "contract-sla-core",
      title: "Core SLA Contract Clauses",
      version: "v1.9",
      updated_at: toIsoTimestamp(Date.now() - 10 * 24 * 3600 * 1000),
      url: "https://internal.example/contracts/sla-core",
      body: "SLA clauses include response window, uptime thresholds, and penalty terms.",
      tags: ["contract", "legal", "compliance"],
    },
    {
      id: "product-api-auth",
      title: "Product API Auth Guide",
      version: "v5.0",
      updated_at: toIsoTimestamp(Date.now() - 1 * 24 * 3600 * 1000),
      url: "https://internal.example/docs/api-auth",
      body: "Use OAuth client credentials with scoped tokens and rotate secrets every 90 days.",
      tags: ["docs", "product", "api"],
    },
  ];

  const queryDocs = (query = "", tags = [], maxResults = 3) => {
    const needle = normalizeText(query, 220).toLowerCase();
    const requestedTags = Array.isArray(tags)
      ? tags.map((entry) => normalizeText(entry, 50).toLowerCase()).filter(Boolean)
      : [];
    const scored = defaultDocs
      .map((doc) => {
        const haystack = `${doc.title} ${doc.body} ${doc.tags.join(" ")}`.toLowerCase();
        let score = 0;
        if (needle && haystack.includes(needle)) score += 2;
        requestedTags.forEach((tag) => {
          if (doc.tags.includes(tag)) score += 1;
        });
        return { doc, score };
      })
      .filter((entry) => entry.score > 0 || (!needle && requestedTags.length === 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((entry) => entry.doc);
    return scored;
  };

  const buildKnowledgePayload = (action, query, tags = []) => {
    const policy = getPolicy();
    const maxResults = 4;
    const docs = queryDocs(query, tags, maxResults).map((doc) => {
      const ageHours = Math.max(
        0,
        Math.round((Date.now() - new Date(doc.updated_at).getTime()) / (3600 * 1000)),
      );
      const stale = ageHours > policy.stale_doc_hours;
      return {
        id: doc.id,
        title: doc.title,
        version: doc.version,
        updated_at: doc.updated_at,
        stale,
        age_hours: ageHours,
        url: doc.url,
        summary: truncateWords(doc.body, 26),
        citation: `${doc.title} (${doc.version})`,
      };
    });
    const citations = docs.map((doc) => doc.citation);
    const requiresCitation = action === "policy_lookup" || action === "contract_lookup";
    if (requiresCitation && citations.length === 0) {
      return {
        error: "citation_required",
        message: "No citation-backed knowledge documents found for this high-risk query.",
      };
    }
    return {
      status: "ok",
      connector_mode: "stub",
      action,
      query: normalizeText(query, 220),
      citation_required: requiresCitation,
      documents: docs,
      citations,
    };
  };

  return {
    web_search: async (args = {}) => {
      const managed = await maybeInvokeManagedEndpoint("research", "web_search", args);
      const result =
        managed?.ok === true
          ? { status: "ok", connector_mode: "managed", ...managed.data }
          : buildResearchResponse("web_search", args.query, args);
      await logAudit("web_search", result.error ? "blocked" : "ok", {
        query: normalizeText(args.query, 120),
      });
      return result;
    },

    news_lookup: async (args = {}) => {
      const topic = args.topic || args.query;
      const managed = await maybeInvokeManagedEndpoint("research", "news_lookup", args);
      const result =
        managed?.ok === true
          ? { status: "ok", connector_mode: "managed", ...managed.data }
          : buildResearchResponse("news_lookup", topic, args);
      await logAudit("news_lookup", result.error ? "blocked" : "ok", {
        topic: normalizeText(topic, 120),
      });
      return result;
    },

    docs_lookup: async (args = {}) => {
      const query = args.query || args.product;
      const managed = await maybeInvokeManagedEndpoint("research", "docs_lookup", args);
      const result =
        managed?.ok === true
          ? { status: "ok", connector_mode: "managed", ...managed.data }
          : buildResearchResponse("docs_lookup", query, args);
      await logAudit("docs_lookup", result.error ? "blocked" : "ok", {
        query: normalizeText(query, 120),
      });
      return result;
    },

    site_crawl_summary: async (args = {}) => {
      const url = normalizeText(args.url, 280);
      if (!url) {
        return { error: "invalid_url", message: "url is required." };
      }
      const domain = extractDomainFromUrl(url);
      const domainCheck = assertTrustedDomains([domain]);
      if (!domainCheck.ok) {
        return {
          error: "untrusted_domain_requested",
          message: "URL domain is not in trusted allowlist.",
          untrusted_domains: [domain],
          trusted_domains: domainCheck.trusted,
        };
      }
      const managed = await maybeInvokeManagedEndpoint("research", "site_crawl_summary", args);
      if (managed?.ok === true) {
        await logAudit("site_crawl_summary", "ok", { domain });
        return { status: "ok", connector_mode: "managed", ...managed.data };
      }
      const maxPages = clampNumber(args.max_pages, 1, 10, 3);
      const pages = Array.from({ length: maxPages }).map((_, index) => ({
        url: `${url.replace(/\/$/, "")}/page-${index + 1}`,
        title: `Crawled page ${index + 1}`,
        summary: `Summary for page ${index + 1} from ${domain}.`,
      }));
      const result = {
        status: "ok",
        connector_mode: "stub",
        url,
        domain,
        crawled_at: new Date().toISOString(),
        pages,
        summary:
          `Site crawl summary generated for ${domain}. ${pages.length} pages analyzed with trusted-domain policy.`,
      };
      await logAudit("site_crawl_summary", "ok", { domain, page_count: pages.length });
      return result;
    },

    crm_lookup_account: async (args = {}) => {
      const scoped = requireScopedKey("business", "read");
      const accountId = normalizeText(args.account_id || args.email, 80);
      if (!accountId) {
        return { error: "invalid_account_identifier", message: "account_id or email is required." };
      }
      const managed = await maybeInvokeManagedEndpoint("business", "crm_lookup_account", args);
      const result =
        managed?.ok === true
          ? { status: "ok", connector_mode: "managed", ...managed.data }
          : {
              status: "ok",
              connector_mode: "stub",
              key_present: scoped.key_present === true,
              account_id: accountId,
              account_status: "active",
              owner: "Customer Success",
              health: "green",
            };
      await logAudit("crm_lookup_account", "ok", { account_id: accountId });
      return result;
    },

    crm_create_lead: async (args = {}) => {
      const scoped = requireScopedKey("business", "write");
      if (!scoped.ok) return scoped;
      const confirmation = requireWriteConfirmation(args, "crm_create_lead");
      if (!confirmation.ok) return confirmation;
      const name = normalizeText(args.name, 80);
      if (!name) return { error: "invalid_name", message: "Lead name is required." };
      const managed = await maybeInvokeManagedEndpoint("business", "crm_create_lead", args);
      let result = managed?.ok === true
        ? { status: "ok", connector_mode: "managed", ...managed.data }
        : null;
      if (!result && crmContactSyncService && typeof crmContactSyncService.upsertContact === "function") {
        try {
          const synced = await crmContactSyncService.upsertContact({
            provider: args.provider || args.crm_provider || "stub",
            contact: {
              name,
              email: normalizeText(args.email, 120) || null,
              phone: normalizeText(args.phone, 80) || null,
              interest: normalizeText(args.interest, 120) || null,
            },
            metadata: {
              connector: "crm_create_lead",
              call_sid: callSid || null,
            },
          });
          result = {
            status: "ok",
            connector_mode: "crm_service",
            lead_id: synced.contact_id || null,
            created_at: new Date().toISOString(),
            name,
            email: normalizeText(args.email, 120) || null,
            interest: normalizeText(args.interest, 120) || null,
          };
        } catch (error) {
          return blockedResult("crm_create_lead", {
            error: normalizeText(error?.code || "crm_sync_failed", 80),
            message: normalizeText(error?.message || "CRM contact sync failed.", 240),
          });
        }
      }
      if (!result) {
        result = {
          status: "ok",
          connector_mode: "stub",
          lead_id: createId("lead"),
          created_at: new Date().toISOString(),
          name,
          email: normalizeText(args.email, 120) || null,
          interest: normalizeText(args.interest, 120) || null,
        };
      }
      await logAudit("crm_create_lead", "ok", { lead_id: result.lead_id || null });
      return result;
    },

    ticket_create: async (args = {}) => {
      const scoped = requireScopedKey("business", "write");
      if (!scoped.ok) return scoped;
      const confirmation = requireWriteConfirmation(args, "ticket_create");
      if (!confirmation.ok) return confirmation;
      if (!normalizeText(args.subject, 140) || !normalizeText(args.description, 320)) {
        return {
          error: "invalid_ticket_payload",
          message: "subject and description are required.",
        };
      }
      const managed = await maybeInvokeManagedEndpoint("business", "ticket_create", args);
      const result =
        managed?.ok === true
          ? { status: "ok", connector_mode: "managed", ...managed.data }
          : {
              status: "ok",
              connector_mode: "stub",
              ticket_id: createId("ticket"),
              priority: normalizeText(args.priority, 20) || "normal",
              created_at: new Date().toISOString(),
            };
      await logAudit("ticket_create", "ok", { ticket_id: result.ticket_id || null });
      return result;
    },

    email_send_followup: async (args = {}) => {
      const confirmation = requireWriteConfirmation(args, "email_send_followup");
      if (!confirmation.ok) return blockedResult("email_send_followup", confirmation);

      const to = normalizeEmailAddress(args.to || args.email || args.recipient_email);
      if (!isLikelyEmailAddress(to)) {
        return blockedResult("email_send_followup", {
          error: "invalid_email_recipient",
          message: "Valid to email is required.",
        });
      }

      const subject = normalizeText(args.subject, 200);
      const scriptId = normalizeText(args.script_id || args.template_id, 120);
      const text = normalizeText(args.text || args.body || args.message, 200000);
      const html = normalizeText(args.html, 200000);
      const templateContext = {
        ...normalizeObject(args.template_context),
        call_intent: normalizeText(args.call_intent || args.intent, 120),
        customer_status: normalizeText(args.customer_status, 120),
        booking_state: normalizeText(args.booking_state, 120),
        payment_state: normalizeText(args.payment_state || args.payment_status, 120),
        call_outcome: normalizeText(args.call_outcome || args.outcome, 120),
        escalation_state: normalizeText(args.escalation_state || args.ticket_state, 120),
        transcript_summary: normalizeText(args.transcript_summary, 500),
      };
      Object.keys(templateContext).forEach((key) => {
        if (templateContext[key] === "") {
          delete templateContext[key];
        }
      });
      const shouldSelectTemplate =
        args.select_template === true ||
        args.auto_select_template === true ||
        (!scriptId && !subject && !text && !html && Object.keys(templateContext).length > 0);
      if (!scriptId && !shouldSelectTemplate && !subject) {
        return blockedResult("email_send_followup", {
          error: "invalid_email_subject",
          message: "subject is required when no script_id/template_id is provided.",
        });
      }
      if (!scriptId && !shouldSelectTemplate && !text && !html) {
        return blockedResult("email_send_followup", {
          error: "invalid_email_body",
          message: "text or html is required when no script_id/template_id is provided.",
        });
      }

      const idempotency = buildConnectorIdempotencyKey("email_send_followup", {
        ...args,
        to,
        subject,
        script_id: scriptId,
      });
      const metadata = {
        ...normalizeObject(args.metadata),
        connector: "sendgrid",
        connector_action: "email_send_followup",
        call_sid: callSid || null,
        ...(Object.keys(templateContext).length ? { template_context: templateContext } : {}),
      };
      const emailPayload = {
        to,
        provider: "sendgrid",
        variables: normalizeObject(args.variables),
        metadata,
        is_marketing: args.is_marketing === true,
        ...(shouldSelectTemplate ? { select_template: true } : {}),
        ...(Object.keys(templateContext).length ? { template_context: templateContext } : {}),
        ...(normalizeText(args.from, 160) ? { from: normalizeText(args.from, 160) } : {}),
        ...(subject ? { subject } : {}),
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
        ...(scriptId ? { script_id: scriptId } : {}),
        ...(normalizeText(args.send_at, 80) ? { send_at: normalizeText(args.send_at, 80) } : {}),
        ...(normalizeText(args.tenant_id, 80) ? { tenant_id: normalizeText(args.tenant_id, 80) } : {}),
      };

      if (emailService && typeof emailService.enqueueEmail === "function") {
        try {
          const queued = await emailService.enqueueEmail(emailPayload, {
            idempotencyKey: idempotency.key,
          });
          const result = {
            status: "ok",
            connector_mode: "sendgrid",
            provider: "sendgrid",
            queued: queued?.suppressed ? false : true,
            suppressed: queued?.suppressed === true,
            deduped: queued?.deduped === true,
            message_id: queued?.message_id || null,
            idempotency_key_present: true,
            idempotency_key_generated: idempotency.generated,
          };
          await logAudit("email_send_followup", "ok", {
            provider: "sendgrid",
            message_id: result.message_id,
            recipient_domain: getEmailDomain(to),
            suppressed: result.suppressed,
          });
          return result;
        } catch (error) {
          return blockedResult("email_send_followup", {
            error: normalizeText(error?.code || "sendgrid_enqueue_failed", 80),
            message: normalizeText(error?.message || "SendGrid email enqueue failed.", 240),
          });
        }
      }

      if (getManagedEndpoint("business")) {
        const scoped = requireScopedKey("business", "write");
        if (!scoped.ok) return blockedResult("email_send_followup", scoped);
      }
      const managed = await maybeInvokeManagedEndpoint(
        "business",
        "email_send_followup",
        emailPayload,
      );
      const result =
        managed?.ok === true
          ? {
              status: "ok",
              connector_mode: "managed",
              provider: "sendgrid",
              ...managed.data,
            }
          : {
              status: "ok",
              connector_mode: "stub",
              provider: "sendgrid",
              queued: true,
              message_id: createId("email"),
              idempotency_key_present: true,
              idempotency_key_generated: idempotency.generated,
              created_at: new Date().toISOString(),
            };
      await logAudit("email_send_followup", "ok", {
        provider: "sendgrid",
        message_id: result.message_id || null,
        recipient_domain: getEmailDomain(to),
      });
      return result;
    },

    calendar_check_availability: async (args = {}) => {
      const start = toIsoTimestamp(args.window_start);
      const end = toIsoTimestamp(args.window_end);
      const durationMin = clampNumber(args.duration_min, 15, 240, 30);
      const managed = await maybeInvokeManagedEndpoint(
        "business",
        "calendar_check_availability",
        args,
      );
      const result =
        managed?.ok === true
          ? { status: "ok", connector_mode: "managed", ...managed.data }
          : {
              status: "ok",
              connector_mode: "stub",
              window_start: start,
              window_end: end,
              duration_min: durationMin,
              slots: [
                { start, end: toIsoTimestamp(Date.now() + durationMin * 60 * 1000) },
                {
                  start: toIsoTimestamp(Date.now() + 2 * 3600 * 1000),
                  end: toIsoTimestamp(Date.now() + 2 * 3600 * 1000 + durationMin * 60 * 1000),
                },
              ],
            };
      await logAudit("calendar_check_availability", "ok", { duration_min: durationMin });
      return result;
    },

    order_lookup_status: async (args = {}) => {
      const orderId = normalizeText(args.order_id, 80);
      if (!orderId) return { error: "invalid_order_id", message: "order_id is required." };
      const managed = await maybeInvokeManagedEndpoint("business", "order_lookup_status", args);
      const result =
        managed?.ok === true
          ? { status: "ok", connector_mode: "managed", ...managed.data }
          : {
              status: "ok",
              connector_mode: "stub",
              order_id: orderId,
              status: "in_transit",
              updated_at: new Date().toISOString(),
              eta: toIsoTimestamp(Date.now() + 24 * 3600 * 1000),
            };
      await logAudit("order_lookup_status", "ok", { order_id: orderId });
      return result;
    },

    payment_connector_health: async (args = {}) => {
      const result = getPaymentProviderSwitchboard().getHealth(args);
      await logAudit("payment_connector_health", "ok", {
        readiness: result.readiness,
        requested_provider: result.requested_provider || null,
      });
      return result;
    },

    payment_connector_policy_evaluate: async (args = {}) => {
      const action = normalizeText(args.action, 120);
      if (!action) {
        return blockedResult("payment_connector_policy_evaluate", {
          error: "missing_payment_policy_action",
          message: "action is required.",
        });
      }
      const switchboard = getPaymentProviderSwitchboard();
      const result = evaluatePaymentConnectorPolicy(action, args, {
        callConfig: getCallConfig() || {},
        requestedProvider: switchboard.getRequestedProvider(args),
        requestedConnector: switchboard.getRequestedConnector(args),
      });
      await logAudit("payment_connector_policy_evaluate", result.ok ? "ok" : "blocked", {
        action,
        provider: result.policy?.requested_provider || null,
        error: result.error || null,
      });
      return {
        status: result.ok ? "ok" : "blocked",
        ...result,
      };
    },

    payment_link_generate: async (args = {}) => {
      const safe = ensurePaymentSafety(args);
      if (!safe.ok) return blockedResult("payment_link_generate", safe);
      const confirmation = requireWriteConfirmation(args, "payment_link_generate");
      if (!confirmation.ok) return blockedResult("payment_link_generate", confirmation);
      const paymentEnabled = ensurePaymentFeatureEnabled();
      if (!paymentEnabled.ok) return blockedResult("payment_link_generate", paymentEnabled);
      const prepared = preparePaymentWriteArgs("payment_link_generate", args);
      if (!prepared.ok) return blockedResult("payment_link_generate", prepared);
      if (!prepared.dryRun) {
        const scoped = requireScopedKey("payment", "write");
        if (!scoped.ok) return blockedResult("payment_link_generate", scoped);
      }
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return blockedResult("payment_link_generate", {
          error: "invalid_amount",
          message: "amount must be a positive number.",
        });
      }
      const payment = await getPaymentProviderSwitchboard().execute(
        "payment_link_generate",
        prepared.args,
        {
          dryRun: prepared.dryRun,
          stubBuilder: () => ({
            payment_link_id: createId("plink"),
            payment_url: `https://pay.example/checkout/${createId("p")}`,
            amount: Number(amount.toFixed(2)),
            currency: normalizeText(args.currency, 3).toUpperCase() || "USD",
            expires_at: toIsoTimestamp(Date.now() + 2 * 3600 * 1000),
            idempotency_key_present: true,
          }),
        },
      );
      if (payment?.ok === false) {
        return blockedResult("payment_link_generate", payment.data);
      }
      const result = payment.data;
      await logAudit("payment_link_generate", "ok", {
        payment_link_id: result.payment_link_id || null,
        dry_run: prepared.dryRun,
        live_mode: prepared.liveMode,
        idempotency_key_present: true,
        idempotency_key_generated: prepared.idempotencyGenerated,
      });
      return result;
    },

    payment_retry_link_generate: async (args = {}) => {
      const safe = ensurePaymentSafety(args);
      if (!safe.ok) return blockedResult("payment_retry_link_generate", safe);
      const confirmation = requireWriteConfirmation(args, "payment_retry_link_generate");
      if (!confirmation.ok) return blockedResult("payment_retry_link_generate", confirmation);
      const paymentEnabled = ensurePaymentFeatureEnabled();
      if (!paymentEnabled.ok) return blockedResult("payment_retry_link_generate", paymentEnabled);
      const prepared = preparePaymentWriteArgs("payment_retry_link_generate", args);
      if (!prepared.ok) return blockedResult("payment_retry_link_generate", prepared);
      if (!prepared.dryRun) {
        const scoped = requireScopedKey("payment", "write");
        if (!scoped.ok) return blockedResult("payment_retry_link_generate", scoped);
      }
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return blockedResult("payment_retry_link_generate", {
          error: "invalid_amount",
          message: "amount must be a positive number.",
        });
      }
      const payment = await getPaymentProviderSwitchboard().execute(
        "payment_retry_link_generate",
        prepared.args,
        {
          dryRun: prepared.dryRun,
          stubBuilder: () => ({
            payment_link_id: createId("retry_plink"),
            recovery_payment_link_id: createId("recovery"),
            payment_url: `https://pay.example/retry/${createId("p")}`,
            amount: Number(amount.toFixed(2)),
            currency: normalizeText(args.currency, 3).toUpperCase() || "USD",
            source_payment_intent_id: normalizeText(args.payment_intent_id, 120) || null,
            source_checkout_session_id: normalizeText(args.checkout_session_id, 120) || null,
            source_order_id: normalizeText(args.order_id, 120) || null,
            expires_at: toIsoTimestamp(Date.now() + 2 * 3600 * 1000),
            idempotency_key_present: true,
          }),
        },
      );
      if (payment?.ok === false) {
        return blockedResult("payment_retry_link_generate", payment.data);
      }
      const result = payment.data;
      await logAudit("payment_retry_link_generate", "ok", {
        payment_link_id: result.payment_link_id || null,
        dry_run: prepared.dryRun,
        live_mode: prepared.liveMode,
        idempotency_key_present: true,
        idempotency_key_generated: prepared.idempotencyGenerated,
      });
      return result;
    },

    invoice_create: async (args = {}) => {
      const safe = ensurePaymentSafety(args);
      if (!safe.ok) return blockedResult("invoice_create", safe);
      const confirmation = requireWriteConfirmation(args, "invoice_create");
      if (!confirmation.ok) return blockedResult("invoice_create", confirmation);
      const paymentEnabled = ensurePaymentFeatureEnabled();
      if (!paymentEnabled.ok) return blockedResult("invoice_create", paymentEnabled);
      const prepared = preparePaymentWriteArgs("invoice_create", args);
      if (!prepared.ok) return blockedResult("invoice_create", prepared);
      if (!prepared.dryRun) {
        const scoped = requireScopedKey("payment", "write");
        if (!scoped.ok) return blockedResult("invoice_create", scoped);
      }
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return blockedResult("invoice_create", {
          error: "invalid_amount",
          message: "amount must be a positive number.",
        });
      }
      const payment = await getPaymentProviderSwitchboard().execute(
        "invoice_create",
        prepared.args,
        {
          dryRun: prepared.dryRun,
          stubBuilder: () => ({
            invoice_id: createId("inv"),
            customer_ref: normalizeText(args.customer_ref, 80),
            amount: Number(amount.toFixed(2)),
            currency: normalizeText(args.currency, 3).toUpperCase() || "USD",
            due_date: toIsoTimestamp(args.due_date || Date.now() + 3 * 24 * 3600 * 1000),
            idempotency_key_present: true,
          }),
        },
      );
      if (payment?.ok === false) {
        return blockedResult("invoice_create", payment.data);
      }
      const result = payment.data;
      await logAudit("invoice_create", "ok", {
        invoice_id: result.invoice_id || null,
        dry_run: prepared.dryRun,
        live_mode: prepared.liveMode,
        idempotency_key_present: true,
        idempotency_key_generated: prepared.idempotencyGenerated,
      });
      return result;
    },

    invoice_reminder_send: async (args = {}) => {
      const invoiceId = normalizeText(args.invoice_id, 160);
      if (!invoiceId) {
        return blockedResult("invoice_reminder_send", {
          error: "invalid_invoice_id",
          message: "invoice_id is required.",
        });
      }
      const safe = ensurePaymentSafety(args);
      if (!safe.ok) return blockedResult("invoice_reminder_send", safe);
      const confirmation = requireWriteConfirmation(args, "invoice_reminder_send");
      if (!confirmation.ok) return blockedResult("invoice_reminder_send", confirmation);
      const paymentEnabled = ensurePaymentFeatureEnabled();
      if (!paymentEnabled.ok) return blockedResult("invoice_reminder_send", paymentEnabled);
      const prepared = preparePaymentWriteArgs("invoice_reminder_send", args);
      if (!prepared.ok) return blockedResult("invoice_reminder_send", prepared);
      if (!prepared.dryRun) {
        const scoped = requireScopedKey("payment", "write");
        if (!scoped.ok) return blockedResult("invoice_reminder_send", scoped);
      }
      const payment = await getPaymentProviderSwitchboard().execute(
        "invoice_reminder_send",
        prepared.args,
        {
          dryRun: prepared.dryRun,
          stubBuilder: () => ({
            invoice_id: invoiceId,
            reminder_sent: true,
            state: "sent",
            sent_at: new Date().toISOString(),
            idempotency_key_present: true,
          }),
        },
      );
      if (payment?.ok === false) {
        return blockedResult("invoice_reminder_send", payment.data);
      }
      const result = payment.data;
      await logAudit("invoice_reminder_send", "ok", {
        invoice_id: result.invoice_id || invoiceId,
        dry_run: prepared.dryRun,
        live_mode: prepared.liveMode,
        idempotency_key_present: true,
        idempotency_key_generated: prepared.idempotencyGenerated,
      });
      return result;
    },

    payment_intent_status: async (args = {}) => {
      const intentId = normalizeText(
        args.payment_intent_id ||
          args.payment_id ||
          args.order_id ||
          args.payment_link_id ||
          args.invoice_id ||
          args.checkout_session_id ||
          args.refund_id,
        120,
      );
      if (!intentId) {
        return {
          error: "invalid_payment_intent_id",
          message:
            "payment_intent_id, order_id, payment_link_id, invoice_id, checkout_session_id, or refund_id is required.",
        };
      }
      const payment = await getPaymentProviderSwitchboard().execute(
        "payment_intent_status",
        args,
        {
          stubBuilder: () => ({
            payment_intent_id: intentId,
            status_value: "requires_action",
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (payment?.ok === false) {
        return blockedResult("payment_intent_status", payment.data, {
          payment_intent_id: intentId,
        });
      }
      const result = payment.data;
      await logAudit("payment_intent_status", "ok", { payment_intent_id: intentId });
      return result;
    },

    payment_session_history: async (args = {}) => {
      const lookupId = normalizeText(
        args.payment_intent_id ||
          args.payment_id ||
          args.order_id ||
          args.payment_link_id ||
          args.invoice_id ||
          args.checkout_session_id ||
          args.refund_id ||
          args.external_id,
        160,
      );
      const lookupCallSid = normalizeText(args.call_sid || callSid, 160);
      if (!lookupId && !lookupCallSid) {
        return {
          error: "invalid_payment_session_lookup",
          message:
            "payment_intent_id, order_id, invoice_id, checkout_session_id, refund_id, or call_sid is required.",
        };
      }

      const lookupArgs = {
        ...args,
        payment_intent_id: lookupId || args.payment_intent_id,
        call_sid: lookupCallSid || args.call_sid,
        limit: clampNumber(args.limit, 1, 25, 10),
      };
      const payment = await getPaymentProviderSwitchboard().execute(
        "payment_session_history",
        lookupArgs,
        {
          stubBuilder: () => ({
            payment_intent_id: lookupId || null,
            call_sid: lookupCallSid || null,
            status_value: "UNKNOWN",
            sessions: [],
            events: [],
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (payment?.ok === false) {
        return blockedResult("payment_session_history", payment.data, {
          payment_intent_id: lookupId || null,
          call_sid: lookupCallSid || null,
        });
      }
      const result = payment.data;
      await logAudit("payment_session_history", "ok", {
        payment_intent_id: lookupId || null,
        call_sid: lookupCallSid || null,
      });
      return result;
    },

    payment_failure_summary: async (args = {}) => {
      const lookupId = normalizeText(
        args.payment_intent_id ||
          args.payment_id ||
          args.order_id ||
          args.payment_link_id ||
          args.invoice_id ||
          args.checkout_session_id ||
          args.refund_id ||
          args.external_id,
        160,
      );
      const lookupCallSid = normalizeText(args.call_sid || callSid, 160);
      if (!lookupId && !lookupCallSid) {
        return {
          error: "invalid_payment_failure_lookup",
          message:
            "payment_intent_id, payment_id, order_id, invoice_id, checkout_session_id, refund_id, or call_sid is required.",
        };
      }
      const lookupArgs = {
        ...args,
        payment_intent_id: lookupId || args.payment_intent_id,
        call_sid: lookupCallSid || args.call_sid,
        limit: clampNumber(args.limit, 1, 25, 10),
      };
      const payment = await getPaymentProviderSwitchboard().execute(
        "payment_failure_summary",
        lookupArgs,
        {
          stubBuilder: () => ({
            payment_intent_id: lookupId || null,
            call_sid: lookupCallSid || null,
            failed_attempts: 0,
            latest_failure: null,
            recommended_action: "none",
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (payment?.ok === false) {
        return blockedResult("payment_failure_summary", payment.data, {
          payment_intent_id: lookupId || null,
          call_sid: lookupCallSid || null,
        });
      }
      const result = payment.data;
      await logAudit("payment_failure_summary", "ok", {
        payment_intent_id: lookupId || null,
        call_sid: lookupCallSid || null,
        failed_attempts: result.failed_attempts || 0,
      });
      return result;
    },

    customer_payment_profile: async (args = {}) => {
      const customerRef = normalizeText(
        args.customer_ref || args.customer_id || args.customer_email,
        160,
      );
      const lookupCallSid = normalizeText(args.call_sid || callSid, 160);
      if (!customerRef && !lookupCallSid) {
        return {
          error: "invalid_customer_payment_profile_lookup",
          message: "customer_ref, customer_id, customer_email, or call_sid is required.",
        };
      }
      const lookupArgs = {
        ...args,
        customer_ref: customerRef || args.customer_ref,
        call_sid: lookupCallSid || args.call_sid,
        limit: clampNumber(args.limit, 1, 25, 10),
      };
      const payment = await getPaymentProviderSwitchboard().execute(
        "customer_payment_profile",
        lookupArgs,
        {
          stubBuilder: () => ({
            customer_ref: customerRef || null,
            call_sid: lookupCallSid || null,
            total_sessions: 0,
            successful_payments: 0,
            failed_payments: 0,
            payment_methods: [],
            updated_at: new Date().toISOString(),
          }),
        },
      );
      if (payment?.ok === false) {
        return blockedResult("customer_payment_profile", payment.data, {
          customer_ref: customerRef || null,
          call_sid: lookupCallSid || null,
        });
      }
      const result = payment.data;
      await logAudit("customer_payment_profile", "ok", {
        customer_ref: customerRef || null,
        call_sid: lookupCallSid || null,
        total_sessions: result.total_sessions || 0,
      });
      return result;
    },

    paypal_agent_toolkit_manifest: async (args = {}) => {
      const paypal = await maybeInvokePaypalConnector("agent_toolkit_manifest", args);
      if (paypal?.ok === false) {
        await logAudit("paypal_agent_toolkit_manifest", "blocked", {
          error: paypal.data?.error || "paypal_error",
        });
        return paypal.data;
      }
      const result =
        paypal?.ok === true
          ? { status: "ok", connector_mode: "paypal", ...paypal.data }
          : {
              status: "ok",
              connector_mode: "stub",
              provider: "paypal",
              provider_action: "agent_toolkit_manifest",
              package: PAYPAL_AGENT_TOOLKIT_PACKAGE,
              toolkit_surface: "ai-sdk",
              tool_count: 0,
              tools: [],
              message:
                "PayPal connector disabled. Set PAYPAL_CONNECTOR_ENABLED=true or payment_connector=paypal to inspect toolkit tools.",
            };
      await logAudit("paypal_agent_toolkit_manifest", "ok", {
        tool_count: result.tool_count || 0,
      });
      return result;
    },

    paypal_agent_toolkit_execute: async (args = {}) => {
      const toolName = normalizeText(args.tool_name || args.tool || args.name, 120).toLowerCase();
      const input = args.input;
      if (!toolName) {
        return blockedResult("paypal_agent_toolkit_execute", {
          error: "missing_paypal_agent_tool",
          message: "tool_name is required.",
        });
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return blockedResult("paypal_agent_toolkit_execute", {
          error: "invalid_paypal_agent_tool_input",
          message: "input must be a JSON object passed to the PayPal Agent Toolkit tool.",
        });
      }
      const safe = ensurePaymentSafety(input);
      if (!safe.ok) return blockedResult("paypal_agent_toolkit_execute", safe);

      const paypal = await maybeInvokePaypalConnector("agent_toolkit_execute", {
        ...args,
        tool_name: toolName,
        input,
      });
      if (paypal?.ok === false) {
        await logAudit("paypal_agent_toolkit_execute", "blocked", {
          tool_name: toolName,
          error: paypal.data?.error || "paypal_error",
        });
        return paypal.data;
      }
      if (paypal?.ok !== true) {
        return blockedResult("paypal_agent_toolkit_execute", {
          error: "paypal_connector_disabled",
          message:
            "PayPal connector must be enabled or selected with payment_connector=paypal to execute PayPal Agent Toolkit tools.",
          tool_name: toolName,
          allowed_tools: PAYPAL_AGENT_TOOLKIT_READ_TOOLS,
        });
      }

      const result = { status: "ok", connector_mode: "paypal", ...paypal.data };
      await logAudit("paypal_agent_toolkit_execute", "ok", {
        tool_name: toolName,
      });
      return result;
    },

    refund_request_initiate: async (args = {}) => {
      const safe = ensurePaymentSafety(args);
      if (!safe.ok) return blockedResult("refund_request_initiate", safe);
      if (!(args.confirm_primary === true && args.confirm_secondary === true)) {
        return blockedResult("refund_request_initiate", {
          error: "double_confirmation_required",
          message: "Refund initiation requires confirm_primary=true and confirm_secondary=true.",
        });
      }
      const confirmation = requireWriteConfirmation(args, "refund_request_initiate");
      if (!confirmation.ok) return blockedResult("refund_request_initiate", confirmation);
      const paymentEnabled = ensurePaymentFeatureEnabled();
      if (!paymentEnabled.ok) return blockedResult("refund_request_initiate", paymentEnabled);
      const prepared = preparePaymentWriteArgs("refund_request_initiate", args);
      if (!prepared.ok) return blockedResult("refund_request_initiate", prepared);
      if (!prepared.dryRun) {
        const scoped = requireScopedKey("payment", "write");
        if (!scoped.ok) return blockedResult("refund_request_initiate", scoped);
      }
      const callConfig = getCallConfig() || {};
      if (callConfig?.risk_state?.hard_block === true) {
        return blockedResult("refund_request_initiate", {
          error: "risk_hard_block",
          message: "Refund initiation blocked due to high-risk combination.",
        });
      }
      const payment = await getPaymentProviderSwitchboard().execute(
        "refund_request_initiate",
        prepared.args,
        {
          dryRun: prepared.dryRun,
          stubBuilder: () => ({
            refund_request_id: createId("refund"),
            payment_intent_id: normalizeText(args.payment_intent_id, 120),
            state: "pending_review",
            created_at: new Date().toISOString(),
            idempotency_key_present: true,
          }),
        },
      );
      if (payment?.ok === false) {
        return blockedResult("refund_request_initiate", payment.data);
      }
      const result = payment.data;
      await logAudit("refund_request_initiate", "ok", {
        refund_request_id: result.refund_request_id || null,
        dry_run: prepared.dryRun,
        live_mode: prepared.liveMode,
        idempotency_key_present: true,
        idempotency_key_generated: prepared.idempotencyGenerated,
      });
      return result;
    },

    kyc_verify_identity: async (args = {}) => {
      const customerId = normalizeText(args.customer_id, 80);
      if (!customerId) return { error: "invalid_customer_id", message: "customer_id is required." };
      const managed = await maybeInvokeManagedEndpoint("risk", "kyc_verify_identity", args);
      const result =
        managed?.ok === true
          ? { status: "ok", connector_mode: "managed", ...managed.data }
          : {
              status: "ok",
              connector_mode: "stub",
              customer_id: customerId,
              verification_level: normalizeText(args.verification_level, 20) || "basic",
              outcome: "verified",
              checked_at: new Date().toISOString(),
            };
      await logAudit("kyc_verify_identity", "ok", { customer_id: customerId });
      return result;
    },

    fraud_score_assess: async (args = {}) => {
      const customerId = normalizeText(args.customer_id, 80);
      if (!customerId) return { error: "invalid_customer_id", message: "customer_id is required." };
      const amount = Number(args.amount || 0);
      const velocityCount = clampNumber(args.velocity_count, 0, 10000, 0);
      const listHit = args.list_hit === true;
      const scoreRaw = 0.2 + (amount > 1000 ? 0.25 : amount > 300 ? 0.12 : 0) + Math.min(0.4, velocityCount / 40) + (listHit ? 0.3 : 0);
      const score = Number(Math.min(1, scoreRaw).toFixed(2));
      const action = score >= 0.85 ? "hard_block" : score >= 0.55 ? "step_up_verification" : "allow";
      const result = {
        status: "ok",
        connector_mode: "stub",
        customer_id: customerId,
        fraud_score: score,
        recommended_action: action,
        checks: {
          amount,
          velocity_count: velocityCount,
          list_hit: listHit,
        },
      };
      const callConfig = getCallConfig() || {};
      callConfig.risk_state = {
        hard_block: action === "hard_block",
        step_up_required: action === "step_up_verification",
        fraud_score: score,
        updated_at: new Date().toISOString(),
      };
      setCallConfig(callConfig);
      await logAudit("fraud_score_assess", "ok", {
        customer_id: customerId,
        fraud_score: score,
        action,
      });
      return result;
    },

    velocity_check: async (args = {}) => {
      const customerId = normalizeText(args.customer_id, 80);
      if (!customerId) return { error: "invalid_customer_id", message: "customer_id is required." };
      const eventsCount = clampNumber(args.events_count, 0, 10000, 0);
      const threshold = 12;
      const action = eventsCount > threshold ? "step_up_verification" : "allow";
      const result = {
        status: "ok",
        connector_mode: "stub",
        customer_id: customerId,
        events_count: eventsCount,
        threshold,
        recommended_action: action,
      };
      await logAudit("velocity_check", "ok", {
        customer_id: customerId,
        events_count: eventsCount,
        action,
      });
      return result;
    },

    risk_list_check: async (args = {}) => {
      const identifier = normalizeText(args.identifier, 120);
      if (!identifier) return { error: "invalid_identifier", message: "identifier is required." };
      const lower = identifier.toLowerCase();
      const matched = lower.includes("blocked") || lower.includes("fraud");
      const result = {
        status: "ok",
        connector_mode: "stub",
        identifier,
        list_type: normalizeText(args.list_type, 20) || "both",
        match: matched,
        recommended_action: matched ? "hard_block" : "allow",
      };
      await logAudit("risk_list_check", "ok", { identifier, match: matched });
      return result;
    },

    kb_search: async (args = {}) => {
      const payload = buildKnowledgePayload("kb_search", args.query, ["kb", "support"]);
      await logAudit("kb_search", payload.error ? "blocked" : "ok", {
        query: normalizeText(args.query, 120),
      });
      return payload;
    },

    runbook_lookup: async (args = {}) => {
      const payload = buildKnowledgePayload(
        "runbook_lookup",
        args.incident_type,
        ["runbook", "support"],
      );
      await logAudit("runbook_lookup", payload.error ? "blocked" : "ok", {
        incident_type: normalizeText(args.incident_type, 80),
      });
      return payload;
    },

    policy_lookup: async (args = {}) => {
      const payload = buildKnowledgePayload("policy_lookup", args.policy_name, [
        "policy",
        "compliance",
      ]);
      await logAudit("policy_lookup", payload.error ? "blocked" : "ok", {
        policy_name: normalizeText(args.policy_name, 80),
      });
      return payload;
    },

    product_doc_lookup: async (args = {}) => {
      const query = `${normalizeText(args.product, 80)} ${normalizeText(args.query, 120)}`.trim();
      const payload = buildKnowledgePayload("product_doc_lookup", query, [
        "product",
        "docs",
      ]);
      await logAudit("product_doc_lookup", payload.error ? "blocked" : "ok", {
        product: normalizeText(args.product, 80),
      });
      return payload;
    },

    contract_lookup: async (args = {}) => {
      const query = `${normalizeText(args.contract_id, 80)} ${normalizeText(args.query, 120)}`.trim();
      const payload = buildKnowledgePayload("contract_lookup", query, [
        "contract",
        "compliance",
      ]);
      await logAudit("contract_lookup", payload.error ? "blocked" : "ok", {
        contract_id: normalizeText(args.contract_id, 80),
      });
      return payload;
    },
  };
}

module.exports = {
  connectorPackTools,
  buildConnectorPackImplementations,
  hasSensitiveCardData,
  extractDomainFromUrl,
  sanitizeDomain,
};
