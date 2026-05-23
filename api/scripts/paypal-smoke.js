#!/usr/bin/env node

const { PaypalPaymentService } = require("../services/paypalPaymentService");

function boolFrom(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function redact(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function createReport() {
  const checks = [];
  return {
    pass(name, details = {}) {
      checks.push({ name, status: "pass", details });
    },
    fail(name, message, details = {}) {
      checks.push({ name, status: "fail", message, details });
    },
    skip(name, message, details = {}) {
      checks.push({ name, status: "skip", message, details });
    },
    summary() {
      return checks.reduce(
        (acc, check) => {
          acc[check.status] += 1;
          return acc;
        },
        { pass: 0, fail: 0, skip: 0 },
      );
    },
    checks,
  };
}

function getConfig() {
  return {
    live: boolFrom(process.env.PAYPAL_SMOKE_LIVE),
    clientId: process.env.PAYPAL_CLIENT_ID || "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
    environment: process.env.PAYPAL_ENVIRONMENT || process.env.PAYPAL_ENV || "sandbox",
    returnUrl:
      process.env.PAYPAL_SMOKE_RETURN_URL ||
      process.env.PAYPAL_RETURN_URL ||
      "https://example.com/paypal/return",
    cancelUrl:
      process.env.PAYPAL_SMOKE_CANCEL_URL ||
      process.env.PAYPAL_CANCEL_URL ||
      "https://example.com/paypal/cancel",
    brandName: process.env.PAYPAL_BRAND_NAME || "VoicedNut",
    timeoutMs: Number(process.env.PAYPAL_TIMEOUT_MS || 7000),
    amount: process.env.PAYPAL_SMOKE_AMOUNT || "1.00",
    currency: process.env.PAYPAL_SMOKE_CURRENCY || "USD",
    description: process.env.PAYPAL_SMOKE_DESCRIPTION || "VoicedNut PayPal smoke test",
  };
}

function validateConfig(report, config) {
  if (!config.clientId) {
    report.fail("config.client_id", "PAYPAL_CLIENT_ID is required.");
  } else {
    report.pass("config.client_id", { value: redact(config.clientId) });
  }

  if (!config.clientSecret) {
    report.fail("config.client_secret", "PAYPAL_CLIENT_SECRET is required.");
  } else {
    report.pass("config.client_secret", { value: redact(config.clientSecret) });
  }

  if (!["sandbox", "live"].includes(config.environment)) {
    report.fail("config.environment", "PAYPAL_ENVIRONMENT must be sandbox or live.", {
      value: config.environment,
    });
  } else {
    report.pass("config.environment", { value: config.environment });
  }

  const amount = Number(config.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    report.fail("config.amount", "PAYPAL_SMOKE_AMOUNT must be a positive number.", {
      value: config.amount,
    });
  } else {
    report.pass("config.amount", {
      amount: amount.toFixed(2),
      currency: config.currency,
    });
  }
}

async function runLiveReadback(report, config) {
  const service = new PaypalPaymentService({
    config: {
      enabled: true,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      environment: config.environment,
      returnUrl: config.returnUrl,
      cancelUrl: config.cancelUrl,
      brandName: config.brandName,
      defaultCurrency: config.currency,
      timeoutMs: config.timeoutMs,
    },
  });

  const smokeId = `paypal-smoke-${Date.now()}`;
  const order = await service.execute(
    "payment_link_generate",
    {
      amount: config.amount,
      currency: config.currency,
      description: config.description,
      idempotency_key: smokeId,
    },
    { callSid: smokeId, callConfig: {} },
  );

  if (order?.error) {
    report.fail("live.order_create", order.message || order.error, { error: order.error });
    return;
  }
  if (!order?.order_id || !order?.payment_url) {
    report.fail("live.order_create", "PayPal order response was missing order_id or payment_url.", {
      response_keys: Object.keys(order || {}),
    });
    return;
  }

  report.pass("live.order_create", {
    order_id: order.order_id,
    status: order.status_value,
    payment_url: order.payment_url,
  });

  const toolkit = await service.execute("agent_toolkit_execute", {
    tool_name: "get_order",
    input: { id: order.order_id },
  });

  if (toolkit?.error) {
    report.fail("live.agent_toolkit_get_order", toolkit.message || toolkit.error, {
      error: toolkit.error,
      order_id: order.order_id,
    });
    return;
  }

  report.pass("live.agent_toolkit_get_order", {
    order_id: order.order_id,
    result_type: typeof toolkit?.result,
  });
}

async function main() {
  const report = createReport();
  const config = getConfig();
  validateConfig(report, config);

  if (report.summary().fail === 0 && config.live) {
    await runLiveReadback(report, config);
  } else if (!config.live) {
    report.skip("live.order_create", "Set PAYPAL_SMOKE_LIVE=1 to create a PayPal order.");
    report.skip(
      "live.agent_toolkit_get_order",
      "Set PAYPAL_SMOKE_LIVE=1 to read the created order through PayPal Agent Toolkit.",
    );
  }

  const summary = report.summary();
  console.log(
    JSON.stringify(
      {
        provider: "paypal",
        environment: config.environment,
        live: config.live,
        summary,
        checks: report.checks,
      },
      null,
      2,
    ),
  );

  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`PayPal smoke failed: ${error.message}`);
  process.exit(2);
});
