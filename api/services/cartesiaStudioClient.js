"use strict";

const fetch = require("node-fetch");
const { cartesiaWebSocketBaseUrl, normalizeCartesiaApiBaseUrl } = require("./cartesiaEndpoints");

const CARTESIA_API_BASE_URL = "https://api.cartesia.ai";
const CARTESIA_API_VERSION = "2026-08-14";
const CARTESIA_WEBHOOK_API_VERSION = "2026-08-14";
const MAX_REALTIME_STT_AUDIO_BYTES = 1_600_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const AUDIO_EXTENSIONS = new Set(["flac", "mp3", "mpeg", "mpga", "oga", "ogg", "wav", "webm"]);

function studioError(code, message, status = null) {
  const error = new Error(message);
  error.code = code;
  error.status = Number(status) || null;
  error.retryable = false;
  error.providerSubmissionState = status && status < 500 ? "rejected" : "unknown";
  return error;
}

function encodedId(value, kind) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) throw studioError(`cartesia_${kind}_id_invalid`, `A valid Cartesia ${kind} ID is required`, 400);
  return encodeURIComponent(id);
}

function jsonResponse(response, operation) {
  return response.json().catch(() => {
    throw studioError(`cartesia_${operation}_response_invalid`, "Cartesia returned an invalid response", response.status);
  });
}

