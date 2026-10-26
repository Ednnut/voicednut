const { toCanonicalCallStatus } = require("./providerFlowPolicy");

const VOICE_PROVIDER_OPERATIONS = Object.freeze({
  OUTBOUND_CREATE: "outbound_call.create",
  ACTIVE_CALL_TERMINATE: "call.active_terminate",
});

function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeProviderResult(provider, result = {}) {
  const normalizedProvider = normalizeProviderName(provider) || "unknown";
  const callId = String(result.callId || result.call_id || "").trim();
  if (!callId) {
    throw new Error(`Voice provider ${normalizedProvider} returned no local call ID`);
  }
  const rawStatus = String(result.status || "queued").trim().toLowerCase();
  const status = /^[a-z0-9_-]{1,64}$/.test(rawStatus) ? rawStatus : "unknown";
  const metadata =
    result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
      ? { ...result.metadata }
      : {};
  return Object.freeze({
    provider: normalizedProvider,
    channel: "call",
    operation: VOICE_PROVIDER_OPERATIONS.OUTBOUND_CREATE,
    submissionState: "accepted",
    callId,
    status: status || "queued",
    canonicalStatus: toCanonicalCallStatus(normalizedProvider, status) || "unknown",
    providerCallId: String(result.providerCallId || result.provider_call_id || "").trim() || null,
    metadata,
  });
}

function normalizeProviderOperationError(providerName, operation, error) {
  const provider = normalizeProviderName(providerName) || "unknown";
  const normalizedOperation = String(operation || "").trim().toLowerCase();
  const suppliedState = String(error?.providerSubmissionState || "").trim().toLowerCase();
  const submissionState = ["not_submitted", "rejected", "unknown"].includes(suppliedState)
    ? suppliedState
    : "unknown";
  const suppliedCode = String(error?.code || "").trim().toLowerCase();
  const code = /^[a-z][a-z0-9_]{0,79}$/.test(suppliedCode)
    ? suppliedCode
    : "provider_operation_failed";
  const statusCode = Number(error?.statusCode || error?.status);
  return Object.freeze({
    provider,
    channel: "call",
    operation: /^[a-z][a-z0-9_.-]{0,79}$/.test(normalizedOperation) ? normalizedOperation : "unknown",
    code,
    statusCode: Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : null,
    submissionState,
    retryable: error?.retryable === true,
    message: "Voice provider operation failed",
  });
}

function createUnsupportedOperationError(provider, operation) {
  const error = new Error(`Voice provider ${provider} does not support ${operation}`);
  error.code = "provider_operation_unsupported";
  error.provider = provider;
  error.operation = operation;
  error.providerSubmissionState = "not_submitted";
  return error;
}

class VoiceProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(providerName, adapter) {
    const provider = normalizeProviderName(providerName);
    if (!provider) throw new Error("Voice provider name is required");
    if (!adapter || typeof adapter !== "object") {
      throw new Error(`Voice provider ${provider} adapter is required`);
    }
    if (typeof adapter.createOutboundCall !== "function") {
      throw new Error(`Voice provider ${provider} must implement createOutboundCall`);
    }
    const capabilities = Array.isArray(adapter.capabilities) ? adapter.capabilities : [];
    this.providers.set(provider, Object.freeze({
      capabilities: Object.freeze(
        Array.from(new Set(capabilities.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))),
      ),
      createOutboundCall: adapter.createOutboundCall,
      endCall: typeof adapter.endCall === "function" ? adapter.endCall : null,
    }));
    return this;
  }

  has(providerName) {
    return this.providers.has(normalizeProviderName(providerName));
  }

  list() {
    return Array.from(this.providers.keys());
  }

  getCapabilities(providerName) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.providers.get(provider);
    return adapter ? [...adapter.capabilities] : [];
  }

  getDescriptor(providerName) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.providers.get(provider);
    if (!adapter) return null;
    return Object.freeze({
      provider,
      channel: "call",
      capabilities: Object.freeze([...adapter.capabilities]),
      operations: Object.freeze({
        [VOICE_PROVIDER_OPERATIONS.OUTBOUND_CREATE]: true,
        [VOICE_PROVIDER_OPERATIONS.ACTIVE_CALL_TERMINATE]: typeof adapter.endCall === "function",
      }),
    });
  }

  supportsOperation(providerName, operation) {
    const descriptor = this.getDescriptor(providerName);
    return descriptor?.operations?.[String(operation || "").trim().toLowerCase()] === true;
  }

  async createOutboundCall(providerName, request = {}) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.providers.get(provider);
    if (!adapter) throw new Error(`Unsupported voice provider ${provider || "(empty)"}`);
    const result = await adapter.createOutboundCall(request);
    return normalizeProviderResult(provider, result);
  }

  async endCall(providerName, request = {}) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.providers.get(provider);
    if (!adapter) throw new Error(`Unsupported voice provider ${provider || "(empty)"}`);
    if (typeof adapter.endCall !== "function") {
      throw createUnsupportedOperationError(provider, VOICE_PROVIDER_OPERATIONS.ACTIVE_CALL_TERMINATE);
    }
    return adapter.endCall(request);
  }
}

module.exports = {
  VOICE_PROVIDER_OPERATIONS,
  VoiceProviderRegistry,
  normalizeProviderResult,
  normalizeProviderOperationError,
};
