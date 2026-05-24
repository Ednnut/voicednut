const assert = require("node:assert/strict");

const {
  buildConnectorPackImplementations,
  connectorPackTools,
} = require("../functions/connectorPacks");

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

describe("connector pack SendGrid email", () => {
  it("exposes a guarded SendGrid follow-up tool descriptor", () => {
    const descriptor = connectorPackTools.find(
      (tool) => tool.function?.name === "email_send_followup",
    );

    assert.ok(descriptor);
    assert.equal(descriptor.function.connector.id, "business_sendgrid_followup");
    assert.equal(descriptor.function.connector.class, "side_effect");
    assert.equal(descriptor.function.connector.approval.required, true);
    assert.ok(descriptor.function.connector.capability_tags.includes("sendgrid"));
    assert.ok(descriptor.function.parameters.required.includes("confirm_write"));
  });

  it("queues confirmed follow-up email through the SendGrid email service", async () => {
    const audit = createDbAuditLog();
    const queuedPayloads = [];
    const tools = buildConnectorPackImplementations({
      callSid: "CA_sendgrid_followup",
      db: audit.db,
      getCallConfig: () => ({}),
      emailService: {
        enqueueEmail: async (payload, options) => {
          queuedPayloads.push({ payload, options });
          return { message_id: "email_sendgrid_123" };
        },
      },
    });

    const result = await tools.email_send_followup({
      to: "Customer@Example.com",
      from: "agent@example.com",
      subject: "Follow-up",
      text: "Thanks for calling.",
      variables: { first_name: "Customer" },
      idempotency_key: "sendgrid-followup-idem",
      confirm_write: true,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.connector_mode, "sendgrid");
    assert.equal(result.provider, "sendgrid");
    assert.equal(result.queued, true);
    assert.equal(result.message_id, "email_sendgrid_123");
    assert.equal(result.idempotency_key_present, true);
    assert.equal(result.idempotency_key_generated, false);
    assert.equal(queuedPayloads.length, 1);
    assert.equal(queuedPayloads[0].payload.to, "customer@example.com");
    assert.equal(queuedPayloads[0].payload.provider, "sendgrid");
    assert.equal(queuedPayloads[0].payload.metadata.connector, "sendgrid");
    assert.equal(queuedPayloads[0].payload.metadata.call_sid, "CA_sendgrid_followup");
    assert.equal(queuedPayloads[0].options.idempotencyKey, "sendgrid-followup-idem");
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_sendgrid_followup");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "email_send_followup");
    assert.equal(auditEntry[2].status, "ok");
    assert.equal(auditEntry[2].provider, "sendgrid");
    assert.equal(auditEntry[2].message_id, "email_sendgrid_123");
    assert.equal(auditEntry[2].recipient_domain, "example.com");
  });

  it("queues SendGrid follow-up with automatic template selection context", async () => {
    const audit = createDbAuditLog();
    const queuedPayloads = [];
    const tools = buildConnectorPackImplementations({
      callSid: "CA_sendgrid_template_select",
      db: audit.db,
      getCallConfig: () => ({}),
      emailService: {
        enqueueEmail: async (payload, options) => {
          queuedPayloads.push({ payload, options });
          return { message_id: "email_template_selected" };
        },
      },
    });

    const result = await tools.email_send_followup({
      to: "customer@example.com",
      select_template: true,
      payment_state: "paid",
      call_intent: "billing receipt",
      variables: { first_name: "Customer" },
      confirm_write: true,
    });

    assert.equal(result.status, "ok");
    assert.equal(queuedPayloads.length, 1);
    assert.equal(queuedPayloads[0].payload.select_template, true);
    assert.equal(queuedPayloads[0].payload.template_context.payment_state, "paid");
    assert.equal(queuedPayloads[0].payload.template_context.call_intent, "billing receipt");
    assert.equal(queuedPayloads[0].payload.metadata.template_context.payment_state, "paid");
    assert.match(queuedPayloads[0].options.idempotencyKey, /^connector_email_send_followup_/);
  });

  it("blocks SendGrid follow-up email without explicit write confirmation", async () => {
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_sendgrid_blocked",
      db: audit.db,
      getCallConfig: () => ({}),
      emailService: {
        enqueueEmail: async () => {
          throw new Error("email service should not be called");
        },
      },
    });

    const result = await tools.email_send_followup({
      to: "customer@example.com",
      subject: "Follow-up",
      text: "Thanks for calling.",
    });

    assert.equal(result.error, "write_confirmation_required");
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_sendgrid_blocked");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "email_send_followup");
    assert.equal(auditEntry[2].status, "blocked");
    assert.equal(auditEntry[2].error, "write_confirmation_required");
  });
});

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

