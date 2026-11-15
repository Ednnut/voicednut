"use strict";

const assert = require("node:assert/strict");
const {
  CartesiaSpeechSettingsStore,
  SETTING_KEY,
  BUSINESS_SETTING_KEY_PREFIX,
  resolveCallSpeechProfile,
  applyBusinessSpeechProfile,
} = require("../services/cartesiaSpeechSettingsStore");

function makeStore(overrides = {}) {
  const rows = new Map();
  const config = {
    tts: {
      provider: "deepgram",
      cartesia: { voiceId: "voice_old", model: "sonic-3", language: "en", speed: 1, volume: 1, outputFormat: "wav" },
    },
  };
  const db = {
    async getSetting(key) { return rows.get(key) ?? null; },
    async setSetting(key, value) {
      if (value === null) rows.delete(key);
      else rows.set(key, value);
    },
  };
  const studio = {
    async listModels() {
      return { models: [
        { id: "sonic-3.6-2026-08-27", capability: "tts", supportedLanguages: ["en", "es"] },
        { id: "ink-whisper", capability: "stt", supportedLanguages: [] },
      ] };
    },
    async getVoice(id) { return { voice: { id } }; },
  };
  return {
    rows,
    config,
    store: new CartesiaSpeechSettingsStore({ db, config }),
    studio: { ...studio, ...overrides.studio },
  };
}

