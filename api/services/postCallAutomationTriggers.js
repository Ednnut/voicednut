function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return safeObject(parsed);
  } catch (_) {
    return {};
  }
}

function normalizeText(value, max = 240) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

function normalizeStatus(value) {
  return normalizeText(value, 80).toLowerCase().replace(/[\s-]+/g, "_");
}

function isSuccessfulPaymentStatus(provider, status) {
  const normalizedProvider = normalizeStatus(provider);
  const normalizedStatus = normalizeStatus(status);
  const successByProvider = {
    stripe: new Set(["complete", "completed", "paid", "succeeded", "success"]),
    paypal: new Set(["completed", "complete", "paid", "success"]),
    square: new Set(["completed", "complete", "paid", "success"]),
  };
  const success =
    successByProvider[normalizedProvider] ||
    new Set(["completed", "complete", "paid", "succeeded", "success"]);
  return success.has(normalizedStatus);
}

function deriveCustomerFromSession(session = {}) {
  const metadata = parseJsonObject(session.metadata);
  return {
    email:
      session.customer_email ||
      session.email ||
      metadata.customer_email ||
      metadata.email ||
      metadata.contact_email ||
      "",
    phone:
      session.customer_phone ||
      session.phone ||
      metadata.customer_phone ||
      metadata.phone ||
      metadata.contact_phone ||
      "",
    name:
      session.customer_name ||
      session.name ||
      metadata.customer_name ||
      metadata.name ||
      "",
    external_id:
      session.customer_id ||
      metadata.customer_id ||
      metadata.contact_id ||
      "",
  };
}

async function resolvePaymentSession({ db, provider, result }) {
  if (!db || !result) return null;
  const resourceId = normalizeText(result.resource_id || result.resourceId, 200);
  const normalizedProvider = normalizeStatus(provider);
  if (!resourceId) return null;
  if (normalizedProvider === "stripe" && typeof db.getStripePaymentSession === "function") {
    return db.getStripePaymentSession(resourceId).catch(() => null);
  }
  if (normalizedProvider === "paypal" && typeof db.getPaypalPaymentSession === "function") {
    return db.getPaypalPaymentSession(resourceId).catch(() => null);
  }
  if (normalizedProvider === "square") {
    if (typeof db.getSquarePaymentSession === "function") {
      const direct = await db.getSquarePaymentSession(resourceId).catch(() => null);
      if (direct) return direct;
    }
    if (typeof db.findSquarePaymentSessionByRelatedId === "function") {
      return db.findSquarePaymentSessionByRelatedId(resourceId).catch(() => null);
    }
  }
  return null;
}

function buildPaymentAutomationPayload({ provider, result, session }) {
  const normalizedProvider = normalizeStatus(provider);
  const eventId = normalizeText(result?.event_id || result?.eventId, 200);
  const resourceId = normalizeText(result?.resource_id || result?.resourceId, 200);
  const status = normalizeText(result?.status, 80);
  const sessionMetadata = parseJsonObject(session?.metadata);
  const callSid =
    normalizeText(session?.call_sid || session?.callSid, 160) ||
    normalizeText(result?.call_sid || result?.callSid, 160) ||
    normalizeText(result?.normalized_event?.call_sid || result?.normalized_event?.callSid, 160);
  const customer = deriveCustomerFromSession(session || {});
  return {
    trigger_event: "payment_succeeded",
    call_sid: callSid || null,
    idempotency_key: `payment:${normalizedProvider}:${eventId || resourceId || status || "unknown"}`,
    payment_state: "paid",
    payment_status: status,
    payment_provider: normalizedProvider,
    payment_event_type: normalizeText(result?.event_type || result?.eventType, 160),
    payment_resource_id: resourceId,
    customer,
    contact: customer,
    metadata: {
      provider: normalizedProvider,
      event_id: eventId || null,
      event_type: normalizeText(result?.event_type || result?.eventType, 160) || null,
      resource_id: resourceId || null,
      payment_status: status || null,
      payment_session_id: session?.session_id || session?.id || null,
    },
    context: {
      ...sessionMetadata,
      payment_state: "paid",
      payment_status: status,
      payment_provider: normalizedProvider,
      payment_event_type: normalizeText(result?.event_type || result?.eventType, 160),
      payment_resource_id: resourceId,
    },
    variables: {
      payment_provider: normalizedProvider,
      payment_status: status,
      payment_resource_id: resourceId,
    },
  };
}

