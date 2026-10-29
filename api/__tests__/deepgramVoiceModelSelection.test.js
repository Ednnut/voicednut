const assert = require("node:assert/strict");
const {
  CURATED_DEEPGRAM_VOICE_MODELS,
  isCuratedDeepgramVoiceModel,
} = require("../services/deepgramVoiceModels");

describe("curated Deepgram Voice Agent voice selection", () => {
  it("accepts the project catalog identifiers after trimming", () => {
    for (const voice of CURATED_DEEPGRAM_VOICE_MODELS) {
      assert.equal(isCuratedDeepgramVoiceModel(` ${voice.id} `), true);
    }
  });

  it("rejects blank, legacy aliases, arbitrary identifiers, and non-strings", () => {
    for (const voice of ["", "alice", "custom-voice", null, undefined, {}]) {
      assert.equal(isCuratedDeepgramVoiceModel(voice), false);
    }
  });
});