describe("connector pack Square payments", () => {
  it("routes payment link generation through the selected Square connector", async () => {
    const calls = [];
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_square_pack",
      db: audit.db,
      getCallConfig: () => ({
        connector_api_keys: {
          payment: "payment-key",
        },
      }),
      squareConfig: {
        enabled: true,
        environment: "sandbox",
        accessToken: "square-token",
        locationId: "LOC123",
        returnUrl: "https://example.test/square/return",
      },
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse(200, {
          payment_link: {
            id: "sq_plink_pack",
            url: "https://square.test/pay/sq_plink_pack",
            order_id: "ORDER-SQ",
          },
        });
      },
    });

    const result = await tools.payment_link_generate({
      payment_connector: "square",
      amount: 6,
      currency: "USD",
      description: "Deposit",
      confirm_write: true,
      idempotency_key: "square-pack-idem",
    });

    assert.equal(result.status, "ok");
    assert.equal(result.connector_mode, "square");
    assert.equal(result.provider, "square");
    assert.equal(result.payment_link_id, "sq_plink_pack");
    assert.equal(result.order_id, "ORDER-SQ");
    assert.equal(result.payment_url, "https://square.test/pay/sq_plink_pack");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://connect.squareupsandbox.com/v2/online-checkout/payment-links");
    assert.equal(calls[0].options.headers.authorization, "Bearer square-token");
    assert.equal(calls[0].options.headers["Square-Version"], "2026-05-20");
    const requestBody = JSON.parse(calls[0].options.body);
    assert.equal(requestBody.idempotency_key, "square-pack-idem");
    assert.equal(requestBody.quick_pay.location_id, "LOC123");
    assert.equal(requestBody.quick_pay.price_money.amount, 600);
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_square_pack");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "payment_link_generate");
    assert.equal(auditEntry[2].status, "ok");
    assert.equal(auditEntry[2].payment_link_id, "sq_plink_pack");
  });
});

