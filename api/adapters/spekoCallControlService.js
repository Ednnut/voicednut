const { SpekoAdapterError, isE164 } = require("./spekoVoiceAdapter");

const CONTROL_ID_MAX_LENGTH = 512;

function requiredIdentifier(value, code, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > CONTROL_ID_MAX_LENGTH) {
    throw new SpekoAdapterError(`A valid Speko ${label} is required`, {
      code,
      status: 400,
    });
  }
  return normalized;
}

class SpekoCallControlService {
  constructor(options = {}) {
    this.config = options.config || options.voiceAdapter?.config || {};
    this.voiceAdapter = options.voiceAdapter;
    this.store = options.store || null;
    if (!this.voiceAdapter || typeof this.voiceAdapter.getClient !== "function") {
      throw new Error("SpekoCallControlService requires the shared Speko SDK client adapter");
    }
  }

  async getClient() {
    this.validateConfig();
    return this.voiceAdapter.getClient();
  }

  validateConfig(options = {}) {
    if (typeof this.voiceAdapter.validateApiConfig === "function") {
      this.voiceAdapter.validateApiConfig();
    } else {
      this.voiceAdapter.validateConfig({ requireWebhook: false, requireAgent: false });
    }
    if (this.config.callControlEnabled !== true) {
      throw new SpekoAdapterError("Speko call control is disabled", {
        code: "speko_call_control_disabled",
        status: 403,
      });
    }
    if (options.requireBroker === true && !String(this.config.brokerId || "").trim()) {
      throw new SpekoAdapterError("Speko broker ID is not configured", {
        code: "speko_missing_broker_id",
        status: 400,
      });
    }
  }

  async runAudited(operation, identifiers, context, callback) {
    let auditId = null;
    if (this.store?.startSpekoHumanCallControlAudit) {
      auditId = await this.store.startSpekoHumanCallControlAudit({
        operation, call_id: identifiers?.callId, control_id: identifiers?.controlId,
        actor_hint: context?.actorId, actor_source: context?.actorSource,
        request_id: context?.requestId,
      });
    }
    try {
      const result = await callback();
      if (auditId != null) {
        const callId = result?.call?.id || result?.id;
        await this.store.finishSpekoHumanCallControlAudit({
          id: auditId, status: "succeeded", ...(callId ? { call_id: callId } : {}),
        }).catch(() => {});
      }
      return result;
    } catch (error) {
      if (auditId != null) await this.store.finishSpekoHumanCallControlAudit({
        id: auditId, status: "failed", error_code: error?.code || "speko_call_control_failed",
      }).catch(() => {});
      throw error;
    }
  }

  async dial(params = {}, auditContext = {}) {
    this.validateConfig({ requireBroker: true });
    if (!isE164(params.to)) {
      throw new SpekoAdapterError("Destination must be a valid E.164 number", {
        code: "speko_invalid_destination",
        status: 400,
      });
    }
    if (params.from !== undefined && !isE164(params.from)) {
      throw new SpekoAdapterError("Caller ID must be a valid E.164 number", {
        code: "speko_invalid_phone_number",
        status: 400,
      });
    }
    const client = await this.getClient();
    return this.runAudited("dial", {}, auditContext, async () => {
    let result;
    try {
      result = await client.callControl.dial({
        to: String(params.to).trim(),
        ...(params.from ? { from: String(params.from).trim() } : {}),
        ...(params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
          ? { metadata: params.metadata }
          : {}),
      });
    } catch (error) {
      const status = Number(error?.status);
      const rejected = Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;
      if (rejected) throw error;
      throw new SpekoAdapterError("Speko human call creation outcome is unknown; check call history before retrying", {
        code: "speko_human_dial_uncertain", status: 503, uncertain: true, cause: error,
      });
    }
    await this.persistCall(result?.call || result);
    return result;
    });
  }

  async persistCall(call) {
    if (!this.store?.saveSpekoHumanCall) return;
    try { await this.store.saveSpekoHumanCall({ call }); }
    catch (cause) {
      throw new SpekoAdapterError("Speko call was created but could not be stored", {
        code: "speko_call_mapping_persistence_failed", status: 503, uncertain: true, cause,
      });
    }
  }

  async getCall(callId) {
    const client = await this.getClient();
    const call = await client.callControl.get(
      requiredIdentifier(callId, "speko_missing_call_id", "call ID"),
    );
    await this.persistCall(call);
    return call;
  }

  async listCalls(params = {}) {
    const client = await this.getClient();
    const allowed = {};
    for (const key of ["status", "direction", "brokerId"]) {
      if (typeof params[key] === "string" && params[key].trim()) {
        allowed[key] = params[key].trim().slice(0, CONTROL_ID_MAX_LENGTH);
      }
    }
    if (params.limit !== undefined) {
      const limit = Number(params.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new SpekoAdapterError("Speko call list limit must be between 1 and 100", {
          code: "speko_invalid_call_list_limit",
          status: 400,
        });
      }
      allowed.limit = limit;
    }
    const result = await client.callControl.list(allowed);
    for (const call of result?.calls || []) await this.persistCall(call);
    return result;
  }

