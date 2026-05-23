const assert = require("node:assert/strict");

const { buildConnectorPackImplementations } = require("../functions/connectorPacks");

function createDbAuditLog() {
  const entries = [];
  return {
    entries,
    db: {
      updateCallState: async (...args) => {
        entries.push(args);
      },
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("connector pack PayPal Agent Toolkit", () => {
  it("routes allowlisted read tools through the PayPal connector", async () => {
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_paypal_toolkit",
      db: audit.db,
      getCallConfig: () => ({}),
      paypalConfig: {
        enabled: true,
        clientId: "client-id",
        clientSecret: "client-secret",
        environment: "sandbox",
      },
      paypalAgentToolkitFactory: () => ({
        getTools: () => ({
          get_order: {
            description: "Get an order.",
            execute: async (input) => ({ id: input.id, status: "CREATED" }),
          },
        }),
      }),
    });

    const result = await tools.paypal_agent_toolkit_execute({
      payment_connector: "paypal",
      tool_name: "get_order",
      input: { id: "ORDER-123" },
    });

    assert.equal(result.status, "ok");
    assert.equal(result.connector_mode, "paypal");
    assert.equal(result.provider_action, "agent_toolkit_execute");
    assert.equal(result.tool_name, "get_order");
    assert.equal(result.read_only, true);
    assert.deepEqual(result.result, { id: "ORDER-123", status: "CREATED" });
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_paypal_toolkit");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "paypal_agent_toolkit_execute");
    assert.equal(auditEntry[2].status, "ok");
    assert.equal(auditEntry[2].tool_name, "get_order");
  });

  it("does not execute PayPal toolkit tools unless the PayPal connector is selected", async () => {
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_paypal_toolkit_disabled",
      db: audit.db,
      getCallConfig: () => ({}),
      paypalConfig: {
        enabled: true,
        clientId: "client-id",
        clientSecret: "client-secret",
        environment: "sandbox",
      },
      paypalAgentToolkitFactory: () => {
        throw new Error("toolkit factory should not be called");
      },
    });

    const result = await tools.paypal_agent_toolkit_execute({
      tool_name: "get_order",
      input: { id: "ORDER-123" },
    });

    assert.equal(result.error, "paypal_connector_disabled");
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_paypal_toolkit_disabled");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "paypal_agent_toolkit_execute");
    assert.equal(auditEntry[2].status, "blocked");
    assert.equal(auditEntry[2].error, "paypal_connector_disabled");
  });

  it("keeps PayPal toolkit write tools blocked behind the connector pack", async () => {
    const tools = buildConnectorPackImplementations({
      callSid: "CA_paypal_toolkit_write",
      getCallConfig: () => ({}),
      paypalConfig: {
        enabled: true,
        clientId: "client-id",
        clientSecret: "client-secret",
        environment: "sandbox",
      },
      paypalAgentToolkitFactory: () => ({
        getTools: () => ({
          create_order: {
            description: "Create an order.",
            execute: async () => ({ id: "ORDER-NEW" }),
          },
        }),
      }),
    });

    const result = await tools.paypal_agent_toolkit_execute({
      payment_connector: "paypal",
      tool_name: "create_order",
      input: { amount: "1.00", currency: "USD" },
    });

    assert.equal(result.error, "paypal_agent_tool_not_allowed");
    assert.equal(result.tool_name, "create_order");
    assert.ok(result.allowed_tools.includes("get_order"));
    assert.ok(result.blocked_tools.includes("create_order"));
  });

  it("blocks card-like payloads before invoking the PayPal toolkit connector", async () => {
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_paypal_toolkit_pci",
      db: audit.db,
      getCallConfig: () => ({}),
      paypalConfig: {
        enabled: true,
        clientId: "client-id",
        clientSecret: "client-secret",
        environment: "sandbox",
      },
      paypalAgentToolkitFactory: () => {
        throw new Error("toolkit factory should not be called");
      },
    });

    const result = await tools.paypal_agent_toolkit_execute({
      payment_connector: "paypal",
      tool_name: "get_order",
      input: { card_number: "4111111111111111" },
    });

    assert.equal(result.error, "pci_violation_blocked");
    assert.match(result.message, /tokenized payment flows/);
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_paypal_toolkit_pci");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "paypal_agent_toolkit_execute");
    assert.equal(auditEntry[2].status, "blocked");
    assert.equal(auditEntry[2].error, "pci_violation_blocked");
  });
});

describe("connector pack Stripe payments", () => {
  it("routes payment link generation through the selected Stripe connector", async () => {
    const calls = [];
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_stripe_pack",
      db: audit.db,
      getCallConfig: () => ({
        connector_api_keys: {
          payment: "payment-key",
        },
      }),
      stripeConfig: {
        enabled: true,
        secretKey: "sk_test_123",
        returnUrl: "https://example.test/stripe/return",
        cancelUrl: "https://example.test/stripe/cancel",
      },
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse(200, {
          id: "cs_test_pack",
          url: "https://checkout.stripe.test/cs_test_pack",
          payment_status: "unpaid",
          status: "open",
          amount_total: 500,
          currency: "usd",
        });
      },
    });

    const result = await tools.payment_link_generate({
      payment_connector: "stripe",
      amount: 5,
      currency: "USD",
      description: "Deposit",
      confirm_write: true,
      idempotency_key: "stripe-pack-idem",
    });

    assert.equal(result.status, "ok");
    assert.equal(result.connector_mode, "stripe");
    assert.equal(result.provider, "stripe");
    assert.equal(result.payment_link_id, "cs_test_pack");
    assert.equal(result.payment_url, "https://checkout.stripe.test/cs_test_pack");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers["idempotency-key"], "stripe-pack-idem");
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_stripe_pack");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "payment_link_generate");
    assert.equal(auditEntry[2].status, "ok");
    assert.equal(auditEntry[2].payment_link_id, "cs_test_pack");
  });

  it("uses the local Stripe payment history path when selected", async () => {
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_stripe_history",
      db: {
        ...audit.db,
        async listStripePaymentSessions(query) {
          assert.equal(query.external_id, "cs_test_history");
          return [
            {
              external_id: "cs_test_history",
              status: "PAID",
              metadata: "{\"connector\":\"stripe\"}",
            },
          ];
        },
        async listStripePaymentEvents(query) {
          assert.equal(query.external_id, "cs_test_history");
          return [
            {
              external_event_id: "evt_history",
              event_type: "checkout.session.completed",
              status: "PAID",
              payload: "{\"id\":\"evt_history\"}",
            },
          ];
        },
      },
      getCallConfig: () => ({}),
      stripeConfig: {
        enabled: true,
      },
    });

    const result = await tools.payment_session_history({
      payment_connector: "stripe",
      payment_intent_id: "cs_test_history",
    });

    assert.equal(result.status, "ok");
    assert.equal(result.connector_mode, "stripe");
    assert.equal(result.provider, "stripe");
    assert.equal(result.status_value, "PAID");
    assert.equal(result.sessions.length, 1);
    assert.deepEqual(result.sessions[0].metadata, { connector: "stripe" });
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0].payload, { id: "evt_history" });
  });
});
