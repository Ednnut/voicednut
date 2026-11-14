"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { validatePlivoSignatureV3 } = require("../middleware/plivoSignatureV3");
const {
  __testables: appTestables,
} = require("../app");
const {
  assertPlivoWebhookAuthConfiguration,
} = require("../services/webhookAuthConfig");

function signPayload(token, payload) {
  return crypto
    .createHmac("sha256", token)
    .update(payload)
    .digest("base64");
}

describe("Plivo Signature V3 validation", () => {
  it("validates the final URL, sorted POST fields, and nonce", () => {
    const token = "offline-test-plivo-auth-token";
    const req = {
      method: "POST",
      protocol: "https",
      headers: {
        host: "voice.example.test",
        "x-plivo-signature-v3-nonce": "unique-test-nonce",
      },
      originalUrl: "/plivo/events?callSid=internal-call-1",
      body: {
        From: "+15555550100",
        CallUUID: "provider-call-1",
        CallStatus: "ringing",
      },
    };
    const signedPayload =
      "https://voice.example.test/plivo/events?callSid=internal-call-1." +
      "CallStatusringingCallUUIDprovider-call-1From+15555550100." +
      "unique-test-nonce";
    req.headers["x-plivo-signature-v3"] = signPayload(token, signedPayload);

    assert.equal(validatePlivoSignatureV3(req, token), true);
    req.body.CallStatus = "completed";
    assert.equal(validatePlivoSignatureV3(req, token), false);
  });

  it("accepts the master-account header and comma-separated active signatures", () => {
    const token = "offline-test-plivo-auth-token";
    const req = {
      method: "GET",
      protocol: "https",
      headers: {
        host: "voice.example.test",
        "x-plivo-signature-v3-nonce": "unique-test-nonce",
        "x-plivo-signature-ma-v3": [
          "invalid-signature",
          signPayload(
            token,
            "https://voice.example.test/plivo/answer?CallUUID=provider-call-1&callSid=internal-call-1.unique-test-nonce",
          ),
        ].join(","),
      },
      originalUrl: "/plivo/answer?callSid=internal-call-1&CallUUID=provider-call-1",
    };

    assert.equal(validatePlivoSignatureV3(req, token), true);
  });

  it("wires native validation into strict Plivo webhook authentication", () => {
    const token = "offline-test-plivo-auth-token";
    const signedPayload =
      "https://voice.example.test/plivo/events?callSid=internal-call-1." +
      "CallStatusringingCallUUIDprovider-call-1From+15555550100." +
      "unique-test-nonce";
    const req = {
      method: "POST",
      protocol: "https",
      path: "/plivo/events",
      originalUrl: "/plivo/events?callSid=internal-call-1",
      body: {
        From: "+15555550100",
        CallUUID: "provider-call-1",
        CallStatus: "ringing",
      },
      headers: {
        host: "voice.example.test",
        "x-plivo-signature-v3-nonce": "unique-test-nonce",
        "x-plivo-signature-v3": signPayload(token, signedPayload),
      },
    };
    const previous = appTestables.setCallTestConfigForTests({
      plivo: {
        authToken: token,
        webhookSecret: "",
        webhookValidation: "strict",
      },
    });
    const response = {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(body) {
        this.body = body;
        return this;
      },
    };

    try {
      assert.equal(
        appTestables.requireValidPlivoWebhook(req, response, req.path),
        true,
      );
      assert.equal(
        appTestables.requireValidPlivoWebhook(req, response, req.path),
        false,
      );
      assert.equal(response.statusCode, 401);
      req.headers["x-plivo-signature-v3-nonce"] = "another-test-nonce";
      req.headers["x-plivo-signature-v3"] = signPayload(
        token,
        signedPayload.replace("unique-test-nonce", "another-test-nonce"),
      );
      req.body.CallStatus = "failed";
      assert.equal(
        appTestables.requireValidPlivoWebhook(req, response, req.path),
        false,
      );
      assert.equal(response.statusCode, 401);
    } finally {
      appTestables.setCallTestConfigForTests({ plivo: previous.plivo });
    }
  });

  it("accepts Plivo auth tokens as strict webhook credentials at startup", () => {
    assert.doesNotThrow(() =>
      assertPlivoWebhookAuthConfiguration({
        platform: { provider: "plivo" },
        plivo: { authToken: "offline-test-plivo-auth-token", webhookValidation: "strict" },
      }),
    );
  });
});
