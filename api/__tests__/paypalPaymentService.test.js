const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Database = require("../db/db");
const { PaypalPaymentService } = require("../services/paypalPaymentService");

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("PaypalPaymentService", () => {
  it("creates PayPal checkout orders and stores normalized session state", async () => {
    const calls = [];
    const db = {
      sessions: [],
      async upsertPaypalPaymentSession(payload) {
        this.sessions.push(payload);
      },
    };
    const service = new PaypalPaymentService({
      db,
      config: {
        enabled: true,
        environment: "sandbox",
        clientId: "client",
        clientSecret: "secret",
        brandName: "VoicedNut",
        returnUrl: "https://example.test/return",
        cancelUrl: "https://example.test/cancel",
      },
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        if (String(url).endsWith("/v1/oauth2/token")) {
          return jsonResponse(200, { access_token: "access-token", expires_in: 3600 });
        }
        if (String(url).endsWith("/v2/checkout/orders")) {
          return jsonResponse(201, {
            id: "ORDER-123",
            status: "CREATED",
            links: [{ rel: "approve", href: "https://paypal.test/checkout/ORDER-123" }],
          });
        }
        return jsonResponse(404, { message: "not found" });
      },
    });

    const result = await service.execute(
      "payment_link_generate",
      {
        amount: 12.5,
        currency: "usd",
        description: "Balance due",
        idempotency_key: "idem-1",
      },
      { callSid: "CA_paypal_001" },
    );

    assert.equal(result.provider, "paypal");
    assert.equal(result.order_id, "ORDER-123");
    assert.equal(result.payment_url, "https://paypal.test/checkout/ORDER-123");
    assert.equal(result.amount, 12.5);
    assert.equal(result.currency, "USD");
    assert.equal(db.sessions.length, 1);
    assert.equal(db.sessions[0].call_sid, "CA_paypal_001");
    assert.equal(db.sessions[0].external_id, "ORDER-123");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers["paypal-request-id"], "idem-1");
  });

  it("emits sanitized PayPal connector health and call metrics", async () => {
    const health = [];
    const metrics = [];
    const service = new PaypalPaymentService({
      db: {
        async logServiceHealth(service_name, status, details) {
          health.push({ service_name, status, details });
        },
        async addCallMetric(call_sid, metric_type, metric_value, metric_data) {
          metrics.push({ call_sid, metric_type, metric_value, metric_data });
        },
      },
      config: {
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
      },
      agentToolkitFactory: () => ({
        getTools: () => ({
          get_order: {
            description: "Get order",
            execute: async (input) => ({ id: input.id, status: "COMPLETED" }),
          },
        }),
      }),
    });

    const result = await service.execute(
      "agent_toolkit_execute",
      {
        tool_name: "get_order",
        input: { id: "ORDER-123" },
      },
      { callSid: "CA_paypal_observe_001" },
    );

    assert.equal(result.provider_action, "agent_toolkit_execute");
    assert.equal(health.length, 1);
    assert.equal(health[0].service_name, "paypal_connector");
    assert.equal(health[0].status, "healthy");
    assert.equal(health[0].details.event, "paypal_connector_execute");
    assert.equal(health[0].details.action, "agent_toolkit_execute");
    assert.equal(health[0].details.tool_name, "get_order");
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].call_sid, "CA_paypal_observe_001");
    assert.equal(metrics[0].metric_type, "paypal_connector_event");
    assert.equal(metrics[0].metric_value, 1);
    assert.equal(JSON.stringify(health[0].details).includes("ORDER-123"), false);
  });

  it("rejects PayPal invoice creation without a recipient email", async () => {
    let httpCalls = 0;
    const service = new PaypalPaymentService({
      config: {
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
      },
      fetchFn: async () => {
        httpCalls += 1;
        return jsonResponse(500, {});
      },
    });

    const result = await service.execute("invoice_create", { amount: 10 });

    assert.equal(result.error, "missing_invoice_recipient");
    assert.equal(httpCalls, 0);
  });

  it("returns an explicit configuration error before making PayPal calls", async () => {
    let httpCalls = 0;
    const service = new PaypalPaymentService({
      config: { enabled: true },
      fetchFn: async () => {
        httpCalls += 1;
        return jsonResponse(200, {});
      },
    });

    const result = await service.execute("payment_intent_status", {
      payment_intent_id: "ORDER-123",
    });

    assert.equal(result.error, "paypal_not_configured");
    assert.equal(httpCalls, 0);
  });

  it("exposes the official PayPal Agent Toolkit manifest without leaking handlers", async () => {
    const factoryCalls = [];
    const service = new PaypalPaymentService({
      config: {
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
        environment: "sandbox",
      },
      agentToolkitFactory: (options) => {
        factoryCalls.push(options);
        return {
          getTools: () => ({
            create_order: {
              description: "Create order",
              parameters: { type: "object" },
              execute: async () => {},
            },
            create_invoice: {
              description: "Create invoice",
              inputSchema: { type: "object" },
            },
          }),
        };
      },
    });

    const result = await service.execute("agent_toolkit_manifest");

    assert.equal(result.provider, "paypal");
    assert.equal(result.provider_action, "agent_toolkit_manifest");
    assert.equal(result.package, "@paypal/agent-toolkit");
    assert.equal(result.toolkit_surface, "ai-sdk");
    assert.equal(result.tool_count, 2);
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      ["create_invoice", "create_order"],
    );
    const createOrderTool = result.tools.find((tool) => tool.name === "create_order");
    assert.equal(createOrderTool.has_execute, true);
    assert.equal(createOrderTool.execute, undefined);
    assert.equal(factoryCalls[0].clientId, "client");
    assert.equal(factoryCalls[0].clientSecret, "secret");
    assert.equal(factoryCalls[0].configuration.context.sandbox, true);
    assert.equal(factoryCalls[0].configuration.actions.orders.create, true);
    assert.equal(factoryCalls[0].configuration.actions.payments.createRefund, true);
  });

  it("executes allowlisted read-only PayPal Agent Toolkit tools", async () => {
    const executedInputs = [];
    const service = new PaypalPaymentService({
      config: {
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
      },
      agentToolkitFactory: () => ({
        getTools: () => ({
          get_order: {
            description: "Get order",
            execute: async (input) => {
              executedInputs.push(input);
              return { id: input.id, status: "COMPLETED" };
            },
          },
        }),
      }),
    });

    const result = await service.execute("agent_toolkit_execute", {
      tool_name: "get_order",
      input: { id: "ORDER-123" },
    });

    assert.equal(result.provider, "paypal");
    assert.equal(result.provider_action, "agent_toolkit_execute");
    assert.equal(result.package, "@paypal/agent-toolkit");
    assert.equal(result.toolkit_surface, "ai-sdk");
    assert.equal(result.tool_name, "get_order");
    assert.equal(result.read_only, true);
    assert.deepEqual(result.result, { id: "ORDER-123", status: "COMPLETED" });
    assert.deepEqual(executedInputs, [{ id: "ORDER-123" }]);
  });

  it("blocks write-oriented PayPal Agent Toolkit tools from direct agent execution", async () => {
    let executeCalls = 0;
    const service = new PaypalPaymentService({
      config: {
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
      },
      agentToolkitFactory: () => ({
        getTools: () => ({
          create_order: {
            description: "Create order",
            execute: async () => {
              executeCalls += 1;
              return { id: "ORDER-NEW" };
            },
          },
        }),
      }),
    });

    const result = await service.execute("agent_toolkit_execute", {
      tool_name: "create_order",
      input: { amount: "10.00" },
    });

    assert.equal(result.error, "paypal_agent_tool_not_allowed");
    assert.equal(result.tool_name, "create_order");
    assert.deepEqual(result.allowed_tools, ["get_invoice", "get_order", "get_refund", "list_invoices"]);
    assert.equal(result.blocked_tools.includes("create_order"), true);
    assert.equal(executeCalls, 0);
  });

  it("ignores unsafe tools in custom PayPal Agent Toolkit read allowlists", async () => {
    let executeCalls = 0;
    const service = new PaypalPaymentService({
      config: {
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
        agentToolkitReadTools: ["get_order", "create_order"],
      },
      agentToolkitFactory: () => ({
        getTools: () => ({
          create_order: {
            description: "Create order",
            execute: async () => {
              executeCalls += 1;
              return { id: "ORDER-NEW" };
            },
          },
          get_order: {
            description: "Get order",
            execute: async () => ({ id: "ORDER-123" }),
          },
        }),
      }),
    });

    const result = await service.execute("agent_toolkit_execute", {
      tool_name: "create_order",
      input: { amount: "10.00" },
    });

    assert.equal(result.error, "paypal_agent_tool_not_allowed");
    assert.deepEqual(result.allowed_tools, ["get_order"]);
    assert.equal(executeCalls, 0);
  });

  it("blocks direct card data before PayPal Agent Toolkit execution", async () => {
    let executeCalls = 0;
    const service = new PaypalPaymentService({
      config: {
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
      },
      agentToolkitFactory: () => ({
        getTools: () => ({
          get_order: {
            description: "Get order",
            execute: async () => {
              executeCalls += 1;
              return { id: "ORDER-123" };
            },
          },
        }),
      }),
    });

    const result = await service.execute("agent_toolkit_execute", {
      tool_name: "get_order",
      input: { card_number: "4111111111111111" },
    });

    assert.equal(result.error, "pci_violation_blocked");
    assert.match(result.message, /tokenized payment flows/);
    assert.equal(executeCalls, 0);
  });

  it("verifies PayPal webhook signatures with the official verification endpoint", async () => {
    const calls = [];
    const health = [];
    const service = new PaypalPaymentService({
      db: {
        async logServiceHealth(service_name, status, details) {
          health.push({ service_name, status, details });
        },
      },
      config: {
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
        webhookId: "WH-CONFIGURED",
      },
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        if (String(url).endsWith("/v1/oauth2/token")) {
          return jsonResponse(200, { access_token: "access-token", expires_in: 3600 });
        }
        if (String(url).endsWith("/v1/notifications/verify-webhook-signature")) {
          return jsonResponse(200, { verification_status: "SUCCESS" });
        }
        return jsonResponse(404, {});
      },
    });

    const event = { id: "WH-VERIFY", event_type: "CHECKOUT.ORDER.APPROVED" };
    const result = await service.verifyWebhookSignature(event, {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/certs/test",
      "paypal-transmission-id": "transmission-id",
      "paypal-transmission-sig": "signature",
      "paypal-transmission-time": "2026-05-16T00:00:00Z",
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    const verifyPayload = JSON.parse(calls[1].options.body);
    assert.equal(verifyPayload.webhook_id, "WH-CONFIGURED");
    assert.deepEqual(verifyPayload.webhook_event, event);
    assert.equal(health.length, 1);
    assert.equal(health[0].service_name, "paypal_connector");
    assert.equal(health[0].status, "healthy");
    assert.equal(health[0].details.event, "paypal_webhook_verification");
    assert.equal(health[0].details.verification_status, "SUCCESS");
  });

  it("deduplicates PayPal webhook events and reconciles related payment sessions", async () => {
    const events = new Set();
    const updates = [];
    const health = [];
    const db = {
      async logServiceHealth(service_name, status, details) {
        health.push({ service_name, status, details });
      },
      async recordPaypalPaymentEvent(payload) {
        if (events.has(payload.external_event_id)) {
          return { inserted: false };
        }
        events.add(payload.external_event_id);
        return { inserted: true };
      },
      async updatePaypalPaymentSessionStatus(externalId, payload) {
        updates.push({ externalId, payload });
        return 1;
      },
    };
    const service = new PaypalPaymentService({
      db,
      config: { enabled: true, clientId: "client", clientSecret: "secret" },
      fetchFn: async () => jsonResponse(500, {}),
    });
    const event = {
      id: "WH-CAPTURE-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAPTURE-123",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "15.00" },
        supplementary_data: {
          related_ids: {
            order_id: "ORDER-123",
          },
        },
      },
    };

    const first = await service.handleWebhookEvent(event);
    const duplicate = await service.handleWebhookEvent(event);

    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);
    assert.equal(first.updated_sessions, 2);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(
      updates.map((update) => update.externalId).sort(),
      ["CAPTURE-123", "ORDER-123"],
    );
    assert.equal(updates[0].payload.status, "COMPLETED");
    assert.equal(updates[0].payload.amount, "15.00");
    assert.equal(health.length, 2);
    assert.equal(health[0].status, "healthy");
    assert.equal(health[0].details.event, "paypal_webhook_reconcile");
    assert.equal(health[0].details.updated_sessions, 2);
    assert.equal(health[1].status, "degraded");
    assert.equal(health[1].details.status, "duplicate");
  });

  it("records capture webhooks against an existing related PayPal order session", async () => {
    const recordedEvents = [];
    const sessions = new Map([
      ["ORDER-123", { external_id: "ORDER-123", status: "CREATED" }],
    ]);
    const db = {
      async recordPaypalPaymentEvent(payload) {
        recordedEvents.push(payload);
        return { inserted: true };
      },
      async getPaypalPaymentSession(externalId) {
        return sessions.get(externalId) || null;
      },
      async updatePaypalPaymentSessionStatus(externalId, payload) {
        if (!sessions.has(externalId)) return 0;
        sessions.set(externalId, {
          ...sessions.get(externalId),
          status: payload.status,
          amount: payload.amount,
          currency: payload.currency,
        });
        return 1;
      },
      async upsertPaypalPaymentSession(payload) {
        sessions.set(payload.external_id, payload);
      },
    };
    const service = new PaypalPaymentService({
      db,
      config: { enabled: true, clientId: "client", clientSecret: "secret" },
      fetchFn: async () => jsonResponse(500, {}),
    });

    const result = await service.handleWebhookEvent({
      id: "WH-CAPTURE-ORDER",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAPTURE-123",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "15.00" },
        supplementary_data: {
          related_ids: {
            order_id: "ORDER-123",
          },
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.resource_id, "ORDER-123");
    assert.equal(result.updated_sessions, 2);
    assert.equal(recordedEvents[0].resource_id, "ORDER-123");
    assert.equal(sessions.get("ORDER-123").status, "COMPLETED");
    assert.equal(sessions.get("CAPTURE-123").status, "COMPLETED");
  });

  it("ignores late PayPal webhook status regressions for completed sessions", async () => {
    const updates = [];
    const sessions = new Map([
      ["ORDER-123", { external_id: "ORDER-123", status: "COMPLETED" }],
    ]);
    const db = {
      async recordPaypalPaymentEvent() {
        return { inserted: true };
      },
      async getPaypalPaymentSession(externalId) {
        return sessions.get(externalId) || null;
      },
      async updatePaypalPaymentSessionStatus(externalId, payload) {
        updates.push({ externalId, payload });
        sessions.set(externalId, { ...sessions.get(externalId), status: payload.status });
        return 1;
      },
    };
    const service = new PaypalPaymentService({
      db,
      config: { enabled: true, clientId: "client", clientSecret: "secret" },
      fetchFn: async () => jsonResponse(500, {}),
    });

    const result = await service.handleWebhookEvent({
      id: "WH-LATE-APPROVED",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource: {
        id: "ORDER-123",
        status: "APPROVED",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.updated_sessions, 0);
    assert.deepEqual(result.ignored_sessions, ["ORDER-123"]);
    assert.equal(sessions.get("ORDER-123").status, "COMPLETED");
    assert.equal(updates.length, 0);
  });

  it("returns local PayPal session history without calling PayPal APIs", async () => {
    let httpCalls = 0;
    const db = {
      async listPaypalPaymentSessions(filters) {
        assert.equal(filters.external_id, "ORDER-789");
        assert.equal(filters.limit, 5);
        return [
          {
            external_id: "ORDER-789",
            status: "COMPLETED",
            metadata: JSON.stringify({ connector: "paypal" }),
            updated_at: "2026-05-16T00:00:00Z",
          },
        ];
      },
      async listPaypalPaymentEvents(filters) {
        assert.equal(filters.external_id, "ORDER-789");
        return [
          {
            external_event_id: "WH-789",
            event_type: "CHECKOUT.ORDER.COMPLETED",
            resource_id: "ORDER-789",
            status: "COMPLETED",
            payload: JSON.stringify({ id: "WH-789" }),
            created_at: "2026-05-16T00:00:00Z",
          },
        ];
      },
    };
    const service = new PaypalPaymentService({
      db,
      config: { enabled: true },
      fetchFn: async () => {
        httpCalls += 1;
        return jsonResponse(500, {});
      },
    });

    const result = await service.execute("payment_session_history", {
      order_id: "ORDER-789",
      limit: 5,
    });

    assert.equal(result.provider_action, "payment_session_history");
    assert.equal(result.payment_intent_id, "ORDER-789");
    assert.equal(result.status_value, "COMPLETED");
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].metadata.connector, "paypal");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].payload.id, "WH-789");
    assert.equal(httpCalls, 0);
  });
});

