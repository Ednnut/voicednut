const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { __testables } = require("../services/statusRoutes");

function buildStatusApp() {
  const db = {
    async healthCheck() {},
    async getCallsWithTranscripts() {
      return [{ call_sid: "call-1" }];
    },
    async getCallJobStatusSummary() {
      return {
        pending: 2,
        running: 1,
        completed: 8,
        failed: 0,
        open_dead_letters: 1,
      };
    },
    async getNotificationAnalytics() {
      return {
        total_notifications: 3,
        overall_success_rate: 100,
        breakdown: [],
      };
    },
    db: {
      all(_sql, callback) {
        callback(null, []);
      },
    },
  };
  const handler = __testables.createHealthHandler({
    config: { apiAuth: { hmacSecret: "" }, keypadGuard: { enabled: true } },
    verifyHmacSignature: () => ({ ok: false }),
    hasAdminToken: (req) => req.headers["x-admin-token"] === "test-admin-token",
    getDb: () => db,
    webhookService: {
      async healthCheck() {
        return { status: "running" };
      },
      getCallStatusStats() {
        return {};
      },
    },
    refreshInboundDefaultScript: async () => {},
    getInboundHealthContext: () => ({
      inboundDefaultSummary: {},
      inboundEnvSummary: {},
    }),
    supportedProviders: [],
    providerHealth: new Map(),
    getProviderReadiness: () => ({}),
    isProviderDegraded: () => false,
    getProviderHealthScore: () => null,
    pruneExpiredKeypadProviderOverrides: () => {},
    keypadProviderOverrides: new Map(),
    callConfigurations: new Map(),
    functionEngine: null,
    callFunctionSystems: new Map(),
    getCallCanaryState: () => null,
  });
  const app = express();
  app.get("/health", handler);
  app.get("/ready", handler);
  return app;
}

describe("system health route visibility", () => {
  it("keeps the public health response minimal", async () => {
    const response = await request(buildStatusApp()).get("/health").expect(200);

    assert.equal(response.body.public, true);
    assert.equal(response.body.readiness, "ready");
    assert.equal(response.body.services, undefined);
    assert.equal(response.body.active_calls, undefined);
  });

  it("requires authentication for the detailed readiness response", async () => {
    const response = await request(buildStatusApp()).get("/ready").expect(401);
    assert.equal(response.headers["cache-control"], "no-store");
  });

  it("returns detailed operational fields to an authenticated readiness request", async () => {
    const response = await request(buildStatusApp())
      .get("/ready")
      .set("x-admin-token", "test-admin-token")
      .expect(200);

    assert.equal(response.body.enhanced_features, true);
    assert.equal(response.body.services.database.connected, true);
    assert.equal(response.body.services.database.recent_calls, 1);
    assert.equal(response.body.services.call_jobs.pending, 2);
    assert.equal(response.body.services.call_jobs.open_dead_letters, 1);
    assert.deepEqual(response.body.system_health, []);
    assert.equal(response.headers["cache-control"], "no-store");
  });
});
