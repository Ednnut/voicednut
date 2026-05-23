const assert = require("node:assert/strict");

const express = require("express");

const PlivoVoiceAdapter = require("../adapters/PlivoVoiceAdapter");
const {
  buildCanonicalCallStatusEvent,
} = require("../adapters/providerFlowPolicy");
const {
  collectRegisteredRoutes,
} = require("../adapters/providerPreflight");
const {
  createPlivoAnswerWebhookHandler,
} = require("../services/webhookRoutes");
const {
  EnhancedSmsService,
  __testables: smsTestables,
} = require("../routes/sms");

const { PlivoSmsAdapter } = smsTestables;

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: "",
    contentType: "",
    type(value) {
      this.contentType = value;
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
}

describe("Plivo provider integration", () => {
  it("builds outbound voice calls with Plivo REST fields and request_uuid correlation", async () => {
    const requests = [];
    const adapter = new PlivoVoiceAdapter(
      {
        authId: "auth-id",
        authToken: "auth-token",
        voice: {
          fromNumber: "+15555550100",
        },
        fetch: async (url, options) => {
          requests.push({ url, options });
          return {
            ok: true,
            status: 201,
            text: async () => JSON.stringify({
              call_uuid: "plivo-call-uuid",
              request_uuid: "internal-call-sid",
            }),
          };
        },
      },
      { info: () => {}, warn: () => {} },
    );

    const response = await adapter.createOutboundCall({
      to: "+15555550123",
      callSid: "internal-call-sid",
      answerUrl: "https://api.example.com/plivo/answer",
      eventUrl: "https://api.example.com/plivo/events",
    });

    assert.equal(response.call_uuid, "plivo-call-uuid");
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/v1\/Account\/auth-id\/Call\/$/);
    assert.equal(requests[0].options.method, "POST");
    assert.match(requests[0].options.headers.Authorization, /^Basic /);

    const payload = JSON.parse(requests[0].options.body);
    assert.deepEqual(payload, {
      from: "+15555550100",
      to: "+15555550123",
      answer_url: "https://api.example.com/plivo/answer",
      answer_method: "GET",
      request_uuid: "internal-call-sid",
      ring_url: "https://api.example.com/plivo/events",
      ring_method: "POST",
      hangup_url: "https://api.example.com/plivo/events",
      hangup_method: "POST",
    });
  });

  it("returns Plivo Stream XML for outbound answer callbacks", async () => {
    const handler = createPlivoAnswerWebhookHandler({
      requireValidPlivoWebhook: () => true,
      resolvePlivoCallSid: async () => "internal-call-sid",
      rememberPlivoCallMapping: () => {},
      getPlivoCallUuid: (payload) => payload.CallUUID,
      buildPlivoWebsocketUrl: (_req, callSid, params) =>
        `wss://api.example.com/plivo/stream?callSid=${callSid}&uuid=${params.uuid}&direction=${params.direction}`,
      getPlivoStreamContentType: () => "audio/x-mulaw;rate=8000",
      resolveHost: () => "api.example.com",
    });
    const req = {
      path: "/plivo/answer",
      query: {
        callSid: "internal-call-sid",
        CallUUID: "plivo-call-uuid",
        Direction: "outbound",
      },
      body: {},
    };
    const res = createResponseRecorder();

    await handler(req, res);

    assert.equal(res.contentType, "text/xml");
    assert.match(res.body, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(res.body, /<Stream bidirectional="true" keepCallAlive="true"/);
    assert.match(res.body, /contentType="audio\/x-mulaw;rate=8000"/);
    assert.match(res.body, /wss:\/\/api.example.com\/plivo\/stream/);
    assert.match(res.body, /direction=outbound/);
  });

  it("synthesizes inbound Plivo call setup when answer callbacks have no internal callSid", async () => {
    const setups = [];
    const directions = new Map();
    const callConfigurations = new Map();
    const callFunctionSystems = new Map();
    const handler = createPlivoAnswerWebhookHandler({
      requireValidPlivoWebhook: () => true,
      resolvePlivoCallSid: async () => null,
      rememberPlivoCallMapping: () => {},
      getPlivoCallUuid: (payload) => payload.CallUUID,
      buildPlivoInboundCallSid: (uuid) => `plivo-in-${uuid}`,
      refreshInboundDefaultScript: async () => {},
      ensureCallSetup: (callSid, payload, options) => {
        setups.push({ callSid, payload, options });
        return {
          callConfig: {
            provider_metadata: {},
            first_message: "Hello",
          },
          functionSystem: {},
        };
      },
      ensureCallRecord: async () => ({ phone_number: "+15555550123" }),
      normalizePhoneForFlag: (value) => value,
      shouldRateLimitInbound: () => ({ limited: false }),
      buildPlivoWebsocketUrl: (_req, callSid, params) =>
        `wss://api.example.com/plivo/stream?callSid=${callSid}&direction=${params.direction}`,
      getPlivoStreamContentType: () => "audio/x-mulaw;rate=8000",
      resolveHost: () => "api.example.com",
      config: { telegram: {} },
      webhookService: {
        sendCallStatusUpdate: async () => {},
        setInboundGate: () => {},
      },
      getDb: () => ({}),
      getCallConfigurations: () => callConfigurations,
      getCallFunctionSystems: () => callFunctionSystems,
      getCallDirections: () => directions,
    });
    const req = {
      path: "/plivo/answer",
      query: {
        CallUUID: "plivo-call-uuid",
        Direction: "inbound",
        From: "+15555550123",
        To: "+15555550100",
      },
      body: {},
    };
    const res = createResponseRecorder();

    await handler(req, res);

    assert.equal(res.contentType, "text/xml");
    assert.equal(setups.length, 1);
    assert.equal(setups[0].callSid, "plivo-in-plivo-call-uuid");
    assert.equal(setups[0].options.provider, "plivo");
    assert.equal(setups[0].options.inbound, true);
    assert.equal(directions.get("plivo-in-plivo-call-uuid"), "inbound");
    assert.equal(callConfigurations.get("plivo-in-plivo-call-uuid").provider, "plivo");
    assert.equal(
      callConfigurations.get("plivo-in-plivo-call-uuid").provider_metadata.plivo_uuid,
      "plivo-call-uuid",
    );
    assert.match(res.body, /direction=inbound/);
  });

  it("normalizes Plivo call statuses into canonical lifecycle events", () => {
    const completed = buildCanonicalCallStatusEvent(
      "plivo",
      {
        CallUUID: "plivo-call-uuid",
        CallStatus: "hangup",
        Duration: "42",
      },
      { callSid: "internal-call-sid" },
    );
    const noAnswer = buildCanonicalCallStatusEvent(
      "plivo",
      {
        CallStatus: "no_answer",
      },
      { callSid: "internal-call-sid-2" },
    );

    assert.equal(completed.provider, "plivo");
    assert.equal(completed.call_sid, "internal-call-sid");
    assert.equal(completed.status, "completed");
    assert.equal(completed.notification_type, "call_completed");
    assert.equal(completed.duration, 42);
    assert.equal(noAnswer.status, "no-answer");
    assert.equal(noAnswer.notification_type, "call_no_answer");
  });

  it("recognizes express-ws websocket routes during provider preflight route collection", () => {
    const app = express();
    app.get("/plivo/stream/.websocket", (_req, res) => res.sendStatus(426));

    const routes = collectRegisteredRoutes(app);

    assert.equal(routes.has("GET /plivo/stream/.websocket"), true);
    assert.equal(routes.has("GET /plivo/stream"), true);
  });

  it("does not construct a Twilio client when SMS provider is Plivo", async () => {
    const service = new EnhancedSmsService({
      getActiveProvider: () => "plivo",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const adapter = service.getAdapter("plivo");

    assert.equal(adapter instanceof PlivoSmsAdapter, true);
    assert.equal(service.twilio, null);
  });
});
