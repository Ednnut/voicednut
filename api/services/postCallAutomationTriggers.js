const { transitionExecutionContext } = require("./executionContext");

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
    business_id: normalizeText(session?.business_id, 120) || null,
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
    business_id: normalizeText(callRecord.business_id || callRecord.businessId, 120) || null,
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

function buildPostCallOutcomeClassificationPayload({ callSid, businessId, finalStatus, notificationType }) {
  const normalizedCallSid = normalizeText(callSid, 160);
  if (!normalizedCallSid) return null;
  const callOutcome = normalizeText(finalStatus, 80).toLowerCase().replace(/[\s-]+/g, "_");
  const outcomeClassification = {
    completed: "completed",
    no_answer: "not_connected",
    busy: "not_connected",
    declined: "not_connected",
    failed: "failed",
    canceled: "canceled",
  }[callOutcome] || "unknown";
  return {
    trigger_event: "post_call_outcome_classified",
    business_id: normalizeText(businessId, 120) || null,
    call_sid: normalizedCallSid,
    idempotency_key: `call-outcome-classified:${normalizedCallSid}`,
    call_outcome: callOutcome || "unknown",
    outcome_classification: outcomeClassification,
    context: {
      call_sid: normalizedCallSid,
      call_outcome: callOutcome || "unknown",
      outcome_classification: outcomeClassification,
      notification_type: normalizeText(notificationType, 80) || null,
    },
  };
}

async function triggerPostCallOutcomeWebhook({ outgoingWebhookService, payload, logger = console }) {
  if (!outgoingWebhookService || typeof outgoingWebhookService.enqueueEvent !== "function" || !payload) {
    return { skipped: true, reason: "outgoing_webhook_unavailable" };
  }
  try {
    return { queued: await outgoingWebhookService.enqueueEvent(payload) };
  } catch (error) {
    const code = String(error?.code || "outgoing_webhook_enqueue_failed").trim().toLowerCase();
    const safeCode = /^[a-z][a-z0-9_.-]{0,79}$/.test(code) ? code : "outgoing_webhook_enqueue_failed";
    logger?.error?.("post_call_outcome_webhook_enqueue_failed", {
      call_sid: payload.call_sid || null, error_code: safeCode,
    });
    return { skipped: true, reason: "outgoing_webhook_enqueue_failed" };
  }
}

function buildPostCallAutomationFailurePayload({ callSid, businessId, failureStage, errorCode }) {
  const normalizedCallSid = normalizeText(callSid, 160);
  const normalizedBusinessId = normalizeText(businessId, 120);
  const stage = ["workflow_trigger", "automation_execution"].includes(failureStage) ? failureStage : null;
  const code = normalizeStatus(errorCode);
  if (!normalizedCallSid || !normalizedBusinessId || !stage) return null;
  return {
    trigger_event: "post_call_automation_failed",
    business_id: normalizedBusinessId,
    call_sid: normalizedCallSid,
    idempotency_key: `post-call-automation-failed:${normalizedCallSid}:${stage}`,
    payload: {
      failure_stage: stage,
      error_code: /^[a-z][a-z0-9_.-]{0,79}$/.test(code) ? code : "post_call_automation_failed",
    },
  };
}

async function triggerPostCallAutomationFailureWebhook({ outgoingWebhookService, payload, logger = console }) {
  if (!outgoingWebhookService || typeof outgoingWebhookService.enqueueEvent !== "function" || !payload) {
    return { skipped: true, reason: "outgoing_webhook_unavailable" };
  }
  try {
    return { queued: await outgoingWebhookService.enqueueEvent(payload) };
  } catch (error) {
    const code = normalizeStatus(error?.code || "outgoing_webhook_enqueue_failed");
    logger?.error?.("post_call_automation_failure_webhook_enqueue_failed", {
      call_sid: payload.call_sid || null,
      error_code: /^[a-z][a-z0-9_.-]{0,79}$/.test(code) ? code : "outgoing_webhook_enqueue_failed",
    });
    return { skipped: true, reason: "outgoing_webhook_enqueue_failed" };
  }
}

