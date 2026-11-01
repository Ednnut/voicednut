"use strict";

const assert = require("node:assert/strict");
const { CartesiaClient, CARTESIA_API_VERSION } = require("../services/cartesiaClient");

describe("CartesiaClient", () => {
  it("submits the documented single-call shape with server-side auth and pinned API version", async () => {
    let request;
    const client = new CartesiaClient({
      apiKey: "sk_car_test",
      enabled: true,
      dispatchEnabled: true,
      fetch: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, json: async () => ({ calls: [{ number: "+14155550123", agent_call_id: "agent_call_123", error: {} }] }) };
      },
    });

    const result = await client.createOutboundCall({
      agentId: "agent_1", fromNumberId: "ap_number_1", toNumber: "+14155550123",
      dynamicVariables: {}, ringingTimeoutSeconds: 30, maxCallDurationMinutes: 30,
    });

    assert.deepEqual(result, { providerCallId: "agent_call_123", status: "queued" });
    assert.equal(request.url, "https://api.cartesia.ai/agents/calls");
    assert.equal(request.options.headers.Authorization, "Bearer sk_car_test");
    assert.equal(request.options.headers["Cartesia-Version"], CARTESIA_API_VERSION);
    assert.deepEqual(JSON.parse(request.options.body), {
      from_number_id: "ap_number_1",
      agent_id: "agent_1",
      outbound_calls: [{ to_number: "+14155550123", dynamic_variables: {} }],
      ringing_timeout_seconds: 30,
      max_call_duration_minutes: 30,
    });
  });

  it("submits one documented batch request and marks transport uncertainty without retrying", async () => {
    let request;
    let attempts = 0;
    const client = new CartesiaClient({
      apiKey: "sk_car_test", enabled: true, dispatchEnabled: true,
      fetch: async (url, options) => {
        attempts += 1;
        request = { url, options };
        return { ok: true, status: 200, json: async () => ({ id: "batch_1", status: "queued" }) };
      },
    });
    assert.deepEqual(await client.createCallBatch({
      name: "vn-campaign", agentId: "agent_1", fromNumberId: "number_1", targetConcurrencyLimit: 2,
      recipients: [{ to_number: "+14155550123", dynamic_variables: { tag: "campaign" } }],
    }), { batchId: "batch_1", status: "queued", createdAt: null });
    assert.equal(attempts, 1);
    assert.equal(request.url, "https://api.cartesia.ai/agents/calls/batches");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.Authorization, "Bearer sk_car_test");
    assert.equal(request.options.headers["Cartesia-Version"], CARTESIA_API_VERSION);
    assert.deepEqual(JSON.parse(request.options.body), {
      name: "vn-campaign", agent_id: "agent_1", from_number_id: "number_1",
      recipients: [{ to_number: "+14155550123", dynamic_variables: { tag: "campaign" } }],
      target_concurrency_limit: 2,
    });
    const uncertain = new CartesiaClient({
      apiKey: "sk_car_test", enabled: true, dispatchEnabled: true,
      fetch: async () => { attempts += 1; throw new Error("connection reset"); },
    });
    await assert.rejects(uncertain.createCallBatch({}), { code: "cartesia_batch_transport_error", providerSubmissionState: "unknown" });
    assert.equal(attempts, 2);
  });

  it("fails closed when either dispatch gate or the credential is missing", async () => {
    const client = new CartesiaClient({ enabled: true, dispatchEnabled: false, apiKey: "sk_car_test", fetch: async () => { throw new Error("must not send"); } });
    await assert.rejects(client.createOutboundCall({}), { code: "cartesia_not_configured", providerSubmissionState: "not_submitted" });
  });

  it("does not retry or convert transport uncertainty into a safe rejection", async () => {
    const client = new CartesiaClient({ enabled: true, dispatchEnabled: true, apiKey: "sk_car_test", fetch: async () => { throw new Error("network reset"); } });
    await assert.rejects(client.createOutboundCall({}), { code: "cartesia_call_transport_error", providerSubmissionState: "unknown", retryable: false });
  });

  it("marks explicit provider rejection without exposing response details", async () => {
    const client = new CartesiaClient({
      enabled: true, dispatchEnabled: true, apiKey: "sk_car_test",
      fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: "private provider text" }) }),
    });
    await assert.rejects(client.createOutboundCall({}), (error) => {
      assert.equal(error.code, "cartesia_call_rejected");
      assert.equal(error.providerSubmissionState, "rejected");
      assert.doesNotMatch(error.message, /private provider text/);
      return true;
    });
  });

  it("looks up a call with the versioned, authenticated GET contract", async () => {
    let request;
    const client = new CartesiaClient({ enabled: true, dispatchEnabled: false, apiKey: "sk_car_test", fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ id: "call_1", status: "started" }) };
    } });
    assert.deepEqual(await client.getCall("call_1"), { id: "call_1", status: "started" });
    assert.equal(request.url, "https://api.cartesia.ai/agents/calls/call_1");
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.headers.Authorization, "Bearer sk_car_test");
    assert.equal(request.options.headers["Cartesia-Version"], CARTESIA_API_VERSION);
  });

  it("downloads bounded call audio and deletes a call only through the documented endpoints", async () => {
    const requests = [];
    const client = new CartesiaClient({ enabled: true, dispatchEnabled: false, apiKey: "sk_car_test", fetch: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "DELETE") return { ok: true, status: 204 };
      const audio = Buffer.from([1, 2, 3, 4]);
      return { ok: true, status: 200, headers: { get: () => String(audio.length) }, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) };
    } });
    const audio = await client.getCallAudio("call_1");
    assert.deepEqual(audio, { bytes: Buffer.from([1, 2, 3, 4]), contentType: "audio/wav" });
    assert.deepEqual(await client.deleteCall("call_1"), { deleted: true });
    assert.equal(requests[0].url, "https://api.cartesia.ai/agents/calls/call_1/audio");
    assert.equal(requests[0].options.headers["Cartesia-Version"], CARTESIA_API_VERSION);
    assert.equal(requests[1].options.method, "DELETE");
    await assert.rejects(client.getCallAudio("bad/id"), { code: "cartesia_call_id_invalid" });
  });

  it("lists calls with an agent and bounded time filter plus the documented cursor", async () => {
    let request;
    const client = new CartesiaClient({ enabled: true, dispatchEnabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      request = { url: new URL(url), options };
      return { ok: true, status: 200, json: async () => ({ data: [], has_more: false, next_page: null }) };
    } });
    await client.listCalls({ agentId: "agent_1", startTimeGte: "2026-10-31T11:00:00.000Z", limit: 100, startingAfter: "call_prev" });
    assert.equal(request.url.pathname, "/agents/calls");
    assert.equal(request.url.searchParams.get("agent_id"), "agent_1");
    assert.equal(request.url.searchParams.get("start_time_gte"), "2026-10-31T11:00:00.000Z");
    assert.equal(request.url.searchParams.get("starting_after"), "call_prev");
    assert.equal(request.url.searchParams.get("limit"), "100");
    assert.equal(request.options.method, "GET");
  });

  it('requests transcript expansion only when the official review-queue filter needs tool-call names', async () => {
    let request;
    const client = new CartesiaClient({ enabled: true, apiKey: 'sk_car_test', fetch: async (url, options) => {
      request = { url: new URL(url), options };
      return { ok: true, status: 200, json: async () => ({ data: [], has_more: false }) };
    } });
    await client.listCalls({ agentId: 'agent_1', startTimeGte: '2026-10-31T10:00:00Z', expandTranscript: true });
    assert.equal(request.url.searchParams.get('expand'), 'transcript');
    assert.equal(request.options.headers['Cartesia-Version'], CARTESIA_API_VERSION);
  });

  it("keeps read-only recovery available when outbound dispatch is disabled", async () => {
    const client = new CartesiaClient({
      enabled: true, dispatchEnabled: false, apiKey: "sk_car_test",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ id: "call_1", agent_id: "agent_1", status: "completed" }) }),
    });
    assert.equal(client.isConfigured(), false);
    assert.equal(client.isReadConfigured(), true);
    assert.deepEqual(await client.getCall("call_1"), { id: "call_1", agent_id: "agent_1", status: "completed" });
    await assert.rejects(client.createOutboundCall({}), { code: "cartesia_not_configured" });
  });

  it("uses the documented account agent inventory endpoint", async () => {
    let request;
    const client = new CartesiaClient({ enabled: true, dispatchEnabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ summaries: [{ id: "agent_1", phone_numbers: [] }] }) };
    } });
    assert.deepEqual(await client.listAgents(), { summaries: [{ id: "agent_1", phone_numbers: [] }] });
    assert.equal(request.url, "https://api.cartesia.ai/v1/agents");
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.headers["Cartesia-Version"], CARTESIA_API_VERSION);
  });

  it("reads documented agent and deployment inventory/detail endpoints with versioned server auth", async () => {
    const requests = [];
    const client = new CartesiaClient({ enabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => url.endsWith("/deployments") ? [] : { id: "agent_1" } };
    } });
    assert.deepEqual(await client.getAgent("agent_1"), { id: "agent_1" });
    assert.deepEqual(await client.listAgentDeployments("agent_1"), []);
    assert.deepEqual(await client.getDeployment("deploy_1"), { id: "agent_1" });
    assert.deepEqual(requests.map((request) => request.url), [
      "https://api.cartesia.ai/agents/agent_1",
      "https://api.cartesia.ai/agents/agent_1/deployments",
      "https://api.cartesia.ai/agents/deployments/deploy_1",
    ]);
    for (const { options } of requests) {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer sk_car_test");
      assert.equal(options.headers["Cartesia-Version"], CARTESIA_API_VERSION);
    }
    await assert.rejects(client.getAgent("../agent"), { code: "cartesia_agent_id_invalid" });
    await assert.rejects(client.getDeployment("bad/id"), { code: "cartesia_deployment_id_invalid" });
  });

  it("cancels a call through the documented versioned endpoint without retrying", async () => {
    let request;
    const client = new CartesiaClient({ enabled: true, dispatchEnabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ cancelled: true }) };
    } });
    assert.deepEqual(await client.cancelCall("call_1"), { cancelled: true });
    assert.equal(request.url, "https://api.cartesia.ai/agents/calls/call_1/cancel");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.Authorization, "Bearer sk_car_test");
    assert.equal(request.options.headers["Cartesia-Version"], CARTESIA_API_VERSION);
    await assert.rejects(client.cancelCall("bad/id"), { code: "cartesia_call_id_invalid", providerSubmissionState: "not_submitted" });
    const disabled = new CartesiaClient({ enabled: true, dispatchEnabled: false, apiKey: "sk_car_test", fetch: async () => { throw new Error("must not contact Cartesia"); } });
    await assert.rejects(disabled.cancelCall("call_1"), { code: "cartesia_not_configured", providerSubmissionState: "not_submitted" });
  });

  it('uses documented batch list/detail/cancel/retry endpoints and never retries mutations', async () => {
    const requests = [];
    const client = new CartesiaClient({ enabled: true, dispatchEnabled: true, apiKey: 'sk_car_test', fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return { ok: true, status: 200, json: async () => ({ id: 'batch_1', status: 'completed', data: [], has_more: false }) };
    } });
    await client.listCallBatches({ agentId: 'agent_1', limit: 101, startingAfter: 'batch_prev' });
    await client.getCallBatch('batch_1');
    await client.cancelCallBatch('batch_1');
    await client.retryCallBatch('batch_1');
    assert.equal(requests.length, 4);
    assert.equal(requests[0].url.pathname, '/agents/calls/batches');
    assert.equal(requests[0].url.searchParams.get('limit'), '100');
    assert.equal(requests[0].url.searchParams.get('agent_id'), 'agent_1');
    assert.equal(requests[0].url.searchParams.get('starting_after'), 'batch_prev');
    assert.equal(requests[1].url.pathname, '/agents/calls/batches/batch_1');
    assert.equal(requests[2].url.pathname, '/agents/calls/batches/batch_1/cancel');
    assert.equal(requests[3].url.pathname, '/agents/calls/batches/batch_1/retry');
    for (const request of requests) {
      assert.equal(request.options.headers.Authorization, 'Bearer sk_car_test');
      assert.equal(request.options.headers['Cartesia-Version'], CARTESIA_API_VERSION);
    }
    let attempts = 0;
    const uncertain = new CartesiaClient({ enabled: true, dispatchEnabled: true, apiKey: 'sk_car_test', fetch: async () => { attempts += 1; throw new Error('timeout'); } });
    await assert.rejects(uncertain.retryCallBatch('batch_1'), { code: 'cartesia_batch_retry_transport_error', providerSubmissionState: 'unknown' });
    assert.equal(attempts, 1);
  });
});
