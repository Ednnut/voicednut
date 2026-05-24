const assert = require("node:assert/strict");

const express = require("express");

const {
  CHECK_STATUS,
  buildProviderCallbackUrls,
  isProviderSupported,
  runProviderPreflight,
} = require("../adapters/providerPreflight");

function createPaypalConfig(paypalOverrides = {}) {
  return {
    server: {
      hostname: "api.example.com",
    },
    payment: {
      paypal: {
        enabled: true,
        environment: "sandbox",
        clientId: "paypal-client",
        clientSecret: "paypal-secret",
        webhookId: "paypal-webhook",
        returnUrl: "https://api.example.com/paypal/return",
        cancelUrl: "https://api.example.com/paypal/cancel",
        ...paypalOverrides,
      },
    },
  };
}

function createStripeConfig(stripeOverrides = {}) {
  return {
    server: {
      hostname: "api.example.com",
    },
    payment: {
      stripe: {
        enabled: true,
        environment: "test",
        secretKey: "sk_test_123",
        webhookSecret: "whsec_test",
        returnUrl: "https://api.example.com/stripe/return",
        cancelUrl: "https://api.example.com/stripe/cancel",
        ...stripeOverrides,
      },
    },
  };
}

function createSquareConfig(squareOverrides = {}) {
  return {
    server: {
      hostname: "api.example.com",
    },
    payment: {
      square: {
        enabled: true,
        environment: "sandbox",
        accessToken: "square-token",
        locationId: "L123",
        webhookSignatureKey: "square-signature-key",
        webhookUrl: "https://api.example.com/webhook/square",
        returnUrl: "https://api.example.com/square/return",
        ...squareOverrides,
      },
    },
  };
}

function createAppWithPaypalWebhook() {
  const app = express();
  app.post("/webhook/paypal", (_req, res) => res.sendStatus(204));
  return app;
}

function createAppWithStripeWebhook() {
  const app = express();
  app.post("/webhook/stripe", (_req, res) => res.sendStatus(204));
  return app;
}

function createAppWithSquareWebhook() {
  const app = express();
  app.post("/webhook/square", (_req, res) => res.sendStatus(204));
  return app;
}

function findCheck(report, id) {
  return report.checks.find((check) => check.id === id);
}

describe("PayPal provider preflight", () => {
  it("registers PayPal as a payment-only preflight provider", () => {
    assert.equal(isProviderSupported("payment", "paypal"), true);
    assert.equal(isProviderSupported("call", "paypal"), false);
    assert.equal(isProviderSupported("sms", "paypal"), false);
  });

  it("builds the PayPal webhook callback URL from SERVER", () => {
    const callbacks = buildProviderCallbackUrls(
      "paypal",
      "payment",
      createPaypalConfig(),
    );

    assert.deepEqual(callbacks.urls, ["https://api.example.com/webhook/paypal"]);
    assert.equal(callbacks.base_url, "https://api.example.com");
    assert.equal(callbacks.reason, null);
  });

  it("passes offline readiness when PayPal credentials, webhook auth, route, and read tools are configured", async () => {
    const report = await runProviderPreflight({
      provider: "paypal",
      channel: "payment",
      mode: "manual",
      config: createPaypalConfig(),
      app: createAppWithPaypalWebhook(),
      allowNetwork: false,
      requireReachability: false,
      guards: {
        paypal: true,
      },
    });

    assert.equal(report.ok, true);
    assert.equal(findCheck(report, "credentials_auth").status, CHECK_STATUS.WARN);
    assert.equal(findCheck(report, "webhook_auth").status, CHECK_STATUS.PASS);
    assert.equal(findCheck(report, "callback_urls").status, CHECK_STATUS.PASS);
    assert.equal(findCheck(report, "required_routes").status, CHECK_STATUS.PASS);
    assert.equal(
      findCheck(report, "agent_toolkit_read_surface").status,
      CHECK_STATUS.PASS,
    );
  });

  it("fails when PayPal webhook signature configuration or route registration is missing", async () => {
    const report = await runProviderPreflight({
      provider: "paypal",
      channel: "payment",
      mode: "manual",
      config: createPaypalConfig({ webhookId: "" }),
      app: express(),
      allowNetwork: false,
      requireReachability: false,
      guards: {
        paypal: false,
      },
    });

    assert.equal(report.ok, false);
    assert.equal(findCheck(report, "webhook_auth").status, CHECK_STATUS.FAIL);
    assert.equal(findCheck(report, "required_routes").status, CHECK_STATUS.FAIL);
  });

  it("fails when custom PayPal Agent Toolkit config enables no safe read tools", async () => {
    const report = await runProviderPreflight({
      provider: "paypal",
      channel: "payment",
      mode: "manual",
      config: createPaypalConfig({
        agentToolkitReadTools: ["create_order", "send_invoice"],
      }),
      app: createAppWithPaypalWebhook(),
      allowNetwork: false,
      requireReachability: false,
      guards: {
        paypal: true,
      },
    });

    const toolkitCheck = findCheck(report, "agent_toolkit_read_surface");
    assert.equal(report.ok, false);
    assert.equal(toolkitCheck.status, CHECK_STATUS.FAIL);
    assert.deepEqual(toolkitCheck.details.default_read_tools, [
      "get_invoice",
      "get_order",
      "get_refund",
      "list_invoices",
    ]);
    assert.ok(toolkitCheck.details.blocked_tools.includes("create_order"));
  });
});

