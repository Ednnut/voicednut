const assert = require("node:assert/strict");
const config = require("../config");
const { __testables } = require("../app");

describe("public callback host resolution", () => {
  const previousHostname = config.server.hostname;

  after(() => {
    config.server.hostname = previousHostname;
  });

  it("prefers configured SERVER over untrusted forwarded and Host headers", () => {
    config.server.hostname = "https://api.voicednut.example/";
    assert.equal(
      __testables.resolveHost({
        headers: {
          "x-forwarded-host": "attacker.example",
          host: "internal-container:3000",
        },
      }),
      "api.voicednut.example",
    );
  });

  it("uses proxy headers only when SERVER is not configured", () => {
    config.server.hostname = "";
    assert.equal(
      __testables.resolveHost({
        headers: {
          "x-forwarded-host": "proxy.example, internal.example",
          host: "internal-container:3000",
        },
      }),
      "proxy.example",
    );
  });
});
