class CallEVoiceAdapter {
  constructor(options = {}) {
    if (typeof options.createTaskCall !== "function") {
      throw new Error("CallEVoiceAdapter requires a task call handler");
    }
    this.createTaskCallHandler = options.createTaskCall;
    this.cancelTaskCallHandler = typeof options.cancelTaskCall === "function" ? options.cancelTaskCall : null;
    this.getCallHandler = typeof options.getCall === "function" ? options.getCall : null;
    this.listCallEventsHandler = typeof options.listCallEvents === "function" ? options.listCallEvents : null;
    this.capabilities = Object.freeze([
      "outbound_task",
      ...(this.cancelTaskCallHandler ? ["cancel_before_submission"] : []),
      ...(this.getCallHandler ? ["call_status", "transcript", "structured_result", "outcome"] : []),
      ...(this.listCallEventsHandler ? ["event_history"] : []),
    ]);
  }

  async createTaskCall(request = {}) {
    return this.createTaskCallHandler(request);
  }

  async cancelTaskCall(request = {}) {
    if (!this.cancelTaskCallHandler) {
      const error = new Error("CALL-E task cancellation is unavailable");
      error.code = "provider_operation_unsupported";
      error.provider = "call_e";
      error.operation = "outbound_task.cancel_before_submission";
      error.providerSubmissionState = "not_submitted";
      throw error;
    }
    return this.cancelTaskCallHandler(request);
  }

  async getCall(request = {}) {
    if (!this.getCallHandler) throw new Error("CALL-E status reads are unavailable");
    return this.getCallHandler(request);
  }

  async listCallEvents(request = {}) {
    if (!this.listCallEventsHandler) throw new Error("CALL-E event reads are unavailable");
    return this.listCallEventsHandler(request);
  }
}

module.exports = CallEVoiceAdapter;
