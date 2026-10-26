function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeProviderResult(provider, result = {}) {
  const callId = String(result.callId || result.call_id || "").trim();
  if (!callId) {
    throw new Error(`Voice provider ${provider} returned no local call ID`);
  }
  const status = String(result.status || "queued").trim().toLowerCase();
  const metadata =
    result.metadata && typeof result.metadata === "object" && !Array.isArray(result.metadata)
      ? { ...result.metadata }
      : {};
  return Object.freeze({
    provider,
    callId,
    status: status || "queued",
    providerCallId: String(result.providerCallId || result.provider_call_id || "").trim() || null,
    metadata,
  });
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
    if (typeof adapter.endCall !== "function") {
      throw new Error(`Voice provider ${provider} must implement endCall`);
    }
    this.providers.set(provider, Object.freeze({
      capabilities: Object.freeze(
        Array.from(new Set((adapter.capabilities || []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))),
      ),
      createOutboundCall: adapter.createOutboundCall,
      endCall: adapter.endCall,
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
    return adapter.endCall(request);
  }
}

module.exports = {
  VoiceProviderRegistry,
  normalizeProviderResult,
};
