const assert = require("assert");
const {
  buildCallTemplateExecutionContext,
  fingerprintTemplate,
} = require("../adapters/templateExecution");

describe("call template execution context", () => {
  it("keeps persisted template identity, version, provider and flow explicit", () => {
    const context = buildCallTemplateExecutionContext({
      template: { id: 42, version: 3, prompt: "Prompt", first_message: "Hello" },
      provider: " TWILIO ",
      flow: " OUTBOUND_VOICE ",
    });

    assert.strictEqual(context.contract_version, 1);
    assert.strictEqual(context.template_id, 42);
    assert.strictEqual(context.template_version, 3);
    assert.strictEqual(context.template_source, "call_template");
    assert.strictEqual(context.provider, "twilio");
    assert.strictEqual(context.flow, "outbound_voice");
    assert.strictEqual(context.provider_resource_id, null);
    assert.strictEqual(context.compatibility_status, "unassessed");
    assert.strictEqual(context.deployment_status, "unmapped");
    assert.strictEqual(context.fallback_provider, null);
    assert.match(context.configuration_fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(context));
  });

  it("can carry explicit provider mapping and fallback state", () => {
    const context = buildCallTemplateExecutionContext({
      template: { id: 7, version: 2, prompt: "Prompt" },
      provider: "vapi",
      providerResourceId: "assistant-123",
      compatibilityStatus: "vapi-compatible-with-adapter",
      deploymentStatus: "synced",
      fallbackProvider: "twilio",
      flow: "outbound_voice",
    });

    assert.strictEqual(context.provider_resource_id, "assistant-123");
    assert.strictEqual(
      context.compatibility_status,
      "vapi-compatible-with-adapter",
    );
    assert.strictEqual(context.deployment_status, "synced");
    assert.strictEqual(context.fallback_provider, "twilio");
  });

  it("labels calls without a persisted template as inline", () => {
    const context = buildCallTemplateExecutionContext({
      template: null,
      provider: "plivo",
      flow: "digit_capture",
    });

    assert.strictEqual(context.template_id, null);
    assert.strictEqual(context.template_version, null);
    assert.strictEqual(context.template_source, "inline");
    assert.strictEqual(context.configuration_fingerprint, null);
  });

  it("fingerprints only the selected template configuration fields", () => {
    const first = fingerprintTemplate({
      id: 1,
      version: 1,
      prompt: "Prompt",
      updated_at: "2026-01-01",
      objective_tags: ["support", "follow_up"],
    });
    const sameContent = fingerprintTemplate({
      objective_tags: ["support", "follow_up"],
      prompt: "Prompt",
      id: 1,
      version: 9,
      updated_at: "2027-01-01",
    });
    const changedContent = fingerprintTemplate({
      prompt: "Changed prompt",
      objective_tags: ["support", "follow_up"],
    });

    assert.strictEqual(first, sameContent);
    assert.notStrictEqual(first, changedContent);
  });

  it("requires a provider and execution flow", () => {
    assert.throws(
      () => buildCallTemplateExecutionContext({ flow: "outbound_voice" }),
      /requires a provider/,
    );
    assert.throws(
      () => buildCallTemplateExecutionContext({ provider: "twilio" }),
      /requires a flow/,
    );
  });
});
