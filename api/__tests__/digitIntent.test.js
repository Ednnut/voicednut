const assert = require("node:assert/strict");
const { createDigitCollectionService } = require("../functions/Digit");

describe("digit intent profile inference", () => {
  it("preserves script terminator policy for keyword-derived expectations", () => {
    const service = createDigitCollectionService({
      settings: { intentPredictor: () => [] },
      callConfigurations: new Map(),
    });

    const expectation = service.inferDigitExpectationFromText(
      "Please enter your PIN.",
      { script_policy: { allow_terminator: true, terminator_char: "*" } },
    );

    assert.equal(expectation.profile, "pin");
    assert.equal(expectation.allow_terminator, true);
    assert.equal(expectation.terminator_char, "*");
  });

  it("preserves script terminator policy for predictive expectations", () => {
    const service = createDigitCollectionService({
      settings: { intentPredictor: () => [{ profile: "pin", score: 0.9 }] },
      callConfigurations: new Map(),
    });

    const intent = service.determineDigitIntent("CA_DIGIT_INTENT_TEST", {
      script_policy: { allow_terminator: true, terminator_char: "*" },
    });

    assert.equal(intent.mode, "dtmf");
    assert.equal(intent.expectation.profile, "pin");
    assert.equal(intent.expectation.allow_terminator, true);
    assert.equal(intent.expectation.terminator_char, "*");
  });
});
