const assert = require("node:assert/strict");

const { app, __testables } = require("../app");

describe("API app bootstrap", function () {
  it("registers Vapi Mini App routes behind the initialized request middleware", function () {
    const layers = app._router.stack;
    const paths = ["/miniapp/vapi/web-assistants", "/miniapp/vapi/web-calls"];

    for (const path of paths) {
      const routeIndex = layers.findIndex((layer) => layer.route?.path === path);
      assert.ok(routeIndex > 0, `${path} should be registered`);
      assert.equal(layers[routeIndex].route.stack[0].name, "requireMiniAppSession");
      assert.ok(
        layers.slice(0, routeIndex).some((layer) => layer.name === "jsonParser"),
        `${path} should be registered after JSON body parsing`,
      );
    }
  });

  it("registers workflow definition reads and mutations behind admin-token authorization", function () {
    const layers = app._router.stack;
    const paths = [
      "/post-call/workflows",
      "/post-call/workflows/:workflow_id/versions",
      "/post-call/workflows/:workflow_id/versions/:version/approve",
    ];
    const routes = paths.flatMap((path) => {
      const matching = layers.filter((entry) => entry.route?.path === path);
      assert.ok(matching.length, `${path} should be registered`);
      matching.forEach((layer) => assert.equal(layer.route.stack[0].name, "requireAdminToken"));
      return matching.map((layer) => layer.route.stack.map((handler) => handler.name));
    });
    assert.ok(routes.every((handlers) => handlers.length >= 2));
  });

  it("forwards agent runtime configuration and voice selection through Script Studio updates", function () {
    const agentConfig = { schema_version: 5, approved_tools: [], handoff_policy: { enabled: false } };
    const spec = __testables.buildMiniAppActionSpec("callscript.update", {
      id: 17,
      agent_config: agentConfig,
      voice_model: "aura-2-thalia-en",
    });

    assert.equal(spec.path, "/api/call-scripts/17");
    assert.equal(spec.body.agent_config, agentConfig);
    assert.equal(spec.body.voice_model, "aura-2-thalia-en");
    assert.deepEqual(
      __testables.buildMiniAppActionSpec("callscript.update", {
        id: 17,
        agent_config: [],
      }),
      { error: "agent_config must be a JSON object or null" },
    );
  });
});