describe("Cartesia speech settings store", () => {
  it("persists only a currently callable TTS model and applies the profile independently of telephony", async () => {
    const { rows, config, store, studio } = makeStore();
    const result = await store.save({
      provider: "cartesia",
      voice_id: "voice_new",
      model_id: "sonic-3.6-2026-08-27",
      language: "en",
      speed: 1.1,
      volume: 0.9,
      output_format: "mp3",
    }, studio);

    assert.equal(result.profile.source, "saved");
    assert.equal(rows.has(SETTING_KEY), true);
    assert.equal(config.tts.provider, "cartesia");
    assert.equal(config.tts.cartesia.voiceId, "voice_new");
    assert.equal(config.tts.cartesia.model, "sonic-3.6-2026-08-27");
    assert.equal(config.callProvider, undefined);
  });

  it("preserves the prior saved profile when a model is unavailable or language-incompatible", async () => {
    const unavailable = makeStore();
    await unavailable.store.save({
      provider: "cartesia", voice_id: "voice_old", model_id: "sonic-3.6-2026-08-27", language: "en",
      speed: 1, volume: 1, output_format: "wav",
    }, unavailable.studio);
    const prior = await unavailable.store.getProfile();

    await assert.rejects(unavailable.store.save({
      provider: "cartesia", voice_id: "voice_new", model_id: "not-listed", language: "en",
      speed: 1, volume: 1, output_format: "wav",
    }, unavailable.studio), { code: "cartesia_model_unavailable" });
    await assert.rejects(unavailable.store.save({
      provider: "cartesia", voice_id: "voice_new", model_id: "sonic-3.6-2026-08-27", language: "fr",
      speed: 1, volume: 1, output_format: "wav",
    }, unavailable.studio), { code: "cartesia_language_unsupported" });
    assert.deepEqual(await unavailable.store.getProfile(), prior);
  });

  it("requires a real voice and resets only the saved speech profile", async () => {
    const { rows, config, store, studio } = makeStore();
    await assert.rejects(store.save({
      provider: "cartesia", voice_id: "voice_new", model_id: "sonic-3.6-2026-08-27", language: "en",
      speed: 1, volume: 1, output_format: "wav",
    }, {
      async listModels() { return { models: [{ id: "sonic-3.6-2026-08-27", capability: "tts", supportedLanguages: ["en"] }] }; },
      async getVoice() { throw new Error("missing"); },
    }));
    assert.equal(rows.has(SETTING_KEY), false);
    await store.save({
      provider: "cartesia", voice_id: "voice_new", model_id: "sonic-3.6-2026-08-27", language: "en",
      speed: 1, volume: 1, output_format: "wav",
    }, studio);
    await store.reset();
    assert.equal(rows.has(SETTING_KEY), false);
    assert.equal(config.tts.provider, "deepgram");
    assert.equal(config.tts.cartesia.voiceId, "voice_old");
  });

  it("isolates saved profiles by business and leaves the process-wide TTS defaults unchanged", async () => {
    const { rows, config, store, studio } = makeStore();
    const originalProvider = config.tts.provider;
    const first = await store.saveBusinessProfile("biz-one", {
      provider: "cartesia", voice_id: "voice_one", model_id: "sonic-3.6-2026-08-27",
      language: "en", speed: 1.1, volume: 0.9, output_format: "mp3",
    }, studio);

    assert.equal(first.profile.source, "business");
    assert.equal(rows.has(`${BUSINESS_SETTING_KEY_PREFIX}biz-one`), true);
    assert.equal(rows.has(SETTING_KEY), false);
    assert.equal(config.tts.provider, originalProvider);
    assert.equal((await store.getBusinessProfile("biz-one")).voice_id, "voice_one");
    assert.notEqual((await store.getBusinessProfile("biz-two")).voice_id, "voice_one");

    await store.saveBusinessProfile("biz-two", {
      provider: "cartesia", voice_id: "voice_two", model_id: "sonic-3.6-2026-08-27",
      language: "es", speed: 1, volume: 1, output_format: "wav",
    }, studio);
    assert.equal((await store.getBusinessProfile("biz-one")).voice_id, "voice_one");
    assert.equal((await store.getBusinessProfile("biz-two")).voice_id, "voice_two");
    await store.resetBusinessProfile("biz-one");
    assert.notEqual((await store.getBusinessProfile("biz-one")).voice_id, "voice_one");
    assert.equal((await store.getBusinessProfile("biz-two")).voice_id, "voice_two");
  });

  it("uses the legacy saved profile only as a clearly labeled fallback until a business override exists", async () => {
    const { store, studio } = makeStore();
    await store.save({
      provider: "cartesia", voice_id: "voice_legacy", model_id: "sonic-3.6-2026-08-27",
      language: "en", speed: 1, volume: 1, output_format: "wav",
    }, studio);

    const fallback = await store.getBusinessProfile("biz-one");
    assert.equal(fallback.voice_id, "voice_legacy");
    assert.equal(fallback.source, "global_fallback");
  });

  it("uses business speech defaults for calls unless the saved script pins its own voice", () => {
    const profile = {
      provider: "cartesia", voice_id: "voice_business", model_id: "sonic-3.6",
      language: "en", speed: 1, volume: 1, output_format: "wav", source: "business",
    };
    assert.deepEqual(resolveCallSpeechProfile(null, profile), {
      provider: "cartesia", voice_id: "voice_business", model_id: "sonic-3.6",
      language: "en", speed: 1, volume: 1, output_format: "wav",
    });
    assert.deepEqual(resolveCallSpeechProfile({ provider: "cartesia", voice_id: "voice_script" }, profile), {
      provider: "cartesia", voice_id: "voice_script", model_id: "sonic-3.6",
      language: "en", speed: 1, volume: 1, output_format: "wav",
    });
    assert.equal(resolveCallSpeechProfile(null, { ...profile, source: "environment" }), null);
  });

  it("adds business speech settings to a call script policy without changing unrelated call configuration", () => {
    const policy = {
      requires_otp: false,
      agent_config: { approved_tools: ["lookup"], speech_settings: { provider: "cartesia", voice_id: "voice_script" } },
    };
    const applied = applyBusinessSpeechProfile(policy, {
      provider: "cartesia", voice_id: "voice_business", model_id: "sonic-3.6",
      language: "en", speed: 1.1, volume: 0.9, output_format: "wav", source: "business",
    });

    assert.deepEqual(applied, {
      requires_otp: false,
      agent_config: {
        approved_tools: ["lookup"],
        speech_settings: {
          provider: "cartesia", voice_id: "voice_script", model_id: "sonic-3.6",
          language: "en", speed: 1.1, volume: 0.9, output_format: "wav",
        },
      },
    });
    assert.equal(policy.agent_config.speech_settings.model_id, undefined);
  });
});
