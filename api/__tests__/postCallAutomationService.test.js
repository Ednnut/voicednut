const assert = require("node:assert/strict");

const { PostCallAutomationService } = require("../services/postCallAutomationService");

function createAutomationDb(rows) {
  const runs = new Map();
  const rules = new Map(rows.map((row) => [row.rule_id, row]));
  return {
    runs,
    rules,
    listPostCallAutomationRules: async (filters = {}) =>
      Array.from(rules.values()).filter((row) => {
        if (filters.enabled !== undefined && Boolean(row.enabled) !== Boolean(filters.enabled)) {
          return false;
        }
        if (filters.trigger_event && row.trigger_event !== filters.trigger_event) {
          return false;
        }
        return true;
      }),
    upsertPostCallAutomationRule: async (rule) => {
      rules.set(rule.rule_id, { ...(rules.get(rule.rule_id) || {}), ...rule });
      return 1;
    },
    getPostCallAutomationRule: async (ruleId) => rules.get(ruleId) || null,
    recordPostCallAutomationRun: async (run) => {
      runs.set(run.run_id, { ...(runs.get(run.run_id) || {}), ...run });
      return true;
    },
    getPostCallAutomationRun: async (runId) => runs.get(runId) || null,
    listPostCallAutomationRuns: async (filters = {}) =>
      Array.from(runs.values()).filter((run) => {
        if (filters.call_sid && run.call_sid !== filters.call_sid) return false;
        if (filters.rule_id && run.rule_id !== filters.rule_id) return false;
        if (filters.status && run.status !== filters.status) return false;
        if (filters.trigger_event && run.trigger_event !== filters.trigger_event) return false;
        if (filters.retry_of_run_id && run.retry_of_run_id !== filters.retry_of_run_id) return false;
        return true;
      }),
    getPostCallAutomationRunByIdempotency: async (key) =>
      Array.from(runs.values()).find((run) => run.idempotency_key === key) || null,
  };
}

