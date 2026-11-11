"use strict";

class CartesiaVoiceAdapter {
  constructor(options = {}) {
    if (typeof options.createOutboundCall !== "function") {
      throw new Error("CartesiaVoiceAdapter requires an outbound call handler");
    }
    this.createOutboundCallHandler = options.createOutboundCall;
    this.capabilities = Object.freeze(["managed_agent_outbound_call"]);
  }

  async createOutboundCall(request = {}) {
    const result = await this.createOutboundCallHandler(request);
    const providerCallId = String(result?.providerCallId || "").trim();
    return {
      callId: providerCallId,
      providerCallId,
      status: result?.status || "queued",
      metadata: {
        idempotentReplay: result?.idempotentReplay === true,
      },
    };
  }
}

module.exports = CartesiaVoiceAdapter;