describe("connector pack payment guardrails", () => {
  it("reports sanitized payment connector health", async () => {
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_payment_health",
      db: audit.db,
      getCallConfig: () => ({
        connector_api_keys: {
          payment: "payment-key",
        },
      }),
      stripeConfig: {
        enabled: true,
        secretKey: "sk_test_health_secret",
      },
      paypalConfig: {
        enabled: false,
        clientId: "paypal-client",
        clientSecret: "paypal-secret",
      },
    });

    const result = await tools.payment_connector_health({
      payment_connector: "stripe",
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.status, "ok");
    assert.equal(result.connector_mode, "diagnostic");
    assert.equal(result.readiness, "ready");
    assert.equal(result.requested_provider, "stripe");
    assert.equal(result.scoped_payment_key_present, true);
    assert.equal(result.providers.stripe.ready, true);
    assert.equal(result.providers.stripe.selected, true);
    assert.equal(result.providers.paypal.ready, false);
    assert.ok(result.capabilities.providers.stripe.actions.includes("payment_link_generate"));
    assert.equal(serialized.includes("payment-key"), false);
    assert.equal(serialized.includes("sk_test_health_secret"), false);
    assert.equal(serialized.includes("paypal-secret"), false);

    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_payment_health");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "payment_connector_health");
    assert.equal(auditEntry[2].status, "ok");
    assert.equal(auditEntry[2].readiness, "ready");
    assert.equal(auditEntry[2].requested_provider, "stripe");
  });

  it("requires an explicit payment connector for live writes", async () => {
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_payment_live_guard",
      db: audit.db,
      getCallConfig: () => ({
        connector_api_keys: {
          payment: "payment-key",
        },
        payment_live_mode: true,
      }),
    });

    const result = await tools.payment_link_generate({
      amount: 5,
      currency: "USD",
      confirm_write: true,
    });

    assert.equal(result.error, "payment_live_connector_required");
    assert.match(result.message, /payment_connector/);
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_payment_live_guard");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "payment_link_generate");
    assert.equal(auditEntry[2].status, "blocked");
    assert.equal(auditEntry[2].error, "payment_live_connector_required");
  });

  it("blocks payment writes when connector policy excludes the requested provider", async () => {
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_payment_policy",
      db: audit.db,
      getCallConfig: () => ({
        payment_connector_allowed_providers: "stripe",
        connector_api_keys: {
          payment: "payment-key",
        },
      }),
      squareConfig: {
        enabled: true,
        accessToken: "square-token",
        locationId: "LOC123",
      },
    });

    const result = await tools.payment_link_generate({
      payment_connector: "square",
      amount: 5,
      currency: "USD",
      confirm_write: true,
      idempotency_key: "blocked-square",
    });

    assert.equal(result.error, "payment_connector_policy_violation");
    assert.equal(result.reason, "provider_not_allowed");
    assert.deepEqual(result.allowed_providers, ["stripe"]);
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_payment_policy");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "payment_link_generate");
    assert.equal(auditEntry[2].status, "blocked");
    assert.equal(auditEntry[2].error, "payment_connector_policy_violation");
  });

  it("uses dry-run stubs without scoped keys or provider calls", async () => {
    let fetchCalled = false;
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_payment_dry_run",
      db: audit.db,
      getCallConfig: () => ({}),
      stripeConfig: {
        enabled: true,
        secretKey: "sk_test_dry_run",
        returnUrl: "https://example.test/stripe/return",
      },
      fetchFn: async () => {
        fetchCalled = true;
        throw new Error("provider should not be called during dry run");
      },
    });

    const result = await tools.payment_link_generate({
      payment_connector: "stripe",
      amount: 12.5,
      currency: "USD",
      confirm_write: true,
      dry_run: true,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.connector_mode, "stub");
    assert.equal(result.dry_run, true);
    assert.equal(result.skipped_provider_execution, true);
    assert.equal(result.idempotency_key_present, true);
    assert.equal(fetchCalled, false);
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_payment_dry_run");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "payment_link_generate");
    assert.equal(auditEntry[2].status, "ok");
    assert.equal(auditEntry[2].dry_run, true);
    assert.equal(auditEntry[2].idempotency_key_generated, true);
  });

  it("generates idempotency keys for provider payment writes", async () => {
    const calls = [];
    const audit = createDbAuditLog();
    const tools = buildConnectorPackImplementations({
      callSid: "CA_payment_idempotency",
      db: audit.db,
      getCallConfig: () => ({
        connector_api_keys: {
          payment: "payment-key",
        },
      }),
      stripeConfig: {
        enabled: true,
        secretKey: "sk_test_idempotency",
        returnUrl: "https://example.test/stripe/return",
        cancelUrl: "https://example.test/stripe/cancel",
      },
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return jsonResponse(200, {
          id: "cs_test_generated_idem",
          url: "https://checkout.stripe.test/cs_test_generated_idem",
          payment_status: "unpaid",
          status: "open",
          amount_total: 900,
          currency: "usd",
        });
      },
    });

    const result = await tools.payment_link_generate({
      payment_connector: "stripe",
      amount: 9,
      currency: "USD",
      description: "Generated idempotency",
      customer_ref: "cust-123",
      confirm_write: true,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.connector_mode, "stripe");
    assert.equal(result.payment_link_id, "cs_test_generated_idem");
    assert.equal(calls.length, 1);
    assert.match(
      calls[0].options.headers["idempotency-key"],
      /^vp_payment_link_generate_[a-f0-9]{24}$/,
    );
    const auditEntry = audit.entries.at(-1);
    assert.equal(auditEntry[0], "CA_payment_idempotency");
    assert.equal(auditEntry[1], "connector_action");
    assert.equal(auditEntry[2].action, "payment_link_generate");
    assert.equal(auditEntry[2].status, "ok");
    assert.equal(auditEntry[2].dry_run, false);
    assert.equal(auditEntry[2].idempotency_key_generated, true);
  });
});
