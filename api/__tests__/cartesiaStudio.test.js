"use strict";

const assert = require("node:assert/strict");
const { CartesiaStudioClient, CARTESIA_API_VERSION } = require("../services/cartesiaStudioClient");
const {
  CartesiaStudioService,
  validatePronunciationItems,
  validateSttKeyterms,
  normalizeSttTurnSettings,
  validateWebhookTool,
  validateClientTool,
  phraseCacheKey,
} = require("../services/cartesiaStudioService");

describe("CartesiaStudioClient", () => {
  it("uses versioned server authentication for read endpoints and documented paths", async () => {
    const requests = [];
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ id: "resource_1", data: [] }) };
    } });
    await client.listVoices({ isOwner: true, limit: 10 });
    await client.getVoice("voice_1");
    await client.listPronunciationDictionaries();
    await client.listMetricResults({ agentId: "agent_1", limit: 5 });
    await client.getCallRuntimeLogs("call_1");
    await client.listTools();
    assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
      "/voices", "/voices/voice_1", "/pronunciation-dicts/", "/agents/metrics/results", "/agents/calls/call_1/logs", "/v1/agents/tools",
    ]);
    for (const { options } of requests) {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer sk_car_test");
      assert.equal(options.headers["Cartesia-Version"], CARTESIA_API_VERSION);
    }
  });

  it("builds documented multipart requests for instant voice clones and Pro dataset files", async () => {
    const requests = [];
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/datasets/dataset_1/files")) return { ok: true, status: 204, json: async () => { throw new Error("204 has no body"); } };
      return { ok: true, status: 201, json: async () => ({ id: "voice_1", name: "Support", language: "en" }) };
    } });
    await client.cloneVoice({ clip: Buffer.from("voice sample"), name: "Support", language: "en", filename: "speaker.wav" });
    await client.uploadDatasetFile("dataset_1", { file: Buffer.from("training sample"), filename: "sample.wav" });
    assert.equal(requests[0].url, "https://api.cartesia.ai/voices/clone");
    assert.match(requests[0].options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
    assert.match(requests[0].options.body.toString(), /name="clip"; filename="speaker.wav"/);
    assert.match(requests[0].options.body.toString(), /name="access"/);
    assert.equal(requests[1].url, "https://api.cartesia.ai/datasets/dataset_1/files");
    assert.match(requests[1].options.body.toString(), /name="file"; filename="sample.wav"/);
    assert.match(requests[1].options.body.toString(), /name="purpose"\r\n\r\nfine_tune/);
    assert.equal(requests[0].options.headers["Cartesia-Version"], CARTESIA_API_VERSION);
  });

  it("posts TTS JSON, returns audio bytes, and never retries failed writes", async () => {
    let count = 0;
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      count += 1;
      assert.equal(url, "https://api.cartesia.ai/tts/bytes");
      assert.equal(options.method, "POST");
      return { ok: true, status: 200, headers: { get: () => "audio/wav" }, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
    } });
    const result = await client.generateSpeech({ transcript: "Hello", voice: "voice_1", model_id: "sonic-3.6" });
    assert.deepEqual(result.bytes, Buffer.from([1, 2, 3]));
    assert.equal(result.contentType, "audio/wav");
    assert.equal(count, 1);
  });

  it("uses documented voice lifecycle, accents, infill, agent, phone, and usage endpoints", async () => {
    const requests = [];
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", adminApiKey: "sk_admin_test", fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (options.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
      if (new URL(url).pathname === "/infill/bytes") return { ok: true, status: 200, headers: { get: () => "audio/wav" }, arrayBuffer: async () => Uint8Array.from([1, 2]).buffer };
      if (options.method === "POST" || options.method === "PATCH") return { ok: true, status: 200, json: async () => ({ id: "voice_1", is_owner: true, name: "Voice", accents: [] }) };
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    } });
    await client.listAccents({ isLocalizable: true });
    await client.localizeVoice({ voice_id: "voice_1", name: "Localized", accent: "parisian", access: "private" });
    await client.updateVoice("voice_1", { name: "Renamed" });
    await client.deleteVoice("voice_1");
    await client.addVoiceAccents("voice_1", { accents: ["parisian"] });
    await client.deleteVoiceAccent("voice_1", "accent_1");
    await client.infillSpeech({ transcript: "Hello", voiceId: "voice_1", leftAudio: { data: Buffer.from("left"), filename: "left.wav" } });
    await client.listAgents();
    await client.listAgentTemplates();
    await client.updateAgent("agent_1", { name: "Support", tts_language: "en" });
    await client.listDeployments("agent_1");
    await client.listAgentVersions("agent_1");
    await client.getManagedAgent("agent_1");
    await client.getAgentVersion("agent_1", "version_1");
    await client.restoreAgentVersion("agent_1", { model: { model: "sonic-3.6" } }, "Restore version_1");
    await client.listPhoneNumbers();
    await client.importPhoneNumber({ number: "+14155550123", provider: { id: "provider_1" }, label: "Support", agent_id: "agent_1" });
    await client.provisionPhoneNumber({ label: "Support", agent_id: "agent_1" });
    await client.updatePhoneNumber("phone_1", { agent_id: "agent_1" });
    await client.getCreditUsage({ interval: "day" });
    await client.getAgentUsage({ interval: "day" });
    assert.deepEqual(requests.map(({ url }) => `${url.pathname}${url.search}`), [
      "/accents?is_localizable=true", "/voices/localize", "/voices/voice_1", "/voices/voice_1",
      "/voices/voice_1/accents", "/voices/voice_1/accents/accent_1", "/infill/bytes", "/v1/agents",
      "/agents/templates", "/v1/agents/agent_1", "/agents/agent_1/deployments", "/v1/agents/agent_1/versions", "/v1/agents/agent_1", "/v1/agents/agent_1/versions/version_1", "/v1/agents/agent_1", "/agents/phone-numbers", "/agents/phone-numbers", "/agents/phone-numbers/provision", "/agents/phone-numbers/phone_1",
      "/usage/credits?interval=day", "/usage/agents?interval=day",
    ]);
    assert.match(requests[6].options.body.toString(), /name="left_audio"; filename="left.wav"/);
    assert.deepEqual(JSON.parse(requests[14].options.body), { config: { model: { model: "sonic-3.6" } }, version_description: "Restore version_1" });
    assert.equal(requests.at(-1).options.headers.Authorization, "Bearer sk_admin_test");
    assert.equal(requests.at(-2).options.headers.Authorization, "Bearer sk_admin_test");
    assert.ok(requests.slice(0, -2).every(({ options }) => options.headers.Authorization === "Bearer sk_car_test"));
  });

  it("requires the separate admin credential for agent usage and bounds STT multipart inputs", async () => {
    let request;
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ text: "hello", words: [] }) };
    } });
    assert.throws(() => client.getAgentUsage(), { code: "cartesia_admin_usage_not_configured" });
    await client.transcribeAudio({ file: Buffer.from("audio"), filename: "voice.wav", timestampGranularities: ["word"] });
    assert.equal(request.url, "https://api.cartesia.ai/stt");
    assert.match(request.options.body.toString(), /name="timestamp_granularities\[\]"\r\n\r\nword/);
    assert.match(request.options.body.toString(), /name="file"; filename="voice.wav"/);
  });

  it("uses the documented platform-key auth and API version for agent lifecycle webhook management", async () => {
    const requests = [];
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", adminApiKey: "sk_admin_test",
      fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ id: "agent_webhook_1", display_name: "Operations", secret: "must-not-be-returned" }) }; } });
    await client.createAgentWebhook({ url: "https://voice.example.com/webhook/cartesia", secret: "server-secret", display_name: "Operations" });
    assert.equal(requests[0].url, "https://api.cartesia.ai/agents/webhooks");
    assert.equal(requests[0].options.headers["X-API-Key"], "sk_admin_test");
    assert.equal(requests[0].options.headers["Cartesia-Version"], "2026-03-01");
    assert.equal(Object.hasOwn(requests[0].options.headers, "Authorization"), false);
    assert.deepEqual(JSON.parse(requests[0].options.body), { url: "https://voice.example.com/webhook/cartesia", secret: "server-secret", display_name: "Operations" });
  });

  it("returns the documented TTS SSE body as a stream", async () => {
    const { Readable } = require("node:stream");
    const expected = Readable.from(["data: audio-chunk\n\n"]);
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      assert.equal(url, "https://api.cartesia.ai/tts/sse");
      assert.equal(options.headers.Accept, "text/event-stream");
      return { ok: true, status: 200, body: expected, headers: { get: () => "text/event-stream" } };
    } });
    const result = await client.streamSpeech({ transcript: "Hello" });
    assert.equal(result.stream, expected);
    assert.equal(result.contentType, "text/event-stream");
    result.abort();
  });

  it("streams raw PCM to realtime STT with keyterms and the documented close command", async () => {
    const { EventEmitter } = require("node:events");
    const sent = [];
    let socketUrl;
    class FakeSocket extends EventEmitter {
      constructor(url, options) {
        super(); this.url = url; this.options = options; socketUrl = url;
        queueMicrotask(() => this.emit("open"));
      }
      send(value) {
        sent.push(value);
        if (typeof value === "string" && JSON.parse(value).type === "close") {
          queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "turn.end", transcript: "recognized words" }))));
        }
      }
      close() {}
    }
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", WebSocket: FakeSocket });
    const result = await client.transcribeAudioRealtime({ file: Buffer.alloc(6400), keyterms: ["VOICEDNUT"] });
    assert.equal(result.transcript, "recognized words");
    assert.equal(new URL(socketUrl).pathname, "/stt/turns/websocket");
    assert.equal(new URL(socketUrl).searchParams.get("keyterm"), "VOICEDNUT");
    assert.equal(new URL(socketUrl).searchParams.get("encoding"), "pcm_s16le");
    const binaryChunks = sent.filter((entry) => Buffer.isBuffer(entry));
    assert.equal(binaryChunks.length, 2);
    assert.equal(binaryChunks[0].length, 3200);
    assert.deepEqual(JSON.parse(sent.at(-1)), { type: "close" });
  });

  it("streams multiple TTS continuation segments over one mocked Cartesia context", async () => {
    const { EventEmitter } = require("node:events");
    const sent = [];
    let socketUrl;
    let socketOptions;
    class FakeSocket extends EventEmitter {
      constructor(url, options) { super(); socketUrl = url; socketOptions = options; queueMicrotask(() => this.emit("open")); }
      send(payload) {
        sent.push(JSON.parse(payload));
        if (sent.at(-1).continue === false) {
          queueMicrotask(() => {
            this.emit("message", Buffer.from(JSON.stringify({ type: "chunk", context_id: sent.at(-1).context_id, data: Buffer.from([1, 2, 3, 4]).toString("base64") })));
            this.emit("message", Buffer.from(JSON.stringify({ type: "done", context_id: sent.at(-1).context_id })));
          });
        }
      }
      close() {}
    }
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", WebSocket: FakeSocket });
    const result = await client.streamSpeechContinuations({ voice_id: "voice_1", model_id: "sonic-3.6", language: "en", transcripts: ["Hello, ", "world."] });
    const contextIds = new Set(sent.map((part) => part.context_id));
    assert.equal(new URL(socketUrl).pathname, "/tts/websocket");
    assert.equal(new URL(socketUrl).searchParams.get("api_key"), null);
    assert.equal(new URL(socketUrl).searchParams.get("cartesia_version"), CARTESIA_API_VERSION);
    assert.equal(socketOptions.headers["X-API-Key"], "sk_car_test");
    assert.equal(sent.length, 3);
    assert.equal(contextIds.size, 1);
    assert.deepEqual(sent.map((part) => [part.transcript, part.continue]), [["Hello, ", true], ["world.", true], ["", false]]);
    assert.deepEqual(result.bytes, Buffer.from([1, 2, 3, 4]));
    assert.equal(result.contentType, "audio/pcm");
  });

  it("rejects invalid continuation segment counts before opening a WebSocket", async () => {
    let opened = 0;
    class FakeSocket { constructor() { opened += 1; } }
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", WebSocket: FakeSocket });
    assert.throws(() => client.streamSpeechContinuations({ voice_id: "voice_1", transcripts: ["only one"] }), { code: "cartesia_tts_continuations_invalid" });
    assert.equal(opened, 0);
  });

  it("uses documented Cartesia paths for Pro fine-tuning, dictionaries, metrics, and tools", async () => {
    const requests = [];
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      if (options.method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id: "resource_1", status: "queued", data: [] }) };
    } });
    await client.createDataset({ name: "PVC samples" });
    await client.deleteDataset("dataset_1");
    await client.createFineTune({ name: "PVC", dataset: "dataset_1", language: "en" });
    await client.getFineTune("fine_tune_1");
    await client.listFineTuneVoices("fine_tune_1");
    await client.deleteFineTune("fine_tune_1");
    await client.createPronunciationDictionary({ name: "Terms", items: [] });
    await client.updatePronunciationDictionary("dict_1", { name: "Terms v2" });
    await client.deletePronunciationDictionary("dict_1");
    await client.createMetric({ name: "resolved", prompt: "Was the issue resolved?" });
    await client.assignMetric("agent_1", "metric_1");
    await client.createTool({ type: "webhook", name: "lookup" });
    await client.updateTool("tool_1", { name: "lookup_v2" });
    await client.deleteTool("tool_1");
    assert.deepEqual(requests.map(({ url }) => `${url.pathname}${url.search}`), [
      "/datasets", "/datasets/dataset_1", "/fine-tunes", "/fine-tunes/fine_tune_1", "/fine-tunes/fine_tune_1/voices", "/fine-tunes/fine_tune_1",
      "/pronunciation-dicts/", "/pronunciation-dicts/dict_1", "/pronunciation-dicts/dict_1",
      "/agents/metrics", "/agents/agent_1/metrics/metric_1", "/v1/agents/tools", "/v1/agents/tools/tool_1", "/v1/agents/tools/tool_1",
    ]);
    assert.equal(requests.filter(({ options }) => options.method !== "GET").length, 12);
    assert.ok(requests.every(({ options }) => options.headers["Cartesia-Version"] === CARTESIA_API_VERSION));
  });

  it("rejects invalid identifiers and oversized voice uploads before provider I/O", async () => {
    let count = 0;
    const client = new CartesiaStudioClient({ enabled: true, apiKey: "sk_car_test", fetch: async () => { count += 1; } });
    assert.throws(() => client.getVoice("../voice"), { code: "cartesia_voice_id_invalid" });
    assert.throws(() => client.cloneVoice({ clip: Buffer.alloc(16 * 1024 * 1024 + 1), name: "A", language: "en" }), { code: "cartesia_voice_clip_invalid" });
    assert.equal(count, 0);
  });
});

