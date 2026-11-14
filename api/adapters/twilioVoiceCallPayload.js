function buildTwilioOutboundCallPayload(options = {}) {
  const host = String(options.host || "").trim();
  const to = String(options.to || "").trim();
  const from = String(options.from || "").trim();
  const callSid = String(options.callSid || "").trim();
  if (!host) {
    throw new Error("Twilio outbound payload requires host");
  }
  if (!to) {
    throw new Error("Twilio outbound payload requires destination number");
  }
  if (!from) {
    throw new Error("Twilio outbound payload requires source number");
  }
  const callbackQuery = callSid ? `?callSid=${encodeURIComponent(callSid)}` : "";
  const payload = {
    url: `https://${host}/incoming${callbackQuery}`,
    to,
    from,
    statusCallback: `https://${host}/webhook/call-status${callbackQuery}`,
    statusCallbackEvent: [
      "initiated",
      "ringing",
      "answered",
      "completed",
      "busy",
      "no-answer",
      "canceled",
      "failed",
    ],
    statusCallbackMethod: "POST",
  };
  if (options.machineDetection) {
    payload.machineDetection = options.machineDetection;
  }
  if (Number.isFinite(Number(options.machineDetectionTimeout))) {
    payload.machineDetectionTimeout = Number(options.machineDetectionTimeout);
  }
  return payload;
}

module.exports = { buildTwilioOutboundCallPayload };
