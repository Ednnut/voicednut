<<<<<<< HEAD
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
=======
const assert = require('node:assert/strict');
const { CartesiaApiError, CartesiaClient } = require('../services/cartesiaClient');

const TEST_API_KEY = 'sk_car_test_secret';

function makeClient(overrides = {}) {
  return new CartesiaClient({
    enabled: true,
    apiKey: TEST_API_KEY,
    apiVersion: '2026-08-14',
    timeoutMs: 5000,
    ...overrides,
  });
}

function successResponse(payload = { data: [], has_more: false, next_page: null }) {
  return { ok: true, status: 200, json: async () => payload };
}

describe('Cartesia Managed Agents client configuration and authentication', () => {
  it('keeps the integration disabled by default and does not call Cartesia', async () => {
    let fetchCalled = false;
    const client = makeClient({ enabled: false, fetchFn: async () => { fetchCalled = true; } });

    assert.deepEqual(client.getConfigurationStatus(), {
      enabled: false,
      configured: false,
      apiVersion: '2026-08-14',
    });
    await assert.rejects(client.validateCredentials(), { code: 'cartesia_disabled' });
    assert.equal(fetchCalled, false);
  });

  it('validates credentials through the documented read-only agents endpoint and returns no account data', async () => {
    let request;
    const client = makeClient({
      fetchFn: async (url, options) => {
        request = { url, options };
        return successResponse({
          data: [{ id: 'agent-private-id', name: 'Private agent', description: 'private', version_id: 'version' }],
          has_more: false,
          next_page: null,
        });
      },
    });

    const result = await client.validateCredentials();

    assert.deepEqual(result, { valid: true });
    assert.equal(request.url, 'https://api.cartesia.ai/v1/agents?limit=1');
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.headers.Authorization, `Bearer ${TEST_API_KEY}`);
    assert.equal(request.options.headers['Cartesia-Version'], '2026-08-14');
    assert.equal(request.options.headers.Accept, 'application/json');
    assert.equal(JSON.stringify(result).includes('agent-private-id'), false);
  });

  it('does not call Cartesia when the server key is missing or is an admin key', async () => {
    let fetchCalls = 0;
    const fetchFn = async () => { fetchCalls += 1; };
    const missingKeyClient = makeClient({ apiKey: '', fetchFn });
    const adminKeyClient = makeClient({ apiKey: 'sk_car_admin_test', fetchFn });

    await assert.rejects(missingKeyClient.validateCredentials(), { code: 'cartesia_not_configured' });
    await assert.rejects(adminKeyClient.validateCredentials(), { code: 'cartesia_invalid_key_type' });
    assert.equal(fetchCalls, 0);
  });

  it('sanitizes provider errors and never returns provider messages or credentials', async () => {
    const rawProviderMessage = `invalid key ${TEST_API_KEY}`;
    const client = makeClient({
      fetchFn: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error_code: 'unauthorized', title: 'Unauthorized', message: rawProviderMessage }),
      }),
    });

    await assert.rejects(client.validateCredentials(), (error) => {
      assert.ok(error instanceof CartesiaApiError);
      assert.equal(error.code, 'cartesia_unauthorized');
      assert.equal(error.status, 401);
      assert.equal(error.message.includes(TEST_API_KEY), false);
      assert.equal(error.message.includes(rawProviderMessage), false);
>>>>>>> 95a068c (updated)
      return true;
    });
  });

