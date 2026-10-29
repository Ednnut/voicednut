const assert = require("node:assert/strict");
const { buildManagedVoiceAgentSettings } = require("../routes/voiceAgentBridge");

describe("Deepgram Voice Agent Settings payload", () => {
  it("preserves Flux v2 and uses a language hint for multilingual Flux without Nova-only formatting", () => {
    const settings = buildManagedVoiceAgentSettings({
      agent: {
        language: "es",
        listen: {
          provider: {
            model: "flux-general-multi",
            version: "v2",
            smart_format: true,
            keyterms: ["appointment"],
          },
        },
      },
    });

    assert.deepEqual(settings.agent.listen.provider, {
      type: "deepgram",
      model: "flux-general-multi",
      version: "v2",
      language_hints: ["es"],
      keyterms: ["appointment"],
    });
  });

  it("uses the configured language and smart formatting for Nova", () => {
    const settings = buildManagedVoiceAgentSettings({
      agent: {
        language: "es",
        listen: {
          provider: { model: "nova-3", smart_format: true },
        },
      },
    });

    assert.deepEqual(settings.agent.listen.provider, {
      type: "deepgram",
      model: "nova-3",
      language: "es",
      smart_format: true,
    });
  });
});
