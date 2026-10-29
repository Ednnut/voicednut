const assert = require("node:assert/strict");
const {
  CallEApiError,
  CallEClient,
  CALL_E_PRODUCTION_BASE_URL,
  CALL_E_TEST_BASE_URL,
  buildCallEDeploymentStatus,
  createCallEClientFromEnv,
  isAllowedBaseUrl,
} = require("../services/callEClient");

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

describe("CALL-E server client", () => {
  it("reports gated dispatch readiness without exposing secrets", () => {
    const disabled = buildCallEDeploymentStatus(new CallEClient({ apiKey: "private-test-key" }));
    assert.deepEqual(disabled, {
      integrationEnabled: false,
      providerAccessReady: false,
      destinationAllowlistReady: false,
      dispatchKillSwitchEnabled: false,
      pilotApprovalReady: false,
      pilotReadinessReviewed: false,
      previewAvailable: true,
      dispatchAvailable: false,
      pilotReady: false,
      dispatchBlocker: "dispatch_kill_switch_disabled",
      dispatchBlockers: [
        "dispatch_kill_switch_disabled",
        "exact_preview_pilot_approval_missing_or_expired",
        "pilot_external_readiness_review_required",
      ],
    });
    assert.equal(JSON.stringify(disabled).includes("private-test-key"), false);

    const configured = buildCallEDeploymentStatus(new CallEClient({
      enabled: true,
      apiKey: "private-test-key",
      baseUrl: CALL_E_TEST_BASE_URL,
      fetchFn: async () => jsonResponse(200, {}),
    }), { destinationAllowlistReady: true });
    assert.equal(configured.providerAccessReady, true);
    assert.equal(configured.destinationAllowlistReady, true);
    assert.equal(configured.dispatchAvailable, false);
    assert.equal(configured.pilotReady, false);
    assert.equal(configured.dispatchBlockers.length, 3);
    assert.equal("apiKey" in configured, false);
    assert.equal("baseUrl" in configured, false);
  });

  it("is disabled and unconfigured by default", () => {
    const client = new CallEClient({ apiKey: "server-only" });
    assert.equal(client.isConfigured(), false);
    assert.equal(isAllowedBaseUrl(CALL_E_PRODUCTION_BASE_URL), true);
    assert.equal(isAllowedBaseUrl(CALL_E_TEST_BASE_URL), true);
    assert.equal(isAllowedBaseUrl("https://example.com"), false);
    assert.equal(isAllowedBaseUrl("https://api.heycall-e.com.evil.test"), false);
    assert.equal(isAllowedBaseUrl("http://api.heycall-e.com"), false);
  });

  it("uses bearer auth and the idempotency header for a create call", async () => {
    let observed;
    const client = new CallEClient({
      enabled: true,
      apiKey: "server-secret-for-test",
      baseUrl: CALL_E_TEST_BASE_URL,
      fetchFn: async (url, options) => {
        observed = { url, options };
        return jsonResponse(202, { id: "call_test_123", object: "call", status: "queued", call_outcome: null, result_status: "pending", transcript: [], result: null, error: null });
      },
    });
    assert.equal(client.isConfigured(), true);
    const response = await client.createCall({ task: "Synthetic task", phone: "+14155550123", result_schema: {} }, "voicednut:call-e:test-123");
    assert.equal(response.id, "call_test_123");
    assert.equal(observed.url, `${CALL_E_TEST_BASE_URL}/v2/calls`);
    assert.equal(observed.options.headers.Authorization, "Bearer server-secret-for-test");
    assert.equal(observed.options.headers["Idempotency-Key"], "voicednut:call-e:test-123");
    assert.equal(observed.options.method, "POST");
  });

  it("emits low-cardinality request metrics without provider IDs, destination, task, or credentials", async () => {
    const metrics = [];
    const client = new CallEClient({
      enabled: true,
      apiKey: "private-metric-test-key",
      fetchFn: async () => jsonResponse(202, { id: "call_sensitive_123", object: "call" }),
      onMetric(metric) { metrics.push(metric); },
    });
    await client.createCall({ task: "private task", phone: "+14155550123" }, "private-idempotency-key");
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].operation, "call.create");
    assert.equal(metrics[0].method, "POST");
    assert.equal(metrics[0].outcome, "success");
    assert.equal(metrics[0].statusCode, 202);
    assert.equal(Number.isFinite(metrics[0].durationMs), true);
    const serialized = JSON.stringify(metrics);
    for (const privateValue of ["call_sensitive_123", "+14155550123", "private task", "private-idempotency-key", "private-metric-test-key"]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  });

  it("restricts call reads, cancel and event cursors to documented, bounded paths", async () => {
    const urls = [];
    const client = new CallEClient({ enabled: true, apiKey: "test-key", fetchFn: async (url) => {
      urls.push(url);
      return jsonResponse(200, { id: "call_test_123", object: "call" });
    } });
    await client.getCall("call_test_123");
    await client.cancelCall("call_test_123");
    await client.listCallEvents("call_test_123", { cursor: "evt_1", limit: 1000 });
    assert.equal(urls[0], `${CALL_E_PRODUCTION_BASE_URL}/v2/calls/call_test_123`);
    assert.equal(urls[1], `${CALL_E_PRODUCTION_BASE_URL}/v2/calls/call_test_123/cancel`);
    assert.equal(urls[2], `${CALL_E_PRODUCTION_BASE_URL}/v2/calls/call_test_123/events?limit=100&cursor=evt_1`);
    assert.throws(() => client.getCall("../secret"), (error) => error.code === "call_e_invalid_call_id");
    assert.throws(() => client.listCallEvents("call_test_123", { cursor: "x".repeat(513) }), (error) => error.code === "call_e_invalid_cursor");
  });

  it("returns sanitized errors and marks only documented pre-acceptance errors as no-call", async () => {
    const client = new CallEClient({ enabled: true, apiKey: "secret", fetchFn: async () => jsonResponse(422, {
      error: { code: "unsupported_region", message: "sensitive provider detail" },
    }) });
    await assert.rejects(client.createCall({ task: "x" }, "voicednut:call-e:key"), (error) => {
      assert.ok(error instanceof CallEApiError);
      assert.equal(error.code, "call_e_unsupported_region");
      assert.equal(error.noCallCreated, true);
      assert.equal(error.message.includes("sensitive provider detail"), false);
      return true;
    });

    const generic = new CallEClient({ enabled: true, apiKey: "secret", fetchFn: async () => jsonResponse(409, {
      error: { code: "idempotency_conflict", message: "private detail", details: { reason_code: "creation_in_progress" } },
    }) });
    await assert.rejects(generic.createCall({ task: "x" }, "voicednut:call-e:key"), (error) => {
      assert.equal(error.code, "call_e_idempotency_conflict");
      assert.equal(error.noCallCreated, false);
      assert.equal(error.providerCode, "idempotency_conflict");
      assert.equal(error.reasonCode, "creation_in_progress");
      assert.equal(error.recoveryAction, "backoff_same_request_and_idempotency_key");
      assert.equal(error.message.includes("private detail"), false);
      return true;
    });
  });

  it("preserves rate-limit classification without retrying", async () => {
    let attempts = 0;
    const client = new CallEClient({ enabled: true, apiKey: "secret", fetchFn: async () => {
      attempts += 1;
      return jsonResponse(429, { error: { code: "rate_limit_exceeded" } });
    } });
    await assert.rejects(client.getCall("call_test_123"), (error) => {
      assert.equal(error.code, "call_e_rate_limit_exceeded");
      assert.equal(error.retryable, true);
      assert.equal(error.recoveryAction, "backoff_same_request_and_idempotency_key");
      return true;
    });
    assert.equal(attempts, 1);
  });

  it("keeps test/prod configuration explicit and never retries requests automatically", async () => {
    const previousBase = process.env.CALLE_BASE_URL;
    const previousEnabled = process.env.CALLE_ENABLED;
    process.env.CALLE_ENABLED = "true";
    process.env.CALLE_BASE_URL = CALL_E_TEST_BASE_URL;
    try {
      const client = createCallEClientFromEnv({ apiKey: "test-only", fetchFn: async () => { throw new Error("network down"); } });
      assert.equal(client.baseUrl, CALL_E_TEST_BASE_URL);
      let attempts = 0;
      client.fetch = async () => { attempts += 1; throw new Error("network down"); };
      await assert.rejects(client.createCall({ task: "x" }, "voicednut:call-e:key"), (error) => error.code === "call_e_network_error");
      assert.equal(attempts, 1);
    } finally {
      if (previousBase === undefined) delete process.env.CALLE_BASE_URL;
      else process.env.CALLE_BASE_URL = previousBase;
      if (previousEnabled === undefined) delete process.env.CALLE_ENABLED;
      else process.env.CALLE_ENABLED = previousEnabled;
    }
  });
});
