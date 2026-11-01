const assert = require("node:assert/strict");

const {
  buildCallCompletionAutomationPayload,
  buildPostCallOutcomeClassificationPayload,
  maybeRunPaymentAutomation,
  runPostCallAutomationTrigger,
  triggerPostCallOutcomeWorkflow,
} = require("../services/postCallAutomationTriggers");

function createSilentLogger() {
  return {
    error: () => {},
    warn: () => {},
    log: () => {},
  };
}

describe("PostCallAutomationTriggers", () => {
  it("runs payment automation for successful provider events with a stable idempotency key", async () => {
    const payloads = [];
    const states = [];
    const liveEvents = [];
    const result = await maybeRunPaymentAutomation({
      provider: "stripe",
      result: {
        ok: true,
        duplicate: false,
        event_id: "evt_123",
        event_type: "checkout.session.completed",
        resource_id: "cs_123",
        status: "complete",
      },
      ctx: {
        db: {
          getStripePaymentSession: async () => ({
            session_id: "local_123",
            external_id: "cs_123",
            call_sid: "CA123",
            metadata: JSON.stringify({ customer_email: "ada@example.com" }),
          }),
          updateCallState: async (callSid, state, data) => {
            states.push({ callSid, state, data });
          },
        },
        webhookService: {
          addLiveEvent: (callSid, line, options) => {
            liveEvents.push({ callSid, line, options });
          },
        },
        postCallAutomationService: {
          evaluateAndRun: async (payload) => {
            payloads.push(payload);
            return {
              trigger_event: payload.trigger_event,
              matched: 1,
              runs: [{ run_id: "run_123", rule_id: "receipt", status: "completed" }],
            };
          },
        },
      },
      logger: createSilentLogger(),
    });

    assert.equal(result.ok, true);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0].trigger_event, "payment_succeeded");
    assert.equal(payloads[0].call_sid, "CA123");
    assert.equal(payloads[0].idempotency_key, "payment:stripe:evt_123");
    assert.equal(payloads[0].payment_state, "paid");
    assert.equal(payloads[0].customer.email, "ada@example.com");
    assert.equal(states[0].state, "post_call_automation_completed");
    assert.equal(liveEvents[0].callSid, "CA123");
    assert.equal(liveEvents[0].line, "Automation ran 1 rule");
  });

  it("skips duplicate or non-success payment events", async () => {
    let calls = 0;
    const ctx = {
      postCallAutomationService: {
        evaluateAndRun: async () => {
          calls += 1;
        },
      },
    };

    const duplicate = await maybeRunPaymentAutomation({
      provider: "paypal",
      result: { ok: true, duplicate: true, resource_id: "PAY-1", status: "completed" },
      ctx,
      logger: createSilentLogger(),
    });
    const pending = await maybeRunPaymentAutomation({
      provider: "square",
      result: { ok: true, duplicate: false, resource_id: "SQ-1", status: "pending" },
      ctx,
      logger: createSilentLogger(),
    });

    assert.equal(duplicate.skipped, true);
    assert.equal(pending.skipped, true);
    assert.equal(calls, 0);
  });

  it("records and reports automation failures without throwing", async () => {
    const states = [];
    const liveEvents = [];
    const result = await runPostCallAutomationTrigger({
      service: {
        evaluateAndRun: async () => {
          throw new Error("email unavailable");
        },
      },
      webhookService: {
        addLiveEvent: (callSid, line, options) => {
          liveEvents.push({ callSid, line, options });
        },
      },
      db: {
        updateCallState: async (callSid, state, data) => {
          states.push({ callSid, state, data });
        },
      },
      logger: createSilentLogger(),
      callSid: "CA999",
      payload: { trigger_event: "post_call_completed", call_sid: "CA999" },
    });

    assert.equal(result.ok, false);
    assert.equal(states[0].state, "post_call_automation_failed");
    assert.equal(liveEvents[0].line, "Automation failed");
  });

  it("builds post-call completion payloads from call summaries and transcripts", () => {
    const payload = buildCallCompletionAutomationPayload({
      callSid: "CA321",
      call: { phone_number: "+15551234567", user_chat_id: 42 },
      transcripts: [{ message: "hello" }],
      summary: { summary: "Customer requested a booking link" },
      finalStatus: "completed",
      notificationType: "call_completed",
      duration: 45,
    });

    assert.equal(payload.trigger_event, "post_call_completed");
    assert.equal(payload.idempotency_key, "call-completed:CA321");
    assert.equal(payload.transcript_summary, "Customer requested a booking link");
    assert.equal(payload.customer.phone, "+15551234567");
    assert.equal(payload.metadata.has_transcript, true);
  });

  it("builds a separate data-minimized post-call outcome classification payload", () => {
    const payload = buildPostCallOutcomeClassificationPayload({
      callSid: "CA321",
      finalStatus: "no-answer",
      notificationType: "call_no_answer",
    });

    assert.equal(payload.trigger_event, "post_call_outcome_classified");
    assert.equal(payload.idempotency_key, "call-outcome-classified:CA321");
    assert.equal(payload.call_outcome, "no_answer");
    assert.equal(payload.context.outcome_classification, "not_connected");
    assert.equal(Object.hasOwn(payload, "customer"), false);
    assert.equal(Object.hasOwn(payload, "transcript_summary"), false);
    assert.equal(Object.hasOwn(payload, "transcript"), false);
    assert.equal(buildPostCallOutcomeClassificationPayload({ finalStatus: "completed" }), null);
    const completed = buildPostCallOutcomeClassificationPayload({ callSid: "CA322", finalStatus: "completed" });
    assert.equal(completed.outcome_classification, "completed");
  });

  it("logs only a sanitized error code when a classification workflow trigger fails", async () => {
    const errors = [];
    const result = await triggerPostCallOutcomeWorkflow({
      workflowService: { trigger: async () => { throw Object.assign(new Error("private text"), { code: "private@example.com" }); } },
      payload: { call_sid: "CA321" },
      logger: { error: (...args) => errors.push(args) },
    });
    assert.deepEqual(result, { skipped: true, reason: "workflow_trigger_failed" });
    assert.deepEqual(errors, [["post_call_outcome_workflow_trigger_failed", { call_sid: "CA321", error_code: "workflow_trigger_failed" }]]);
  });
});