describe("Stripe provider preflight", () => {
  it("registers Stripe as a payment-only preflight provider", () => {
    assert.equal(isProviderSupported("payment", "stripe"), true);
    assert.equal(isProviderSupported("call", "stripe"), false);
    assert.equal(isProviderSupported("sms", "stripe"), false);
  });

  it("builds the Stripe webhook callback URL from SERVER", () => {
    const callbacks = buildProviderCallbackUrls(
      "stripe",
      "payment",
      createStripeConfig(),
    );

    assert.deepEqual(callbacks.urls, ["https://api.example.com/webhook/stripe"]);
    assert.equal(callbacks.base_url, "https://api.example.com");
    assert.equal(callbacks.reason, null);
  });

  it("passes offline readiness when Stripe credentials, webhook auth, and route are configured", async () => {
    const report = await runProviderPreflight({
      provider: "stripe",
      channel: "payment",
      mode: "manual",
      config: createStripeConfig(),
      app: createAppWithStripeWebhook(),
      allowNetwork: false,
      requireReachability: false,
      guards: {
        stripe: true,
      },
    });

    assert.equal(report.ok, true);
    assert.equal(findCheck(report, "credentials_auth").status, CHECK_STATUS.WARN);
    assert.equal(findCheck(report, "webhook_auth").status, CHECK_STATUS.PASS);
    assert.equal(findCheck(report, "callback_urls").status, CHECK_STATUS.PASS);
    assert.equal(findCheck(report, "required_routes").status, CHECK_STATUS.PASS);
    assert.equal(findCheck(report, "agent_toolkit_read_surface"), undefined);
  });

  it("fails when Stripe webhook signature configuration or route registration is missing", async () => {
    const report = await runProviderPreflight({
      provider: "stripe",
      channel: "payment",
      mode: "manual",
      config: createStripeConfig({ webhookSecret: "" }),
      app: express(),
      allowNetwork: false,
      requireReachability: false,
      guards: {
        stripe: false,
      },
    });

    assert.equal(report.ok, false);
    assert.equal(findCheck(report, "webhook_auth").status, CHECK_STATUS.FAIL);
    assert.equal(findCheck(report, "required_routes").status, CHECK_STATUS.FAIL);
  });
});

describe("Square provider preflight", () => {
  it("registers Square as a payment-only preflight provider", () => {
    assert.equal(isProviderSupported("payment", "square"), true);
    assert.equal(isProviderSupported("call", "square"), false);
    assert.equal(isProviderSupported("sms", "square"), false);
  });

  it("builds the Square webhook callback URL from SQUARE_WEBHOOK_URL", () => {
    const callbacks = buildProviderCallbackUrls(
      "square",
      "payment",
      createSquareConfig(),
    );

    assert.deepEqual(callbacks.urls, ["https://api.example.com/webhook/square"]);
    assert.equal(callbacks.reason, null);
  });

  it("falls back to SERVER when Square webhook URL is not explicitly configured", () => {
    const callbacks = buildProviderCallbackUrls(
      "square",
      "payment",
      createSquareConfig({ webhookUrl: "" }),
    );

    assert.deepEqual(callbacks.urls, ["https://api.example.com/webhook/square"]);
    assert.equal(callbacks.base_url, "https://api.example.com");
    assert.equal(callbacks.reason, null);
  });

  it("passes offline readiness when Square credentials, webhook auth, and route are configured", async () => {
    const report = await runProviderPreflight({
      provider: "square",
      channel: "payment",
      mode: "manual",
      config: createSquareConfig(),
      app: createAppWithSquareWebhook(),
      allowNetwork: false,
      requireReachability: false,
      guards: {
        square: true,
      },
    });

    assert.equal(report.ok, true);
    assert.equal(findCheck(report, "credentials_auth").status, CHECK_STATUS.WARN);
    assert.equal(findCheck(report, "webhook_auth").status, CHECK_STATUS.PASS);
    assert.equal(findCheck(report, "callback_urls").status, CHECK_STATUS.PASS);
    assert.equal(findCheck(report, "required_routes").status, CHECK_STATUS.PASS);
    assert.equal(findCheck(report, "agent_toolkit_read_surface"), undefined);
  });

  it("fails when Square webhook signature configuration or route registration is missing", async () => {
    const report = await runProviderPreflight({
      provider: "square",
      channel: "payment",
      mode: "manual",
      config: createSquareConfig({ webhookSignatureKey: "" }),
      app: express(),
      allowNetwork: false,
      requireReachability: false,
      guards: {
        square: false,
      },
    });

    assert.equal(report.ok, false);
    assert.equal(findCheck(report, "webhook_auth").status, CHECK_STATUS.FAIL);
    assert.equal(findCheck(report, "required_routes").status, CHECK_STATUS.FAIL);
  });
});
