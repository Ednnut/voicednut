"use strict";

const {
  createPaypalPaymentService,
  isPaypalConnectorName,
} = require("./paypalPaymentService");
const {
  createStripePaymentService,
  isStripeConnectorName,
} = require("./stripePaymentService");
const {
  createSquarePaymentService,
  isSquareConnectorName,
} = require("./squarePaymentService");

const PAYMENT_PROVIDER_ORDER = Object.freeze(["stripe", "paypal", "square"]);

const PAYMENT_ACTION_CAPABILITIES = Object.freeze({
  payment_link_generate: Object.freeze({
    class: "write",
    description: "Create a PCI-safe hosted checkout/payment link.",
    lookup_fields: Object.freeze(["payment_intent_id", "checkout_session_id", "order_id"]),
  }),
  payment_retry_link_generate: Object.freeze({
    class: "write",
    description: "Create a PCI-safe recovery link after a failed or abandoned payment.",
    lookup_fields: Object.freeze(["payment_intent_id", "checkout_session_id", "order_id"]),
  }),
  invoice_create: Object.freeze({
    class: "write",
    description: "Create and optionally send a provider invoice.",
    lookup_fields: Object.freeze(["invoice_id"]),
  }),
  invoice_reminder_send: Object.freeze({
    class: "write",
    description: "Send a reminder for an existing provider invoice.",
    lookup_fields: Object.freeze(["invoice_id"]),
  }),
  payment_intent_status: Object.freeze({
    class: "read",
    description: "Read provider payment, order, invoice, checkout session, or refund status.",
    lookup_fields: Object.freeze([
      "payment_intent_id",
      "checkout_session_id",
      "payment_link_id",
      "order_id",
      "invoice_id",
      "refund_id",
    ]),
  }),
  payment_session_history: Object.freeze({
    class: "read",
    description: "Read locally persisted payment session and webhook history.",
    lookup_fields: Object.freeze([
      "payment_intent_id",
      "checkout_session_id",
      "payment_link_id",
      "order_id",
      "invoice_id",
      "refund_id",
      "call_sid",
    ]),
  }),
  payment_failure_summary: Object.freeze({
    class: "read",
    description: "Summarize failed, pending, and successful payment attempts from local history.",
    lookup_fields: Object.freeze([
      "payment_intent_id",
      "checkout_session_id",
      "payment_link_id",
      "order_id",
      "invoice_id",
      "refund_id",
      "call_sid",
    ]),
  }),
  customer_payment_profile: Object.freeze({
    class: "read",
    description: "Summarize recent customer payment activity from locally persisted sessions and events.",
    lookup_fields: Object.freeze(["customer_ref", "customer_id", "customer_email", "call_sid"]),
  }),
  refund_request_initiate: Object.freeze({
    class: "write",
    description: "Create a provider refund from a payment intent, charge, capture, or order.",
    lookup_fields: Object.freeze(["payment_intent_id", "charge_id", "capture_id", "order_id"]),
  }),
  agent_toolkit_manifest: Object.freeze({
    class: "read",
    description: "Inspect configured PayPal Agent Toolkit read tools.",
    lookup_fields: Object.freeze([]),
  }),
  agent_toolkit_execute: Object.freeze({
    class: "read",
    description: "Execute an allowlisted read-only PayPal Agent Toolkit tool.",
    lookup_fields: Object.freeze(["tool_name"]),
  }),
});