  async getCallEvents(callId) {
    const client = await this.getClient();
    const events = await client.callControl.events(
      requiredIdentifier(callId, "speko_missing_call_id", "call ID"),
    );
    await this.persistEvents(events?.events || [], "history");
    return events;
  }

  async persistEvents(events, source) {
    if (!this.store?.recordSpekoHumanCallEvent) return;
    for (const event of events) {
      const safe = {};
      for (const key of ["status", "mode", "transfer_id", "failure_cause", "reason"]) {
        if (event?.payload?.[key] != null) safe[key] = event.payload[key];
      }
      await this.store.recordSpekoHumanCallEvent({
        event_id: event?.id, call_id: event?.callId, control_id: event?.controlId,
        event_type: event?.type, occurred_at: event?.occurredAt, source, details: safe,
      });
    }
  }

  async reconcileCallEvents(callId) {
    const id = requiredIdentifier(callId, "speko_missing_call_id", "call ID");
    const client = await this.getClient();
    const [call, history] = await Promise.all([client.callControl.get(id), client.callControl.events(id)]);
    await this.persistCall(call);
    await this.persistEvents(history?.events || [], "history");
    return { call, events: history?.events || [] };
  }

  async refreshCallsForBroker(brokerId, limit = 100) {
    const result = await this.listCalls({ brokerId, limit });
    return result?.calls || [];
  }

  async getPresenceToken() {
    this.validateConfig({ requireBroker: true });
    const client = await this.getClient();
    return client.callControl.presenceToken();
  }

  async join(controlId) {
    this.validateConfig({ requireBroker: true });
    await this.requireKnownLeg(controlId);
    const client = await this.getClient();
    return client.callControl.join(
      requiredIdentifier(controlId, "speko_missing_control_id", "control ID"),
    );
  }

  async requireKnownLeg(controlId) {
    if (!this.store?.getSpekoHumanCallLeg) return;
    const leg = await this.store.getSpekoHumanCallLeg({ control_id: requiredIdentifier(controlId, "speko_missing_control_id", "control ID") });
    if (!leg) throw new SpekoAdapterError("Speko call leg is not recorded", { code: "speko_call_leg_not_found", status: 404 });
    return leg;
  }

  async command(command, controlId, params = {}, auditContext = {}) {
    const client = await this.getClient();
    const normalizedControlId = requiredIdentifier(
      controlId,
      "speko_missing_control_id",
      "control ID",
    );
    const leg = await this.requireKnownLeg(normalizedControlId);
    const supported = new Set([
      "answer",
      "hangup",
      "bridge",
      "hold",
      "unhold",
      "mute",
      "unmute",
      "dtmf",
      "transfer",
    ]);
    if (!supported.has(command)) {
      throw new SpekoAdapterError("Unsupported Speko call-control command", {
        code: "speko_call_control_unsupported",
        status: 400,
      });
    }
    return this.runAudited(command, { callId: leg?.call_id, controlId: normalizedControlId }, auditContext, async () => {
    if (command === "dtmf") {
      if (!/^[0-9*#,w]{1,64}$/.test(String(params.digits || ""))) {
        throw new SpekoAdapterError("Invalid Speko DTMF digits", {
          code: "speko_invalid_dtmf",
          status: 400,
        });
      }
      return client.callControl.dtmf(normalizedControlId, {
        digits: String(params.digits),
      });
    }
    if (command === "transfer") {
      const destination = String(params.to || "").trim();
      if (
        typeof params.to !== "string" ||
        !destination ||
        destination.length > CONTROL_ID_MAX_LENGTH ||
        /[\u0000-\u001f\u007f]/.test(destination) ||
        !["blind", "warm"].includes(params.mode)
      ) {
        throw new SpekoAdapterError("Speko transfer requires a PSTN number or broker leg and a valid mode", {
          code: "speko_invalid_transfer",
          status: 400,
        });
      }
      return client.callControl.transfer(normalizedControlId, {
        to: destination,
        mode: params.mode,
      });
    }
    if (command === "bridge") {
      const bridgeTo = requiredIdentifier(
        params.bridgeTo,
        "speko_invalid_bridge_target",
        "bridge target",
      );
      return client.callControl.bridge(normalizedControlId, { bridgeTo });
    }
    if (command === "hangup") {
      return client.callControl.hangup(normalizedControlId, params.reason
        ? { reason: String(params.reason).slice(0, 240) }
        : {});
    }
    return client.callControl[command](normalizedControlId);
    });
  }

  async setStatus(status, auditContext = {}) {
    this.validateConfig({ requireBroker: true });
    if (!["available", "busy", "away", "offline"].includes(status)) {
      throw new SpekoAdapterError("Invalid Speko presence status", {
        code: "speko_invalid_presence_status",
        status: 400,
      });
    }
    const client = await this.getClient();
    return this.runAudited("presence_status", {}, auditContext, () => client.callControl.setStatus(status));
  }

  async register(auditContext = {}) {
    this.validateConfig({ requireBroker: true });
    const client = await this.getClient();
    return this.runAudited("presence_register", {}, auditContext, () => client.callControl.register());
  }

  async heartbeat() {
    this.validateConfig({ requireBroker: true });
    const client = await this.getClient();
    return client.callControl.heartbeat();
  }
}

module.exports = { SpekoCallControlService };
