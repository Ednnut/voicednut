const { toCanonicalCallStatus } = require("./providerFlowPolicy");

const VOICE_PROVIDER_OPERATIONS = Object.freeze({
  OUTBOUND_CREATE: "outbound_call.create",
  OUTBOUND_TASK_CREATE: "outbound_task.create",
  OUTBOUND_TASK_CANCEL: "outbound_task.cancel_before_submission",
  CALL_READ: "call.read",
  CALL_EVENTS_READ: "call.events.read",
  ACTIVE_CALL_TERMINATE: "call.active_terminate",
});

function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeProviderResult(provider, result = {}, operation = VOICE_PROVIDER_OPERATIONS.OUTBOUND_CREATE) {
  const normalizedProvider = normalizeProviderName(provider) || "unknown";
  const callId = String(result.callId || result.call_id || result.localCallId || "").trim();
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
    operation,
    submissionState: "accepted",
    callId,
    status: status || "queued",
    canonicalStatus: toCanonicalCallStatus(normalizedProvider, status) || "unknown",
    providerCallId: String(result.providerCallId || result.provider_call_id || "").trim() || null,
    ...(result.localCallId ? { localCallId: callId } : {}),
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

function canFailoverAfterProviderError(error) {
  return ["not_submitted", "rejected"].includes(
    String(error?.providerSubmissionState || "").trim().toLowerCase(),
  );
}

function createPreflightError(report) {
  const error = new Error(
    report.reason === "provider_not_registered"
      ? `Unsupported voice provider ${report.provider || "(empty)"}`
      : `Voice provider ${report.provider} does not support ${report.operation}`,
  );
  error.code = report.reason;
  error.provider = report.provider;
  error.operation = report.operation;
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
    if (["createOutboundCall", "createTaskCall", "getCall", "listCallEvents"].every((key) => typeof adapter[key] !== "function")) {
      throw new Error(`Voice provider ${provider} must implement at least one provider operation`);
    }
    const capabilities = Array.isArray(adapter.capabilities) ? adapter.capabilities : [];
    this.providers.set(provider, Object.freeze({
      capabilities: Object.freeze(
        Array.from(new Set(capabilities.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))),
      ),
      createOutboundCall: typeof adapter.createOutboundCall === "function" ? adapter.createOutboundCall.bind(adapter) : null,
      createTaskCall: typeof adapter.createTaskCall === "function" ? adapter.createTaskCall.bind(adapter) : null,
      cancelTaskCall: typeof adapter.cancelTaskCall === "function" ? adapter.cancelTaskCall.bind(adapter) : null,
      getCall: typeof adapter.getCall === "function" ? adapter.getCall.bind(adapter) : null,
      listCallEvents: typeof adapter.listCallEvents === "function" ? adapter.listCallEvents.bind(adapter) : null,
      endCall: typeof adapter.endCall === "function" ? adapter.endCall.bind(adapter) : null,
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
        [VOICE_PROVIDER_OPERATIONS.OUTBOUND_CREATE]: typeof adapter.createOutboundCall === "function",
        [VOICE_PROVIDER_OPERATIONS.OUTBOUND_TASK_CREATE]: typeof adapter.createTaskCall === "function",
        [VOICE_PROVIDER_OPERATIONS.OUTBOUND_TASK_CANCEL]: typeof adapter.cancelTaskCall === "function",
        [VOICE_PROVIDER_OPERATIONS.CALL_READ]: typeof adapter.getCall === "function",
        [VOICE_PROVIDER_OPERATIONS.CALL_EVENTS_READ]: typeof adapter.listCallEvents === "function",
        [VOICE_PROVIDER_OPERATIONS.ACTIVE_CALL_TERMINATE]: typeof adapter.endCall === "function",
      }),
    });
  }

  preflightOperation(providerName, operation) {
    const provider = normalizeProviderName(providerName);
    const normalizedOperation = String(operation || "").trim().toLowerCase();
    const knownOperation = Object.values(VOICE_PROVIDER_OPERATIONS).includes(normalizedOperation);
    const descriptor = this.getDescriptor(provider);
    const reason = !descriptor
      ? "provider_not_registered"
      : !knownOperation
        ? "provider_operation_unknown"
        : descriptor.operations[normalizedOperation] === true
          ? null
          : "provider_operation_unsupported";
    return Object.freeze({
      ok: reason === null,
      provider: provider || null,
      operation: normalizedOperation || null,
      reason,
    });
  }

  requireOperation(providerName, operation) {
    const report = this.preflightOperation(providerName, operation);
    if (!report.ok) throw createPreflightError(report);
    return this.providers.get(report.provider);
  }

  supportsOperation(providerName, operation) {
    const descriptor = this.getDescriptor(providerName);
    return descriptor?.operations?.[String(operation || "").trim().toLowerCase()] === true;
  }

  async createOutboundCall(providerName, request = {}) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.requireOperation(provider, VOICE_PROVIDER_OPERATIONS.OUTBOUND_CREATE);
    const result = await adapter.createOutboundCall(request);
    return normalizeProviderResult(provider, result);
  }

  async createTaskCall(providerName, request = {}) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.requireOperation(provider, VOICE_PROVIDER_OPERATIONS.OUTBOUND_TASK_CREATE);
    const result = await adapter.createTaskCall(request);
    return normalizeProviderResult(provider, result, VOICE_PROVIDER_OPERATIONS.OUTBOUND_TASK_CREATE);
  }

  async cancelTaskCall(providerName, request = {}) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.requireOperation(provider, VOICE_PROVIDER_OPERATIONS.OUTBOUND_TASK_CANCEL);
    return adapter.cancelTaskCall(request);
  }

  async getCall(providerName, request = {}) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.requireOperation(provider, VOICE_PROVIDER_OPERATIONS.CALL_READ);
    return adapter.getCall(request);
  }

  async listCallEvents(providerName, request = {}) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.requireOperation(provider, VOICE_PROVIDER_OPERATIONS.CALL_EVENTS_READ);
    return adapter.listCallEvents(request);
  }

  async endCall(providerName, request = {}) {
    const provider = normalizeProviderName(providerName);
    const adapter = this.requireOperation(provider, VOICE_PROVIDER_OPERATIONS.ACTIVE_CALL_TERMINATE);
    return adapter.endCall(request);
  }
}

module.exports = {
  VOICE_PROVIDER_OPERATIONS,
  VoiceProviderRegistry,
  normalizeProviderResult,
  normalizeProviderOperationError,
  canFailoverAfterProviderError,
};