const PAYMENT_PROVIDER_CAPABILITIES = Object.freeze({
  paypal: Object.freeze({
    provider: "paypal",
    display_name: "PayPal",
    supports_live_mode: true,
    supports_managed_endpoint: false,
    supports_local_history: true,
    actions: Object.freeze([
      "payment_link_generate",
      "payment_retry_link_generate",
      "invoice_create",
      "invoice_reminder_send",
      "payment_intent_status",
      "payment_session_history",
      "payment_failure_summary",
      "customer_payment_profile",
      "refund_request_initiate",
      "agent_toolkit_manifest",
      "agent_toolkit_execute",
    ]),
    refund_sources: Object.freeze(["capture_id", "order_id"]),
    primary_lookup_fields: Object.freeze(["order_id", "invoice_id", "refund_id"]),
  }),
  stripe: Object.freeze({
    provider: "stripe",
    display_name: "Stripe",
    supports_live_mode: true,
    supports_managed_endpoint: false,
    supports_local_history: true,
    actions: Object.freeze([
      "payment_link_generate",
      "payment_retry_link_generate",
      "invoice_create",
      "invoice_reminder_send",
      "payment_intent_status",
      "payment_session_history",
      "payment_failure_summary",
      "customer_payment_profile",
      "refund_request_initiate",
    ]),
    refund_sources: Object.freeze(["payment_intent_id", "charge_id"]),
    primary_lookup_fields: Object.freeze([
      "payment_intent_id",
      "checkout_session_id",
      "invoice_id",
      "refund_id",
    ]),
  }),
  square: Object.freeze({
    provider: "square",
    display_name: "Square",
    supports_live_mode: true,
    supports_managed_endpoint: false,
    supports_local_history: true,
    actions: Object.freeze([
      "payment_link_generate",
      "payment_retry_link_generate",
      "payment_intent_status",
      "payment_session_history",
      "payment_failure_summary",
      "customer_payment_profile",
      "refund_request_initiate",
    ]),
    refund_sources: Object.freeze(["payment_id"]),
    primary_lookup_fields: Object.freeze([
      "payment_id",
      "payment_link_id",
      "order_id",
      "refund_id",
    ]),
  }),
});

const PAYMENT_PROVIDERS = Object.freeze({
  paypal: {
    enabledEnv: "PAYPAL_CONNECTOR_ENABLED",
    isConnectorName: isPaypalConnectorName,
  },
  stripe: {
    enabledEnv: "STRIPE_CONNECTOR_ENABLED",
    isConnectorName: isStripeConnectorName,
  },
  square: {
    enabledEnv: "SQUARE_CONNECTOR_ENABLED",
    isConnectorName: isSquareConnectorName,
  },
});

function normalizeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function isEnvEnabled(name) {
  return String(process.env[name] || "").toLowerCase() === "true";
}

function normalizeAction(action) {
  return normalizeText(action, 120);
}

function providerSupportsAction(provider, action) {
  const actionName = normalizeAction(action);
  if (!actionName) return false;
  return PAYMENT_PROVIDER_CAPABILITIES[provider]?.actions.includes(actionName) === true;
}

function getProviderCredentialNames(provider) {
  if (provider === "stripe") return ["STRIPE_SECRET_KEY"];
  if (provider === "paypal") return ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"];
  if (provider === "square") return ["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"];
  return [`${provider}_credentials`];
}

function getCapabilitySnapshot() {
  const actions = Object.entries(PAYMENT_ACTION_CAPABILITIES).reduce(
    (acc, [action, capability]) => ({
      ...acc,
      [action]: {
        ...capability,
        lookup_fields: Array.from(capability.lookup_fields || []),
      },
    }),
    {},
  );
  const providers = Object.entries(PAYMENT_PROVIDER_CAPABILITIES).reduce(
    (acc, [provider, capability]) => ({
      ...acc,
      [provider]: {
        ...capability,
        actions: Array.from(capability.actions || []),
        refund_sources: Array.from(capability.refund_sources || []),
        primary_lookup_fields: Array.from(capability.primary_lookup_fields || []),
      },
    }),
    {},
  );
  return { actions, providers };
}

function buildOkResult(mode, data = {}) {
  return {
    ok: true,
    mode,
    data: {
      status: "ok",
      connector_mode: mode,
      ...(data && typeof data === "object" ? data : {}),
    },
  };
}

