const assert = require("node:assert/strict");

const {
  createPaymentProviderSwitchboard,
  getCapabilitySnapshot,
  providerSupportsAction,
} = require("../services/paymentProviderSwitchboard");

function withEnv(values, fn) {
  const previous = {};
  Object.keys(values).forEach((key) => {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    });
}

function createSwitchboard(options = {}) {
  const calls = [];
  const switchboard = createPaymentProviderSwitchboard({
    callSid: "CA_switchboard",
    getCallConfig: () => options.callConfig || {},
    managedInvoker: options.managedInvoker,
    createStripeService: () => ({
      execute: async (action, args, context) => {
        calls.push({ provider: "stripe", action, args, context });
        return options.stripeResult || {
          provider: "stripe",
          payment_link_id: "cs_switchboard",
        };
      },
    }),
    createPaypalService: () => ({
      execute: async (action, args, context) => {
        calls.push({ provider: "paypal", action, args, context });
        return options.paypalResult || {
          provider: "paypal",
          order_id: "ORDER-SWITCHBOARD",
        };
      },
    }),
    createSquareService: () => ({
      execute: async (action, args, context) => {
        calls.push({ provider: "square", action, args, context });
        return options.squareResult || {
          provider: "square",
          payment_link_id: "SQ-SWITCHBOARD",
        };
      },
    }),
  });
  return { calls, switchboard };
}