async function triggerPostCallOutcomeWorkflow({ workflowService, payload, logger = console }) {
  if (!workflowService || (!workflowService.enqueueEvent && !workflowService.trigger) || !payload) {
    return { skipped: true, reason: "workflow_service_unavailable" };
  }
  try {
    const enqueue = workflowService.enqueueEvent || workflowService.trigger;
    return await enqueue.call(workflowService, payload);
  } catch (error) {
    const rawCode = String(error?.code || "workflow_trigger_failed").trim().toLowerCase();
    logger?.error?.("post_call_outcome_workflow_trigger_failed", {
      call_sid: payload.call_sid || null,
      error_code: /^[a-z][a-z0-9_.-]{0,79}$/.test(rawCode) ? rawCode : "workflow_trigger_failed",
    });
    return { skipped: true, reason: "workflow_trigger_failed" };
  }
}

async function runPostCallAutomationTrigger({
  service,
  workflowService,
  outgoingWebhookService,
  webhookService,
  db,
  logger = console,
  payload,
  callSid,
}) {
  const effectiveCallSid = normalizeText(callSid || payload?.call_sid || payload?.callSid, 160);
  const hasAutomationService = service && typeof service.evaluateAndRun === "function";
  const hasWorkflowService = workflowService &&
    (typeof workflowService.trigger === "function" || typeof workflowService.enqueueEvent === "function");
  const hasOutgoingWebhookService = outgoingWebhookService && typeof outgoingWebhookService.enqueueEvent === "function";
  if (!hasAutomationService && !hasWorkflowService && !hasOutgoingWebhookService) {
    return { ok: false, skipped: true, reason: "service_unavailable" };
  }
  let triggerPayload = payload && typeof payload === "object" ? payload : {};
  if (effectiveCallSid && typeof db?.getLatestCallState === "function") {
    try {
      const createdState = await db.getLatestCallState(effectiveCallSid, "call_created");
      if (createdState?.execution_context && typeof createdState.execution_context === "object") {
        triggerPayload = {
          ...triggerPayload,
          execution_context: transitionExecutionContext(
            createdState.execution_context,
            "processing",
            { internal_call_id: effectiveCallSid, current_stage: "post_call_automation" },
          ),
        };
      }
    } catch (error) {
      logger?.warn?.("post_call_execution_context_unavailable", {
        call_sid: effectiveCallSid,
        error_code: String(error?.code || "execution_context_read_failed").slice(0, 80),
      });
    }
  }
  let workflowResult = null;
  let workflowErrorCode = null;
  if (hasWorkflowService) {
    try {
      const triggerWorkflow = workflowService.enqueueEvent || workflowService.trigger;
      workflowResult = await triggerWorkflow.call(workflowService, triggerPayload);
    } catch (error) {
      const code = String(error?.code || "workflow_trigger_failed").trim().toLowerCase();
      workflowErrorCode = /^[a-z][a-z0-9_.-]{0,79}$/.test(code) ? code : "workflow_trigger_failed";
      logger?.error?.("post_call_workflow_trigger_failed", {
        call_sid: effectiveCallSid || null,
        error_code: workflowErrorCode,
      });
    }
  }
  if (outgoingWebhookService && typeof outgoingWebhookService.enqueueEvent === "function") {
    try {
      await outgoingWebhookService.enqueueEvent(triggerPayload);
    } catch (error) {
      logger?.error?.("post_call_outgoing_webhook_enqueue_failed", {
        call_sid: effectiveCallSid || null,
        error_code: String(error?.code || "outgoing_webhook_enqueue_failed").slice(0, 80),
      });
    }
  }
  try {
    const result = hasAutomationService ? await service.evaluateAndRun(triggerPayload) : {};
    if (workflowResult?.status === "dead_letter") {
      workflowErrorCode = "workflow_event_requires_recovery";
    }
    const workflowFailed = Boolean(workflowErrorCode);
    if (effectiveCallSid && db && typeof db.updateCallState === "function") {
      await db
        .updateCallState(
          effectiveCallSid,
          workflowFailed
            ? "post_call_automation_failed"
            : workflowResult?.accepted === true
              ? "post_call_automation_queued"
              : "post_call_automation_completed",
          {
            trigger_event: result.trigger_event || triggerPayload.trigger_event || null,
            matched: Number(result.matched) || 0,
            runs: Array.isArray(result.runs)
              ? result.runs.map((run) => ({
                  run_id: run.run_id,
                  rule_id: run.rule_id,
                  status: run.status,
                  deduped: run.deduped === true,
                }))
              : [],
            workflow_matched: Number(workflowResult?.matched) || 0,
            workflow_event_id: workflowResult?.event_id || null,
            workflow_error_code: workflowErrorCode,
            workflow_runs: Array.isArray(workflowResult?.runs)
              ? workflowResult.runs.map((run) => ({
                  workflow_id: run.workflow_id,
                  workflow_version: run.workflow_version,
                  run_id: run.run_id || null,
                  status: run.status,
                  error_code: run.error_code || null,
                }))
              : [],
            at: new Date().toISOString(),
          },
        )
        .catch(() => {});
    }
    if (workflowFailed) {
      const failurePayload = buildPostCallAutomationFailurePayload({
        callSid: effectiveCallSid,
        businessId: triggerPayload.business_id,
        failureStage: "workflow_trigger",
        errorCode: workflowErrorCode,
      });
      await triggerPostCallAutomationFailureWebhook({ outgoingWebhookService, payload: failurePayload, logger });
    }
    if (effectiveCallSid && webhookService && typeof webhookService.addLiveEvent === "function") {
      const matched = Number(result.matched) || 0;
      const workflowMatched = Number(workflowResult?.matched) || 0;
      const workflowQueued = workflowResult?.accepted === true;
      const message = workflowFailed
        ? "Post-call automation needs operator review"
        : matched > 0 && workflowQueued
          ? `Automation ran ${matched} rule${matched === 1 ? "" : "s"}; workflow event queued`
          : matched > 0 && workflowMatched > 0
            ? `Automation ran ${matched} rule${matched === 1 ? "" : "s"}; started ${workflowMatched} workflow${workflowMatched === 1 ? "" : "s"}`
            : matched > 0
              ? `Automation ran ${matched} rule${matched === 1 ? "" : "s"}`
              : workflowMatched > 0
                ? `Started ${workflowMatched} workflow${workflowMatched === 1 ? "" : "s"}`
                : workflowQueued
                  ? "Workflow event queued"
                  : "Automation checked: no matching rules";
      webhookService.addLiveEvent(
        effectiveCallSid,
        message,
        { force: matched > 0 || workflowMatched > 0 || workflowQueued },
      );
    }
    return {
      ok: !workflowErrorCode,
      result,
      workflow_result: workflowResult,
      ...(workflowErrorCode ? { error_code: workflowErrorCode } : {}),
    };
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
    const failurePayload = buildPostCallAutomationFailurePayload({
      callSid: effectiveCallSid,
      businessId: triggerPayload.business_id,
      failureStage: "automation_execution",
      errorCode: "post_call_automation_failed",
    });
    await triggerPostCallAutomationFailureWebhook({ outgoingWebhookService, payload: failurePayload, logger });
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
  let scopedSession = session;
  const linkedCallSid = normalizeText(session?.call_sid || session?.callSid, 160);
  if (linkedCallSid && typeof db?.getCall === "function") {
    const call = await db.getCall(linkedCallSid).catch(() => null);
    scopedSession = { ...session, business_id: call?.business_id || null };
  }
  const payload = buildPaymentAutomationPayload({ provider, result, session: scopedSession });
  if (!payload.call_sid) {
    logger?.warn?.("post_call_payment_automation_skipped", {
      provider: normalizeStatus(provider),
      resource_id: payload.payment_resource_id || null,
      reason: "missing_call_sid",
    });
    return { ok: false, skipped: true, reason: "missing_call_sid" };
  }
  const workflowService = typeof ctx.getPostCallWorkflowExecutionService === "function"
    ? ctx.getPostCallWorkflowExecutionService()
    : ctx.postCallWorkflowExecutionService;
  return runPostCallAutomationTrigger({
    service: ctx.postCallAutomationService,
    workflowService,
    webhookService: ctx.webhookService,
    db,
    logger,
    payload,
    callSid: payload.call_sid,
  });
}

module.exports = {
  buildPostCallAutomationFailurePayload,
  buildCallCompletionAutomationPayload,
  buildPostCallOutcomeClassificationPayload,
  triggerPostCallOutcomeWebhook,
  buildPaymentAutomationPayload,
  isSuccessfulPaymentStatus,
  maybeRunPaymentAutomation,
  resolvePaymentSession,
  runPostCallAutomationTrigger,
  triggerPostCallOutcomeWorkflow,
};
