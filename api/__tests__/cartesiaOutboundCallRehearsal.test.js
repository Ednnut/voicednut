"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");
const { CallEContactPolicyService } = require("../services/callEContactPolicyService");
const { BUSINESS_SETTING_KEY_PREFIX } = require("../services/cartesiaSpeechSettingsStore");
const { __testables } = require("../app");

describe("offline unified Cartesia outbound-call rehearsal", () => {
  let db;
  let dbPath;
  let previousDb;
  let previousRegistry;
  let previousConfig;
  let callId;
  const providerCallId = "CA00000000000000000000000000000001";

  beforeEach(async () => {
    callId = null;
    dbPath = path.join(os.tmpdir(), `voicednut-cartesia-call-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    previousDb = __testables.getDb();
    __testables.setDbForTests(db);
    previousConfig = __testables.setCallTestConfigForTests({
      twilio: {
        accountSid: "AC00000000000000000000000000000000",
        authToken: "offline-test-token",
        fromNumber: "+14155550100",
      },
      plivo: {
        authId: "MA00000000000000000000000000000000",
        authToken: "offline-test-token",
        voice: { fromNumber: "+14155550101" },
      },
      vonage: {
        apiKey: "offline-api-key",
        apiSecret: "offline-api-secret",
        applicationId: "00000000-0000-4000-8000-000000000001",
        privateKey: "offline-test-private-key",
        voice: { fromNumber: "+14155550102" },
      },
      server: { hostname: "voice.example.invalid" },
      providerFailover: { enabled: false },
    });
    previousRegistry = __testables.setVoiceProviderRegistryForTests({
      createOutboundCall: async (_provider, request) => ({
        callId: request.callSid,
        providerCallId,
        status: "queued",
        metadata: { transport: "offline_fake" },
      }),
    });
  });

  afterEach(async () => {
    __testables.setVoiceProviderRegistryForTests(previousRegistry);
    if (callId) __testables.cleanupCallStateForTests(callId);
    __testables.setDbForTests(previousDb);
    __testables.setCallTestConfigForTests(previousConfig);
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => {
      try { fs.unlinkSync(file); } catch (_) {}
    });
  });

  it("uses saved business speech defaults, replays idempotently, and processes shared status events", async () => {
    const businessId = "business_cartesia_rehearsal";
    const actorId = "123456789";
    const destination = "+14155550123";
    const templateId = await db.createCallTemplate({
      name: "Synthetic Cartesia rehearsal",
      prompt: "Provide general information using safe and concise language.",
      first_message: "Hello, this is a synthetic test.",
      business_id: businessId,
    });
    await db.grantCallEBusinessOperator({
      business_id: businessId,
      telegram_id: actorId,
      role: "policy_manager",
    });
    await db.setCallEBusinessSafetyPolicy({
      business_id: businessId,
      actor_id: actorId,
      max_calls_per_day: 10,
      quiet_hours_start: null,
      quiet_hours_end: null,
      timezone: "UTC",
      emergency_stop: false,
      contact_cooldown_hours: 0,
    });
    await new CallEContactPolicyService({ db }).recordConsent({
      businessId,
      destination,
      eventKey: "cartesia:rehearsal:consent:0001",
      source: "written",
      evidenceReference: "cartesia:rehearsal:evidence:0001",
      occurredAt: new Date().toISOString(),
    });
    await db.setSetting(`${BUSINESS_SETTING_KEY_PREFIX}${businessId}`, JSON.stringify({
      provider: "cartesia",
      voice_id: "voice_synthetic_01",
      model_id: "sonic-3",
      language: "en",
      speed: 1.1,
      volume: 1,
      output_format: "wav",
    }));

    let fakeDispatches = 0;
    __testables.setVoiceProviderRegistryForTests({
      createOutboundCall: async (provider, request) => {
        assert.equal(provider, "twilio");
        assert.equal(request.number, destination);
        assert.ok(request.callSid);
        const pendingCall = await db.getCall(request.callSid);
        assert.equal(pendingCall.status, "submission_pending");
        callId = request.callSid;
        fakeDispatches += 1;
        return {
          callId,
          providerCallId,
          status: "queued",
          metadata: { transport: "offline_fake" },
        };
      },
    });
    const request = {
      number: destination,
      user_chat_id: actorId,
      business_id: businessId,
      script_id: templateId,
      preferred_provider: "twilio",
      idempotency_key: "cartesia-rehearsal-call-0001",
    };

    const accepted = await __testables.placeOutboundCall(request);
    assert.equal(accepted.callId, callId);
    assert.equal(accepted.provider, "twilio");
    const callConfig = __testables.getCallConfigurations().get(callId);
    assert.deepEqual(callConfig.script_policy.agent_config.speech_settings, {
      provider: "cartesia",
      voice_id: "voice_synthetic_01",
      model_id: "sonic-3",
      language: "en",
      speed: 1.1,
      volume: 1,
      output_format: "wav",
    });
    assert.equal(callConfig.provider, "twilio");
    assert.equal(callConfig.provider_metadata.transport, "offline_fake");
    assert.equal(callConfig.provider_call_id, providerCallId);
    assert.equal(fakeDispatches, 1);

    const replay = await __testables.placeOutboundCall(request);
    assert.equal(replay.callId, callId);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(fakeDispatches, 1);

    const inProgress = await __testables.processCallStatusWebhookPayload({
      CallSid: providerCallId,
      CallStatus: "in-progress",
      SequenceNumber: "1",
    }, { internalCallSid: callId });
    assert.equal(inProgress.ok, true);
    const completed = await __testables.processCallStatusWebhookPayload({
      CallSid: providerCallId,
      CallStatus: "completed",
      Duration: "12",
      SequenceNumber: "2",
    }, { internalCallSid: callId });
    assert.equal(completed.ok, true);
    const duplicate = await __testables.processCallStatusWebhookPayload({
      CallSid: providerCallId,
      CallStatus: "completed",
      Duration: "12",
      SequenceNumber: "2",
    }, { internalCallSid: callId });
    assert.equal(duplicate.deduped, true);
    assert.equal((await db.getCall(callId)).status, "completed");
    assert.equal(
      (await db.getLatestCallState(callId, "provider_metadata_updated")).twilio_call_sid,
      providerCallId,
    );
    assert.equal(fakeDispatches, 1);
  });

  it("runs the standard outbound flow with mocked Twilio, Plivo, and Vonage acceptance", async () => {
    const cases = ["twilio", "plivo", "vonage"];
    for (const provider of cases) {
      const businessId = `business_${provider}_matrix`;
      const actorId = "123456789";
      const destination = "+14155550123";
      const templateId = await db.createCallTemplate({
        name: `Synthetic ${provider} matrix rehearsal`,
        prompt: "Provide general information safely.",
        first_message: "Hello.",
        business_id: businessId,
      });
      await db.grantCallEBusinessOperator({ business_id: businessId, telegram_id: actorId, role: "policy_manager" });
      await db.setCallEBusinessSafetyPolicy({
        business_id: businessId, actor_id: actorId, max_calls_per_day: 10,
        quiet_hours_start: null, quiet_hours_end: null, timezone: "UTC",
        emergency_stop: false, contact_cooldown_hours: 0,
      });
      await new CallEContactPolicyService({ db }).recordConsent({
        businessId,
        destination,
        eventKey: `provider-matrix:${provider}:consent`,
        source: "written",
        evidenceReference: `provider-matrix:${provider}:evidence`,
        occurredAt: new Date().toISOString(),
      });

      let dispatches = 0;
      const fakeProviderCallId = `${provider}-offline-accepted`;
      __testables.setVoiceProviderRegistryForTests({
        createOutboundCall: async (selectedProvider, request) => {
          dispatches += 1;
          assert.equal(selectedProvider, provider);
          assert.equal((await db.getCall(request.callSid)).status, "submission_pending");
          callId = request.callSid;
          return {
            callId: request.callSid,
            providerCallId: fakeProviderCallId,
            status: "queued",
            metadata: { transport: "offline_fake", provider },
          };
        },
      });
      const request = {
        number: destination,
        user_chat_id: actorId,
        business_id: businessId,
        script_id: templateId,
        preferred_provider: provider,
        idempotency_key: `provider-matrix-${provider}-0001`,
      };
      const result = await __testables.placeOutboundCall(request);
      assert.equal(result.provider, provider);
      assert.equal(result.callId, callId);
      assert.equal((await db.getCall(callId)).status, "queued");
      assert.equal(__testables.getCallConfigurations().get(callId).provider_call_id, fakeProviderCallId);
      assert.equal(dispatches, 1);
      const replay = await __testables.placeOutboundCall(request);
      assert.equal(replay.idempotentReplay, true);
      assert.equal(dispatches, 1);
      __testables.cleanupCallStateForTests(callId);
      callId = null;
    }
  });

  it("keeps a correlation-mismatched accepted call pending and reserves its safety dispatch", async () => {
    const businessId = "business_correlation_mismatch";
    const actorId = "123456789";
    const destination = "+14155550123";
    const templateId = await db.createCallTemplate({
      name: "Synthetic correlation mismatch rehearsal",
      prompt: "Provide general information.",
      first_message: "Hello.",
      business_id: businessId,
    });
    await db.grantCallEBusinessOperator({ business_id: businessId, telegram_id: actorId, role: "policy_manager" });
    await db.setCallEBusinessSafetyPolicy({
      business_id: businessId, actor_id: actorId, max_calls_per_day: 10,
      quiet_hours_start: null, quiet_hours_end: null, timezone: "UTC",
      emergency_stop: false, contact_cooldown_hours: 0,
    });
    await new CallEContactPolicyService({ db }).recordConsent({
      businessId, destination, eventKey: "correlation-mismatch:consent", source: "written",
      evidenceReference: "correlation-mismatch:evidence", occurredAt: new Date().toISOString(),
    });
    const request = {
      number: destination, user_chat_id: actorId, business_id: businessId, script_id: templateId,
      preferred_provider: "twilio", idempotency_key: "correlation-mismatch-call-0001",
    };
    __testables.setVoiceProviderRegistryForTests({
      createOutboundCall: async (_provider, providerRequest) => {
        callId = providerRequest.callSid;
        return { callId: "unexpected-local-id", providerCallId, status: "queued", metadata: {} };
      },
    });

    await assert.rejects(
      __testables.placeOutboundCall(request),
      (error) => error.code === "provider_call_correlation_mismatch",
    );
    assert.equal((await db.getCall(callId)).status, "unknown");
    const state = await db.getLatestCallState(callId, "outbound_submission_uncertain");
    assert.equal(state.provider_call_id, providerCallId);
    const idempotency = await db.getOutboundCallIdempotency(request.idempotency_key);
    assert.equal(idempotency.status, "pending");
    const reservationKey = `twilio:${createHash("sha256").update(request.idempotency_key).digest("hex")}`;
    const reservation = await new Promise((resolve, reject) => db.db.get(
      "SELECT status FROM outbound_contact_dispatch_history WHERE reservation_key = ?",
      [reservationKey],
      (error, row) => error ? reject(error) : resolve(row),
    ));
    assert.equal(reservation.status, "accepted");
  });

  it("persists an uncertain submission and blocks an automatic duplicate retry", async () => {
    const businessId = "business_uncertain_rehearsal";
    const actorId = "123456789";
    const templateId = await db.createCallTemplate({
      name: "Synthetic uncertain submission rehearsal",
      prompt: "Provide general information.",
      first_message: "Hello.",
      business_id: businessId,
    });
    await db.grantCallEBusinessOperator({
      business_id: businessId,
      telegram_id: actorId,
      role: "policy_manager",
    });
    await db.setCallEBusinessSafetyPolicy({
      business_id: businessId,
      actor_id: actorId,
      max_calls_per_day: 10,
      quiet_hours_start: null,
      quiet_hours_end: null,
      timezone: "UTC",
      emergency_stop: false,
      contact_cooldown_hours: 0,
    });
    await new CallEContactPolicyService({ db }).recordConsent({
      businessId,
      destination: "+14155550123",
      eventKey: "cartesia:rehearsal:consent:uncertain-01",
      source: "written",
      evidenceReference: "cartesia:rehearsal:evidence:uncertain-01",
      occurredAt: new Date().toISOString(),
    });
    const request = {
      number: "+14155550123",
      user_chat_id: actorId,
      business_id: businessId,
      script_id: templateId,
      preferred_provider: "twilio",
      idempotency_key: "uncertain-submission-rehearsal-01",
    };
    let dispatches = 0;
    __testables.setVoiceProviderRegistryForTests({
      createOutboundCall: async (_provider, providerRequest) => {
        dispatches += 1;
        const pendingCall = await db.getCall(providerRequest.callSid);
        callId = providerRequest.callSid;
        assert.equal(pendingCall.status, "submission_pending");
        const error = new Error("simulated timeout");
        error.code = "simulated_timeout";
        error.providerSubmissionState = "unknown";
        throw error;
      },
    });

    await assert.rejects(
      __testables.placeOutboundCall(request),
      (error) => error.code === "provider_submission_ambiguous",
    );
    assert.equal((await db.getCall(callId)).status, "unknown");
    await assert.rejects(
      __testables.placeOutboundCall(request),
      (error) => error.code === "idempotency_in_progress",
    );
    assert.equal(dispatches, 1);

    let rejectedCallId;
    __testables.setVoiceProviderRegistryForTests({
      createOutboundCall: async (_provider, providerRequest) => {
        rejectedCallId = providerRequest.callSid;
        const error = new Error("simulated provider rejection");
        error.code = "simulated_rejection";
        error.providerSubmissionState = "rejected";
        throw error;
      },
    });
    await assert.rejects(
      __testables.placeOutboundCall({
        ...request,
        idempotency_key: "rejected-submission-rehearsal-01",
      }),
      (error) => error.code === "simulated_rejection",
    );
    assert.equal((await db.getCall(rejectedCallId)).status, "failed");
  });

  it("records provider acceptance as uncertain when post-dispatch persistence fails and blocks retries", async () => {
    const businessId = "business_persistence_rehearsal";
    const actorId = "123456789";
    const destination = "+14155550123";
    const templateId = await db.createCallTemplate({
      name: "Synthetic persistence rehearsal",
      prompt: "Provide general information.",
      first_message: "Hello.",
      business_id: businessId,
    });
    await db.grantCallEBusinessOperator({
      business_id: businessId,
      telegram_id: actorId,
      role: "policy_manager",
    });
    await db.setCallEBusinessSafetyPolicy({
      business_id: businessId,
      actor_id: actorId,
      max_calls_per_day: 10,
      quiet_hours_start: null,
      quiet_hours_end: null,
      timezone: "UTC",
      emergency_stop: false,
      contact_cooldown_hours: 0,
    });
    await new CallEContactPolicyService({ db }).recordConsent({
      businessId,
      destination,
      eventKey: "cartesia:rehearsal:consent:persistence-01",
      source: "written",
      evidenceReference: "cartesia:rehearsal:evidence:persistence-01",
      occurredAt: new Date().toISOString(),
    });
    const request = {
      number: destination,
      user_chat_id: actorId,
      business_id: businessId,
      script_id: templateId,
      preferred_provider: "twilio",
      idempotency_key: "persistence-rehearsal-call-01",
    };
    const originalUpdateCallStatus = db.updateCallStatus.bind(db);
    let dispatches = 0;
    db.updateCallStatus = async (id, status, additionalData) => {
      if (status === "queued") throw new Error("simulated status persistence failure");
      return originalUpdateCallStatus(id, status, additionalData);
    };
    __testables.setVoiceProviderRegistryForTests({
      createOutboundCall: async (_provider, providerRequest) => {
        dispatches += 1;
        callId = providerRequest.callSid;
        return {
          callId,
          providerCallId,
          status: "queued",
          metadata: { transport: "offline_fake" },
        };
      },
    });

    await assert.rejects(
      __testables.placeOutboundCall(request),
      (error) =>
        error.code === "outbound_persistence_failed" &&
        error.providerSubmissionState === "accepted" &&
        error.retryable === false,
    );
    assert.equal((await db.getCall(callId)).status, "unknown");
    assert.equal(
      (await db.getLatestCallState(callId, "outbound_submission_uncertain"))
        .provider_call_id,
      providerCallId,
    );
    const idempotency = await db.getOutboundCallIdempotency(request.idempotency_key);
    assert.equal(idempotency.status, "pending");
    assert.equal(idempotency.call_sid, callId);
    await assert.rejects(
      __testables.placeOutboundCall(request),
      (error) => error.code === "idempotency_in_progress",
    );
    assert.equal(dispatches, 1);
  });

  it("rejects invalid payment settings before dispatching any provider call", async () => {
    const templateId = await db.createCallTemplate({
      name: "Synthetic payment validation rehearsal",
      prompt: "Provide general information.",
      first_message: "Hello.",
    });
    let dispatches = 0;
    __testables.setVoiceProviderRegistryForTests({
      createOutboundCall: async () => {
        dispatches += 1;
        throw new Error("Provider dispatch must not run for invalid payment settings");
      },
    });
    const baseRequest = {
      number: "+14155550123",
      script_id: templateId,
      preferred_provider: "twilio",
    };

    await assert.rejects(
      __testables.placeOutboundCall({
        ...baseRequest,
        idempotency_key: "invalid-payment-policy-rehearsal-01",
        payment_policy: { max_attempts_per_call: 11 },
      }),
      (error) => error.code === "payment_policy_invalid" && error.status === 400,
    );
    await assert.rejects(
      __testables.placeOutboundCall({
        ...baseRequest,
        idempotency_key: "invalid-payment-amount-rehearsal-01",
        payment_enabled: true,
        payment_amount: "not-a-number",
      }),
      (error) => error.code === "payment_validation_error" && error.status === 400,
    );

    const callCount = await new Promise((resolve, reject) => {
      db.db.get("SELECT COUNT(*) AS count FROM calls", (error, row) => {
        if (error) reject(error);
        else resolve(Number(row?.count) || 0);
      });
    });
    assert.equal(dispatches, 0);
    assert.equal(callCount, 0);
  });
});