function buildCallCompletionAutomationPayload({
  callSid,
  call,
  transcripts,
  summary,
  finalStatus,
  notificationType,
  duration,
}) {
  const callRecord = safeObject(call);
  const transcriptRows = Array.isArray(transcripts) ? transcripts : [];
  const summaryObject = safeObject(summary);
  const transcriptSummary =
    normalizeText(summaryObject.summary, 2000) ||
    normalizeText(callRecord.call_summary || callRecord.summary, 2000);
  const customer = {
    email: callRecord.customer_email || callRecord.email || "",
    phone: callRecord.phone_number || callRecord.from_number || callRecord.to_number || "",
    name: callRecord.victim_name || callRecord.customer_name || callRecord.name || "",
    external_id: callRecord.customer_id || callRecord.contact_id || "",
  };
  return {
    trigger_event: "post_call_completed",
    call_sid: callSid,
    idempotency_key: `call-completed:${callSid}`,
    call_outcome: finalStatus,
    outcome: finalStatus,
    transcript_summary: transcriptSummary,
    summary: transcriptSummary,
    customer,
    contact: customer,
    call: {
      call_sid: callSid,
      status: finalStatus || callRecord.status || callRecord.twilio_status || null,
      phone_number: callRecord.phone_number || null,
      user_chat_id: callRecord.user_chat_id || null,
      started_at: callRecord.started_at || callRecord.created_at || null,
      ended_at: callRecord.ended_at || null,
      duration: duration || callRecord.duration || null,
      summary: transcriptSummary,
    },
    metadata: {
      notification_type: notificationType || null,
      duration_seconds: duration || null,
      transcript_count: transcriptRows.length,
      has_transcript: transcriptRows.some((entry) =>
        Boolean(normalizeText(entry?.message || entry?.text, 1)),
      ),
    },
    context: {
      call_sid: callSid,
      call_outcome: finalStatus,
      outcome: finalStatus,
      notification_type: notificationType,
      duration_seconds: duration,
      transcript_count: transcriptRows.length,
      transcript_summary: transcriptSummary,
    },
    variables: {
      call_sid: callSid,
      call_outcome: finalStatus,
      duration_seconds: duration,
      transcript_summary: transcriptSummary,
    },
  };
}

async function runPostCallAutomationTrigger({
  service,
  webhookService,
  db,
  logger = console,
  payload,
  callSid,
}) {
  const effectiveCallSid = normalizeText(callSid || payload?.call_sid || payload?.callSid, 160);
  if (!service || typeof service.evaluateAndRun !== "function") {
    return { ok: false, skipped: true, reason: "service_unavailable" };
  }
  try {
    const result = await service.evaluateAndRun(payload || {});
    if (effectiveCallSid && db && typeof db.updateCallState === "function") {
      await db
        .updateCallState(effectiveCallSid, "post_call_automation_completed", {
          trigger_event: result.trigger_event || payload?.trigger_event || null,
          matched: Number(result.matched) || 0,
          runs: Array.isArray(result.runs)
            ? result.runs.map((run) => ({
                run_id: run.run_id,
                rule_id: run.rule_id,
                status: run.status,
                deduped: run.deduped === true,
              }))
            : [],
          at: new Date().toISOString(),
        })
        .catch(() => {});
    }
    if (effectiveCallSid && webhookService && typeof webhookService.addLiveEvent === "function") {
      const matched = Number(result.matched) || 0;
      webhookService.addLiveEvent(
        effectiveCallSid,
        matched > 0
          ? `Automation ran ${matched} rule${matched === 1 ? "" : "s"}`
          : "Automation checked: no matching rules",
        { force: matched > 0 },
      );
    }
    return { ok: true, result };
  } catch (error) {
    logger?.error?.("post_call_automation_trigger_failed", {
      call_sid: effectiveCallSid || null,
      trigger_event: payload?.trigger_event || null,
      error: error?.message || "automation_failed",
    });
    if (effectiveCallSid && db && typeof db.updateCallState === "function") {
      await db
        .updateCallState(effectiveCallSid, "post_call_automation_failed", {
          trigger_event: payload?.trigger_event || null,
          error: error?.message || "automation_failed",
          at: new Date().toISOString(),
        })
        .catch(() => {});
    }
    if (effectiveCallSid && webhookService && typeof webhookService.addLiveEvent === "function") {
      webhookService.addLiveEvent(effectiveCallSid, "Automation failed", { force: true });
    }
    return { ok: false, error: error?.message || "automation_failed" };
  }
}

async function maybeRunPaymentAutomation({ provider, result, ctx = {}, logger = console }) {
  if (!result?.ok || result.duplicate === true) {
    return { ok: false, skipped: true, reason: "ignored_payment_event" };
  }
  if (!isSuccessfulPaymentStatus(provider, result.status)) {
    return { ok: false, skipped: true, reason: "non_success_payment_status" };
  }
  const db = typeof ctx.getDb === "function" ? ctx.getDb() : ctx.db;
  const session = await resolvePaymentSession({ db, provider, result });
  const payload = buildPaymentAutomationPayload({ provider, result, session });
  if (!payload.call_sid) {
    logger?.warn?.("post_call_payment_automation_skipped", {
      provider: normalizeStatus(provider),
      resource_id: payload.payment_resource_id || null,
      reason: "missing_call_sid",
    });
    return { ok: false, skipped: true, reason: "missing_call_sid" };
  }
  return runPostCallAutomationTrigger({
    service: ctx.postCallAutomationService,
    webhookService: ctx.webhookService,
    db,
    logger,
    payload,
    callSid: payload.call_sid,
  });
}

module.exports = {
  buildCallCompletionAutomationPayload,
  buildPaymentAutomationPayload,
  isSuccessfulPaymentStatus,
  maybeRunPaymentAutomation,
  resolvePaymentSession,
  runPostCallAutomationTrigger,
};