function multipartBody(fields, file) {
  const boundary = `----voicednut-cartesia-${cryptoRandomHex()}`;
  const chunks = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(item)}\r\n`));
    }
  }
  const files = Array.isArray(file) ? file : file ? [file] : [];
  for (const current of files) {
    const filename = String(current.filename || "audio.wav").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "audio.wav";
    const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(String(current.contentType || "")) ? current.contentType : "application/octet-stream";
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${current.fieldName || "clip"}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    chunks.push(Buffer.from(current.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

function createRealtimeSttSession(client, input, path) {
  const audioInput = input.file ?? input.audio;
  const file = Buffer.isBuffer(audioInput) ? audioInput : Buffer.from(audioInput || "");
  if (!file.length || file.length > MAX_REALTIME_STT_AUDIO_BYTES || file.length % 2 !== 0) {
    throw studioError("cartesia_stt_realtime_audio_invalid", "Realtime STT requires raw PCM16 audio of no more than 50 seconds (1.6 MB)", 400);
  }
  if (!client.enabled || !client.apiKey || client.apiVersion !== CARTESIA_API_VERSION) {
    throw studioError("cartesia_studio_not_configured", "Cartesia Studio operations are disabled or not configured", 503);
  }
  let WebSocket = client.WebSocket;
  if (!WebSocket) {
    try { WebSocket = require("ws"); }
    catch { throw studioError("cartesia_realtime_stt_unavailable", "A WebSocket client is required for realtime Cartesia STT", 503); }
  }
  const encoding = String(input.encoding || "pcm_s16le");
  const sampleRate = Number(input.sampleRate || 16000);
  if (encoding !== "pcm_s16le" || sampleRate !== 16000) throw studioError("cartesia_stt_realtime_format_invalid", "Realtime transcription currently requires PCM16 audio sampled at 16 kHz", 400);
  const params = new URLSearchParams({
    model: input.model || "ink-2",
    encoding,
    sample_rate: String(sampleRate),
    cartesia_version: client.apiVersion,
  });
  for (const term of Array.isArray(input.keyterms) ? input.keyterms.slice(0, 100) : []) params.append("keyterm", String(term).slice(0, 120));
  const socket = new WebSocket(`${client.websocketBaseUrl}${path}?${params}`, {
    headers: { Authorization: `Bearer ${client.apiKey}` },
    maxPayload: 64 * 1024,
  });
  const audioDurationMs = Math.ceil(file.length / 32);
  return {
    file,
    socket,
    timeoutMs: Math.min(60000, Math.max(client.timeoutMs, audioDurationMs + 10000)),
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendRealtimeSttAudio(socket, file, isActive) {
  const bytesPerChunk = 3200;
  for (let offset = 0; offset < file.length; offset += bytesPerChunk) {
    if (!isActive()) return false;
    const chunk = file.subarray(offset, Math.min(file.length, offset + bytesPerChunk));
    socket.send(chunk);
    await wait(Math.max(1, Math.ceil(chunk.length / 32)));
  }
  return isActive();
}

function cryptoRandomHex() {
  return require("node:crypto").randomBytes(12).toString("hex");
}

class CartesiaStudioClient {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || "").trim();
    this.adminApiKey = String(options.adminApiKey || "").trim();
    this.webhookSecret = String(options.webhookSecret || "").trim();
    this.webhookUrl = String(options.webhookUrl || "").trim();
    this.enabled = options.enabled === true;
    this.timeoutMs = Math.max(1000, Math.min(60000, Number(options.timeoutMs) || 20000));
    this.fetch = options.fetch || fetch;
    this.WebSocket = options.WebSocket || null;
    this.apiBaseUrl = normalizeCartesiaApiBaseUrl(options.apiBaseUrl || CARTESIA_API_BASE_URL);
    this.websocketBaseUrl = cartesiaWebSocketBaseUrl(this.apiBaseUrl);
    this.apiVersion = String(options.apiVersion || CARTESIA_API_VERSION).trim();
  }

  isConfigured() {
    return this.enabled && Boolean(this.apiKey) && this.apiVersion === CARTESIA_API_VERSION && typeof this.fetch === "function";
  }

  async request(method, path, options = {}) {
    const requestKey = String(options.apiKey || this.apiKey).trim();
    if (!this.enabled || !requestKey || this.apiVersion !== CARTESIA_API_VERSION || typeof this.fetch !== "function") {
      throw studioError(options.adminUsage ? "cartesia_admin_usage_not_configured" : "cartesia_studio_not_configured", "Cartesia Studio operations are disabled or not configured", 503);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const authHeader = String(options.authHeader || "Authorization");
      const authValue = authHeader === "Authorization" ? `Bearer ${requestKey}` : requestKey;
      const headers = { [authHeader]: authValue, "Cartesia-Version": options.apiVersion || this.apiVersion, ...(options.headers || {}) };
      const response = await this.fetch(`${this.apiBaseUrl}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
        signal: controller.signal,
      });
      if (options.responseType === "bytes") {
        if (!response.ok) throw studioError(`cartesia_${options.operation}_failed`, "Cartesia rejected the operation", response.status);
        return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers?.get?.("content-type") || "application/octet-stream" };
      }
      if (response.status === 204) return {};
      const payload = await jsonResponse(response, options.operation || "studio");
      if (!response.ok) throw studioError(`cartesia_${options.operation || "studio"}_failed`, "Cartesia rejected the operation", response.status);
      if (options.includeHeaders) {
        return { payload, headers: { hasMore: response.headers?.get?.("x-has-more") || "", nextCursor: response.headers?.get?.("x-next-cursor") || "" } };
      }
      return payload;
    } catch (error) {
      if (String(error?.code || "").startsWith("cartesia_")) throw error;
      throw studioError(`cartesia_${options.operation || "studio"}_${error?.name === "AbortError" ? "timeout" : "transport_error"}`, "Cartesia Studio is temporarily unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  read(path, operation) { return this.request("GET", path, { operation }); }
  write(method, path, body, operation) {
    return this.request(method, path, { operation, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  async listAgentWebhooks() {
    const result = await this.request("GET", "/agents/webhooks", {
      operation: "agent_webhook_list", apiKey: this.apiKey,
      apiVersion: CARTESIA_WEBHOOK_API_VERSION,
    });
    return { webhooks: Array.isArray(result?.webhooks) ? result.webhooks : Array.isArray(result?.data) ? result.data : [] };
  }
  async getAgentWebhook(id) {
    return this.request("GET", `/agents/webhooks/${encodedId(id, "webhook")}`, {
      operation: "agent_webhook_lookup", apiKey: this.apiKey,
      apiVersion: CARTESIA_WEBHOOK_API_VERSION,
    });
  }
  async createAgentWebhook(input = {}) {
    return this.request("POST", "/agents/webhooks", {
      operation: "agent_webhook_create", apiKey: this.apiKey,
      apiVersion: CARTESIA_WEBHOOK_API_VERSION,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
  }
  async updateAgentWebhook(id, input = {}) {
    const result = await this.request("PATCH", `/agents/webhooks/${encodedId(id, "webhook")}`, {
      operation: "agent_webhook_update", apiKey: this.apiKey,
      apiVersion: CARTESIA_WEBHOOK_API_VERSION,
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    return typeof result === "string" ? { id: result } : result;
  }
  async deleteAgentWebhook(id) {
    return this.request("DELETE", `/agents/webhooks/${encodedId(id, "webhook")}`, {
      operation: "agent_webhook_delete", apiKey: this.apiKey,
      apiVersion: CARTESIA_WEBHOOK_API_VERSION,
    });
  }

  listVoices(query = {}) {
    const params = new URLSearchParams();
    if (query.isOwner === true) params.set("is_owner", "true");
    if (query.limit) params.set("limit", String(Math.max(1, Math.min(100, Number(query.limit) || 50))));
    if (query.startingAfter && ID_PATTERN.test(String(query.startingAfter))) params.set("starting_after", String(query.startingAfter));
    if (query.endingBefore && ID_PATTERN.test(String(query.endingBefore))) params.set("ending_before", String(query.endingBefore));
    for (const [source, target, maxLength] of [["q", "q", 100], ["language", "language", 24], ["gender", "gender", 32]]) {
      const value = String(query[source] || "").trim();
      if (value && value.length <= maxLength) params.set(target, value);
    }
    return this.read(`/voices${params.size ? `?${params}` : ""}`, "voice_list");
  }
  listModels(query = {}) {
    const capability = String(query.capability || "").trim().toLowerCase();
    if (capability && !new Set(["tts", "stt"]).has(capability)) {
      throw studioError("cartesia_model_capability_invalid", "Model capability must be tts or stt", 400);
    }
    const params = new URLSearchParams();
    if (capability) params.set("capability", capability);
    return this.read(`/models${params.size ? `?${params}` : ""}`, "model_list");
  }
  getVoice(id) { return this.read(`/voices/${encodedId(id, "voice")}`, "voice_lookup"); }
  updateVoice(id, input) { return this.write("PATCH", `/voices/${encodedId(id, "voice")}`, input, "voice_update"); }
  deleteVoice(id) { return this.request("DELETE", `/voices/${encodedId(id, "voice")}`, { operation: "voice_delete" }); }
  listAccents(query = {}) {
    const params = new URLSearchParams();
    if (query.isLocalizable === true) params.set("is_localizable", "true");
    if (query.limit) params.set("limit", String(Math.max(1, Math.min(100, Number(query.limit) || 50))));
    return this.read(`/accents${params.size ? `?${params}` : ""}`, "accent_list");
  }
  localizeVoice(input) { return this.write("POST", "/voices/localize", input, "voice_localize"); }
  addVoiceAccents(voiceId, input) { return this.write("PATCH", `/voices/${encodedId(voiceId, "voice")}/accents`, input, "voice_accents_add"); }
  deleteVoiceAccent(voiceId, accentId) {
    return this.request("DELETE", `/voices/${encodedId(voiceId, "voice")}/accents/${encodedId(accentId, "accent")}`, { operation: "voice_accent_delete" });
  }
  cloneVoice(input = {}) {
    const data = Buffer.isBuffer(input.clip) ? input.clip : Buffer.from(input.clip || "");
    if (!data.length || data.length > 16 * 1024 * 1024) throw studioError("cartesia_voice_clip_invalid", "Voice sample must be between 1 byte and 16 MB", 400);
    const filename = String(input.filename || "voice-sample.wav");
    if (!AUDIO_EXTENSIONS.has(filename.split(".").pop().toLowerCase())) throw studioError("cartesia_voice_clip_format_invalid", "Cartesia voice samples must use a supported audio file format", 400);
    const { boundary, body } = multipartBody({ name: input.name, language: input.language, tagline: input.tagline || "", description: input.description || "", access: "private" }, {
      fieldName: "clip", filename, contentType: input.contentType || "audio/wav", data,
    });
    return this.request("POST", "/voices/clone", { operation: "voice_clone", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
  }

  createDataset(input) { return this.write("POST", "/datasets", input, "dataset_create"); }
  deleteDataset(id) { return this.request("DELETE", `/datasets/${encodedId(id, "dataset")}`, { operation: "dataset_delete" }); }
  uploadDatasetFile(datasetId, input = {}) {
    const data = Buffer.isBuffer(input.file) ? input.file : Buffer.from(input.file || "");
    if (!data.length || data.length > 100 * 1024 * 1024) throw studioError("cartesia_dataset_file_invalid", "Dataset audio file must be between 1 byte and 100 MB", 400);
    const filename = String(input.filename || "sample.wav");
    if (!AUDIO_EXTENSIONS.has(filename.split(".").pop().toLowerCase())) throw studioError("cartesia_dataset_file_format_invalid", "Cartesia training files must use a supported audio file format", 400);
    const { boundary, body } = multipartBody({ purpose: "fine_tune" }, { fieldName: "file", filename, contentType: input.contentType || "audio/wav", data });
    return this.request("POST", `/datasets/${encodedId(datasetId, "dataset")}/files`, { operation: "dataset_file_upload", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
  }
  createFineTune(input) { return this.write("POST", "/fine-tunes", input, "fine_tune_create"); }
  getFineTune(id) { return this.read(`/fine-tunes/${encodedId(id, "fine_tune")}`, "fine_tune_lookup"); }
  deleteFineTune(id) { return this.request("DELETE", `/fine-tunes/${encodedId(id, "fine_tune")}`, { operation: "fine_tune_delete" }); }
  listFineTuneVoices(id) { return this.read(`/fine-tunes/${encodedId(id, "fine_tune")}/voices`, "fine_tune_voices"); }

  generateSpeech(input) {
    return this.request("POST", "/tts/bytes", { operation: "tts_preview", responseType: "bytes", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  }
  async streamSpeech(input) {
    if (!this.isConfigured()) throw studioError("cartesia_studio_not_configured", "Cartesia Studio operations are disabled or not configured", 503);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetch(`${this.apiBaseUrl}/tts/sse`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Cartesia-Version": this.apiVersion, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok) throw studioError("cartesia_tts_stream_failed", "Cartesia rejected the speech stream", response.status);
      const stream = response.body;
      if (!stream || typeof stream.pipe !== "function") throw studioError("cartesia_tts_stream_invalid", "Cartesia returned an invalid speech stream", 502);
      const clear = () => clearTimeout(timeout);
      stream.once("end", clear);
      stream.once("close", clear);
      stream.once("error", clear);
      stream.once("end", () => controller.abort());
      return { stream, contentType: response.headers?.get?.("content-type") || "text/event-stream", abort: () => { clear(); controller.abort(); } };
    } catch (error) {
      clearTimeout(timeout);
      if (String(error?.code || "").startsWith("cartesia_")) throw error;
      throw studioError(`cartesia_tts_stream_${error?.name === "AbortError" ? "timeout" : "transport_error"}`, "Cartesia speech streaming is temporarily unavailable");
    }
  }

  streamSpeechContinuations(input = {}) {
    if (!this.isConfigured()) throw studioError("cartesia_studio_not_configured", "Cartesia Studio operations are disabled or not configured", 503);
    const parts = Array.isArray(input.transcripts) ? input.transcripts : [];
    const transcripts = parts.map((part) => typeof part === "string" ? part : "").filter((part) => part.trim());
    if (transcripts.length < 2 || transcripts.length > 10 || transcripts.some((part) => part.length > 600) ||
        transcripts.reduce((sum, part) => sum + part.length, 0) > 3000) {
      throw studioError("cartesia_tts_continuations_invalid", "Provide 2–10 transcript parts, each up to 600 characters and 3,000 total", 400);
    }
    let WebSocket = this.WebSocket;
    if (!WebSocket) {
      try { WebSocket = require("ws"); }
      catch { throw studioError("cartesia_tts_websocket_unavailable", "A WebSocket client is required for Cartesia TTS continuations", 503); }
    }
    const voice = String(input.voice || input.voice_id || "").trim();
    const modelId = String(input.model_id || "sonic-3.6").trim();
    const language = String(input.language || "en").trim();
    if (!ID_PATTERN.test(voice) || !/^[A-Za-z0-9._:-]{1,80}$/.test(modelId) || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) {
      throw studioError("cartesia_tts_continuations_invalid", "A valid voice, model, and language are required", 400);
    }
    const contextId = require("node:crypto").randomUUID();
    const params = new URLSearchParams({ cartesia_version: this.apiVersion });
    const socket = new WebSocket(`${this.websocketBaseUrl}/tts/websocket?${params}`, { headers: { "X-API-Key": this.apiKey } });
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      let sent = false;
      const timeout = setTimeout(() => finish(studioError("cartesia_tts_continuations_timeout", "Cartesia TTS continuation timed out", 504)), this.timeoutMs);
      timeout.unref?.();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { socket.close(); } catch { /* best-effort cleanup */ }
        if (error) reject(error);
        else if (!size || size > 8 * 1024 * 1024) reject(studioError("cartesia_tts_continuations_response_invalid", "Cartesia returned empty or oversized continuation audio", 502));
        else resolve({ bytes: Buffer.concat(chunks, size), contentType: "audio/pcm" });
      };
      socket.on("open", () => {
        if (sent) return;
        sent = true;
        const common = { model_id: modelId, voice, language, output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 }, context_id: contextId };
        for (const transcript of transcripts) socket.send(JSON.stringify({ ...common, transcript, continue: true }));
        socket.send(JSON.stringify({ ...common, transcript: "", continue: false }));
      });
      socket.on("message", (raw) => {
        let event;
        try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); }
        catch { return finish(studioError("cartesia_tts_continuations_response_invalid", "Cartesia returned an invalid continuation event", 502)); }
        if (!event || String(event.context_id || "") !== contextId) return;
        if (event.type === "error") return finish(studioError("cartesia_tts_continuations_failed", "Cartesia rejected TTS continuation generation", Number(event.status_code) || 502));
        if (event.type === "chunk" && typeof event.data === "string") {
          const audio = Buffer.from(event.data, "base64");
          if (!audio.length || audio.toString("base64").replace(/=+$/, "") !== event.data.replace(/=+$/, "")) return finish(studioError("cartesia_tts_continuations_response_invalid", "Cartesia returned invalid continuation audio", 502));
          size += audio.length;
          if (size > 8 * 1024 * 1024) return finish(studioError("cartesia_tts_continuations_response_invalid", "Cartesia returned oversized continuation audio", 502));
          chunks.push(audio);
        }
        if (event.type === "done") finish();
      });
      socket.on("error", () => finish(studioError("cartesia_tts_continuations_transport_error", "Cartesia TTS continuations are temporarily unavailable", 502)));
      socket.on("close", (code) => { if (!settled) finish(studioError("cartesia_tts_continuations_closed", `Cartesia TTS connection closed before completion (${Number(code) || 0})`, 502)); });
    });
  }

  transcribeAudio(input = {}) {
    const file = Buffer.isBuffer(input.file) ? input.file : Buffer.from(input.file || "");
    if (!file.length || file.length > 25 * 1024 * 1024) throw studioError("cartesia_stt_audio_invalid", "STT audio must be between 1 byte and 25 MB", 400);
    const filename = String(input.filename || "audio.wav");
    if (!AUDIO_EXTENSIONS.has(filename.split(".").pop().toLowerCase())) throw studioError("cartesia_stt_audio_format_invalid", "Cartesia STT audio must use a supported audio file format", 400);
    const fields = {
      model: input.model || "ink-whisper",
      language: input.language,
      "timestamp_granularities[]": input.timestampGranularities || [],
      keyterms: input.keyterms || [],
    };
    const { boundary, body } = multipartBody(fields, { fieldName: "file", filename, contentType: input.contentType, data: file });
    return this.request("POST", "/stt", { operation: "stt_transcribe", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
  }

  transcribeAudioRealtime(input = {}) {
    const { file, socket, timeoutMs } = createRealtimeSttSession(this, input, "/stt/turns/websocket");
    return new Promise((resolve, reject) => {
      const events = [];
      const partials = [];
      let settled = false;
      const finish = (error, finalEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { socket.close(); } catch { /* close best-effort */ }
        if (error) reject(error);
        else resolve({ transcript: safeRealtimeTranscript(finalEvent?.transcript ?? partials.at(-1) ?? ""), events: events.slice(0, 500) });
      };
      const timeout = setTimeout(() => finish(studioError("cartesia_realtime_stt_timeout", "Cartesia realtime transcription timed out", 504)), timeoutMs);
      timeout.unref?.();
      socket.on("open", () => {
        void (async () => {
          try {
            if (input.turnSettings && typeof input.turnSettings === "object") {
              const keys = ["start_threshold", "eager_end_threshold", "end_threshold", "end_timeout_ms"];
              const hasAllSettings = keys.every((key) => Number.isFinite(Number(input.turnSettings[key])));
              if (hasAllSettings) {
                const turn = Object.fromEntries(keys.map((key) => [key, Number(input.turnSettings[key])]));
                socket.send(JSON.stringify({ type: "config", turn }));
              }
            }
            if (!await sendRealtimeSttAudio(socket, file, () => !settled) || settled) return;
            socket.send(JSON.stringify({ type: "close" }));
          } catch {
            finish(studioError("cartesia_realtime_stt_transport_error", "Cartesia realtime transcription is temporarily unavailable", 502));
          }
        })();
      });
      socket.on("message", (raw) => {
        let event;
        try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); }
        catch { return finish(studioError("cartesia_realtime_stt_response_invalid", "Cartesia returned an invalid transcription event", 502)); }
        if (!event || typeof event !== "object") return;
        if (event.type === "error") return finish(studioError("cartesia_realtime_stt_failed", "Cartesia rejected realtime transcription", Number(event.status_code) || 502));
        if (typeof event.transcript === "string" && ["turn.update", "turn.eager_end", "turn.end"].includes(event.type)) partials.push(event.transcript);
        if (events.length < 500) events.push({ type: String(event.type || "event").slice(0, 32), ...(typeof event.transcript === "string" ? { transcript: safeRealtimeTranscript(event.transcript) } : {}) });
        if (event.type === "turn.end") finish(null, event);
      });
      socket.on("error", () => finish(studioError("cartesia_realtime_stt_transport_error", "Cartesia realtime transcription is temporarily unavailable", 502)));
      socket.on("close", (code) => {
        if (!settled) finish(studioError("cartesia_realtime_stt_closed", `Cartesia realtime transcription closed before completion (${Number(code) || 0})`, 502));
      });
    });
  }

  transcribeAudioManual(input = {}) {
    const { socket, file, timeoutMs } = createRealtimeSttSession(this, input, "/stt/websocket");
    return new Promise((resolve, reject) => {
      let transcript = "";
      let language = null;
      let durationSeconds = null;
      let messageCount = 0;
      let finalizeSent = false;
      let closeSent = false;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { socket.close(); } catch { /* close best-effort */ }
        if (error) reject(error);
        else resolve({ transcript, language, durationSeconds });
      };
      const timeout = setTimeout(() => finish(studioError("cartesia_manual_stt_timeout", "Cartesia manual transcription timed out", 504)), timeoutMs);
      timeout.unref?.();
      socket.on("open", () => {
        void (async () => {
          try {
            if (!await sendRealtimeSttAudio(socket, file, () => !settled) || settled) return;
            finalizeSent = true;
            socket.send("finalize");
          } catch {
            finish(studioError("cartesia_manual_stt_transport_error", "Cartesia manual transcription is temporarily unavailable", 502));
          }
        })();
      });
      socket.on("message", (raw) => {
        if (++messageCount > 1000) return finish(studioError("cartesia_manual_stt_response_invalid", "Cartesia returned too many manual transcription events", 502));
        let event;
        try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); }
        catch { return finish(studioError("cartesia_manual_stt_response_invalid", "Cartesia returned an invalid manual transcription event", 502)); }
        if (!event || typeof event !== "object" || Array.isArray(event)) return finish(studioError("cartesia_manual_stt_response_invalid", "Cartesia returned an invalid manual transcription event", 502));
        if (event.type === "error") return finish(studioError("cartesia_manual_stt_failed", "Cartesia rejected manual transcription", Number(event.status_code) || 502));
        if (event.type === "transcript") {
          if (typeof event.is_final !== "boolean" || typeof event.text !== "string") {
            return finish(studioError("cartesia_manual_stt_response_invalid", "Cartesia returned an invalid transcript event", 502));
          }
          if (event.is_final) {
            if (event.text.length + transcript.length > 50000) return finish(studioError("cartesia_manual_stt_response_invalid", "Cartesia returned an oversized transcript", 502));
            transcript += safeRealtimeTranscript(event.text);
            if (typeof event.language === "string") language = event.language.slice(0, 20);
            if (event.duration !== null && event.duration !== undefined && Number.isFinite(Number(event.duration))) durationSeconds = Number(event.duration);
          }
          return;
        }
        if (event.type === "flush_done") {
          if (!finalizeSent || closeSent) return finish(studioError("cartesia_manual_stt_response_invalid", "Cartesia returned an unexpected flush acknowledgment", 502));
          closeSent = true;
          try { socket.send("close"); }
          catch { finish(studioError("cartesia_manual_stt_transport_error", "Cartesia manual transcription is temporarily unavailable", 502)); }
          return;
        }
        if (event.type === "done") {
          if (!closeSent) return finish(studioError("cartesia_manual_stt_response_invalid", "Cartesia closed manual transcription before the flush completed", 502));
          return finish(null);
        }
      });
      socket.on("error", () => finish(studioError("cartesia_manual_stt_transport_error", "Cartesia manual transcription is temporarily unavailable", 502)));
      socket.on("close", (code) => {
        if (!settled) finish(studioError("cartesia_manual_stt_closed", `Cartesia manual transcription closed before completion (${Number(code) || 0})`, 502));
      });
    });
  }

  infillSpeech(input = {}) {
    const files = [];
    for (const [fieldName, source] of [["left_audio", input.leftAudio], ["right_audio", input.rightAudio]]) {
      if (!source) continue;
      const data = Buffer.isBuffer(source.data) ? source.data : Buffer.from(source.data || "");
      if (!data.length || data.length > 16 * 1024 * 1024) throw studioError("cartesia_infill_audio_invalid", "Infill context audio must be between 1 byte and 16 MB", 400);
      const filename = String(source.filename || "context.wav");
      if (!AUDIO_EXTENSIONS.has(filename.split(".").pop().toLowerCase())) throw studioError("cartesia_infill_audio_format_invalid", "Infill context audio must use a supported audio file format", 400);
      files.push({ fieldName, filename, contentType: source.contentType, data });
    }
    if (!files.length) throw studioError("cartesia_infill_context_required", "At least one surrounding audio clip is required", 400);
    const transcript = String(input.transcript || "").trim();
    const voiceId = String(input.voiceId || input.voice_id || "").trim();
    if (!transcript || transcript.length > 1000 || !ID_PATTERN.test(voiceId)) throw studioError("cartesia_infill_input_invalid", "A transcript of at most 1000 characters and valid voice ID are required", 400);
    const fields = { transcript, voice_id: voiceId, model_id: input.modelId || "sonic-3", language: input.language, "output_format[container]": input.container || "wav", "output_format[encoding]": input.encoding || "pcm_s16le", "output_format[sample_rate]": input.sampleRate || 24000 };
    const { boundary, body } = multipartBody(fields, files);
    return this.request("POST", "/infill/bytes", { operation: "speech_infill", responseType: "bytes", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
  }
  listPronunciationDictionaries() { return this.read("/pronunciation-dicts/", "pronunciation_dict_list"); }
  createPronunciationDictionary(input) { return this.write("POST", "/pronunciation-dicts/", input, "pronunciation_dict_create"); }
  getPronunciationDictionary(id) { return this.read(`/pronunciation-dicts/${encodedId(id, "pronunciation_dictionary")}`, "pronunciation_dict_lookup"); }
  updatePronunciationDictionary(id, input) { return this.write("PATCH", `/pronunciation-dicts/${encodedId(id, "pronunciation_dictionary")}`, input, "pronunciation_dict_update"); }
  deletePronunciationDictionary(id) { return this.request("DELETE", `/pronunciation-dicts/${encodedId(id, "pronunciation_dictionary")}`, { operation: "pronunciation_dict_delete" }); }

  listMetrics() { return this.read("/agents/metrics", "metric_list"); }
  createMetric(input) { return this.write("POST", "/agents/metrics", input, "metric_create"); }
  assignMetric(agentId, metricId) {
    return this.write("POST", `/agents/${encodedId(agentId, "agent")}/metrics/${encodedId(metricId, "metric")}`, {}, "metric_assign");
  }
  listMetricResults(query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ agent_id: query.agentId, metric_id: query.metricId, call_id: query.callId })) {
      if (value) params.set(key, String(value));
    }
    params.set("limit", String(Math.max(1, Math.min(100, Number(query.limit) || 25))));
    if (query.startingAfter) params.set("starting_after", String(query.startingAfter));
    return this.request("GET", `/agents/metrics/results?${params}`, { operation: "metric_results", includeHeaders: true }).then((result) => {
      if (Array.isArray(result)) return { data: result };
      return {
        ...(result.payload && typeof result.payload === "object" ? result.payload : {}),
        ...(result.headers.hasMore ? { has_more: result.headers.hasMore === "true" } : {}),
        ...(result.headers.nextCursor ? { next_cursor: result.headers.nextCursor } : {}),
      };
    });
  }

  getCallRuntimeLogs(callId) { return this.read(`/agents/calls/${encodedId(callId, "call")}/logs`, "call_runtime_logs"); }
  listTools() { return this.read("/v1/agents/tools", "tool_list"); }
  getTool(id) { return this.read(`/v1/agents/tools/${encodedId(id, "tool")}`, "tool_lookup"); }
  createTool(input) { return this.write("POST", "/v1/agents/tools", input, "tool_create"); }
  updateTool(id, input) { return this.write("PATCH", `/v1/agents/tools/${encodedId(id, "tool")}`, input, "tool_update"); }
  deleteTool(id) { return this.request("DELETE", `/v1/agents/tools/${encodedId(id, "tool")}`, { operation: "tool_delete" }); }

  listAgents() { return this.read("/v1/agents", "agent_list"); }
  listAgentTemplates() { return this.read("/agents/templates", "agent_template_list"); }
  updateAgent(id, input) { return this.write("PATCH", `/v1/agents/${encodedId(id, "agent")}`, input, "agent_update"); }
  listDeployments(agentId) { return this.read(`/agents/${encodedId(agentId, "agent")}/deployments`, "deployment_list"); }
  listAgentVersions(agentId) { return this.read(`/v1/agents/${encodedId(agentId, "agent")}/versions`, "agent_version_list"); }
  getAgentVersion(agentId, versionId) { return this.read(`/v1/agents/${encodedId(agentId, "agent")}/versions/${encodedId(versionId, "version")}`, "agent_version_lookup"); }
  getManagedAgent(agentId) { return this.read(`/v1/agents/${encodedId(agentId, "agent")}`, "managed_agent_lookup"); }
  restoreAgentVersion(agentId, config, versionDescription) {
    return this.write("PATCH", `/v1/agents/${encodedId(agentId, "agent")}`, { config, version_description: versionDescription }, "agent_version_restore");
  }
  listPhoneNumbers() { return this.read("/agents/phone-numbers", "phone_number_list"); }
  importPhoneNumber(input) { return this.write("POST", "/agents/phone-numbers", input, "phone_number_import"); }
  provisionPhoneNumber(input) { return this.write("POST", "/agents/phone-numbers/provision", input, "phone_number_provision"); }
  updatePhoneNumber(id, input) { return this.write("PATCH", `/agents/phone-numbers/${encodedId(id, "phone_number")}`, input, "phone_number_update"); }
  getCreditUsage(query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ start_ts: query.startTs || query.start_ts, end_ts: query.endTs || query.end_ts, interval: query.interval, group_by: query.groupBy || query.group_by, api_key_id: query.apiKeyId || query.api_key_id })) if (value) params.set(key, String(value));
    if (!this.adminApiKey) throw studioError("cartesia_admin_usage_not_configured", "A dedicated Cartesia admin usage key is required", 503);
    return this.request("GET", `/usage/credits${params.size ? `?${params}` : ""}`, { operation: "credit_usage", apiKey: this.adminApiKey, adminUsage: true });
  }
  getAgentUsage(query = {}) {
    if (!this.adminApiKey) throw studioError("cartesia_admin_usage_not_configured", "A dedicated Cartesia admin usage key is required", 503);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ start_ts: query.startTs || query.start_ts, end_ts: query.endTs || query.end_ts, interval: query.interval })) if (value) params.set(key, String(value));
    return this.request("GET", `/usage/agents${params.size ? `?${params}` : ""}`, { operation: "agent_usage", apiKey: this.adminApiKey, adminUsage: true });
  }
}

function safeRealtimeTranscript(value) {
  return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, 50000);
}

module.exports = {
  CartesiaStudioClient,
  CARTESIA_API_BASE_URL,
  CARTESIA_API_VERSION,
  MAX_REALTIME_STT_AUDIO_BYTES,
  studioError,
};