describe("PostCallAutomationService", () => {
  it("previews matching rules without executing actions", async () => {
    const db = createAutomationDb([
      {
        rule_id: "receipt_after_payment",
        name: "Receipt after payment",
        enabled: 1,
        trigger_event: "post_call_completed",
        conditions_json: JSON.stringify({ payment_state: "paid" }),
        actions_json: JSON.stringify([{ type: "send_email" }]),
        priority: 10,
      },
    ]);
    const service = new PostCallAutomationService({ db });

    const result = await service.preview({
      trigger_event: "post_call_completed",
      payment_state: "paid",
    });

    assert.equal(result.matched_rules.length, 1);
    assert.equal(result.matched_rules[0].rule_id, "receipt_after_payment");
    assert.equal(db.runs.size, 0);
  });

  it("runs email and CRM actions for a matching post-call rule", async () => {
    const db = createAutomationDb([
      {
        rule_id: "payment_receipt_and_crm",
        name: "Payment receipt and CRM",
        enabled: 1,
        trigger_event: "payment_succeeded",
        conditions_json: JSON.stringify({ payment_state: ["paid", "succeeded"] }),
        actions_json: JSON.stringify([
          { type: "send_email", template_context: { payment_state: "paid" } },
          { type: "crm_sync", provider: "hubspot" },
        ]),
        priority: 5,
      },
    ]);
    const emails = [];
    const crmSyncs = [];
    const service = new PostCallAutomationService({
      db,
      emailService: {
        enqueueEmail: async (payload, options) => {
          emails.push({ payload, options });
          return { message_id: "email_123" };
        },
      },
      crmService: {
        syncPostCallRecord: async (payload) => {
          crmSyncs.push(payload);
          return { provider: payload.provider, contact: { contact_id: "crm_123" } };
        },
      },
    });

    const result = await service.evaluateAndRun({
      trigger_event: "payment_succeeded",
      call_sid: "CA123",
      payment_state: "paid",
      customer: { email: "ada@example.com", first_name: "Ada" },
      variables: { receipt_id: "R1" },
    });

    assert.equal(result.matched, 1);
    assert.equal(result.runs[0].status, "completed");
    assert.equal(emails.length, 1);
    assert.equal(emails[0].payload.to, "ada@example.com");
    assert.equal(emails[0].payload.select_template, true);
    assert.equal(emails[0].payload.template_context.payment_state, "paid");
    assert.equal(crmSyncs.length, 1);
    assert.equal(crmSyncs[0].provider, "hubspot");
    const persistedRun = Array.from(db.runs.values()).find((run) => run.status === "completed");
    const persistedResult = JSON.parse(persistedRun.result_json);
    assert.deepEqual(persistedResult.steps.map(({ index, type, status }) => ({ index, type, status })), [
      { index: 0, type: "send_email", status: "completed" },
      { index: 1, type: "crm_sync", status: "completed" },
    ]);
  });

  it("deduplicates repeated automation runs for the same rule and call", async () => {
    const db = createAutomationDb([
      {
        rule_id: "missed_booking",
        name: "Missed booking",
        enabled: 1,
        trigger_event: "post_call_completed",
        conditions_json: JSON.stringify({ booking_state: "missed" }),
        actions_json: JSON.stringify([{ type: "create_ticket" }]),
        priority: 20,
      },
    ]);
    const service = new PostCallAutomationService({ db });

    const first = await service.evaluateAndRun({
      trigger_event: "post_call_completed",
      call_sid: "CA999",
      booking_state: "missed",
    });
    const second = await service.evaluateAndRun({
      trigger_event: "post_call_completed",
      call_sid: "CA999",
      booking_state: "missed",
    });

    assert.equal(first.runs[0].deduped, false);
    assert.equal(second.runs[0].deduped, true);
    assert.equal(second.runs[0].run_id, first.runs[0].run_id);
  });

  it("installs default automation rules only when missing", async () => {
    const db = createAutomationDb([]);
    const service = new PostCallAutomationService({ db });

    const first = await service.ensureDefaultRules();
    const second = await service.ensureDefaultRules();

    assert.equal(first.installed, 3);
    assert.equal(second.installed, 0);
    assert.equal(second.skipped, 3);
    assert.ok(db.rules.has("default_payment_receipt_followup"));
    assert.ok(db.rules.has("default_missed_booking_link"));
    assert.ok(db.rules.has("default_escalation_case_summary"));
  });

  it("lists stored runs with payload and retries failed runs with stable email idempotency", async () => {
    const db = createAutomationDb([
      {
        rule_id: "retry_email",
        name: "Retry email",
        enabled: 1,
        trigger_event: "post_call_completed",
        conditions_json: JSON.stringify({ call_outcome: "complete" }),
        actions_json: JSON.stringify([{ type: "send_email" }]),
        priority: 10,
      },
    ]);
    let attempts = 0;
    const emailIdempotencyKeys = [];
    const service = new PostCallAutomationService({
      db,
      emailService: {
        enqueueEmail: async (_payload, options) => {
          attempts += 1;
          emailIdempotencyKeys.push(options.idempotencyKey);
          if (attempts === 1) {
            throw new Error("provider down");
          }
          return { message_id: "email_retry_1" };
        },
      },
    });

    await assert.rejects(
      () =>
        service.evaluateAndRun({
          trigger_event: "post_call_completed",
          call_sid: "CA_RETRY",
          call_outcome: "complete",
          customer: { email: "ada@example.com" },
        }),
      /provider down/,
    );
    const failedRun = Array.from(db.runs.values()).find((run) => run.status === "failed");
    const listed = await service.listRuns({ status: "failed" });
    const retry = await service.retryRun(failedRun.run_id);

    assert.equal(listed.length, 1);
    assert.equal(listed[0].payload.call_sid, "CA_RETRY");
    assert.equal(retry.run.status, "completed");
    assert.equal(retry.run.deduped, false);
    assert.equal(emailIdempotencyKeys.length, 2);
    assert.equal(emailIdempotencyKeys[0], emailIdempotencyKeys[1]);
  });

  it("persists step progress and skips completed email steps when a later email step retries", async () => {
    const db = createAutomationDb([
      {
        rule_id: "multi_step_email",
        name: "Multi-step email follow-up",
        enabled: 1,
        trigger_event: "post_call_completed",
        conditions_json: JSON.stringify({ call_outcome: "complete" }),
        actions_json: JSON.stringify([{ type: "send_email" }, { type: "send_email" }]),
        priority: 10,
      },
    ]);
    const attempts = [];
    const service = new PostCallAutomationService({
      db,
      emailService: {
        enqueueEmail: async (_payload, options) => {
          attempts.push(options.idempotencyKey);
          if (attempts.length === 2) throw new Error("temporary email provider error");
          return { message_id: `email_${attempts.length}` };
        },
      },
    });
    const payload = {
      trigger_event: "post_call_completed",
      call_sid: "CA_MULTI_STEP",
      call_outcome: "complete",
      customer: { email: "ada@example.com" },
    };

    await assert.rejects(() => service.evaluateAndRun(payload), /temporary email provider error/);
    const original = Array.from(db.runs.values()).find((run) => run.status === "failed");
    assert.deepEqual(JSON.parse(original.result_json).steps.map((step) => step.status), ["completed", "failed"]);

    const retried = await service.retryRun(original.run_id);
    assert.equal(retried.run.status, "completed");
    assert.deepEqual(retried.run.result.steps.map((step) => step.status), ["skipped_completed", "completed"]);
    assert.equal(attempts.length, 3);
    assert.equal(attempts[1], attempts[2]);
  });

  it("blocks retry of a step with an interrupted or non-idempotent outcome", async () => {
    const db = createAutomationDb([
      {
        rule_id: "unsafe_step_retry",
        name: "Ticket workflow",
        enabled: 1,
        trigger_event: "post_call_completed",
        conditions_json: JSON.stringify({}),
        actions_json: JSON.stringify([{ type: "create_ticket" }]),
        priority: 10,
      },
    ]);
    const service = new PostCallAutomationService({ db });
    db.runs.set("run_interrupted", {
      run_id: "run_interrupted",
      rule_id: "unsafe_step_retry",
      trigger_event: "post_call_completed",
      status: "running",
      actions: [{ type: "create_ticket" }],
      payload: { call_sid: "CA_INTERRUPTED" },
      result: { actions: [], steps: [{ index: 0, type: "create_ticket", status: "running" }] },
      attempt: 1,
    });

    await assert.rejects(
      () => service.retryRun("run_interrupted", { force: true }),
      (error) => error.code === "conflict" && /may have completed before interruption/.test(error.message),
    );

    db.runs.set("run_ticket_failed", {
      run_id: "run_ticket_failed",
      rule_id: "unsafe_step_retry",
      trigger_event: "post_call_completed",
      status: "failed",
      actions: [{ type: "create_ticket" }],
      payload: { call_sid: "CA_TICKET_FAILED" },
      result: { actions: [], steps: [{ index: 0, type: "create_ticket", status: "failed" }] },
      attempt: 1,
    });
    await assert.rejects(
      () => service.retryRun("run_ticket_failed"),
      (error) => error.code === "conflict" && /not safe to replay automatically/.test(error.message),
    );
  });
});
