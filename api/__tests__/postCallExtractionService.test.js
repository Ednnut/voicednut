const assert = require("node:assert/strict");
const {
  validateSchema,
  matchesSchema,
  runStructuredExtraction,
} = require("../services/postCallExtractionService");

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "appointment_requested"],
  properties: {
    intent: { type: "string", enum: ["schedule", "question", "other"] },
    appointment_requested: { type: "boolean" },
  },
};

describe("Post-call structured extraction", () => {
  it("defaults only omitted required fields and rejects malformed values at every object level", () => {
    const { required, ...optionalSchema } = schema;
    assert.doesNotThrow(() => validateSchema(optionalSchema));
    assert.doesNotThrow(() => validateSchema({ ...schema, required: [] }));
    for (const value of [false, 0, "", null, "intent", {}]) {
      const invalid = { ...schema, required: value };
      assert.throws(() => validateSchema(invalid), /required fields/);
      assert.throws(() => validateSchema({
        type: "object", additionalProperties: false,
        properties: { nested: invalid },
      }), /required fields/);
    }
  });

  it("accepts only bounded supported JSON Schema constructs and checks required types and enums", () => {
    assert.doesNotThrow(() => validateSchema(schema));
    assert.match(validateSchemaError({ ...schema, additionalProperties: true }), /additionalProperties/);
    assert.deepEqual(matchesSchema({ intent: "sell", appointment_requested: "yes" }, schema).length, 2);
  });

  it("bounds transcript input and records pending review with verified evidence and provenance", async () => {
    const transcript = [
      { id: 12, speaker: "user", timestamp: "2026-10-01T10:00:00Z", message: "I would like to schedule an appointment." },
      { id: 13, speaker: "ai", message: "What day works for you?" },
    ];
    const saved = [];
    const usage = [];
    const result = await runStructuredExtraction({
      callSid: "call-extract-1",
      call: { profile: "support", business_id: "biz-1" },
      transcripts: transcript,
      schema,
      schemaVersion: "appointment_v2",
      config: {
        postCallExtraction: { enabled: true, shadowMode: true, rolloutPercent: 100, minConfidence: 0.8 },
        postCallQa: { allowlist: ["support"], shadowMode: true },
      },
      generate: async ({ transcript: sent }) => {
        assert.deepEqual(sent[0], {
          segment_id: "12", speaker: "customer", timestamp: "2026-10-01T10:00:00Z",
          text: "I would like to schedule an appointment.",
        });
        return {
          request_id: "gen-openrouter-123",
          model: "actual/router-model",
          usage: { prompt_tokens: 540, completion_tokens: 48, total_tokens: 588 },
          content: JSON.stringify({
            data: { intent: "schedule", appointment_requested: true },
            confidence: 0.94,
            evidence: [
              { field: "intent", segment_id: "12", quote: "schedule an appointment" },
              { field: "appointment_requested", segment_id: "12", quote: "I would like to schedule" },
            ],
          }),
        };
      },
      db: {
        async recordCallStructuredExtractionUsage(record) { usage.push(record); },
        async upsertCallStructuredExtraction(record) { saved.push(record); },
      },
    });
    assert.equal(result.status, "pending_review");
    assert.equal(result.persisted, true);
    assert.deepEqual(usage, [{
      call_sid: "call-extract-1", business_id: "biz-1", model_id: "actual/router-model",
      provider_request_id: "gen-openrouter-123", usage_source: "openrouter_chat_completion_response",
      prompt_tokens: 540, completion_tokens: 48, total_tokens: 588,
      recorded_at: saved[0].processed_at,
    }]);
    assert.equal(saved[0].model_id, "actual/router-model");
    assert.equal(saved[0].provider_request_id, "gen-openrouter-123");
    assert.equal(saved[0].usage_source, "openrouter_chat_completion_response");
    assert.equal(saved[0].prompt_tokens, 540);
    assert.equal(saved[0].completion_tokens, 48);
    assert.equal(saved[0].total_tokens, 588);
    assert.equal(saved[0].schema_version, "appointment_v2");
    assert.equal(saved[0].evidence[0].timestamp, transcript[0].timestamp);
    assert.deepEqual(saved[0].validation_errors, []);
  });

  it("discards malformed or unbounded provider token values", async () => {
    let saved;
    await runStructuredExtraction({
      callSid: "call-extract-usage-2", call: { profile: "support", business_id: "biz-1" },
      transcripts: [{ id: 1, speaker: "user", message: "I would like to schedule an appointment." }], schema,
      config: {
        postCallExtraction: { enabled: true, shadowMode: true, rolloutPercent: 100 },
        postCallQa: { allowlist: ["support"], shadowMode: true },
      },
      generate: async () => ({ model: "router/model", request_id: "unsafe/request/id", usage: {
        prompt_tokens: -1, completion_tokens: 20, total_tokens: 1000000001,
      }, content: JSON.stringify({ data: { intent: "schedule", appointment_requested: true }, confidence: 0.9,
        evidence: [{ field: "intent", segment_id: "1", quote: "schedule an appointment" },
          { field: "appointment_requested", segment_id: "1", quote: "I would like to schedule" }] }) }),
      db: { async upsertCallStructuredExtraction(record) { saved = record; } },
    });
    assert.equal(saved.provider_request_id, null);
    assert.equal(saved.prompt_tokens, null);
    assert.equal(saved.completion_tokens, 20);
    assert.equal(saved.total_tokens, null);
  });

  it("marks malformed JSON, missing evidence, and low confidence for review", async () => {
    let saved;
    const result = await runStructuredExtraction({
      callSid: "call-extract-2",
      call: { profile: "support" },
      transcripts: [{ id: 1, speaker: "user", message: "yes" }],
      schema,
      config: {
        postCallExtraction: { enabled: true, shadowMode: true, rolloutPercent: 100, minConfidence: 0.8 },
        postCallQa: { allowlist: ["support"], shadowMode: true },
      },
      generate: async () => "not json",
      db: { async upsertCallStructuredExtraction(record) { saved = record; } },
    });
    assert.equal(result.status, "pending_review");
    assert.ok(saved.validation_errors.some((error) => error.includes("malformed JSON")));
    assert.ok(saved.validation_errors.some((error) => error.includes("evidence")));
  });

  it("does not generate when extraction is outside rollout or shadow safeguards", async () => {
    let called = false;
    const result = await runStructuredExtraction({
      callSid: "call-extract-3", schema, transcripts: [{ message: "hello" }],
      config: { postCallExtraction: { enabled: true, shadowMode: false, rolloutPercent: 100 } },
      generate: async () => { called = true; },
    });
    assert.equal(result.reason, "rollout_or_disabled");
    assert.equal(called, false);
  });
});

function validateSchemaError(value) {
  try { validateSchema(value); return ""; } catch (error) { return error.message; }
}
