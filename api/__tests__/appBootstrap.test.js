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

  it("registers the Vapi readiness route behind admin-token authorization", function () {
    const route = app._router.stack.find((layer) => layer.route?.path === "/api/vapi/status");
    assert.ok(route, "Vapi readiness route should be registered");
    assert.equal(route.route.methods.get, true);
    assert.equal(route.route.stack[0].name, "requireAdminToken");
  });

  it("registers Vapi tool policy reads and mutations behind admin-token authorization", function () {
    for (const [path, method] of [
      ["/api/call-scripts/:id/vapi-tools", "get"],
      ["/api/call-scripts/:id/vapi-tools", "put"],
    ]) {
      const route = app._router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
      assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
      assert.equal(route.route.stack[0].name, "requireAdminToken");
    }
  });

  it("registers Vapi mapping health and exact-confirmation resync behind admin-token authorization", function () {
    for (const [path, method] of [
      ["/api/call-scripts/:id/vapi-health", "get"],
      ["/api/call-scripts/:id/vapi-mappings/:mapping_id/resync", "post"],
    ]) {
      const route = app._router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
      assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
      assert.equal(route.route.stack[0].name, "requireAdminToken");
    }
  });

  it("registers Vapi simulation coverage, history, and runs behind admin-token authorization", function () {
    for (const [path, method] of [
      ["/api/call-scripts/:id/vapi-simulation-suites", "get"],
      ["/api/call-scripts/:id/vapi-simulation-runs", "get"],
      ["/api/call-scripts/:id/vapi-simulation-runs", "post"],
    ]) {
      const route = app._router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
      assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
      assert.equal(route.route.stack[0].name, "requireAdminToken");
    }
  });

  it("registers Vapi eval definitions and run history behind admin-token authorization", function () {
    for (const [path, method] of [
      ["/api/vapi/evals", "get"],
      ["/api/vapi/evals", "post"],
      ["/api/vapi/eval-runs", "get"],
      ["/api/vapi/eval-runs/:runId", "get"],
      ["/api/vapi/eval-runs", "post"],
    ]) {
      const route = app._router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
      assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
      assert.equal(route.route.stack[0].name, "requireAdminToken");
    }
  });

  it("registers Vapi Squad inventory and details behind admin-token authorization", function () {
    for (const path of ["/api/vapi/squads", "/api/vapi/squads/:squadId"]) {
      const route = app._router.stack.find((layer) => layer.route?.path === path && layer.route.methods.get);
      assert.ok(route, `GET ${path} should be registered`);
      assert.equal(route.route.stack[0].name, "requireAdminToken");
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

  it("registers Agent Lab promotion controls behind admin-token authorization", function () {
    const layers = app._router.stack;
    for (const path of ["/api/call-scripts/:id/promotion-readiness", "/api/call-scripts/:id/promotion-history", "/api/call-scripts/:id/promote-live"]) {
      const route = layers.find((layer) => layer.route?.path === path);
      assert.ok(route, `${path} should be registered`);
      assert.equal(route.route.stack[0].name, "requireAdminToken");
    }
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

  it("limits platform-global workflow actions to platform admins and bounds their API specs", function () {
    const adminCaps = __testables.getMiniAppCapabilitiesForRole("admin");
    assert.ok(adminCaps.includes("workflow_manage"));
    assert.equal(__testables.getMiniAppCapabilitiesForRole("operator").includes("workflow_manage"), false);
    assert.equal(__testables.getMiniAppCapabilitiesForRole("viewer").includes("workflow_manage"), false);

    const versions = __testables.buildMiniAppActionSpec("workflow.versions", { limit: 500 });
    assert.equal(versions.capability, "workflow_manage");
    assert.deepEqual(versions.query, { workflow_id: undefined, limit: 100 });
    assert.equal(__testables.buildMiniAppActionSpec("workflow.versions", { workflow_id: "bad id" }).error, "workflow_id is invalid");

    const draft = __testables.buildMiniAppActionSpec("workflow.draft", { definition: { workflow_id: "safe" } });
    assert.equal(draft.capability, "workflow_manage");
    assert.equal(draft.method, "POST");
    assert.equal(draft.body.workflow_id, "safe");
    assert.equal(__testables.buildMiniAppActionSpec("workflow.draft", { definition: [] }).error, "definition must be a JSON object");

    const runs = __testables.buildMiniAppActionSpec("workflow.runs", { status: "waiting_approval", limit: 5 });
    assert.equal(runs.capability, "workflow_manage");
    assert.deepEqual(runs.query, { workflow_id: undefined, status: "waiting_approval", limit: 5 });
    assert.equal(__testables.buildMiniAppActionSpec("workflow.runs", { status: "unknown" }).error, "status is invalid");

    const run = __testables.buildMiniAppActionSpec("workflow.run.get", { run_id: "run_1" });
    assert.equal(run.path, "/post-call/workflows/runs/run_1");
    assert.equal(run.capability, "workflow_manage");
    assert.equal(__testables.buildMiniAppActionSpec("workflow.run.get", { run_id: "../admin" }).error, "run_id is invalid");
  });
});