describe("CartesiaStudioService", () => {
  it("returns no voice prompt/configuration and enforces a private clone request", async () => {
    let received;
    const governanceRows = new Map();
    const voiceGovernanceStore = {
      async recordCartesiaVoiceConsent(row) { governanceRows.set(row.consent_id, { ...row, status: 'active', sample_count: 0 }); },
      async linkCartesiaVoiceGovernanceResource(row) { Object.assign(governanceRows.get(row.consent_id), { resource_id: row.resource_id, resource_type: row.resource_type }); return true; },
      async finishCartesiaVoiceGovernanceCreation() { return true; },
      async markCartesiaVoiceGovernanceFailure(id) { governanceRows.get(id).status = 'provider_failed'; },
      async getCartesiaVoiceGovernance(id) { return governanceRows.get(id) || null; },
      async listCartesiaVoiceGovernance() { return [...governanceRows.values()]; },
    };
    const service = new CartesiaStudioService({ client: {
      async listVoices() { return { data: [{ id: "voice_1", name: "Speaker", language: "en", is_pro: true, accents: [{ locale: "en-US", accent: "general-american", is_native: true }], prompt: "sensitive", secret: "hidden" }] }; },
      async cloneVoice(input) { received = input; return { id: "voice_2", name: input.name, language: input.language, access: input.access }; },
    }, voiceGovernanceStore });
    assert.deepEqual(await service.listVoices(), { voices: [{ id: "voice_1", name: "Speaker", language: "en", access: null, isOwner: false, isPro: true, createdAt: null, accents: [{ locale: "en-US", accent: "general-american", isNative: true }] }] });
    const clone = await service.createInstantVoiceClone({ clip: Buffer.from("synthetic"), name: "Team Voice", language: "en", access: "public", consentActorId: '7001', consentPhrase: 'I CONFIRM SPEAKER CONSENT AND CREATE CARTESIA CLONE TEAM VOICE' });
    assert.equal(received.access, "private");
    assert.equal(clone.voice.id, "voice_2");
    assert.equal(governanceRows.get(clone.consentId).resource_id, 'voice_2');
    assert.doesNotMatch(JSON.stringify(clone), /synthetic|secret|hidden/);
    await assert.rejects(service.createInstantVoiceClone({ clip: Buffer.from('mock'), name: 'No Consent', language: 'en', consentActorId: '7001' }), { code: 'cartesia_voice_consent_required' });
  });

  it("requires durable speaker consent throughout the Pro Clone dataset upload and training lifecycle", async () => {
    const rows = new Map();
    let uploads = 0;
    let tunes = 0;
    const voiceGovernanceStore = {
      async recordCartesiaVoiceConsent(row) { rows.set(row.consent_id, { ...row, status: 'active', sample_count: 0 }); },
      async linkCartesiaVoiceGovernanceResource(row) { Object.assign(rows.get(row.consent_id), { resource_id: row.resource_id, resource_type: row.resource_type }); return true; },
      async finishCartesiaVoiceGovernanceCreation(id) { rows.get(id).active_operations = 0; return true; },
      async markCartesiaVoiceGovernanceFailure(id) { rows.get(id).status = 'provider_failed'; },
      async getCartesiaVoiceGovernance(id) { return rows.get(id) || null; },
      async beginCartesiaVoiceGovernanceOperation(id, _datasetId, token) { if (rows.get(id)?.status !== 'active' || rows.get(id)?.active_operations) return false; rows.get(id).active_operations = 1; rows.get(id).operation_token = token; return true; },
      async finishCartesiaVoiceGovernanceOperation(id, token, patch = {}) { if (!rows.get(id)?.active_operations || rows.get(id).operation_token !== token) return false; rows.get(id).active_operations = 0; if (patch.sampleUploaded) rows.get(id).sample_count += 1; if (patch.fineTuneId) rows.get(id).fine_tune_id = patch.fineTuneId; return true; },
      async markCartesiaVoiceResourceDeleted(id, token) { if (rows.get(id).operation_token !== token) return false; rows.get(id).status = 'deleted'; rows.get(id).active_operations = 0; return true; },
      async listCartesiaVoiceGovernance() { return [...rows.values()]; },
      async revokeCartesiaVoiceConsent(id) { if (rows.get(id)?.status !== 'active') return false; rows.get(id).status = 'revoked'; return true; },
      async claimCartesiaVoiceGovernanceCleanup(id, _datasetId, token) { if (rows.get(id)?.active_operations) return false; rows.get(id).active_operations = 1; rows.get(id).operation_token = token; return true; },
      async clearCartesiaFineTuneLink(id) { rows.get(id).fine_tune_id = null; return true; },
    };
    const service = new CartesiaStudioService({ voiceGovernanceStore, client: {
      async createDataset() { return { id: 'dataset_1', name: 'PVC' }; },
      async uploadDatasetFile() { uploads += 1; return { id: 'file_1' }; },
      async createFineTune() { tunes += 1; return { id: 'fine_tune_1', status: 'pending' }; },
      async deleteFineTune(id) { assert.equal(id, 'fine_tune_1'); },
      async deleteDataset(id) { assert.equal(id, 'dataset_1'); },
    } });
    const created = await service.createDataset({ name: 'Support PVC', consentActorId: '7001', consentPhrase: 'CREATE CARTESIA PRO CLONE DATASET SUPPORT PVC' });
    assert.equal(created.datasetId, 'dataset_1');
    await service.uploadDatasetFile('dataset_1', { file: Buffer.from('mock'), consentId: created.consentId });
    const tune = await service.createFineTune({ dataset_id: 'dataset_1', consent_id: created.consentId, name: 'Support PVC', language: 'en' });
    assert.equal(tune.fineTuneId, 'fine_tune_1');
    assert.equal(rows.get(created.consentId).fine_tune_id, 'fine_tune_1');
    await service.revokeVoiceConsent(created.consentId);
    await assert.rejects(service.uploadDatasetFile('dataset_1', { file: Buffer.from('mock'), consentId: created.consentId }), { code: 'cartesia_voice_consent_not_active' });
    await assert.rejects(service.createFineTune({ dataset_id: 'dataset_1', consent_id: created.consentId, name: 'Support PVC', language: 'en' }), { code: 'cartesia_voice_consent_not_active' });
    assert.equal(uploads, 1);
    assert.equal(tunes, 1);
    const cleanup = await service.deleteGovernedProCloneData(created.consentId);
    assert.equal(cleanup.datasetId, 'dataset_1');
    assert.equal(cleanup.fineTuneDeleted, true);
    assert.equal(rows.get(created.consentId).status, 'deleted');
  });

  it("reports enterprise privacy capabilities without claiming remote ZDR account state", () => {
    const service = new CartesiaStudioService({ client: { isConfigured: () => true, apiVersion: '2026-08-14', apiBaseUrl: 'https://api.cartesia.ai' } });
    const status = service.getEnterpriseDataReadiness();
    assert.equal(status.providerConfigured, true);
    assert.equal(status.zeroDataRetention.remotelyVerifiable, false);
    assert.deepEqual(status.zeroDataRetention.coveredWorkflows, ['tts', 'stt']);
    assert.equal(status.endpointStatus, 'default_endpoint');
  });

  it("provides read-only readiness checks without exposing credentials or webhook payloads", async () => {
    const requested = [];
    const client = {
      enabled: true,
      apiKey: "sk_car_secret_fixture",
      adminApiKey: "sk_admin_secret_fixture",
      apiVersion: "2026-08-14",
      apiBaseUrl: "https://api.cartesia.ai",
      webhookSecret: "a-test-webhook-secret-that-is-at-least-32-chars",
      webhookUrl: "https://voice.example.com/webhook/cartesia",
      isConfigured() { return true; },
      async listVoices(query) { requested.push(["voices", query]); return { data: [{ id: "voice_1" }] }; },
      async listAgents() { requested.push(["agents"]); return { data: [{ id: "agent_1", webhook_id: "agent_webhook_1" }] }; },
      async listAgentWebhooks() { requested.push(["webhooks"]); return { webhooks: [{ id: "agent_webhook_1", url: this.webhookUrl, secret: "provider-secret" }] }; },
    };
    const service = new CartesiaStudioService({ client, webhookEventStore: {
      async listCartesiaWebhookEvents(options) {
        assert.deepEqual(options, { limit: 25 });
        return [
          { event_type: "call_completed", received_at: "2026-10-30 12:00:00", call_id: "private-call-id", webhook_request_id: "private-request-id" },
          { event_type: "call_started", received_at: "2026-10-30 11:59:00" },
        ];
      },
    } });
    const result = await service.getReadiness();
    assert.deepEqual(requested.map(([name]) => name).sort(), ["agents", "voices", "webhooks"]);
    assert.deepEqual(requested.find(([name]) => name === "voices")[1], { limit: 1 });
    assert.equal(result.voices.status, "available");
    assert.equal(result.agents.count, 1);
    assert.equal(result.agents.attachedWebhookCount, 1);
    assert.equal(result.webhook.status, "ready");
    assert.deepEqual(result.webhookReceipts.eventTypes, { call_completed: 1, call_started: 1 });
    assert.equal(result.webhookReceipts.count, 2);
    assert.equal(result.remoteDeliveryHistoryAvailable, false);
    assert.doesNotMatch(JSON.stringify(result), /sk_car_secret_fixture|sk_admin_secret_fixture|provider-secret|private-call-id|private-request-id/);
    assert.match(result.webhookReceipts.source, /VOICEDNUT received-event history/);
    assert.equal(result.credentials.api, "ok");
  });

  it("skips Cartesia probes when disabled and reports unavailable local receipt storage", async () => {
    let calls = 0;
    const service = new CartesiaStudioService({ client: {
      enabled: false, apiKey: "sk_car_fixture", apiBaseUrl: "https://api.cartesia.ai",
      isConfigured() { return false; }, async listVoices() { calls += 1; }, async listAgents() { calls += 1; },
    } });
    const result = await service.getReadiness();
    assert.equal(calls, 0);
    assert.equal(result.configuration.enabled, false);
    assert.equal(result.voices.status, "skipped");
    assert.equal(result.webhook.status, "disabled");
    assert.equal(result.webhookReceipts.status, "unavailable");
    assert.ok(result.recommendations.includes("Set CARTESIA_ENABLED=true to enable Cartesia features."));
  });

  it("does not report locally configured but rejected Cartesia credentials as authenticated", async () => {
    const service = new CartesiaStudioService({ client: {
      enabled: true, apiKey: "configured-fixture", apiVersion: "2026-08-14", apiBaseUrl: "https://api.cartesia.ai",
      webhookSecret: "a-test-webhook-secret-that-is-at-least-32-chars", webhookUrl: "https://voice.example.com/webhook/cartesia",
      isConfigured() { return true; },
      async listVoices() { throw Object.assign(new Error("secret provider body must not escape"), { status: 401 }); },
      async listAgents() { throw Object.assign(new Error("rejected"), { status: 401 }); },
      async listAgentWebhooks() { throw Object.assign(new Error("rejected"), { status: 401 }); },
    } });
    const result = await service.getReadiness();
    assert.equal(result.configuration.apiConfigured, true);
    assert.equal(result.credentials.api, "authentication_failed");
    assert.equal(result.voices.status, "authentication_failed");
    assert.doesNotMatch(JSON.stringify(result), /secret provider body/);
  });

  it("validates localized voice resources, enforces ownership for lifecycle writes, and masks numbers", async () => {
    const actions = [];
    const service = new CartesiaStudioService({ client: {
      async listAccents() { return { data: [{ id: "parisian", name: "Parisian French", locale: "fr-FR", is_localizable: true }] }; },
      async localizeVoice(body) { actions.push(["localize", body]); return { id: "voice_2", name: body.name, access: body.access }; },
      async getVoice() { return { id: "voice_1", is_owner: true, name: "Old", accents: [{ accent: "general-american", is_native: true }] }; },
      async updateVoice(id, body) { actions.push(["update", id, body]); return { id, name: body.name, access: "private" }; },
      async deleteVoice(id) { actions.push(["delete", id]); },
      async addVoiceAccents(id, body) { actions.push(["accents", id, body]); return { id, name: "Voice" }; },
      async deleteVoiceAccent(id, accent) { actions.push(["deleteAccent", id, accent]); },
      async listPhoneNumbers() { return { data: [{ id: "phone_1", number: "+15551234567", provider: { type: "twilio", account_sid: "secret" } }] }; },
    } });
    const localized = await service.localizeVoice({ voiceId: "voice_1", name: "French Voice", accent: "parisian" });
    assert.equal(localized.voice.id, "voice_2");
    await service.updateVoice("voice_1", { name: "Renamed" });
    await service.addVoiceAccents("voice_1", { accents: ["parisian"] });
    await service.deleteVoiceAccent("voice_1", "parisian");
    await service.deleteVoice("voice_1");
    const phones = await service.listPhoneNumbers();
    assert.equal(phones.phoneNumbers[0].number, "••••4567");
    assert.doesNotMatch(JSON.stringify(phones), /secret|account_sid/);
    await assert.rejects(service.localizeVoice({ voiceId: "voice_1", name: "Bad", accent: "unknown" }), { code: "cartesia_voice_accent_not_localizable" });
  });

  it("sanitizes usage, deployments, agents, and STT result data", async () => {
    const service = new CartesiaStudioService({ client: {
      async listAgents() { return { data: [{ id: "agent_1", name: "Desk", prompt: "private prompt", current_version_id: "version_1" }] }; },
      async listDeployments() { return [{ id: "deploy_1", version_id: "version_1", status: "ready", is_live: true, build_logs: "secret" }]; },
      async listPhoneNumbers() { return { data: [] }; },
      async getCreditUsage() { return { data: [{ start_ts: "2026-01-01", end_ts: "2026-01-02", credits: 42, secret: "hidden" }] }; },
      async getAgentUsage() { return { data: [{ start_ts: "2026-01-01", cents: 9, minutes: 2.5, calls: 3, secret: "hidden" }] }; },
      async transcribeAudio() { return { text: "hello", language: "en", duration: 1.5, words: [{ word: "hello", start: 0, end: 1 }], extra: "hidden" }; },
    } });
    const bundle = {
      agents: await service.listAgents(), deployments: await service.listDeployments("agent_1"),
      credits: await service.getCreditUsage(), agentUsage: await service.getAgentUsage(),
      transcript: await service.transcribeAudio({ file: Buffer.from("audio") }),
    };
    assert.equal(bundle.agents.agents[0].currentVersionId, "version_1");
    assert.equal(bundle.deployments.deployments[0].isLive, true);
    assert.equal(bundle.credits.usage[0].credits, 42);
    assert.equal(bundle.agentUsage.usage[0].minutes, 2.5);
    assert.equal(bundle.agentUsage.usage[0].cents, 9);
    assert.equal(bundle.transcript.words[0].word, "hello");
    assert.doesNotMatch(JSON.stringify(bundle), /private prompt|build_logs|secret|hidden/);
  });

  it("sanitizes Cartesia starter template metadata and only returns trusted GitHub repository links", async () => {
    const service = new CartesiaStudioService({ client: { async listAgentTemplates() { return { templates: [
      { id: 'template_1', name: 'Support starter', description: 'Starter for support agents.', repo_url: 'https://github.com/cartesia-ai/starter', root_dir: 'examples/support', required_env_vars: ['CARTESIA_API_KEY'], dependencies: ['cartesia'] },
      { id: 'template_2', name: 'Unknown host', repo_url: 'https://evil.example/repo' },
      { id: 'bad/id', name: 'Invalid ID', repo_url: 'https://github.com/cartesia-ai/invalid' },
    ] }; } } });
    const result = await service.listAgentTemplates();
    assert.equal(result.templates.length, 2);
    assert.equal(result.templates[0].repositoryUrl, 'https://github.com/cartesia-ai/starter');
    assert.equal(result.templates[0].requiredEnvironmentVariables[0], 'CARTESIA_API_KEY');
    assert.equal(result.templates[0].description, 'Starter for support agents.');
    assert.equal(result.templates[1].repositoryUrl, null);
  });

  it("creates and manages call lifecycle webhooks without returning provider secrets", async () => {
    const received = [];
    const client = {
      webhookSecret: "a-secure-test-secret-that-is-at-least-32-chars",
      webhookUrl: "https://voice.example.com/webhook/cartesia",
      async listAgentWebhooks() { return { webhooks: [{ id: "agent_webhook_1", display_name: "Ops", url: this.webhookUrl, secret: "private" }] }; },
      async createAgentWebhook(input) { received.push(input); return { id: "agent_webhook_2", display_name: input.display_name, url: input.url, secret: input.secret }; },
      async updateAgentWebhook(id, input) { received.push({ id, ...input }); return { id, display_name: input.display_name, url: this.webhookUrl }; },
      async deleteAgentWebhook(id) { received.push({ delete: id }); },
    };
    const service = new CartesiaStudioService({ client });
    const listed = await service.listAgentWebhooks();
    assert.equal(listed.webhooks[0].id, "agent_webhook_1");
    assert.doesNotMatch(JSON.stringify(listed), /private|secret/);
    const created = await service.createAgentWebhook({ display_name: "Operations" });
    assert.equal(created.webhook.id, "agent_webhook_2");
    assert.deepEqual(received[0], { url: "https://voice.example.com/webhook/cartesia", secret: client.webhookSecret, display_name: "Operations" });
    assert.doesNotMatch(JSON.stringify(created), /private|secret/);
    await service.updateAgentWebhook("agent_webhook_2", { display_name: "Updated" });
    await service.updateAgentWebhook("agent_webhook_2", { rotate_secret: true });
    await service.deleteAgentWebhook("agent_webhook_2");
    assert.deepEqual(received.slice(1), [{ id: "agent_webhook_2", display_name: "Updated" }, { id: "agent_webhook_2", secret: client.webhookSecret }, { delete: "agent_webhook_2" }]);
    const unconfigured = new CartesiaStudioService({ client: { webhookSecret: "too-short", webhookUrl: "" } });
    await assert.rejects(unconfigured.createAgentWebhook({ display_name: "Operations" }), { code: "cartesia_webhook_not_configured", status: 503 });
    const localCallback = new CartesiaStudioService({ client: {
      webhookSecret: "a-secure-test-secret-that-is-at-least-32-chars",
      webhookUrl: "https://127.0.0.1/webhook/cartesia",
      async createAgentWebhook() { assert.fail("local callback must be rejected before provider I/O"); },
    } });
    await assert.rejects(localCallback.createAgentWebhook({ display_name: "Operations" }), { code: "cartesia_webhook_not_configured", status: 503 });
  });

  it("sanitizes Cartesia agent version history and restores a validated snapshot server-side", async () => {
    const actions = [];
    const service = new CartesiaStudioService({ client: {
      async listAgentVersions(id) { assert.equal(id, "agent_1"); return { data: { versions: [{ id: "version_1", description: "Baseline", created_at: "2026-10-01", created_by: "admin", config: { instructions: "secret" } }] } }; },
      async getAgentVersion(id, versionId) { assert.equal(id, "agent_1"); return { id: versionId, description: "Baseline", created_at: "2026-10-01", created_by: "admin", config: { model: { id: "sonic-3.6" }, language: { primary: "en" }, audio: { output: { voice_id: "voice_1", speed: 1.1 } }, instructions: "secret prompt", initial_message: "private greeting", tools: [{ id: "tool_1", name: "lookup", api_schema: { url: "https://secret.invalid" } }], system_tools: { end_call: {} } } }; },
      async getManagedAgent(id) { return { id, version: { id: "version_2" }, config: { model: { id: "sonic-3.6" }, language: { primary: "fr" }, audio: { output: { voice_id: "voice_2", speed: 1 } }, instructions: "another secret prompt", initial_message: "another private greeting", tools: [{ id: "tool_2" }], system_tools: { transfer_to_number: {} } } }; },
      async listMetrics() { return { data: [{ id: "metric_1", name: "goal_resolved" }] }; },
      async listMetricResults({ callId }) { return { data: [{ call_id: callId, agent_id: "agent_1", metric_id: "metric_1", status: "completed", value: true }] }; },
      async restoreAgentVersion(id, config, description) { actions.push({ id, config, description }); return { id, current_version_id: "version_2" }; },
    } });
    const listed = await service.listAgentVersions("agent_1");
    assert.deepEqual(listed.versions[0], { id: "version_1", description: "Baseline", createdAt: "2026-10-01", createdBy: "admin" });
    const detail = await service.getAgentVersion("agent_1", "version_1");
    assert.equal(detail.version.configSummary.toolNames[0], "lookup");
    assert.equal(detail.version.configSummary.hasInstructions, true);
    assert.equal(detail.version.configSummary.model, "sonic-3.6");
    assert.equal(detail.version.configSummary.voiceId, "voice_1");
    assert.equal(detail.version.configSummary.language, "en");
    const current = await service.getManagedAgentConfigSummary("agent_1");
    assert.equal(current.currentVersionId, "version_2");
    assert.equal(current.configSummary.language, "fr");
    assert.deepEqual(current.configSummary.systemTools, ["transfer_to_number"]);
    assert.doesNotMatch(JSON.stringify({ listed, detail, current }), /secret prompt|private greeting|secret\.invalid/);
    const restored = await service.restoreAgentVersion("agent_1", "version_1", {
      callIds: ["call_1", "call_2", "call_3"], metricIds: ["metric_1"], minimumSamples: 3, minimumPassRate: 0.9,
    });
    assert.equal(restored.currentVersionId, "version_2");
    assert.equal(restored.evaluation.passed, true);
    assert.equal(actions[0].config.instructions, "secret prompt");
    assert.equal(actions[0].description, "Restored from version_1");
    const invalid = new CartesiaStudioService({ client: {
      async getAgentVersion() { return { id: "wrong_version", config: {} }; },
      async restoreAgentVersion() { assert.fail("invalid snapshots must not be restored"); },
    } });
    await assert.rejects(invalid.restoreAgentVersion("agent_1", "version_1"), { code: "cartesia_agent_version_response_invalid" });
    const oversized = new CartesiaStudioService({ client: {
      async getAgentVersion() { return { id: "version_1", config: { prompt: "x".repeat(128 * 1024) } }; },
      async restoreAgentVersion() { assert.fail("oversized snapshots must not be restored"); },
    } });
    await assert.rejects(oversized.restoreAgentVersion("agent_1", "version_1"), { code: "cartesia_agent_version_config_invalid" });
  });

  it("imports and provisions phone numbers while returning only masked numbers", async () => {
    const service = new CartesiaStudioService({ client: {
      async importPhoneNumber(input) {
        assert.equal(input.number, "+14155550123");
        assert.deepEqual(input.provider, { id: "provider_1" });
        return { id: "phone_1", number: input.number, label: input.label, agent_id: input.agent_id };
      },
      async provisionPhoneNumber(input) {
        assert.deepEqual(input, { label: "Support", agent_id: "agent_1" });
        return { id: "phone_2", number: "+14155550999", label: input.label, agent_id: input.agent_id };
      },
    } });
    const imported = await service.importPhoneNumber({ number: "+14155550123", provider: { id: "provider_1" }, label: "Support", agent_id: "agent_1" });
    const provisioned = await service.provisionPhoneNumber({ label: "Support", agent_id: "agent_1" });
    assert.equal(imported.phoneNumber.number, "••••0123");
    assert.equal(provisioned.phoneNumber.number, "••••0999");
    assert.doesNotMatch(JSON.stringify({ imported, provisioned }), /\+1415555/);
    await assert.rejects(service.importPhoneNumber({ number: "4155550123", provider_id: "provider_1", label: "Support" }), { code: "cartesia_phone_number_import_invalid" });
  });

  it("limits agent changes to supported Cartesia settings and returns a safe version summary", async () => {
    let received;
    const service = new CartesiaStudioService({ client: { async updateAgent(id, input) {
      received = { id, input };
      return { id, name: input.name, current_version_id: "version_2", prompt: "private prompt" };
    } } });
    const result = await service.updateAgent("agent_1", { name: "Support", tts_voice: "voice_1", tts_language: "en", noise_suppression_level: 50, ignored: "secret" });
    assert.deepEqual(received, { id: "agent_1", input: { name: "Support", tts_voice: "voice_1", tts_language: "en", noise_suppression_level: 50 } });
    assert.deepEqual(result.agent, { id: "agent_1", name: "Support", currentVersionId: "version_2", updatedAt: null });
    assert.doesNotMatch(JSON.stringify(result), /private prompt|secret/);
    await assert.rejects(service.updateAgent("agent_1", { noise_suppression_level: 101 }), { code: "cartesia_agent_update_invalid" });
  });

  it("validates and sends documented Managed Agent audio, language, and telephony configuration", async () => {
    let received;
    const service = new CartesiaStudioService({ client: { async updateAgent(id, input) { received = { id, input }; return { id, name: 'Support', current_version_id: 'version_3' }; } } });
    const config = {
      audio: {
        input: { noise_suppression: 'max', keyterms: ['Acme'] },
        output: { voice_id: 'voice_1', speed: 1.1, volume: 0.9, pronunciation_dictionary_id: 'dict_1', background_sound: { file_id: 'file_1', volume: 0.5 } },
      },
      language: { additional: [{ code: 'es-MX', presets: { voice_id: 'voice_es' } }] },
      system_tools: {
        end_call: {}, send_dtmf: {}, voicemail_detection: { message: 'Please call us back.' },
        transfer_to_number: { transfers: [{ condition: 'Caller requests support', destination: { type: 'phone', phone_number: '+14155550123' } }] },
      },
      speculative_generation: true,
    };
    await service.updateAgent('agent_1', { config });
    assert.deepEqual(received, { id: 'agent_1', input: { config } });
    await assert.rejects(service.updateAgent('agent_1', { config: { system_tools: { transfer_to_number: { transfers: [{ condition: 'help', destination: { type: 'phone', phone_number: '4155550123' } }] } } } }), { code: 'cartesia_agent_update_invalid' });
    await assert.rejects(service.updateAgent('agent_1', { config: { audio: { output: { speed: 2 } } } }), { code: 'cartesia_agent_update_invalid' });
  });

  it("stores reusable validated audio profiles and applies them through a new agent version", async () => {
    const profiles = new Map();
    const store = {
      async list() { return [...profiles.values()]; },
      async get(id) { return profiles.get(id) || null; },
      async set(profile) { profiles.set(profile.id, profile); return profile; },
      async delete(id) { return profiles.delete(id); },
    };
    const updates = [];
    const service = new CartesiaStudioService({ agentProfileStore: store, client: { async updateAgent(id, input) { updates.push({ id, input }); return { id, current_version_id: 'version_4' }; } } });
    await assert.rejects(service.saveAgentProfile({ name: 'Noisy support', config: { audio: { output: { voice_id: 'voice_1' } } } }, 'not-an-admin'), { code: 'cartesia_agent_profile_actor_invalid' });
    const saved = await service.saveAgentProfile({ name: 'Noisy support', config: { audio: { input: { noise_suppression: 'max', keyterms: ['Acme'] }, output: { voice_id: 'voice_1', speed: 1 } } } }, '7001');
    assert.equal(saved.profile.name, 'Noisy support');
    assert.equal((await service.listAgentProfiles('7001')).profiles.length, 1);
    assert.equal((await service.listAgentProfiles('7002')).profiles.length, 0);
    await assert.rejects(service.applyAgentProfile('agent_1', saved.profile.id, '7002'), { code: 'cartesia_agent_profile_not_found' });
    const applied = await service.applyAgentProfile('agent_1', saved.profile.id, '7001');
    assert.deepEqual(updates[0].input.config, profiles.get(saved.profile.id).config);
    assert.equal(applied.profile.id, saved.profile.id);
    await assert.rejects(service.deleteAgentProfile(saved.profile.id, '7002'), { code: 'cartesia_agent_profile_not_found' });
    assert.equal((await service.deleteAgentProfile(saved.profile.id, '7001')).deleted, true);
    await assert.rejects(service.applyAgentProfile('agent_1', saved.profile.id, '7001'), { code: 'cartesia_agent_profile_not_found' });
  });

  it("adapts raw route audio to infill multipart and realtime STT contracts", async () => {
    const service = new CartesiaStudioService({ client: {
      async infillSpeech(input) {
        assert.deepEqual(input.leftAudio.data, Buffer.from("before"));
        assert.equal(input.leftAudio.filename, "context.wav");
        return { bytes: Buffer.from([7, 6]), contentType: "audio/wav" };
      },
      async transcribeAudioRealtime(input) {
        assert.deepEqual(input.file, Buffer.from([1, 2, 3, 4]));
        assert.deepEqual(input.keyterms, ["VOICEDNUT"]);
        assert.deepEqual(input.turnSettings, { start_threshold: 0.8, eager_end_threshold: 0.6, end_threshold: 0.3, end_timeout_ms: 5600 });
        return { transcript: "recognized", events: [{ type: "turn.end", transcript: "recognized", secret: "hidden" }] };
      },
    } });
    const infill = await service.infillSpeech({ leftAudio: Buffer.from("before"), filename: "context.wav", contentType: "audio/wav", transcript: "replacement", voiceId: "voice_1" });
    assert.deepEqual(Buffer.from(infill), Buffer.from([7, 6]));
    assert.equal(infill.contentType, "audio/wav");
    const realtime = await service.transcribeAudioRealtime({ audio: Buffer.from([1, 2, 3, 4]), keyterms: ["VOICEDNUT"], turn_settings: { start_threshold: 0.8, eager_end_threshold: 0.6, end_threshold: 0.3, end_timeout_ms: 5600 } });
    assert.equal(realtime.transcript, "recognized");
    assert.doesNotMatch(JSON.stringify(realtime), /hidden|secret/);
  });

  it("normalizes TTS settings, STT keyterms, and turn-detection thresholds", () => {
    const serviceModule = require("../services/cartesiaStudioService");
    const tts = serviceModule.validateTtsPreview({ voiceId: "voice_1", transcript: "Hello there.", speed: 1.2, volume: 0.8, locale: "en-US" });
    assert.equal(tts.generation_config.speed, 1.2);
    assert.equal(tts.locale, "en-US");
    assert.equal(serviceModule.validateTtsPreview({
      voiceId: "voice_1", transcript: "Hello", locale: "en-US", emotion: "calm",
    }).generation_config.emotion, "calm");
    assert.equal(serviceModule.validateCartesiaSpeechMarkup('Please say <spell>AB 123</spell>, then pause.<break time="0.5s"/> Name: <<ˈ|k|æ|t>>.'), 'Please say <spell>AB 123</spell>, then pause.<break time="0.5s"/> Name: <<ˈ|k|æ|t>>.');
    assert.throws(() => serviceModule.validateCartesiaSpeechMarkup('<script>alert(1)</script>'), { code: "cartesia_tts_preview_markup_invalid" });
    assert.throws(() => serviceModule.validateCartesiaSpeechMarkup('<break time="12s"/>'), { code: "cartesia_tts_preview_markup_invalid" });
    assert.deepEqual(validateSttKeyterms(["Sonic", "VOICEDNUT"]), ["Sonic", "VOICEDNUT"]);
    assert.throws(() => validateSttKeyterms(["duplicate", "DUPLICATE"]), { code: "cartesia_stt_keyterms_duplicate" });
    assert.deepEqual(normalizeSttTurnSettings({}), { start_threshold: 0.8, eager_end_threshold: 0.6, end_threshold: 0.3, end_timeout_ms: 5600 });
    assert.throws(() => normalizeSttTurnSettings({ start_threshold: 0.5 }), { code: "cartesia_stt_turn_settings_invalid" });
  });

  it("limits pronunciation dictionary items and blocks private or mutating webhook targets", () => {
    assert.deepEqual(validatePronunciationItems([{ text: "VOICEDNUT", pronunciation: "voice nut" }]), [{ text: "VOICEDNUT", pronunciation: "voice nut", case_sensitive: false }]);
    assert.throws(() => validatePronunciationItems([{ text: "Brand", pronunciation: "one" }, { text: "brand", pronunciation: "two" }]), { code: "cartesia_pronunciation_items_duplicate" });
    assert.throws(() => validateWebhookTool({ name: "lookup", description: "Lookup", api_schema: { url: "http://127.0.0.1/private", method: "GET" } }), { code: "cartesia_tool_url_invalid" });
    assert.throws(() => validateWebhookTool({ name: "lookup", description: "Lookup", api_schema: { url: "https://[::ffff:127.0.0.1]/private", method: "GET" } }), { code: "cartesia_tool_url_invalid" });
    assert.throws(() => validateWebhookTool({ name: "write", description: "Mutate", api_schema: { url: "https://example.com/data", method: "POST" } }), { code: "cartesia_tool_input_invalid" });
    const valid = validateWebhookTool({ name: "lookup", description: "Read data", api_schema: { url: "https://api.example.com/lookup", method: "GET" } });
    assert.equal(valid.api_schema.url, "https://api.example.com/lookup");
  });

  it("validates and creates Cartesia client tool definitions", async () => {
    const input = { type: "client", name: "lookup_order", description: "Look up an order when the caller asks", execution_mode: "async", expects_response: true, response_timeout_secs: 12, parameters: { type: "object", properties: { order_id: { type: "string", description: "Order ID", enum: ["A", "B"] }, include_items: { type: "boolean" } }, required: ["order_id"] } };
    const normalized = validateClientTool(input);
    assert.equal(normalized.type, "client");
    assert.equal(normalized.expects_response, true);
    assert.equal(normalized.response_timeout_secs, 12);
    assert.deepEqual(normalized.parameters.required, ["order_id"]);
    assert.throws(() => validateClientTool({ ...input, parameters: { type: "object", properties: { order_id: { type: "object" } } } }), { code: "cartesia_tool_input_invalid" });
    assert.throws(() => validateClientTool({ ...input, parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["missing"] } }), { code: "cartesia_tool_input_invalid" });
    const received = [];
    const service = new CartesiaStudioService({ client: { async createTool(payload) { received.push(payload); return { id: "tool_client_1", ...payload }; } } });
    const result = await service.createClientTool(input);
    assert.equal(result.tool.id, "tool_client_1");
    assert.deepEqual(received, [normalized]);
  });

  it("summarizes runtime logs and metric results without exposing log, transcript, or evaluation text", async () => {
    const service = new CartesiaStudioService({ client: {
      async getCallRuntimeLogs() { return { call_id: "call_1", updated_at: "2026-10-31T10:00:00Z", logs: ["connected", "ERROR authorization secret=topsecret", "warning retry"] }; },
      async listMetricResults() { return { data: [{ call_id: "call_1", agent_id: "agent_1", metric_id: "metric_1", status: "completed", value: true, transcript: "private transcript", summary: "private summary" }] }; },
    } });
    const logs = await service.getCallRuntimeLogs("call_1");
    assert.deepEqual(logs.logs, { callId: "call_1", updatedAt: "2026-10-31T10:00:00Z", lineCount: 3, warningCount: 2, errorCount: 1, hasWarnings: true, hasErrors: true });
    const metrics = await service.listMetricResults({ agentId: "agent_1" });
    assert.equal(metrics.summary.booleanPassCount, 1);
    assert.doesNotMatch(JSON.stringify({ logs, metrics }), /topsecret|private transcript|private summary|authorization secret/);
  });

  it("limits previews, produces audio bytes as base64, and caches with full request identity", async () => {
    const state = new Map();
    const service = new CartesiaStudioService({
      client: {
        async getVoice() { return { id: "voice_1", accents: [{ locale: "en-US", is_native: true }] }; },
        async generateSpeech(body) { assert.equal(body.voice, "voice_1"); return { bytes: Buffer.from([9, 8]), contentType: "audio/wav" }; },
      },
      cacheStore: { async get(key) { return state.get(key); }, async set(key, value) { state.set(key, value); } },
    });
    const preview = await service.synthesizePreview({ transcript: "Hello", voiceId: "voice_1", locale: "en-US", modelId: "sonic-3.6", generationConfig: { speed: 1.1 } });
    assert.equal(Buffer.from(preview.audioBase64, "base64").length, 2);
    const cached = await service.getOrCreatePhraseCache({ transcript: "Hello", voiceId: "voice_1", locale: "en-US", modelId: "sonic-3.6" });
    assert.equal(cached.cached, false);
    assert.equal((await service.getCachedPhrase({ transcript: "Hello", voiceId: "voice_1", locale: "en-US", modelId: "sonic-3.6" })).byteLength, 2);
    assert.equal((await service.getOrCreatePhraseCache({ transcript: "Hello", voiceId: "voice_1", locale: "en-US", modelId: "sonic-3.6" })).cached, true);
    const fallbackPreview = await service.synthesizePreview({ transcript: "Hello", voiceId: "voice_1", locale: "fr-FR" });
    assert.equal(Buffer.from(fallbackPreview.audioBase64, "base64").length, 2);
    await assert.rejects(service.getCachedPhrase("invalid-key"), { code: "cartesia_phrase_cache_key_invalid" });
  });

  it("gates agent-version restore on complete passing boolean metrics and reports version attestation limits", async () => {
    const restoreCalls = [];
    const service = new CartesiaStudioService({ client: {
      async getAgentVersion(_agentId, versionId) { return { id: versionId, config: { instructions: "private" } }; },
      async listMetrics() { return { data: [{ id: "metric_goal", name: "goal_resolved" }] }; },
      async listMetricResults({ callId }) { return { data: [{ callId, agentId: "agent_1", metricId: "metric_goal", createdAt: "2026-10-31T10:00:00Z", status: "completed", value: callId !== "call_fail", transcript: "must stay private" }] }; },
      async restoreAgentVersion() { restoreCalls.push(true); return { current_version_id: "version_new" }; },
    } });
    const criteria = { callIds: ["call_1", "call_2", "call_fail"], metricIds: ["metric_goal"], minimumSamples: 3, minimumPassRate: 0.66 };
    const gate = await service.evaluateAgentVersionGate("agent_1", "version_candidate", criteria);
    assert.equal(gate.gate, "passed");
    assert.equal(gate.completeSampleCount, 3);
    assert.equal(gate.passedSampleCount, 2);
    assert.equal(gate.versionBinding, "operator_attested");
    assert.match(gate.limitations.join(" "), /do not include an agent version ID/);
    assert.doesNotMatch(JSON.stringify(gate), /must stay private|transcript/);
    await assert.rejects(service.restoreAgentVersion("agent_1", "version_candidate", { ...criteria, minimumPassRate: 0.9 }), { code: "cartesia_agent_restore_evaluation_blocked" });
    assert.equal(restoreCalls.length, 0);
    const restored = await service.restoreAgentVersion("agent_1", "version_candidate", criteria);
    assert.equal(restored.currentVersionId, "version_new");
    assert.equal(restoreCalls.length, 1);
  });

  it("supports latency thresholds for completed numeric Cartesia metrics during agent release evaluation", async () => {
    const service = new CartesiaStudioService({ client: {
      async getAgentVersion(_agentId, versionId) { return { id: versionId, config: { model: { id: 'managed' } } }; },
      async listMetrics() { return { data: [{ id: 'metric_success', name: 'system_call_success' }, { id: 'metric_ttfb', name: 'system_text_to_speech_ttfb' }] }; },
      async listMetricResults({ callId }) { return { data: [
        { call_id: callId, agent_id: 'agent_1', metric_id: 'metric_success', status: 'completed', value: true },
        { call_id: callId, agent_id: 'agent_1', metric_id: 'metric_ttfb', status: 'completed', value: callId === 'call_slow' ? 900 : 500 },
      ] }; },
    } });
    const gate = await service.evaluateAgentVersionGate('agent_1', 'version_1', {
      callIds: ['call_fast', 'call_slow'], metricIds: ['metric_success', 'metric_ttfb'],
      metricThresholds: { metric_ttfb: 700 }, minimumSamples: 2, minimumPassRate: 0.75,
    });
    assert.equal(gate.completeSampleCount, 2);
    assert.equal(gate.passedSampleCount, 1);
    assert.equal(gate.passed, false);
    await assert.rejects(service.evaluateAgentVersionGate('agent_1', 'version_1', {
      callIds: ['call_fast'], metricIds: ['metric_ttfb'], metricThresholds: { metric_unknown: 700 }, minimumSamples: 1,
    }), { code: 'cartesia_agent_evaluation_thresholds_invalid' });
  });

  it("reports native voice accents and fallback without claiming language support", async () => {
    const service = new CartesiaStudioService({ client: {
      async getManagedAgent(id) { return { id, config: { language: { primary: "en-US", additional: [{ code: "fr-FR" }] }, audio: { output: { voice_id: "voice_1" } } } }; },
      async getVoice(id) { return { id, accents: [{ locale: "en-US", is_native: true }] }; },
    } });
    const readiness = await service.getAgentLanguageReadiness("agent_1");
    assert.deepEqual(readiness.languages, [
      { code: "en-US", voiceAccent: "native_accent_listed" },
      { code: "fr-FR", voiceAccent: "original_accent_fallback" },
    ]);
    assert.equal(readiness.originalAccent, "en-US");
    assert.match(readiness.notes.join(" "), /does not certify Managed Agent language/);
  });

  it("synthesizes validated continuation parts without returning transcript text", async () => {
    let received;
    const service = new CartesiaStudioService({ client: {
      async streamSpeechContinuations(input) { received = input; return { bytes: Buffer.from([1, 2, 3, 4]) }; },
    } });
    const result = await service.synthesizeContinuations({ voice_id: "voice_1", model_id: "sonic-3.6", language: "en", transcripts: ["Hello, ", "world."] });
    assert.deepEqual(received.transcripts, ["Hello, ", "world."]);
    assert.equal(result.byteLength, 4);
    assert.equal(Buffer.from(result.audioBase64, "base64").length, 4);
    assert.doesNotMatch(JSON.stringify(result), /Hello|world/);
    await assert.rejects(service.synthesizeContinuations({ voice_id: "voice_1", transcripts: ["only one"] }), { code: "cartesia_tts_continuations_invalid" });
  });

  it("requires a durable cache adapter and keys audio by its complete TTS configuration", async () => {
    const input = { voiceId: "voice_1", modelId: "sonic-3.6", transcript: "Hello", outputFormat: { container: "wav", encoding: "pcm_s16le", sample_rate: 24000 } };
    assert.equal(phraseCacheKey(input), phraseCacheKey(input));
    assert.notEqual(phraseCacheKey(input), phraseCacheKey({ ...input, transcript: "Goodbye" }));
    const service = new CartesiaStudioService({ client: {} });
    await assert.rejects(service.getCachedPhrase("a".repeat(64)), { code: "cartesia_phrase_cache_unavailable" });
  });
});
