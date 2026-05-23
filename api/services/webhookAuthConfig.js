"use strict";

function normalizeMode(value = "warn") {
  return String(value || "warn").trim().toLowerCase();
}

function hasSecret(value) {
  return Boolean(String(value || "").trim());
}

function assertEmailWebhookAuthConfiguration(config = {}) {
  const mode = normalizeMode(config.email?.webhookValidation);
  if (mode !== "strict") return;
  const hasEmailSecret = hasSecret(config.email?.webhookSecret);
  const hasHmacSecret = hasSecret(config.apiAuth?.hmacSecret);
  if (hasEmailSecret || hasHmacSecret) return;
  throw new Error(
    "EMAIL_WEBHOOK_VALIDATION is strict but no email webhook auth secret is configured. Set EMAIL_WEBHOOK_SECRET or API_SECRET/API_HMAC_SECRET.",
  );
}

function assertVonageWebhookAuthConfiguration(config = {}) {
  const mode = normalizeMode(config.vonage?.webhookValidation);
  if (mode !== "strict") return;
  if (hasSecret(config.vonage?.webhookSignatureSecret)) return;
  throw new Error(
    "VONAGE_WEBHOOK_VALIDATION is strict but VONAGE_WEBHOOK_SIGNATURE_SECRET is missing. Configure a webhook signature secret before startup.",
  );
}

function assertTwilioWebhookAuthConfiguration(config = {}) {
  const mode = normalizeMode(config.twilio?.webhookValidation);
  if (mode !== "strict") return;
  if (hasSecret(config.twilio?.authToken)) return;
  throw new Error(
    "TWILIO_WEBHOOK_VALIDATION is strict but TWILIO_AUTH_TOKEN is missing. Configure the Twilio auth token before startup.",
  );
}

function assertPlivoWebhookAuthConfiguration(config = {}) {
  const mode = normalizeMode(config.plivo?.webhookValidation);
  if (mode !== "strict") return;
  const activeCallProvider = String(config.platform?.provider || "").toLowerCase();
  const activeSmsProvider = String(config.sms?.provider || "").toLowerCase();
  if (activeCallProvider !== "plivo" && activeSmsProvider !== "plivo") return;
  const hasPlivoSecret = hasSecret(config.plivo?.webhookSecret);
  const hasHmacSecret = hasSecret(config.apiAuth?.hmacSecret);
  if (hasPlivoSecret || hasHmacSecret) return;
  throw new Error(
    "PLIVO_WEBHOOK_VALIDATION is strict but no Plivo webhook auth secret is configured. Set PLIVO_WEBHOOK_SECRET or API_SECRET/API_HMAC_SECRET.",
  );
}

function assertTelegramWebhookAuthConfiguration(config = {}) {
  const mode = normalizeMode(config.telegram?.webhookValidation);
  if (mode !== "strict") return;
  if (hasSecret(config.apiAuth?.hmacSecret)) return;
  throw new Error(
    "TELEGRAM_WEBHOOK_VALIDATION is strict but API_SECRET/API_HMAC_SECRET is missing. Configure API request HMAC authentication before startup.",
  );
}

function assertWebhookAuthConfiguration(config = {}) {
  assertEmailWebhookAuthConfiguration(config);
  assertVonageWebhookAuthConfiguration(config);
  assertTwilioWebhookAuthConfiguration(config);
  assertPlivoWebhookAuthConfiguration(config);
  assertTelegramWebhookAuthConfiguration(config);
}

module.exports = {
  assertWebhookAuthConfiguration,
  assertEmailWebhookAuthConfiguration,
  assertVonageWebhookAuthConfiguration,
  assertTwilioWebhookAuthConfiguration,
  assertPlivoWebhookAuthConfiguration,
  assertTelegramWebhookAuthConfiguration,
};
