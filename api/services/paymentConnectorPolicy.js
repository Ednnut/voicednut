"use strict";

function normalizeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function parseProviderList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry, 40).toLowerCase()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((entry) => normalizeText(entry, 40).toLowerCase())
    .filter(Boolean);
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Number(amount.toFixed(2));
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function readPolicyConfig(options = {}) {
  const env = options.env || process.env;
  const callConfig = options.callConfig || {};
  const callPolicy =
    callConfig.payment_policy ||
    callConfig.paymentPolicy ||
    callConfig?.payment?.policy ||
    {};
  return {
    allowedProviders: parseProviderList(
      firstDefined(
        callPolicy.allowed_providers,
        callPolicy.allowedProviders,
        callConfig.payment_connector_allowed_providers,
        callConfig.paymentConnectorAllowedProviders,
        options.allowedProviders,
        env.PAYMENT_CONNECTOR_ALLOWED_PROVIDERS,
      ),
    ),
    maxPaymentAmount: normalizeAmount(
      firstDefined(
        callPolicy.max_payment_amount,
        callPolicy.maxPaymentAmount,
        callConfig.payment_connector_max_payment_amount,
        callConfig.paymentConnectorMaxPaymentAmount,
        options.maxPaymentAmount,
        env.PAYMENT_CONNECTOR_MAX_PAYMENT_AMOUNT,
      ),
    ),
    maxRefundAmount: normalizeAmount(
      firstDefined(
        callPolicy.max_refund_amount,
        callPolicy.maxRefundAmount,
        callConfig.payment_connector_max_refund_amount,
        callConfig.paymentConnectorMaxRefundAmount,
        options.maxRefundAmount,
        env.PAYMENT_CONNECTOR_MAX_REFUND_AMOUNT,
      ),
    ),
  };
}

function getActionLimit(policy, action) {
  if (action === "refund_request_initiate") return policy.maxRefundAmount;
  if (
    action === "payment_link_generate" ||
    action === "payment_retry_link_generate" ||
    action === "invoice_create"
  ) {
    return policy.maxPaymentAmount;
  }
  return null;
}

function evaluatePaymentConnectorPolicy(action, args = {}, options = {}) {
  const actionName = normalizeText(action, 120);
  const requestedProvider = normalizeText(options.requestedProvider, 40).toLowerCase();
  const requestedConnector = normalizeText(options.requestedConnector, 80).toLowerCase();
  const policy = readPolicyConfig(options);
  const amount = normalizeAmount(args.amount);
  const limitAmount = getActionLimit(policy, actionName);
  const violations = [];

  if (
    requestedProvider &&
    policy.allowedProviders.length > 0 &&
    !policy.allowedProviders.includes(requestedProvider)
  ) {
    violations.push({
      code: "payment_provider_not_allowed",
      message: `${requestedProvider} is not allowed by payment connector policy.`,
    });
  }

  if (amount !== null && limitAmount !== null && amount > limitAmount) {
    violations.push({
      code: "payment_amount_limit_exceeded",
      message: `${actionName} amount ${amount} exceeds policy limit ${limitAmount}.`,
    });
  }

  const result = {
    ok: violations.length === 0,
    status: violations.length === 0 ? "ok" : "blocked",
    policy: {
      allowed_providers: policy.allowedProviders,
      max_payment_amount: policy.maxPaymentAmount,
      max_refund_amount: policy.maxRefundAmount,
    },
    evaluation: {
      action: actionName || null,
      requested_provider: requestedProvider || null,
      requested_connector: requestedConnector || null,
      amount,
      limit_amount: limitAmount,
      violations,
    },
  };

  if (violations.length > 0) {
    const primaryViolation = violations[0] || {};
    return {
      ...result,
      error: "payment_connector_policy_violation",
      reason:
        primaryViolation.code === "payment_provider_not_allowed"
          ? "provider_not_allowed"
          : primaryViolation.code || "policy_violation",
      message: violations.map((violation) => violation.message).join(" "),
      allowed_providers: policy.allowedProviders,
    };
  }
  return result;
}

module.exports = {
  evaluatePaymentConnectorPolicy,
  parseProviderList,
};
