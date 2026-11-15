const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { describe, it } = require("mocha");
const {
  OutgoingWebhookService,
  normalizeTarget,
  resolvePublicAddress,
  safePayload,
} = require("../services/outgoingWebhookService");

describe("OutgoingWebhookService", function () {
  it("accepts only HTTPS public host targets without URL credentials or query data", function () {
    assert.equal(normalizeTarget("https://hooks.example.com/events").hostname, "hooks.example.com");
    for (const target of [
      "http://hooks.example.com/events",
      "https://127.0.0.1/events",
      "https://localhost/events",
      "https://user:pass@hooks.example.com/events",
      "https://hooks.example.com/events?token=secret",
      "https://hooks.example.com:8443/events",
    ]) assert.throws(() => normalizeTarget(target));
  });

  it("rejects a host when any DNS answer is outside public unicast space", async function () {
    await assert.rejects(
      resolvePublicAddress("hooks.example.com", async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.2", family: 4 },
      ]),
      { code: "webhook_destination_rejected" },
    );
    assert.deepEqual(await resolvePublicAddress("hooks.example.com", async () => [
      { address: "8.8.8.8", family: 4 },
    ]), { address: "8.8.8.8", family: 4 });
  });

  it("builds a strict post-call envelope without customer or transcript content", function () {
    const payload = safePayload({
      event_id: "evt_safe", business_id: "biz-1", call_sid: "CA123",
      payload: {
        call_outcome: "no-answer", metadata: { duration_seconds: 42 },
        customer: { phone: "+15551234567", email: "customer@example.com" },
        transcript_summary: "private conversation",
      },
    });
    assert.deepEqual(payload.data, { status: "completed", call_id: "CA123", duration_seconds: 42, outcome: "no_answer" });
    assert.equal(JSON.stringify(payload).includes("customer@example.com"), false);
    assert.equal(JSON.stringify(payload).includes("private conversation"), false);
  });

  it("builds a minimized outcome-classification envelope", function () {
    const payload = safePayload({ trigger_event: "post_call_outcome_classified", event_id: "evt_outcome",
      business_id: "biz-1", call_sid: "CA123", payload: {
        outcome_classification: "not_connected", call_outcome: "no_answer",
        customer: { email: "private@example.com" }, transcript: "private conversation",
      } });
    assert.equal(payload.type, "post_call_outcome_classified");
    assert.deepEqual(payload.data, { call_id: "CA123", outcome_classification: "not_connected" });
    assert.equal(JSON.stringify(payload).includes("private@example.com"), false);
    assert.equal(JSON.stringify(payload).includes("private conversation"), false);
  });

  it("builds a minimized automation-failure envelope", function () {
    const payload = safePayload({ trigger_event: "post_call_automation_failed", event_id: "evt_failure",
      business_id: "biz-1", call_sid: "CA123", payload: {
        failure_stage: "workflow_trigger", error_code: "workflow_event_requires_recovery",
        customer: { email: "private@example.com" }, transcript: "private conversation",
      } });
    assert.equal(payload.type, "post_call_automation_failed");
    assert.deepEqual(payload.data, { call_id: "CA123", failure_stage: "workflow_trigger",
      error_code: "workflow_event_requires_recovery" });
    assert.equal(JSON.stringify(payload).includes("private@example.com"), false);
    assert.equal(JSON.stringify(payload).includes("private conversation"), false);
  });

  it("queues deterministic, minimized events only for enabled subscriptions", async function () {
    const queued = new Map();
    const service = new OutgoingWebhookService({
      enabled: true,
      db: {
        listOutgoingWebhookSubscriptions: async () => [
          { subscription_id: "sub-1", enabled: 1, event_types_json: '["post_call_completed","post_call_outcome_classified","post_call_automation_failed"]' },
          { subscription_id: "sub-2", enabled: 0, event_types_json: '["post_call_completed","post_call_outcome_classified","post_call_automation_failed"]' },
        ],
        enqueueOutgoingWebhookDelivery: async (value) => queued.set(`${value.subscription_id}:${value.event_id}`, value),
      },
    });
    const input = {
      trigger_event: "post_call_completed", business_id: "biz-1", call_sid: "CA123",
      idempotency_key: "call-completed:CA123", call_outcome: "completed",
      customer: { phone: "+15551234567" },
    };
    assert.equal(await service.enqueueEvent(input), 1);
    assert.equal(await service.enqueueEvent(input), 1);
    assert.equal(queued.size, 1);
    const [delivery] = [...queued.values()];
    assert.equal(delivery.event_id.startsWith("evt_"), true);
    assert.equal(JSON.stringify(delivery).includes("+15551234567"), false);
    const classified = {
      trigger_event: "post_call_outcome_classified", business_id: "biz-1", call_sid: "CA123",
      idempotency_key: "call-outcome-classified:CA123", outcome_classification: "not_connected",
      context: { outcome_classification: "not_connected", customer: { email: "private@example.com" } },
    };
    assert.equal(await service.enqueueEvent(classified), 1);
    assert.equal(await service.enqueueEvent(classified), 1);
    assert.equal(queued.size, 2);
    const classifiedDelivery = [...queued.values()].find((row) => row.event_type === "post_call_outcome_classified");
    assert.equal(classifiedDelivery.payload_json.includes("private@example.com"), false);
    assert.deepEqual(JSON.parse(classifiedDelivery.payload_json).data,
      { call_id: "CA123", outcome_classification: "not_connected" });
    const failedEvent = { trigger_event: "post_call_automation_failed", business_id: "biz-1", call_sid: "CA123",
      idempotency_key: "post-call-automation-failed:CA123:workflow_trigger", payload: {
        failure_stage: "workflow_trigger", error_code: "workflow_event_requires_recovery",
        transcript_summary: "private summary",
      } };
    assert.equal(await service.enqueueEvent(failedEvent), 1);
    assert.equal(await service.enqueueEvent(failedEvent), 1);
    assert.equal(queued.size, 3);
    const failureDelivery = [...queued.values()].find((row) => row.event_type === "post_call_automation_failed");
    assert.deepEqual(JSON.parse(failureDelivery.payload_json).data, { call_id: "CA123",
      failure_stage: "workflow_trigger", error_code: "workflow_event_requires_recovery" });
    assert.equal(failureDelivery.payload_json.includes("private summary"), false);
  });

  it("requires a configured environment secret of at least 32 bytes", function () {
    const name = "VOICEDNUT_TEST_WEBHOOK_SECRET";
    const previous = process.env[name];
    process.env[name] = "too-short";
    const service = new OutgoingWebhookService({ enabled: true, db: {} });
    assert.throws(() => service.normalizeSubscription({
      name: "Test", target_url: "https://hooks.example.com", secret_ref: `env://${name}`,
      event_types: ["post_call_completed"],
    }));
    process.env[name] = "x".repeat(32);
    const parsed = service.normalizeSubscription({
      name: "Test", target_url: "https://hooks.example.com", secret_ref: `env://${name}`,
      event_types: ["post_call_completed", "post_call_outcome_classified", "post_call_automation_failed"],
    });
    assert.equal(parsed.secret_env_ref, `env://${name}`);
    assert.deepEqual(parsed.event_types, ["post_call_completed", "post_call_outcome_classified", "post_call_automation_failed"]);
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  it("returns configuration history without exposing the secret reference", async function () {
    const name = "VOICEDNUT_TEST_WEBHOOK_HISTORY_SECRET";
    const previous = process.env[name];
    process.env[name] = "h".repeat(40);
    const service = new OutgoingWebhookService({
      enabled: true,
      db: {
        getOutgoingWebhookSubscription: async () => ({ subscription_id: "sub-1", business_id: "biz-1" }),
        listOutgoingWebhookSubscriptionRevisions: async () => [{
          revision: 3, name: "History", target_url: "https://hooks.example.com/events",
          secret_env_ref: `env://${name}`, enabled: 1, event_types_json: '["post_call_completed"]',
          failure_threshold: 5, actor_id: "7001", change_type: "configured", created_at: "2026-01-01T00:00:00.000Z",
        }],
      },
    });
    try {
      const revisions = await service.listRevisions("sub-1", "biz-1", 20);
      assert.equal(revisions[0].revision, 3);
      assert.equal(revisions[0].actor_id, "7001");
      assert.equal(revisions[0].signing_secret_configured, true);
      assert.equal(JSON.stringify(revisions).includes(name), false);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("pins delivery to the validated address and signs the exact raw body", async function () {
    const name = "VOICEDNUT_TEST_WEBHOOK_DELIVERY_SECRET";
    const previous = process.env[name];
    process.env[name] = "s".repeat(40);
    let requestOptions;
    let requestBody;
    let finished;
    const service = new OutgoingWebhookService({
      enabled: true,
      db: { finishOutgoingWebhookAttempt: async (_deliveryId, result) => { finished = result; } },
      resolveDns: async () => [{ address: "8.8.8.8", family: 4 }],
      request: (options, onResponse) => {
        requestOptions = options;
        const request = new EventEmitter();
        request.destroy = (error) => request.emit("error", error);
        request.end = (body) => {
          requestBody = body;
          const response = new EventEmitter();
          response.statusCode = 204;
          onResponse(response);
          setImmediate(() => response.emit("end"));
        };
        return request;
      },
    });
    try {
      await service.deliver({
        delivery_id: "delivery-1", subscription_id: "subscription-1", event_id: "event-1",
        target_url: "https://hooks.example.com/events", secret_env_ref: `env://${name}`,
        payload_json: '{"id":"event-1","type":"post_call_completed"}', attempts: 0, max_attempts: 8,
      });
      let resolved;
      requestOptions.lookup(requestOptions.hostname, {}, (...args) => { resolved = args; });
      assert.deepEqual(resolved, [null, "8.8.8.8", 4]);
      const timestamp = requestOptions.headers["x-voicednut-timestamp"];
      const expected = crypto.createHmac("sha256", process.env[name])
        .update(`${timestamp}.${requestBody}`).digest("hex");
      assert.equal(requestOptions.headers["x-voicednut-signature"], `v1=${expected}`);
      assert.equal(requestOptions.headers["idempotency-key"], "delivery-1");
      assert.equal(finished.delivered, true);
      assert.equal(finished.response_status, 204);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
});
