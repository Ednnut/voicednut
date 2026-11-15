class CartesiaVoiceAdapter {
  constructor(options = {}) {
    if (typeof options.createOutboundCall !== "function") {
      throw new Error("CartesiaVoiceAdapter requires an outbound call handler");
    }
    this.createOutboundCallHandler = options.createOutboundCall;
    this.capabilities = Object.freeze(["outbound_voice"]);
  }

  async createOutboundCall(request = {}) {
    // The injected orchestration handler owns authorization, durable local-call
    // persistence and submission recovery. Never substitute a provider ID here.
    const result = await this.createOutboundCallHandler(request);
    const localCallId = typeof result?.localCallId === "string" ? result.localCallId.trim() : "";
    const providerCallId = typeof result?.providerCallId === "string" ? result.providerCallId.trim() : "";
    if (!localCallId || !providerCallId || localCallId === providerCallId) {
      const error = new Error("Cartesia outbound result requires distinct local and provider call IDs");
      error.code = "cartesia_call_outcome_unknown";
      error.provider = "cartesia";
      error.providerSubmissionState = "unknown";
      throw error;
    }
    return {
      ...result,
      callId: localCallId,
      localCallId,
      providerCallId,
      metadata: { idempotentReplay: result.idempotentReplay === true },
    };
  }
}

module.exports = CartesiaVoiceAdapter;