"use strict";

function normalizeText(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeStatus(value) {
  return normalizeText(value, 80).toUpperCase() || "UNKNOWN";
}

function normalizeProvider(value) {
  return normalizeText(value, 40).toLowerCase() || "unknown";
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Number(amount.toFixed(2));
}

function centsToAmount(value) {
  const cents = Number(value);
  if (!Number.isFinite(cents)) return null;
  return Number((cents / 100).toFixed(2));
}

function getNestedAmount(resource = {}) {
  const amount =
    resource.amount_money?.amount ??
    resource.total_money?.amount ??
    resource.approved_money?.amount ??
    resource.amount_paid_money?.amount ??
    resource.amount?.value ??
    resource.amount ??
    resource.amount_total ??
    resource.amount_received;
  if (amount == null || amount === "") return null;
  if (
    resource.amount_money ||
    resource.total_money ||
    resource.approved_money ||
    resource.amount_paid_money ||
    String(resource.object || "").toLowerCase() === "checkout.session" ||
    String(resource.object || "").toLowerCase() === "payment_intent"
  ) {
    return centsToAmount(amount);
  }
  return normalizeAmount(amount);
}

function getNestedCurrency(resource = {}) {
  return normalizeText(
    resource.amount_money?.currency ||
      resource.total_money?.currency ||
      resource.approved_money?.currency ||
      resource.amount_paid_money?.currency ||
      resource.currency_code ||
      resource.currency,
    3,
  ).toUpperCase() || null;
}

function mapProviderEventType(provider, providerEventType, status) {
  const eventType = normalizeText(providerEventType, 160).toLowerCase();
  const statusValue = normalizeStatus(status);
  if (
    eventType.includes("refund") ||
    eventType.includes("refunded") ||
    statusValue === "REFUNDED"
  ) {
    return "refund_created";
  }
  if (eventType.includes("invoice") && (eventType.includes("paid") || statusValue === "PAID")) {
    return "invoice_paid";
  }
  if (eventType.includes("invoice") && eventType.includes("failed")) {
    return "invoice_failed";
  }
  if (eventType.includes("invoice")) {
    return "invoice_created";
  }
  if (
    eventType.includes("succeeded") ||
    eventType.includes("completed") ||
    eventType.includes("captured") ||
    statusValue === "SUCCEEDED" ||
    statusValue === "COMPLETED" ||
    statusValue === "PAID" ||
    statusValue === "APPROVED"
  ) {
    return "payment_succeeded";
  }
  if (
    eventType.includes("failed") ||
    eventType.includes("denied") ||
    eventType.includes("canceled") ||
    eventType.includes("cancelled") ||
    eventType.includes("expired") ||
    statusValue === "FAILED" ||
    statusValue === "DENIED" ||
    statusValue === "CANCELED" ||
    statusValue === "CANCELLED" ||
    statusValue === "EXPIRED"
  ) {
    return "payment_failed";
  }
  if (
    eventType.includes("pending") ||
    eventType.includes("created") ||
    statusValue === "PENDING" ||
    statusValue === "PROCESSING" ||
    statusValue === "OPEN"
  ) {
    return "payment_pending";
  }
  return `${normalizeProvider(provider)}_payment_event`;
}

function getProviderEventId(provider, rawEvent = {}) {
  if (provider === "paypal") return rawEvent.id;
  if (provider === "stripe") return rawEvent.id;
  if (provider === "square") return rawEvent.event_id;
  return rawEvent.id || rawEvent.event_id;
}

function getProviderEventType(provider, rawEvent = {}) {
  if (provider === "paypal") return rawEvent.event_type;
  if (provider === "stripe") return rawEvent.type;
  if (provider === "square") return rawEvent.type;
  return rawEvent.type || rawEvent.event_type;
}

function getProviderResource(provider, rawEvent = {}) {
  if (provider === "paypal") return rawEvent.resource || {};
  if (provider === "stripe") return rawEvent.data?.object || {};
  if (provider === "square") return rawEvent.data?.object || rawEvent.data || {};
  return rawEvent.resource || rawEvent.data?.object || rawEvent.data || {};
}

function normalizePaymentEvent(providerValue, rawEvent = {}, options = {}) {
  const provider = normalizeProvider(providerValue);
  const resource =
    options.resource && typeof options.resource === "object"
      ? options.resource
      : getProviderResource(provider, rawEvent);
  const providerEventId = normalizeText(
    options.provider_event_id || getProviderEventId(provider, rawEvent),
    180,
  );
  const providerEventType = normalizeText(
    options.provider_event_type || getProviderEventType(provider, rawEvent),
    180,
  );
  const resourceId = normalizeText(
    options.resource_id ||
      resource.id ||
      resource.payment_id ||
      resource.order_id ||
      resource.invoice_id ||
      resource.refund_id,
    180,
  );
  const status = normalizeStatus(
    options.status ||
      resource.status ||
      resource.payment_status ||
      resource.state ||
      resource.refund_status,
  );
  const amount = normalizeAmount(options.amount) ?? getNestedAmount(resource);
  const currency = normalizeText(options.currency, 3).toUpperCase() || getNestedCurrency(resource);
  const occurredAt = normalizeText(
    options.occurred_at ||
      rawEvent.created_at ||
      rawEvent.created ||
      resource.created_at ||
      resource.created ||
      new Date().toISOString(),
    80,
  );
  const relatedIds = {
    payment_intent_id:
      normalizeText(options.payment_intent_id || resource.payment_intent || resource.payment_id, 180) ||
      null,
    checkout_session_id: normalizeText(options.checkout_session_id || resource.checkout_session_id, 180) || null,
    payment_link_id: normalizeText(options.payment_link_id || resource.payment_link_id, 180) || null,
    order_id: normalizeText(options.order_id || resource.order_id, 180) || null,
    invoice_id: normalizeText(options.invoice_id || resource.invoice_id, 180) || null,
    refund_id: normalizeText(options.refund_id || resource.refund_id, 180) || null,
  };

  return {
    provider,
    provider_event_id: providerEventId || null,
    provider_event_type: providerEventType || null,
    normalized_type: mapProviderEventType(provider, providerEventType, status),
    resource_id: resourceId || null,
    status,
    amount,
    currency,
    occurred_at: occurredAt,
    related_ids: relatedIds,
  };
}

module.exports = {
  mapProviderEventType,
  normalizePaymentEvent,
};