<<<<<<< HEAD
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
=======
  it('reports malformed success responses without returning payloads', async () => {
    const client = makeClient({ fetchFn: async () => successResponse({ data: 'unexpected' }) });
    await assert.rejects(client.validateCredentials(), { code: 'cartesia_invalid_response' });
  });

  it('uses the documented Managed Agents outbound call contract without adding an undocumented idempotency header', async () => {
    let request;
    const client = makeClient({
      fetchFn: async (url, options) => {
        request = { url, options };
        return successResponse({ calls: [{ number: '+15555550123', agent_call_id: 'ac_test_call_01', error: null }] });
      },
    });
    const payload = {
      from_number_id: 'phone_number_test',
      agent_id: 'agent_test',
      outbound_calls: [{ to_number: '+15555550123', dynamic_variables: { customer_name: 'Example' } }],
      ringing_timeout_seconds: 30,
    };

    const response = await client.createOutboundCall(payload);

    assert.equal(request.url, 'https://api.cartesia.ai/agents/calls');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['Cartesia-Version'], '2026-08-14');
    assert.deepEqual(JSON.parse(request.options.body), payload);
    assert.equal(request.options.headers['Idempotency-Key'], undefined);
    assert.equal(response.calls[0].agent_call_id, 'ac_test_call_01');
  });

  it('creates, lists, reads, and cancels batches through the documented versioned endpoints', async () => {
    const requests = [];
    const batch = {
      id: 'batch_test_01', name: 'Test batch', agent_id: 'agent_test', from_number_id: 'phone_test', region: 'US',
      target_concurrency_limit: 2, status: 'pending', total_calls_scheduled: 1, total_calls_dispatched: 0,
      total_calls_finished: 0, retry_count: 0,
    };
    const client = makeClient({ fetchFn: async (url, options) => {
      requests.push({ url, options });
      return successResponse(options.method === 'GET' && url.endsWith('/batches') ? { data: [batch], has_more: false, next_page: null } : batch);
    } });
    const createPayload = { name: 'Test batch', agent_id: 'agent_test', from_number_id: 'phone_test', recipients: [{ to_number: '+15555550123', dynamic_variables: {} }] };
    await client.createCallBatch(createPayload);
    await client.listCallBatches({ limit: 20, starting_after: 'batch_cursor_01', agent_id: 'agent_test' });
    await client.getCallBatch('batch_test_01');
    await client.cancelCallBatch('batch_test_01');
    assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
      ['https://api.cartesia.ai/agents/calls/batches', 'POST'],
      ['https://api.cartesia.ai/agents/calls/batches?limit=20&starting_after=batch_cursor_01&agent_id=agent_test', 'GET'],
      ['https://api.cartesia.ai/agents/calls/batches/batch_test_01', 'GET'],
      ['https://api.cartesia.ai/agents/calls/batches/batch_test_01/cancel', 'POST'],
    ]);
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${TEST_API_KEY}`);
    assert.equal(requests[0].options.headers['Cartesia-Version'], '2026-08-14');
    assert.deepEqual(JSON.parse(requests[0].options.body), createPayload);
    await assert.rejects(client.getCallBatch('../escape'), { code: 'cartesia_invalid_batch_id' });
    await assert.rejects(client.cancelCallBatch('../escape'), { code: 'cartesia_invalid_batch_id' });
    assert.equal(requests.length, 4);
  });

  it('reads and cancels only validated Cartesia call IDs through documented paths', async () => {
    const requests = [];
    const client = makeClient({
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        return successResponse(options.method === 'POST' ? { cancelled: true } : {
          id: 'ac_test_call_01', agent_id: 'agent_test', status: 'started',
        });
      },
    });

    assert.equal((await client.getCall('ac_test_call_01')).status, 'started');
    assert.deepEqual(await client.cancelCall('ac_test_call_01'), { cancelled: true });
    assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
      ['https://api.cartesia.ai/agents/calls/ac_test_call_01', 'GET'],
      ['https://api.cartesia.ai/agents/calls/ac_test_call_01/cancel', 'POST'],
    ]);
    await assert.rejects(client.getCall('../escape'), { code: 'cartesia_invalid_call_id' });
    await assert.rejects(client.cancelCall('../escape'), { code: 'cartesia_invalid_call_id' });
    assert.equal(requests.length, 2);
  });

  it('reads agents and webhooks and assigns a webhook using the documented update field', async () => {
    const requests = [];
    const client = makeClient({
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        if (options.method === 'PATCH') return successResponse({ id: 'agent_test_01', webhook_id: 'webhook_test_01' });
        return successResponse(url.endsWith('/webhook_test_01')
          ? { id: 'webhook_test_01', url: 'https://voice.example.test/api/webhooks/cartesia' }
          : { id: 'agent_test_01', webhook_id: null });
      },
    });

    assert.deepEqual(await client.getAgent('agent_test_01'), { id: 'agent_test_01', webhook_id: null });
    assert.deepEqual(await client.getWebhook('webhook_test_01'), {
      id: 'webhook_test_01', url: 'https://voice.example.test/api/webhooks/cartesia',
    });
    await client.updateAgentWebhook('agent_test_01', 'webhook_test_01');
    assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
      ['https://api.cartesia.ai/agents/agent_test_01', 'GET'],
      ['https://api.cartesia.ai/agents/webhooks/webhook_test_01', 'GET'],
      ['https://api.cartesia.ai/agents/agent_test_01', 'PATCH'],
    ]);
    assert.deepEqual(JSON.parse(requests[2].options.body), { webhook_id: 'webhook_test_01' });
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${TEST_API_KEY}`);
    assert.equal(requests[0].options.headers['Cartesia-Version'], '2026-08-14');
    await assert.rejects(client.getAgent('../escape'), { code: 'cartesia_invalid_agent_id' });
    await assert.rejects(client.getWebhook('../escape'), { code: 'cartesia_invalid_webhook_id' });
    await assert.rejects(client.updateAgentWebhook('agent_test_01', 'bad/id'), { code: 'cartesia_agent_webhook_assignment_invalid' });
    assert.equal(requests.length, 3);
  });

  it('creates a webhook with the documented endpoint and server secret over Bearer-authenticated HTTPS API', async () => {
    let request;
    const client = makeClient({
      fetchFn: async (url, options) => {
        request = { url, options };
        return successResponse({
          id: 'webhook_test_01',
          url: 'https://voice.example.test/api/webhooks/cartesia',
          secret: 'shared-test-secret',
        });
      },
    });
    const payload = { url: 'https://voice.example.test/api/webhooks/cartesia', secret: 'shared-test-secret' };
    const response = await client.createWebhook(payload);
    assert.equal(response.id, 'webhook_test_01');
    assert.equal(request.url, 'https://api.cartesia.ai/agents/webhooks');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, `Bearer ${TEST_API_KEY}`);
    assert.equal(request.options.headers['Cartesia-Version'], '2026-08-14');
    assert.deepEqual(JSON.parse(request.options.body), payload);
    await assert.rejects(client.createWebhook({ ...payload, url: 'http://voice.example.test/hook' }), {
      code: 'cartesia_webhook_create_invalid',
    });
    await assert.rejects(client.createWebhook({ ...payload, secret: '' }), {
      code: 'cartesia_webhook_create_invalid',
    });
  });

  it('lists, reads, and updates phone numbers using the current Managed Agents paths', async () => {
    const requests = [];
    const client = makeClient({
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        return successResponse(options.method === 'PATCH'
          ? { id: 'pn_test_01', number: '+15555550123', agent: { id: 'agent_test' }, provider: { type: 'twilio', id: 'provider_1' } }
          : { data: [], has_more: false });
      },
    });

    await client.listPhoneNumbers({ limit: 20, type: 'twilio', starting_after: 'pn_cursor' });
    await client.getPhoneNumber('pn_test_01');
    await client.updatePhoneNumber('pn_test_01', { agent_id: null });

    assert.equal(requests[0].url, 'https://api.cartesia.ai/agents/phone-numbers?limit=20&type=twilio&starting_after=pn_cursor');
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[1].url, 'https://api.cartesia.ai/agents/phone-numbers/pn_test_01');
    assert.equal(requests[2].url, 'https://api.cartesia.ai/agents/phone-numbers/pn_test_01');
    assert.equal(requests[2].options.method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[2].options.body), { agent_id: null });
    await assert.rejects(client.getPhoneNumber('../escape'), { code: 'cartesia_invalid_phone_number_id' });
    await assert.rejects(client.updatePhoneNumber('pn_test_01', { label: 'unsafe' }), { code: 'cartesia_phone_number_update_invalid' });
    assert.equal(requests.length, 3);
  });

  it('lists providers and creates SIP trunks with the current bearer auth and version headers', async () => {
    const requests = [];
    const client = makeClient({
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        return successResponse(options.method === 'POST'
          ? { id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier' }
          : []);
      },
    });
    const payload = {
      type: 'sip_trunk',
      label: 'Carrier',
      inbound: { credentials: { username: 'inbound', password: 'secret' }, media_encryption: 'allowed' },
      outbound: {
        address: 'sip.carrier.example', transport: 'tls', destination_country: 'US',
        media_encryption: 'required', credentials: { username: 'outbound', password: 'secret' },
      },
    };

    assert.deepEqual(await client.listTelephonyProviders(), []);
    assert.equal((await client.createSipProvider(payload)).id, 'provider_sip_01');
    assert.equal(requests[0].url, 'https://api.cartesia.ai/agents/phone-numbers/providers');
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[1].url, 'https://api.cartesia.ai/agents/phone-numbers/providers');
    assert.equal(requests[1].options.method, 'POST');
    assert.equal(requests[1].options.headers.Authorization, `Bearer ${TEST_API_KEY}`);
    assert.equal(requests[1].options.headers['Cartesia-Version'], '2026-08-14');
    assert.deepEqual(JSON.parse(requests[1].options.body), payload);
    await assert.rejects(client.createSipProvider({ type: 'twilio' }), {
      code: 'cartesia_sip_provider_request_invalid',
    });
  });

  it('imports, provisions, and deletes phone numbers with the documented paths and handles 204', async () => {
    const requests = [];
    const client = makeClient({
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        if (options.method === 'DELETE') return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
        return successResponse({ id: 'pn_test_01', number: '+15555550123', agent: null, provider: { type: 'sip_trunk', id: 'provider_01' } });
      },
    });
    const importPayload = { label: 'Imported line', number: '+15555550123', provider: { id: 'provider_01' }, agent_id: 'agent_01' };
    const provisionPayload = { label: 'New line', agent_id: 'agent_01' };

    assert.equal((await client.importPhoneNumber(importPayload)).id, 'pn_test_01');
    assert.equal((await client.provisionPhoneNumber(provisionPayload)).id, 'pn_test_01');
    assert.deepEqual(await client.deletePhoneNumber('pn_test_01'), { success: true });
    assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
      ['https://api.cartesia.ai/agents/phone-numbers', 'POST'],
      ['https://api.cartesia.ai/agents/phone-numbers/provision', 'POST'],
      ['https://api.cartesia.ai/agents/phone-numbers/pn_test_01', 'DELETE'],
    ]);
    assert.deepEqual(JSON.parse(requests[0].options.body), importPayload);
    assert.deepEqual(JSON.parse(requests[1].options.body), provisionPayload);
    await assert.rejects(client.importPhoneNumber({ ...importPayload, extra: true }), { code: 'cartesia_phone_number_import_invalid' });
    await assert.rejects(client.deletePhoneNumber('../escape'), { code: 'cartesia_invalid_phone_number_id' });
    assert.equal(requests.length, 3);
  });

  it('links Twilio providers through the documented provider endpoint without changing auth conventions', async () => {
    let request;
    const client = makeClient({
      fetchFn: async (url, options) => {
        request = { url, options };
        return successResponse({ id: 'provider_twilio_01', type: 'twilio', label: 'Twilio', region: 'us1' });
      },
    });
    const payload = {
      type: 'twilio', account_sid: `AC${'a'.repeat(32)}`, api_key_sid: `SK${'b'.repeat(32)}`,
      api_key_secret: 'test-twilio-api-secret', region: 'us1', label: 'Twilio',
    };
    assert.equal((await client.createTwilioProvider(payload)).id, 'provider_twilio_01');
    assert.equal(request.url, 'https://api.cartesia.ai/agents/phone-numbers/providers');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, `Bearer ${TEST_API_KEY}`);
    assert.equal(request.options.headers['Cartesia-Version'], '2026-08-14');
    assert.deepEqual(JSON.parse(request.options.body), payload);
    await assert.rejects(client.createTwilioProvider({ ...payload, extra: true }), {
      code: 'cartesia_twilio_provider_request_invalid',
    });
  });

  it('reads, rotates Twilio credentials, and deletes providers through documented paths', async () => {
    const requests = [];
    const client = makeClient({
      fetchFn: async (url, options) => {
        requests.push({ url, options });
        if (options.method === 'DELETE') return { ok: true, status: 204, json: async () => { throw new Error('empty response'); } };
        return successResponse({
          id: 'provider_twilio_01', type: 'twilio', account_sid: `AC${'a'.repeat(32)}`,
          api_key_sid: 'SK1234...wxyz', region: 'ie1', label: 'Twilio',
        });
      },
    });
    const update = { type: 'twilio', api_key_sid: `SK${'b'.repeat(32)}`, api_key_secret: 'new-private-secret', region: 'ie1' };
    assert.equal((await client.getTelephonyProvider('provider_twilio_01')).id, 'provider_twilio_01');
    assert.equal((await client.updateTwilioProvider('provider_twilio_01', update)).region, 'ie1');
    assert.deepEqual(await client.deleteTelephonyProvider('provider_twilio_01'), { success: true });
    assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
      ['https://api.cartesia.ai/agents/phone-numbers/providers/provider_twilio_01', 'GET'],
      ['https://api.cartesia.ai/agents/phone-numbers/providers/provider_twilio_01', 'PATCH'],
      ['https://api.cartesia.ai/agents/phone-numbers/providers/provider_twilio_01', 'DELETE'],
    ]);
    assert.deepEqual(JSON.parse(requests[1].options.body), update);
    assert.equal(requests[1].options.headers['Cartesia-Version'], '2026-08-14');
    await assert.rejects(client.getTelephonyProvider('../escape'), { code: 'cartesia_invalid_provider_id' });
    await assert.rejects(client.deleteTelephonyProvider('../escape'), { code: 'cartesia_invalid_provider_id' });
    await assert.rejects(client.updateTwilioProvider('provider_twilio_01', { ...update, extra: true }), {
      code: 'cartesia_twilio_provider_update_invalid',
    });
  });

  it('updates SIP providers through the documented partial-update endpoint shape', async () => {
    let request;
    const client = makeClient({
      fetchFn: async (url, options) => {
        request = { url, options };
        return successResponse({ id: 'provider_sip_01', type: 'sip_trunk', label: 'Carrier' });
      },
    });
    const payload = {
      type: 'sip_trunk',
      inbound: { allowed_addresses: ['198.51.100.0/24'], media_encryption: 'required' },
      outbound: {
        address: 'sip.carrier.example', transport: 'tls', destination_country: 'US',
        media_encryption: 'required',
      },
    };
    assert.equal((await client.updateSipProvider('provider_sip_01', payload)).type, 'sip_trunk');
    assert.equal(request.url, 'https://api.cartesia.ai/agents/phone-numbers/providers/provider_sip_01');
    assert.equal(request.options.method, 'PATCH');
    assert.equal(request.options.headers['Cartesia-Version'], '2026-08-14');
    assert.deepEqual(JSON.parse(request.options.body), payload);
    await assert.rejects(client.updateSipProvider('provider_sip_01', { ...payload, extra: true }), {
      code: 'cartesia_sip_provider_update_invalid',
    });
  });

  it('bounds the request and classifies timeouts without leaking the fetch error', async () => {
    let requestOptions;
    const client = makeClient({
      timeoutMs: 1500,
      fetchFn: async (_url, options) => {
        requestOptions = options;
        const error = new Error(`timeout with ${TEST_API_KEY}`);
        error.name = 'AbortError';
        throw error;
      },
    });

    await assert.rejects(client.validateCredentials(), (error) => {
      assert.equal(error.code, 'cartesia_timeout');
      assert.equal(error.message.includes(TEST_API_KEY), false);
      return true;
    });
    assert.equal(requestOptions.signal.aborted, false);
>>>>>>> 95a068c (updated)
  });
});
