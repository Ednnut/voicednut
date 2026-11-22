const assert = require("node:assert/strict");
const sqlite3 = require("sqlite3").verbose();
const { __testables } = require("../services/callRoutes");

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createHandler() {
  let recordingRequests = 0;
  const handler = __testables.createGetSpekoRecordingHandler({
    isSafeId: (value) => /^[a-z0-9_-]{1,128}$/i.test(value),
    db: {
      getCall: async () => ({ call_sid: "call_123", user_chat_id: "owner-1" }),
      getLatestCallState: async () => ({
        provider: "speko",
        provider_metadata: { speko_session_id: "session_123" },
      }),
    },
    getSpekoRecording: async () => {
      recordingRequests += 1;
      return {
        url: "https://recording.example/signed",
        expiresAt: "2026-11-21T12:05:00.000Z",
      };
    },
  });
  return { handler, get recordingRequests() { return recordingRequests; } };
}

describe("Speko recording authorization", () => {
  it("requires an owner identity for calls attached to a chat", async () => {
    const fixture = createHandler();
    const res = response();
    await fixture.handler({ params: { callSid: "call_123" }, headers: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "not_authorized" });
    assert.equal(fixture.recordingRequests, 0);
  });

  it("rejects a different owner before requesting a signed recording URL", async () => {
    const fixture = createHandler();
    const res = response();
    await fixture.handler(
      {
        params: { callSid: "call_123" },
        headers: { "x-telegram-chat-id": "owner-2" },
      },
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.equal(fixture.recordingRequests, 0);
  });

  it("returns a no-store link only to the matching owner", async () => {
    const fixture = createHandler();
    const res = response();
    await fixture.handler(
      {
        params: { callSid: "call_123" },
        headers: { "x-telegram-chat-id": "owner-1" },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.body, {
      recording_url: "https://recording.example/signed",
      expires_in: "short-lived",
    });
    assert.equal(fixture.recordingRequests, 1);
  });
});

describe("call details Speko report metadata", () => {
  it("requires the assigned owner identity before returning call details", async () => {
    const handler = __testables.createGetCallDetailsHandler({
      isSafeId: () => true,
      db: { getCall: async () => ({ call_sid: "call_123", user_chat_id: "owner-1" }) },
    });
    const res = response();
    await handler({ params: { callSid: "call_123" }, headers: {} }, res);
    assert.equal(res.statusCode, 403);

    const mismatched = response();
    await handler({
      params: { callSid: "call_123" },
      headers: { "x-telegram-chat-id": "owner-2" },
    }, mismatched);
    assert.equal(mismatched.statusCode, 403);
  });

  it("returns a sanitized report and transcript without exposing a recording URL", async () => {
    const handler = __testables.createGetCallDetailsHandler({
      isSafeId: (value) => /^[a-z0-9_-]{1,128}$/i.test(value),
      normalizeCallRecordForApi: (call) => ({ ...call, call_summary: "Call summary" }),
      buildDigitSummary: () => ({ summary: "", count: 0 }),
      db: {
        db: { all: (_sql, _params, callback) => callback(null, []) },
        getCall: async () => ({ call_sid: "call_123", provider: "speko" }),
        getLatestCallState: async (_callSid, state) => state === "speko_call_report"
          ? {
              provider: "speko", outcome: "Booked ID 12345678", contact: "connected",
              summary: "Customer confirmed", duration_seconds: -92,
              recording_status: "ready", recording_url_available: true,
              recording_url_expires_at: { unexpected: "sensitive" },
              recording_url: "https://signed.example/private",
            }
          : null,
        getCallDigits: async () => [],
        getCallTranscripts: async () => [{ speaker: "ai", message: "Hello there" }],
      },
    });
    const res = response();
    await handler({ params: { callSid: "call_123" }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.speko_report.recording_available, true);
    assert.equal(res.body.speko_report.duration_seconds, null);
    assert.equal(res.body.speko_report.outcome.includes("12345678"), false);
    assert.equal(res.body.transcripts[0].message, "Hello there");
    assert.equal(JSON.stringify(res.body).includes("signed.example"), false);
    assert.equal(JSON.stringify(res.body).includes("unexpected"), false);
  });

  it("returns bounded stored QA findings and aggregate metrics only", async () => {
    const handler = __testables.createGetCallDetailsHandler({
      isSafeId: () => true,
      normalizeCallRecordForApi: (call) => ({ ...call }),
      buildDigitSummary: () => ({ summary: "", count: 0 }),
      db: {
        db: { all: (_sql, _params, callback) => callback(null, []) },
        getCall: async () => ({ call_sid: "call_qa_1", user_chat_id: "owner-1" }),
        getLatestCallState: async () => null,
        getCallDigits: async () => [],
        getCallTranscripts: async () => [],
        getCallQualityReport: async () => ({
          status: "scored",
          score: 74,
          passed: false,
          shadow_mode: true,
          profile: "support",
          model_version: "post_call_qa_v1",
          evaluated_at: "2026-11-22T10:00:00.000Z",
          findings: ["missed_empathy_on_frustration", "unsafe\ninjection", "x".repeat(90)],
          recommendations: ["acknowledge_customer_emotion_before_guidance"],
          metrics: {
            total_turns: 6,
            duration_seconds: 45,
            component_scores: { compliance: 100, empathy: 52, private: "data" },
            transcript_excerpt: "Sensitive transcript evidence",
          },
          raw_transcript: "must not be returned",
        }),
      },
    });
    const res = response();
    await handler({
      params: { callSid: "call_qa_1" },
      headers: { "x-telegram-chat-id": "owner-1" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.qa, {
      status: "scored",
      score: 74,
      passed: false,
      shadow_mode: true,
      profile: "support",
      model_version: "post_call_qa_v1",
      evaluated_at: "2026-11-22T10:00:00.000Z",
      findings: ["missed_empathy_on_frustration"],
      recommendations: ["acknowledge_customer_emotion_before_guidance"],
      metrics: {
        total_turns: 6,
        duration_seconds: 45,
        component_scores: { compliance: 100, empathy: 52 },
      },
    });
    assert.doesNotMatch(JSON.stringify(res.body.qa), /Sensitive transcript|raw_transcript|private/);
  });

  it("does not read QA for an unauthorized call owner", async () => {
    let reportReads = 0;
    const handler = __testables.createGetCallDetailsHandler({
      isSafeId: () => true,
      db: {
        getCall: async () => ({ call_sid: "call_qa_2", user_chat_id: "owner-1" }),
        getCallQualityReport: async () => {
          reportReads += 1;
          return { findings: ["should_not_be_read"] };
        },
      },
    });
    const res = response();
    await handler({
      params: { callSid: "call_qa_2" },
      headers: { "x-telegram-chat-id": "owner-2" },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(reportReads, 0);
  });

  it("preserves null scores for insufficient-transcript reports", async () => {
    const handler = __testables.createGetCallDetailsHandler({
      isSafeId: () => true,
      normalizeCallRecordForApi: (call) => ({ ...call }),
      buildDigitSummary: () => ({ summary: "", count: 0 }),
      db: {
        db: { all: (_sql, _params, callback) => callback(null, []) },
        getCall: async () => ({ call_sid: "call_qa_short" }),
        getLatestCallState: async () => null,
        getCallDigits: async () => [],
        getCallTranscripts: async () => [],
        getCallQualityReport: async () => ({
          status: "insufficient_transcript",
          score: null,
          passed: false,
          findings: ["insufficient_turns"],
          recommendations: [],
          metrics: { threshold_score: null, component_scores: { empathy: null } },
        }),
      },
    });
    const res = response();
    await handler({ params: { callSid: "call_qa_short" }, headers: {} }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.qa.score, null);
    assert.deepEqual(res.body.qa.metrics, {});
  });
});

describe("Speko call reconciliation authorization", () => {
  function createReconcileFixture() {
    let reconcileCalls = 0;
    const handler = __testables.createReconcileSpekoCallHandler({
      isSafeId: (value) => /^[a-z0-9_-]{1,128}$/i.test(value),
      db: {
        getCall: async () => ({ call_sid: "call_123", user_chat_id: "owner-1" }),
      },
      reconcileSpekoCall: async (callSid) => {
        reconcileCalls += 1;
        return { call_sid: callSid, status: "completed" };
      },
    });
    return { handler, get reconcileCalls() { return reconcileCalls; } };
  }

  it("requires the call owner before invoking Speko reconciliation", async () => {
    const fixture = createReconcileFixture();
    const res = response();
    await fixture.handler({
      params: { callSid: "call_123" },
      headers: { "x-telegram-chat-id": "owner-2" },
    }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: "call_owner_mismatch" });
    assert.equal(fixture.reconcileCalls, 0);
  });

  it("runs the bounded reconciliation only for an authorized owner", async () => {
    const fixture = createReconcileFixture();
    const res = response();
    await fixture.handler({
      params: { callSid: "call_123" },
      headers: { "x-telegram-chat-id": "owner-1" },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      success: true,
      call_sid: "call_123",
      status: "completed",
    });
    assert.equal(fixture.reconcileCalls, 1);
  });
});

describe("call log transcript search", () => {
  it("returns a bounded matching transcript excerpt with sensitive digits masked", async () => {
    let capturedSql = "";
    let capturedParams = [];
    const handler = __testables.createSearchCallsHandler({
      parseBoundedInteger: (_value, options) => options.defaultValue,
      normalizeCallRecordForApi: (call) => ({ ...call }),
      digitService: {
        maskOtpForExternal: (value) => String(value).replace(/\d{4,}/g, "[redacted]"),
      },
      db: {
        db: {
          all: (sql, params, callback) => {
            capturedSql = sql;
            capturedParams = params;
            callback(null, [{
              call_sid: "call_123",
              provider: "speko",
              status: "completed",
              created_at: "2026-11-22T10:00:00.000Z",
              transcript_count: 2,
              matching_transcript: "Customer account 1234567890 was updated after selected option.",
            }]);
          },
        },
      },
    });
    const res = response();
    await handler({ query: { q: "selected option" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.results[0].provider, "speko");
    assert.match(res.body.results[0].matching_text, /selected option/);
    assert.match(res.body.results[0].matching_text, /\[redacted\]/);
    assert.equal(res.body.results[0].matching_transcript, undefined);
    assert.match(capturedSql, /EXISTS \(/);
    assert.match(capturedSql, /ESCAPE '!'/);
    assert.doesNotMatch(capturedSql, /GROUP_CONCAT/);
    assert.equal(capturedParams.length, 7);
  });

  it("escapes LIKE wildcards and rejects invalid search lengths", async () => {
    let capturedParams = [];
    const handler = __testables.createSearchCallsHandler({
      parseBoundedInteger: (_value, options) => options.defaultValue,
      normalizeCallRecordForApi: (call) => call,
      db: {
        db: {
          all: (_sql, params, callback) => {
            capturedParams = params;
            callback(null, []);
          },
        },
      },
    });
    const short = response();
    await handler({ query: { q: "x" } }, short);
    assert.equal(short.statusCode, 400);

    const long = response();
    await handler({ query: { q: "x".repeat(121) } }, long);
    assert.equal(long.statusCode, 400);

    const valid = response();
    await handler({ query: { q: "50%_off!" } }, valid);
    assert.equal(valid.statusCode, 200);
    assert.deepEqual(capturedParams, [
      "%50!%!_off!!%",
      "%50!%!_off!!%",
      "%50!%!_off!!%",
      "%50!%!_off!!%",
      "%50!%!_off!!%",
      "%50!%!_off!!%",
      20,
    ]);
  });

  it("executes transcript searches against the existing SQLite tables", async () => {
    const database = new sqlite3.Database(":memory:");
    try {
      await new Promise((resolve, reject) => {
        database.exec(`
          CREATE TABLE calls (
            call_sid TEXT PRIMARY KEY,
            phone_number TEXT,
            call_summary TEXT,
            prompt TEXT,
            first_message TEXT,
            status TEXT,
            duration INTEGER,
            provider TEXT,
            created_at TEXT
          );
          CREATE TABLE transcripts (
            id INTEGER PRIMARY KEY,
            call_sid TEXT,
            speaker TEXT,
            message TEXT,
            timestamp TEXT
          );
          INSERT INTO calls VALUES (
            'speko_call_1', '+12025550100', '', '', '', 'completed', 60,
            'speko', '2026-11-22T10:00:00.000Z'
          );
          INSERT INTO transcripts VALUES (
            1, 'speko_call_1', 'user',
            'Customer asked about shipment update for account 1234567890.',
            '2026-11-22T10:01:00.000Z'
          );
        `, (error) => error ? reject(error) : resolve());
      });
      const handler = __testables.createSearchCallsHandler({
        parseBoundedInteger: (value, options) => {
          const parsed = Number(value);
          return Number.isInteger(parsed) ? Math.min(options.max, Math.max(options.min, parsed)) : options.defaultValue;
        },
        normalizeCallRecordForApi: (call) => ({ ...call }),
        db: { db: database },
      });
      const res = response();
      await handler({ query: { q: "shipment update" } }, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.results.length, 1);
      assert.equal(res.body.results[0].provider, "speko");
      assert.match(res.body.results[0].matching_text, /shipment update/);
      assert.doesNotMatch(res.body.results[0].matching_text, /1234567890/);
    } finally {
      await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
    }
  });
});
