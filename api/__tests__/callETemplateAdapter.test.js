const assert = require("node:assert/strict");
const {
  previewCallETemplate,
  validateCallEResult,
  validateCallEResultSchema,
} = require("../adapters/callETemplateAdapter");

const template = Object.freeze({
  id: 17,
  version: 4,
  prompt: "Confirm whether the caller received the appointment reminder. Do not change the booking.",
  first_message: "Hello, I am calling with a brief appointment reminder.",
  voice_model: null,
  default_profile: null,
  objective_tags: null,
  supports_payment: 0,
  supports_digit_capture: 0,
  requires_otp: 0,
  payment_enabled: 0,
  allow_terminator: 0,
  terminator_char: null,
});

const resultSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["reminder_received", "summary"],
  properties: {
    reminder_received: { type: "boolean" },
    summary: { type: "string", description: "Briefly summarize what was confirmed." },
  },
});

describe("CALL-E template preview adapter", () => {
  it("builds a deterministic no-call preview for a simple synthetic template", () => {
    const preview = previewCallETemplate(template, {
      phone: "+14155550123",
      resultSchema,
    });

    assert.equal(preview.interface, "calls_v2");
    assert.equal(preview.source.templateId, 17);
    assert.equal(preview.source.templateVersion, 4);
    assert.equal(preview.compatible, true);
    assert.deepEqual(preview.missing, []);
    assert.deepEqual(preview.unsupported, []);
    assert.equal(preview.dispatchEnabled, false);
    assert.equal(preview.requestSummary.method, "POST");
    assert.equal(preview.requestSummary.path, "/v2/calls");
    assert.equal(preview.requestSummary.phoneMasked, "+14•••••0123");
    assert.deepEqual(preview.requestSummary.resultProperties, ["reminder_received", "summary"]);
    assert.equal(preview.requestSummary.webhookConfigured, false);
    assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(preview).includes("+14155550123"), false);
    assert.equal(JSON.stringify(preview).includes("CALLE_API_KEY"), false);
  });

  it("does not classify missing or malformed inputs as compatible", () => {
    const preview = previewCallETemplate({ prompt: "Prompt", first_message: "Hello" }, { phone: "123", resultSchema: {} });

    assert.equal(preview.compatible, false);
    assert.deepEqual(preview.missing, ["template_id", "template_version", "valid_e164_phone", "valid_result_schema"]);
    assert.equal(preview.requestSummary.phoneMasked, null);
  });

  it("fails closed for payment, digit capture, profile, provider config, and unknown configuration", () => {
    const preview = previewCallETemplate({
      ...template,
      supports_payment: "true",
      requires_otp: 1,
      default_profile: "identity_verification_plus",
      configuration: { tools: ["payment"], unexpected_setting: true },
    }, { phone: "+14155550123", resultSchema });

    assert.equal(preview.compatible, false);
    assert.ok(preview.unsupported.includes("payment_workflow"));
    assert.ok(preview.unsupported.includes("digit_capture_or_otp"));
    assert.ok(preview.unsupported.includes("default_profile"));
    assert.ok(preview.unsupported.includes("configuration.tools"));
    assert.ok(preview.unsupported.includes("configuration.unexpected_setting"));
  });

  it("treats malformed configuration JSON as unsupported instead of ignoring it", () => {
    const preview = previewCallETemplate({ ...template, config_json: "{not-json" }, {
      phone: "+14155550123",
      resultSchema,
    });

    assert.equal(preview.compatible, false);
    assert.ok(preview.unsupported.includes("configuration.invalid_json"));
  });

  it("changes its fingerprint when the exact version, destination, task, or schema changes", () => {
    const options = { phone: "+14155550123", resultSchema };
    const original = previewCallETemplate(template, options).fingerprint;
    assert.equal(previewCallETemplate({ ...template }, options).fingerprint, original);
    assert.notEqual(previewCallETemplate({ ...template, version: 5 }, options).fingerprint, original);
    assert.notEqual(previewCallETemplate({ ...template, prompt: "Different approved task." }, options).fingerprint, original);
    assert.notEqual(previewCallETemplate(template, { ...options, phone: "+14155550124" }).fingerprint, original);
    assert.notEqual(previewCallETemplate(template, {
      ...options,
      resultSchema: { ...resultSchema, required: ["summary"] },
    }).fingerprint, original);

    for (const change of [
      { business_id: "business-2" },
      { lifecycle_state: "approved" },
      { expected_length: 60 },
      { payment_amount: "1.00" },
      { payment_policy: "Synthetic policy marker" },
      { payment_description: "Synthetic payment description" },
      { payment_start_message: "Synthetic payment start" },
      { payment_success_message: "Synthetic payment success" },
      { payment_failure_message: "Synthetic payment failure" },
      { payment_retry_message: "Synthetic payment retry" },
      { configuration: { policy_mode: "strict" } },
    ]) {
      assert.notEqual(previewCallETemplate({ ...template, ...change }, options).fingerprint, original);
    }
  });

  it("accepts only the documented flat scalar schema subset", () => {
    assert.equal(validateCallEResultSchema(resultSchema).valid, true);
    for (const invalidSchema of [
      { ...resultSchema, properties: { nested: { type: "object", properties: { value: { type: "string" } } } } },
      { ...resultSchema, properties: { items: { type: "array", items: { type: "string" } } } },
      { ...resultSchema, properties: { amount: { type: "number", minimum: 0 } } },
      { ...resultSchema, additionalProperties: true },
      { ...resultSchema, required: ["unknown"] },
      { ...resultSchema, properties: { answer: { type: ["string", "null"] } } },
    ]) {
      assert.equal(validateCallEResultSchema(invalidSchema).valid, false);
    }
  });

  it("validates extracted result values against the local schema", () => {
    assert.equal(validateCallEResult(resultSchema, { reminder_received: true, summary: "Confirmed" }).valid, true);
    assert.equal(validateCallEResult(resultSchema, { reminder_received: "yes", summary: "Confirmed" }).valid, false);
    assert.equal(validateCallEResult(resultSchema, { reminder_received: true, summary: "Confirmed", extra: "value" }).valid, false);
    assert.equal(validateCallEResult(resultSchema, { reminder_received: true }).valid, false);
  });
});