describe("payment provider switchboard", () => {
  it("routes explicit Stripe requests only to Stripe", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: "true",
        STRIPE_CONNECTOR_ENABLED: "true",
      },
      async () => {
        const { calls, switchboard } = createSwitchboard();

        const result = await switchboard.execute(
          "payment_link_generate",
          { payment_connector: "stripe", amount: 5 },
          { stubBuilder: () => ({ payment_link_id: "stub" }) },
        );

        assert.equal(result.ok, true);
        assert.equal(result.mode, "stripe");
        assert.equal(result.data.connector_mode, "stripe");
        assert.equal(result.data.payment_link_id, "cs_switchboard");
        assert.deepEqual(calls.map((call) => call.provider), ["stripe"]);
      },
    );
  });

  it("falls back to the default enabled provider order", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: "true",
        STRIPE_CONNECTOR_ENABLED: "true",
      },
      async () => {
        const { calls, switchboard } = createSwitchboard();

        const result = await switchboard.execute(
          "invoice_create",
          { amount: 9 },
          { stubBuilder: () => ({ invoice_id: "stub" }) },
        );

        assert.equal(result.mode, "stripe");
        assert.deepEqual(calls.map((call) => call.provider), ["stripe"]);
      },
    );
  });

  it("routes explicit PayPal requests only to PayPal", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: undefined,
        STRIPE_CONNECTOR_ENABLED: "true",
      },
      async () => {
        const { calls, switchboard } = createSwitchboard();

        const result = await switchboard.execute(
          "payment_intent_status",
          { payment_connector: "paypal", order_id: "ORDER-123" },
          { stubBuilder: () => ({ status_value: "UNKNOWN" }) },
        );

        assert.equal(result.mode, "paypal");
        assert.equal(result.data.order_id, "ORDER-SWITCHBOARD");
        assert.deepEqual(calls.map((call) => call.provider), ["paypal"]);
      },
    );
  });

  it("routes explicit Square requests only to Square", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: "true",
        STRIPE_CONNECTOR_ENABLED: "true",
        SQUARE_CONNECTOR_ENABLED: "true",
      },
      async () => {
        const { calls, switchboard } = createSwitchboard();

        const result = await switchboard.execute(
          "payment_link_generate",
          { payment_connector: "square", amount: 7 },
          { stubBuilder: () => ({ payment_link_id: "stub" }) },
        );

        assert.equal(result.ok, true);
        assert.equal(result.mode, "square");
        assert.equal(result.data.connector_mode, "square");
        assert.equal(result.data.payment_link_id, "SQ-SWITCHBOARD");
        assert.deepEqual(calls.map((call) => call.provider), ["square"]);
      },
    );
  });

  it("prefers managed endpoint results over provider connectors", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: "true",
        STRIPE_CONNECTOR_ENABLED: "true",
      },
      async () => {
        const { calls, switchboard } = createSwitchboard({
          managedInvoker: async (scope, action, payload) => ({
            ok: true,
            data: { scope, action, payload, invoice_id: "managed_invoice" },
          }),
        });

        const result = await switchboard.execute(
          "invoice_create",
          { amount: 9 },
          { stubBuilder: () => ({ invoice_id: "stub" }) },
        );

        assert.equal(result.mode, "managed");
        assert.equal(result.data.connector_mode, "managed");
        assert.equal(result.data.invoice_id, "managed_invoice");
        assert.deepEqual(calls, []);
      },
    );
  });

  it("uses the stub builder when no provider is selected or enabled", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: undefined,
        STRIPE_CONNECTOR_ENABLED: undefined,
      },
      async () => {
        const { calls, switchboard } = createSwitchboard();

        const result = await switchboard.execute(
          "payment_session_history",
          { payment_intent_id: "pi_stub" },
          { stubBuilder: () => ({ payment_intent_id: "pi_stub", sessions: [] }) },
        );

        assert.equal(result.mode, "stub");
        assert.equal(result.data.connector_mode, "stub");
        assert.deepEqual(result.data.sessions, []);
        assert.deepEqual(calls, []);
      },
    );
  });

  it("returns provider errors without falling through to stubs", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: undefined,
        STRIPE_CONNECTOR_ENABLED: "true",
      },
      async () => {
        const { switchboard } = createSwitchboard({
          stripeResult: {
            error: "stripe_connector_disabled",
            message: "Stripe is not configured.",
          },
        });

        const result = await switchboard.execute(
          "refund_request_initiate",
          { amount: 3 },
          { stubBuilder: () => ({ refund_request_id: "stub" }) },
        );

        assert.equal(result.ok, false);
        assert.equal(result.mode, "stripe");
        assert.equal(result.data.error, "stripe_connector_disabled");
      },
    );
  });

  it("exposes provider capabilities for routing and diagnostics", () => {
    const capabilities = getCapabilitySnapshot();

    assert.equal(providerSupportsAction("stripe", "payment_link_generate"), true);
    assert.equal(providerSupportsAction("paypal", "agent_toolkit_execute"), true);
    assert.equal(providerSupportsAction("square", "payment_retry_link_generate"), true);
    assert.equal(providerSupportsAction("square", "invoice_reminder_send"), false);
    assert.equal(providerSupportsAction("stripe", "agent_toolkit_execute"), false);
    assert.ok(capabilities.providers.stripe.actions.includes("refund_request_initiate"));
    assert.ok(capabilities.providers.square.actions.includes("customer_payment_profile"));
    assert.ok(capabilities.actions.payment_failure_summary.lookup_fields.includes("call_sid"));
    assert.ok(capabilities.actions.payment_intent_status.lookup_fields.includes("refund_id"));
  });

  it("blocks explicitly selected providers that do not support an action", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: "true",
        STRIPE_CONNECTOR_ENABLED: "true",
      },
      async () => {
        const { calls, switchboard } = createSwitchboard();

        const result = await switchboard.execute(
          "agent_toolkit_execute",
          { payment_connector: "stripe", tool_name: "get_order" },
          { stubBuilder: () => ({ status: "stub" }) },
        );

        assert.equal(result.ok, false);
        assert.equal(result.mode, "stripe");
        assert.equal(result.data.error, "payment_provider_action_unsupported");
        assert.deepEqual(calls, []);
      },
    );
  });

  it("uses dry-run stubs before managed endpoints or providers", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: "true",
        STRIPE_CONNECTOR_ENABLED: "true",
      },
      async () => {
        const { calls, switchboard } = createSwitchboard({
          managedInvoker: async () => {
            throw new Error("managed endpoint should not be called");
          },
        });

        const result = await switchboard.execute(
          "payment_link_generate",
          { payment_connector: "stripe", amount: 5 },
          { dryRun: true, stubBuilder: () => ({ payment_link_id: "dry_stub" }) },
        );

        assert.equal(result.ok, true);
        assert.equal(result.mode, "stub");
        assert.equal(result.data.dry_run, true);
        assert.equal(result.data.skipped_provider_execution, true);
        assert.equal(result.data.payment_link_id, "dry_stub");
        assert.deepEqual(calls, []);
      },
    );
  });

  it("reports sanitized payment connector health", async () => {
    await withEnv(
      {
        PAYPAL_CONNECTOR_ENABLED: undefined,
        STRIPE_CONNECTOR_ENABLED: "true",
      },
      async () => {
        const switchboard = createPaymentProviderSwitchboard({
          callSid: "CA_health",
          hasPaymentScopedKey: () => true,
          hasManagedEndpoint: () => true,
          createStripeService: () => ({
            isEnabled: () => true,
            isConfigured: () => true,
            execute: async () => ({}),
          }),
          createPaypalService: () => ({
            isEnabled: () => false,
            isConfigured: () => false,
            execute: async () => ({}),
          }),
          createSquareService: () => ({
            isEnabled: () => false,
            isConfigured: () => false,
            execute: async () => ({}),
          }),
        });

        const result = switchboard.getHealth({ payment_connector: "stripe" });

        assert.equal(result.status, "ok");
        assert.equal(result.connector_mode, "diagnostic");
        assert.equal(result.readiness, "ready");
        assert.equal(result.scoped_payment_key_present, true);
        assert.equal(result.managed_endpoint_configured, true);
        assert.equal(result.providers.stripe.ready, true);
        assert.equal(result.providers.paypal.ready, false);
        assert.equal(result.providers.square.ready, false);
        assert.equal(result.providers.stripe.selected, true);
        assert.ok(result.providers.square.missing.includes("SQUARE_ACCESS_TOKEN"));
        assert.equal(JSON.stringify(result).includes("sk_test"), false);
      },
    );
  });
});
