#!/usr/bin/env node

const { StripePaymentService } = require("../services/stripePaymentService");

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
    live: boolFrom(process.env.STRIPE_SMOKE_LIVE),
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    environment: process.env.STRIPE_ENVIRONMENT || process.env.STRIPE_ENV || "test",
    returnUrl:
      process.env.STRIPE_SMOKE_RETURN_URL ||
      process.env.STRIPE_RETURN_URL ||
      "https://example.com/stripe/return",
    cancelUrl:
      process.env.STRIPE_SMOKE_CANCEL_URL ||
      process.env.STRIPE_CANCEL_URL ||
      "https://example.com/stripe/cancel",
    apiVersion: process.env.STRIPE_API_VERSION || "2026-02-25.clover",
    timeoutMs: Number(process.env.STRIPE_TIMEOUT_MS || 7000),
    amount: process.env.STRIPE_SMOKE_AMOUNT || "1.00",
    currency: process.env.STRIPE_SMOKE_CURRENCY || "USD",
    description: process.env.STRIPE_SMOKE_DESCRIPTION || "VoicedNut Stripe smoke test",
  };
}

function validateConfig(report, config) {
  if (!config.secretKey) {
    report.fail("config.secret_key", "STRIPE_SECRET_KEY is required.");
  } else {
    report.pass("config.secret_key", { value: redact(config.secretKey) });
  }

  if (!config.webhookSecret) {
    report.fail("config.webhook_secret", "STRIPE_WEBHOOK_SECRET is required.");
  } else {
    report.pass("config.webhook_secret", { value: redact(config.webhookSecret) });
  }

  if (!["test", "live", "production"].includes(String(config.environment).toLowerCase())) {
    report.fail("config.environment", "STRIPE_ENVIRONMENT must be test, live, or production.", {
      value: config.environment,
    });
  } else {
    report.pass("config.environment", { value: config.environment });
  }

  const amount = Number(config.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    report.fail("config.amount", "STRIPE_SMOKE_AMOUNT must be a positive number.", {
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
  const service = new StripePaymentService({
    config: {
      enabled: true,
      secretKey: config.secretKey,
      webhookSecret: config.webhookSecret,
      environment: config.environment,
      returnUrl: config.returnUrl,
      cancelUrl: config.cancelUrl,
      apiVersion: config.apiVersion,
      defaultCurrency: config.currency,
      timeoutMs: config.timeoutMs,
    },
  });

  const smokeId = `stripe-smoke-${Date.now()}`;
  const session = await service.execute(
    "payment_link_generate",
    {
      amount: config.amount,
      currency: config.currency,
      description: config.description,
      idempotency_key: smokeId,
    },
    { callSid: smokeId, callConfig: {} },
  );

  if (session?.error) {
    report.fail("live.checkout_session_create", session.message || session.error, {
      error: session.error,
    });
    return;
  }
  if (!session?.payment_link_id || !session?.payment_url) {
    report.fail(
      "live.checkout_session_create",
      "Stripe Checkout Session response was missing payment_link_id or payment_url.",
      { response_keys: Object.keys(session || {}) },
    );
    return;
  }

  report.pass("live.checkout_session_create", {
    payment_link_id: session.payment_link_id,
    status: session.status_value,
    payment_url: session.payment_url,
  });

  const status = await service.execute("payment_intent_status", {
    payment_intent_id: session.payment_link_id,
  });

  if (status?.error) {
    report.fail("live.checkout_session_read", status.message || status.error, {
      error: status.error,
      payment_link_id: session.payment_link_id,
    });
    return;
  }

  report.pass("live.checkout_session_read", {
    payment_link_id: session.payment_link_id,
    status: status.status_value,
  });
}

async function main() {
  const report = createReport();
  const config = getConfig();
  validateConfig(report, config);

  if (report.summary().fail === 0 && config.live) {
    await runLiveReadback(report, config);
  } else if (!config.live) {
    report.skip("live.checkout_session_create", "Set STRIPE_SMOKE_LIVE=1 to create a Stripe Checkout Session.");
    report.skip("live.checkout_session_read", "Set STRIPE_SMOKE_LIVE=1 to read the created Checkout Session.");
  }

  const summary = report.summary();
  console.log(
    JSON.stringify(
      {
        provider: "stripe",
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
  console.error(`Stripe smoke failed: ${error.message}`);
  process.exit(2);
});