class PaymentProviderSwitchboard {
  constructor(options = {}) {
    this.callSid = String(options.callSid || "").trim();
    this.getCallConfig =
      typeof options.getCallConfig === "function" ? options.getCallConfig : () => ({});
    this.db = options.db || null;
    this.fetchFn = options.fetchFn;
    this.managedInvoker =
      typeof options.managedInvoker === "function" ? options.managedInvoker : null;
    this.paypalConfig = options.paypalConfig;
    this.stripeConfig = options.stripeConfig;
    this.squareConfig = options.squareConfig;
    this.paypalAgentToolkitFactory = options.paypalAgentToolkitFactory;
    this.hasPaymentScopedKey =
      typeof options.hasPaymentScopedKey === "function" ? options.hasPaymentScopedKey : null;
    this.hasManagedEndpoint =
      typeof options.hasManagedEndpoint === "function" ? options.hasManagedEndpoint : null;
    this.createPaypalService = options.createPaypalService || createPaypalPaymentService;
    this.createStripeService = options.createStripeService || createStripePaymentService;
    this.createSquareService = options.createSquareService || createSquarePaymentService;
    this.providerOrder = Array.isArray(options.providerOrder)
      ? options.providerOrder.filter((provider) => PAYMENT_PROVIDERS[provider])
      : PAYMENT_PROVIDER_ORDER;
    this.services = {};
  }

  getRequestedConnector(args = {}) {
    const callConfig = this.getCallConfig() || {};
    return normalizeText(
      args.payment_connector ||
        args.connector ||
        callConfig.payment_connector ||
        callConfig?.payment?.connector,
      80,
    ).toLowerCase();
  }

  getRequestedProvider(args = {}) {
    const requestedConnector = this.getRequestedConnector(args);
    if (!requestedConnector) return "";
    return this.providerOrder.find((provider) =>
      PAYMENT_PROVIDERS[provider]?.isConnectorName(requestedConnector),
    ) || "";
  }

  shouldUseProvider(provider, args = {}, action = "") {
    const providerConfig = PAYMENT_PROVIDERS[provider];
    if (!providerConfig) return false;
    if (action && !providerSupportsAction(provider, action)) return false;
    const requestedConnector = this.getRequestedConnector(args);
    if (requestedConnector) {
      return providerConfig.isConnectorName(requestedConnector);
    }
    return isEnvEnabled(providerConfig.enabledEnv);
  }

  getProviderService(provider) {
    if (!PAYMENT_PROVIDERS[provider]) return null;
    if (!this.services[provider]) {
      if (provider === "paypal") {
        this.services[provider] = this.createPaypalService({
          db: this.db,
          fetchFn: this.fetchFn,
          config: this.paypalConfig,
          agentToolkitFactory: this.paypalAgentToolkitFactory,
        });
      } else if (provider === "stripe") {
        this.services[provider] = this.createStripeService({
          db: this.db,
          fetchFn: this.fetchFn,
          config: this.stripeConfig,
        });
      } else if (provider === "square") {
        this.services[provider] = this.createSquareService({
          db: this.db,
          fetchFn: this.fetchFn,
          config: this.squareConfig,
        });
      }
    }
    return this.services[provider] || null;
  }

  async invokeProvider(provider, action, args = {}) {
    if (!this.shouldUseProvider(provider, args, action)) {
      return null;
    }
    const service = this.getProviderService(provider);
    if (!service || typeof service.execute !== "function") {
      return null;
    }
    const result = await service.execute(action, args, {
      callSid: this.callSid,
      callConfig: this.getCallConfig() || {},
    });
    if (result?.error) {
      return { ok: false, mode: provider, data: result };
    }
    return { ok: true, mode: provider, data: result || {} };
  }

