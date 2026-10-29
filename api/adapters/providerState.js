const config = require("../config");

const PROVIDER_CHANNELS = Object.freeze({
  CALL: "call",
  SMS: "sms",
  EMAIL: "email",
});

const SUPPORTED_PROVIDERS = Object.freeze({
  [PROVIDER_CHANNELS.CALL]: Object.freeze(["twilio", "plivo", "vonage", "call_e"]),
  [PROVIDER_CHANNELS.SMS]: Object.freeze(["twilio", "plivo", "vonage"]),
  [PROVIDER_CHANNELS.EMAIL]: Object.freeze(["sendgrid", "mailgun"]),
});

function normalizeChannel(channel) {
  const normalized = String(channel || "")
    .trim()
    .toLowerCase();
  if (!SUPPORTED_PROVIDERS[normalized]) {
    throw new Error(
      `Unsupported provider channel "${channel}". Supported channels: ${Object.keys(
        SUPPORTED_PROVIDERS,
      ).join(", ")}`,
    );
  }
  return normalized;
}

function getSupportedProviders(channel) {
  return SUPPORTED_PROVIDERS[normalizeChannel(channel)];
}

function normalizeProvider(channel, value) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedValue = String(value || "")
    .trim()
    .toLowerCase();
  const supported = getSupportedProviders(normalizedChannel);
  if (!supported.includes(normalizedValue)) {
    throw new Error(
      `Unsupported ${normalizedChannel} provider "${value}". Supported values: ${supported.join(", ")}`,
    );
  }
  return normalizedValue;
}

function resolveInitialProvider(channel) {
  if (channel === PROVIDER_CHANNELS.CALL) {
    const provider = normalizeProvider(channel, config.platform?.provider || "twilio");
    if (provider === "call_e" && !isCallESelectionReady(config.callE)) {
      throw new Error("CALL-E cannot be selected until it is enabled, configured, allowlisted, and pilot-approved");
    }
    return provider;
  }
  if (channel === PROVIDER_CHANNELS.SMS) {
    return normalizeProvider(
      channel,
      config.sms?.provider || config.platform?.provider || "twilio",
    );
  }
  return normalizeProvider(channel, config.email?.provider || "sendgrid");
}

function isCallESelectionReady(settings = {}) {
  const fingerprint = String(settings.pilotApprovalFingerprint || "").trim().toLowerCase();
  const reference = String(settings.pilotApprovalReference || "").trim();
  const expiresAt = String(settings.pilotApprovalExpiresAt || "").trim();
  const baseUrl = String(settings.baseUrl || "").replace(/\/+$/, "");
  return settings.enabled === true && settings.dispatchEnabled === true && Boolean(String(settings.apiKey || "").trim()) &&
    ["https://api.heycall-e.com", "https://test-api.heycall-e.com"].includes(baseUrl) &&
    Array.isArray(settings.allowedDestinations) && settings.allowedDestinations.some((value) => /^\+[1-9]\d{7,14}$/.test(String(value))) &&
    /^[a-f0-9]{64}$/.test(fingerprint) && /^[A-Za-z0-9._:-]{8,180}$/.test(reference) &&
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(expiresAt) && Number.isFinite(Date.parse(expiresAt)) &&
    Date.parse(expiresAt) > Date.now() && settings.pilotReadinessReviewed === true;
}

const activeProviders = {
  [PROVIDER_CHANNELS.CALL]: resolveInitialProvider(PROVIDER_CHANNELS.CALL),
  [PROVIDER_CHANNELS.SMS]: resolveInitialProvider(PROVIDER_CHANNELS.SMS),
  [PROVIDER_CHANNELS.EMAIL]: resolveInitialProvider(PROVIDER_CHANNELS.EMAIL),
};

const storedProviders = {
  ...activeProviders,
};

function getActiveProvider(channel) {
  return activeProviders[normalizeChannel(channel)];
}

function getStoredProvider(channel) {
  return storedProviders[normalizeChannel(channel)];
}

function setActiveProvider(channel, provider) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedProvider = normalizeProvider(normalizedChannel, provider);
  if (normalizedChannel === PROVIDER_CHANNELS.CALL && normalizedProvider === "call_e" && !isCallESelectionReady(config.callE)) {
    throw new Error("CALL-E cannot be selected until it is enabled, configured, allowlisted, and pilot-approved");
  }
  const changed = activeProviders[normalizedChannel] !== normalizedProvider;
  activeProviders[normalizedChannel] = normalizedProvider;
  return {
    channel: normalizedChannel,
    provider: normalizedProvider,
    changed,
  };
}

function setStoredProvider(channel, provider) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedProvider = normalizeProvider(normalizedChannel, provider);
  if (normalizedChannel === PROVIDER_CHANNELS.CALL && normalizedProvider === "call_e" && !isCallESelectionReady(config.callE)) {
    throw new Error("CALL-E cannot be stored as the selected provider until its pilot gates are ready");
  }
  const changed = storedProviders[normalizedChannel] !== normalizedProvider;
  storedProviders[normalizedChannel] = normalizedProvider;
  return {
    channel: normalizedChannel,
    provider: normalizedProvider,
    changed,
  };
}

function getActiveCallProvider() {
  return getActiveProvider(PROVIDER_CHANNELS.CALL);
}

function getActiveSmsProvider() {
  return getActiveProvider(PROVIDER_CHANNELS.SMS);
}

function getActiveEmailProvider() {
  return getActiveProvider(PROVIDER_CHANNELS.EMAIL);
}

function getStoredCallProvider() {
  return getStoredProvider(PROVIDER_CHANNELS.CALL);
}

function getStoredSmsProvider() {
  return getStoredProvider(PROVIDER_CHANNELS.SMS);
}

function getStoredEmailProvider() {
  return getStoredProvider(PROVIDER_CHANNELS.EMAIL);
}

function setActiveCallProvider(provider) {
  return setActiveProvider(PROVIDER_CHANNELS.CALL, provider);
}

function setActiveSmsProvider(provider) {
  return setActiveProvider(PROVIDER_CHANNELS.SMS, provider);
}

function setActiveEmailProvider(provider) {
  return setActiveProvider(PROVIDER_CHANNELS.EMAIL, provider);
}

function setStoredCallProvider(provider) {
  return setStoredProvider(PROVIDER_CHANNELS.CALL, provider);
}

function setStoredSmsProvider(provider) {
  return setStoredProvider(PROVIDER_CHANNELS.SMS, provider);
}

function setStoredEmailProvider(provider) {
  return setStoredProvider(PROVIDER_CHANNELS.EMAIL, provider);
}

module.exports = {
  PROVIDER_CHANNELS,
  SUPPORTED_CALL_PROVIDERS: SUPPORTED_PROVIDERS[PROVIDER_CHANNELS.CALL],
  SUPPORTED_SMS_PROVIDERS: SUPPORTED_PROVIDERS[PROVIDER_CHANNELS.SMS],
  SUPPORTED_EMAIL_PROVIDERS: SUPPORTED_PROVIDERS[PROVIDER_CHANNELS.EMAIL],
  getSupportedProviders,
  normalizeChannel,
  normalizeProvider,
  getActiveProvider,
  getStoredProvider,
  setActiveProvider,
  setStoredProvider,
  getActiveCallProvider,
  getActiveSmsProvider,
  getActiveEmailProvider,
  getStoredCallProvider,
  getStoredSmsProvider,
  getStoredEmailProvider,
  setActiveCallProvider,
  setActiveSmsProvider,
  setActiveEmailProvider,
  setStoredCallProvider,
  setStoredSmsProvider,
  setStoredEmailProvider,
  isCallESelectionReady,
};