describe("PayPal payment persistence", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `voicednut-paypal-${Date.now()}-${Math.random()}.sqlite`,
    );
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) {
      await new Promise((resolve) => db.db.close(() => resolve()));
    }
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch (_) {}
    });
  });

  it("upserts PayPal session state and deduplicates provider events", async () => {
    await db.upsertPaypalPaymentSession({
      call_sid: "CA_paypal_002",
      action: "payment_link_generate",
      external_id: "ORDER-456",
      status: "CREATED",
      amount: "20.00",
      currency: "USD",
      approval_url: "https://paypal.test/checkout/ORDER-456",
      metadata: { source: "test" },
    });
    await db.upsertPaypalPaymentSession({
      action: "payment_link_generate",
      external_id: "ORDER-456",
      status: "APPROVED",
    });

    const session = await db.getPaypalPaymentSession("ORDER-456");
    assert.equal(session.call_sid, "CA_paypal_002");
    assert.equal(session.status, "APPROVED");
    assert.equal(session.amount, "20.00");
    assert.equal(session.action, "payment_link_generate");

    await db.updatePaypalPaymentSessionStatus("ORDER-456", {
      status: "COMPLETED",
      amount: "20.00",
      currency: "USD",
      metadata: { source: "webhook" },
    });

    const updatedSession = await db.getPaypalPaymentSession("ORDER-456");
    assert.equal(updatedSession.action, "payment_link_generate");
    assert.equal(updatedSession.status, "COMPLETED");

    const first = await db.recordPaypalPaymentEvent({
      external_event_id: "WH-1",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource_id: "ORDER-456",
      status: "APPROVED",
      payload: { id: "WH-1" },
    });
    const duplicate = await db.recordPaypalPaymentEvent({
      external_event_id: "WH-1",
      event_type: "CHECKOUT.ORDER.APPROVED",
    });

    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);

    const sessions = await db.listPaypalPaymentSessions({
      call_sid: "CA_paypal_002",
      limit: 5,
    });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].external_id, "ORDER-456");

    const events = await db.listPaypalPaymentEvents({
      external_id: "ORDER-456",
      limit: 5,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].external_event_id, "WH-1");
  });
});