  async execute(action, args = {}, options = {}) {
    const actionName = normalizeAction(action);
    const requestedProvider = this.getRequestedProvider(args);
    if (requestedProvider && !providerSupportsAction(requestedProvider, actionName)) {
      return {
        ok: false,
        mode: requestedProvider,
        data: {
          error: "payment_provider_action_unsupported",
          message: `${requestedProvider} does not support ${actionName}.`,
          provider: requestedProvider,
          action: actionName,
          supported_actions: Array.from(
            PAYMENT_PROVIDER_CAPABILITIES[requestedProvider]?.actions || [],
          ),
        },
      };
    }

    const payload = options.payload || args;
    if (options.dryRun === true) {
      const stubData =
        typeof options.stubBuilder === "function" ? options.stubBuilder(args) : {};
      return buildOkResult("stub", {
        ...stubData,
        dry_run: true,
        skipped_provider_execution: true,
      });
    }

    if (this.managedInvoker) {
      const managed = await this.managedInvoker("payment", actionName, payload);
      if (managed?.ok === true) {
        return buildOkResult("managed", managed.data);
      }
    }

    for (const provider of this.providerOrder) {
      const providerResult = await this.invokeProvider(provider, actionName, args);
      if (!providerResult) continue;
      if (providerResult.ok === false) return providerResult;
      return buildOkResult(provider, providerResult.data);
    }

    const stubData =
      typeof options.stubBuilder === "function" ? options.stubBuilder(args) : {};
    return buildOkResult("stub", stubData);
  }

  getHealth(args = {}) {
    const scopedPaymentKeyPresent = this.hasPaymentScopedKey
      ? this.hasPaymentScopedKey()
      : null;
    const managedEndpointConfigured = this.hasManagedEndpoint
      ? this.hasManagedEndpoint()
      : Boolean(this.managedInvoker);
    const requestedProvider = this.getRequestedProvider(args);
    const providers = this.providerOrder.reduce((acc, provider) => {
      const providerConfig = PAYMENT_PROVIDERS[provider];
      const service = this.getProviderService(provider);
      const enabled = service && typeof service.isEnabled === "function"
        ? service.isEnabled()
        : isEnvEnabled(providerConfig.enabledEnv);
      const configured = service && typeof service.isConfigured === "function"
        ? service.isConfigured()
        : false;
      const selected = requestedProvider ? requestedProvider === provider : enabled;
      const missing = [];
      if (!enabled) missing.push(providerConfig.enabledEnv);
      if (!configured) missing.push(...getProviderCredentialNames(provider));
      if (scopedPaymentKeyPresent === false) missing.push("CONNECTOR_PAYMENT_API_KEY");
      acc[provider] = {
        provider,
        enabled: Boolean(enabled),
        configured: Boolean(configured),
        selected,
        ready: Boolean(enabled && configured && scopedPaymentKeyPresent !== false),
        missing,
        capabilities: {
          ...PAYMENT_PROVIDER_CAPABILITIES[provider],
          actions: Array.from(PAYMENT_PROVIDER_CAPABILITIES[provider]?.actions || []),
          refund_sources: Array.from(
            PAYMENT_PROVIDER_CAPABILITIES[provider]?.refund_sources || [],
          ),
          primary_lookup_fields: Array.from(
            PAYMENT_PROVIDER_CAPABILITIES[provider]?.primary_lookup_fields || [],
          ),
        },
      };
      return acc;
    }, {});
    const readyProviders = Object.values(providers).filter((provider) => provider.ready);
    return {
      status: "ok",
      connector_mode: "diagnostic",
      readiness: readyProviders.length ? "ready" : "not_ready",
      requested_provider: requestedProvider || null,
      managed_endpoint_configured: Boolean(managedEndpointConfigured),
      scoped_payment_key_present: scopedPaymentKeyPresent,
      provider_order: Array.from(this.providerOrder),
      providers,
      capabilities: getCapabilitySnapshot(),
    };
  }
}

function createPaymentProviderSwitchboard(options = {}) {
  return new PaymentProviderSwitchboard(options);
}

module.exports = {
  PAYMENT_ACTION_CAPABILITIES,
  PAYMENT_PROVIDER_CAPABILITIES,
  PAYMENT_PROVIDER_ORDER,
  PaymentProviderSwitchboard,
  createPaymentProviderSwitchboard,
  getCapabilitySnapshot,
  providerSupportsAction,
};
