"use strict";

const assert = require("node:assert/strict");

const {
  createPlivoEventWebhookHandler,
  createVonageEventWebhookHandler,
} = require("../services/webhookRoutes");
const Database = require("../db/db");
const { __testables } = require("../app");

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

function createRetryHarness(handlerFactory) {
  let reserved = false;
  let releaseCount = 0;
  let statusAttempts = 0;
  const ctx = {
    requireValidPlivoWebhook: () => true,
    requireValidVonageWebhook: () => true,
    shouldProcessProviderEventAsync: async () => {
      if (reserved) return false;
      reserved = true;
      return true;
    },
    releaseProviderEventAsync: async () => {
      reserved = false;
      releaseCount += 1;
    },
    recordCallStatus: async () => {
      statusAttempts += 1;
      if (statusAttempts === 1) throw new Error("temporary persistence failure");
    },
    resolvePlivoCallSid: async () => "internal-call-1",
    getPlivoCallUuid: (payload) => payload.CallUUID,
    rememberPlivoCallMapping: () => {},
    resolveVonageCallSid: async () => "internal-call-1",
    getVonageCallPayload: (_req, payload) => ({
      uuid: payload.uuid,
      direction: "outbound",
    }),
    getVonageDtmfDigits: () => null,
    isOutboundVonageDirection: () => true,
    rememberVonageCallMapping: () => {},
    getCallConfigurations: () => new Map(),
    getCallDirections: () => new Map(),
  };
  const handler = handlerFactory(ctx);

  return {
    handler,
    get releaseCount() {
      return releaseCount;
    },
    get statusAttempts() {
      return statusAttempts;
    },
  };
}

describe("provider call webhook retry behavior", () => {
  it("does not keep an in-memory duplicate reservation when durable reservation fails", async () => {
    const previousDb = __testables.getDb();
    let reservations = 0;
    __testables.setDbForTests({
      reserveProviderEventIdempotency: async () => {
        reservations += 1;
        if (reservations === 1) {
          throw Object.assign(new Error("temporary database failure"), {
            code: "SQLITE_BUSY",
          });
        }
        return { reserved: reservations === 2 };
      },
    });

    try {
      const event = {
        provider_call_id: "synthetic-provider-call",
        status: "ringing",
        sequence: "retry-reservation-test",
      };
      await assert.rejects(
        () => __testables.shouldProcessProviderEventAsync("webhook_retry_test", event),
        { code: "provider_event_idempotency_unavailable" },
      );
      assert.equal(
        await __testables.shouldProcessProviderEventAsync("webhook_retry_test", event),
        true,
      );
      assert.equal(
        await __testables.shouldProcessProviderEventAsync("webhook_retry_test", event),
        false,
      );
      assert.equal(reservations, 3);
    } finally {
      __testables.setDbForTests(previousDb);
    }
  });

  for (const [provider, handlerFactory, request] of [
    [
      "Plivo",
      createPlivoEventWebhookHandler,
      {
        path: "/plivo/events",
        body: { CallUUID: "provider-call-1", CallStatus: "ringing" },
      },
    ],
    [
      "Vonage",
      createVonageEventWebhookHandler,
      {
        path: "/ve",
        body: { uuid: "provider-call-1", status: "ringing" },
      },
    ],
  ]) {
    it(`${provider} retries failed processing and acknowledges a successful replay as a duplicate`, async () => {
      const harness = createRetryHarness(handlerFactory);
      const firstResponse = createResponseRecorder();
      const retryResponse = createResponseRecorder();
      const duplicateResponse = createResponseRecorder();

      await harness.handler(request, firstResponse);
      await harness.handler(request, retryResponse);
      await harness.handler(request, duplicateResponse);

      assert.equal(firstResponse.statusCode, 503);
      assert.equal(firstResponse.body, "Service unavailable");
      assert.equal(retryResponse.statusCode, 200);
      assert.equal(retryResponse.body, "OK");
      assert.equal(duplicateResponse.statusCode, 200);
      assert.equal(harness.releaseCount, 1);
      assert.equal(harness.statusAttempts, 2);
    });
  }

  it("releases a durable Twilio status dedupe reservation when processing fails", async () => {
    const previousDb = __testables.getDb();
    const releases = [];
    __testables.setDbForTests({
      reserveProviderEventIdempotency: async () => ({ reserved: true }),
      deleteProviderEventIdempotency: async (payload) => {
        releases.push(payload);
        return { deleted: true };
      },
      getCall: async () => ({
        status: "queued",
        user_chat_id: "999",
        created_at: new Date().toISOString(),
      }),
      getLatestCallState: async () => null,
      updateCallState: async () => {},
      updateCallStatus: async () => {
        throw new Error("database write failed");
      },
      logServiceHealth: async () => {},
    });

    await assert.rejects(
      () => __testables.processCallStatusWebhookPayload(
        { CallSid: "CA123", CallStatus: "ringing", SequenceNumber: "1" },
        { internalCallSid: "local-call-123" },
      ),
      /database write failed/,
    );

    assert.equal(releases.length, 1);
    assert.equal(releases[0].source, "twilio_call_status");
    __testables.setDbForTests(previousDb);
  });

  it("deletes only the matching durable provider event reservation", async () => {
    let capturedQuery = "";
    let capturedParams = [];
    const result = await Database.prototype.deleteProviderEventIdempotency.call({
      db: {
        run(query, params, callback) {
          capturedQuery = query;
          capturedParams = params;
          callback.call({ changes: 1 }, null);
        },
      },
    }, {
      source: "plivo_event",
      event_key: "plivo_event:synthetic-hash",
    });

    assert.match(capturedQuery, /WHERE source = \? AND event_key = \?/);
    assert.deepEqual(capturedParams, ["plivo_event", "plivo_event:synthetic-hash"]);
    assert.deepEqual(result, { deleted: true });
  });
});
