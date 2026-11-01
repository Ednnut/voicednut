'use strict';

const { cartesiaWebSocketBaseUrl } = require('./cartesiaEndpoints');

const MAX_AUDIO_FRAME_BYTES = 32 * 1024;
const MAX_TOTAL_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_FRAME_BYTES = 8 * 1024;
const MAX_PROVIDER_EVENT_BYTES = 256 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const TURN_KEYS = ['start_threshold', 'eager_end_threshold', 'end_threshold', 'end_timeout_ms'];

function sttSessionError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function byteLength(raw) {
  if (Buffer.isBuffer(raw)) return raw.length;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  return Buffer.byteLength(String(raw));
}

function parseTextMessage(raw) {
  if (byteLength(raw) > MAX_TEXT_FRAME_BYTES) throw sttSessionError('cartesia_stt_session_message_too_large', 'STT session command exceeds the 8 KiB limit', 413);
  try {
    const message = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid object');
    return message;
  } catch {
    throw sttSessionError('cartesia_stt_session_message_invalid', 'STT session commands must be JSON objects');
  }
}

function normalizeTurnConfig(message) {
  if (message.type !== 'config' || Object.keys(message).some((key) => !['type', 'turn'].includes(key)) ||
      !message.turn || typeof message.turn !== 'object' || Array.isArray(message.turn) || Object.keys(message.turn).some((key) => !TURN_KEYS.includes(key))) {
    throw sttSessionError('cartesia_stt_session_message_invalid', 'Only Cartesia turn-detection config commands are supported');
  }
  const ranges = {
    start_threshold: [0.5, 0.9], eager_end_threshold: [0.3, 0.8],
    end_threshold: [0.05, 0.5], end_timeout_ms: [640, 11200],
  };
  const turn = {};
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = Number(message.turn[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw sttSessionError('cartesia_stt_session_turn_config_invalid', `Invalid ${key} value`);
    turn[key] = value;
  }
  if (turn.end_threshold >= turn.eager_end_threshold || turn.eager_end_threshold >= turn.start_threshold) {
    throw sttSessionError('cartesia_stt_session_turn_config_invalid', 'Turn thresholds must satisfy end < eager end < start');
  }
  return { type: 'config', turn };
}

function sanitizeProviderEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const type = String(event.type || '');
  if (!['connected', 'turn.start', 'turn.update', 'turn.eager_end', 'turn.resume', 'turn.end', 'error'].includes(type)) return null;
  const output = { type };
  if (event.request_id && ID_PATTERN.test(String(event.request_id))) output.request_id = String(event.request_id);
  if (typeof event.transcript === 'string' && ['turn.update', 'turn.eager_end', 'turn.end'].includes(type)) {
    output.transcript = event.transcript.slice(0, 20000);
  }
  if (type === 'error') {
    output.code = String(event.error_code || event.code || 'cartesia_stt_error').slice(0, 80);
    output.message = 'Cartesia could not transcribe this live audio session.';
    if (Number.isInteger(event.status_code)) output.status_code = event.status_code;
  }
  return output;
}

function selectSessionQuery(query = {}) {
  const selected = {};
  for (const key of ['model', 'encoding', 'sample_rate', 'keyterm']) {
    if (query[key] !== undefined) selected[key] = query[key];
  }
  return selected;
}

function normalizeSessionQuery(query = {}) {
  const allowed = new Set(['model', 'encoding', 'sample_rate', 'keyterm']);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw sttSessionError('cartesia_stt_session_query_invalid', 'STT session contains unsupported query parameters');
  const model = String(query.model || 'ink-2');
  const encoding = String(query.encoding || 'pcm_s16le');
  const sampleRate = Number(query.sample_rate || 16000);
  const formats = new Map([
    ['pcm_s16le', new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000])],
    ['pcm_mulaw', new Set([8000])], ['pcm_alaw', new Set([8000])],
  ]);
  if (!['ink-2', 'ink-preview'].includes(model) || !formats.get(encoding)?.has(sampleRate)) {
    throw sttSessionError('cartesia_stt_session_format_invalid', 'Supported live STT formats are PCM16 at 8–48 kHz, or mu-law/A-law at 8 kHz');
  }
  const terms = Array.isArray(query.keyterm) ? query.keyterm : query.keyterm === undefined ? [] : [query.keyterm];
  if (terms.length > 100 || terms.some((term) => typeof term !== 'string' || !term.trim() || term.length > 120 || /[\u0000-\u001f]/.test(term))) {
    throw sttSessionError('cartesia_stt_session_keyterms_invalid', 'STT keyterms must contain at most 100 non-empty terms of 120 characters');
  }
  return { model, encoding, sampleRate, keyterms: terms.map((term) => term.trim()) };
}

class CartesiaSttSessionRuntime {
  constructor(options = {}) {
    this.WebSocket = options.WebSocket || require('ws');
    this.apiKey = String(options.apiKey || '').trim();
    this.apiVersion = String(options.apiVersion || '2026-08-14').trim();
    this.websocketBaseUrl = cartesiaWebSocketBaseUrl(options.apiBaseUrl);
    this.connectTimeoutMs = Math.max(1000, Math.min(30000, Number(options.connectTimeoutMs) || 10000));
    this.idleTimeoutMs = Math.max(10000, Math.min(120000, Number(options.idleTimeoutMs) || 60000));
    this.sessionTimeoutMs = Math.max(this.idleTimeoutMs, Math.min(30 * 60 * 1000, Number(options.sessionTimeoutMs) || 15 * 60 * 1000));
    if (!this.apiKey) throw sttSessionError('cartesia_stt_session_not_configured', 'Cartesia live STT is not configured', 503);
  }

  connect({ clientSocket, actor, query = {} } = {}) {
    if (!actor?.id) throw sttSessionError('cartesia_stt_session_actor_required', 'An authenticated administrator is required', 401);
    if (!clientSocket || typeof clientSocket.on !== 'function') throw sttSessionError('cartesia_stt_session_socket_required', 'A client WebSocket is required');
    const settings = normalizeSessionQuery(query);
    const params = new URLSearchParams({ cartesia_version: this.apiVersion, model: settings.model, encoding: settings.encoding, sample_rate: String(settings.sampleRate) });
    for (const keyterm of settings.keyterms) params.append('keyterm', keyterm);
    const upstream = new this.WebSocket(`${this.websocketBaseUrl}/stt/turns/websocket?${params}`, { headers: { 'X-API-Key': this.apiKey }, maxPayload: MAX_PROVIDER_EVENT_BYTES });
    let closed = false;
    let audioBytes = 0;
    let idleTimer;
    const pendingMessages = [];
    const connectTimer = setTimeout(() => { sendError('cartesia_stt_session_connect_timeout', 'Cartesia live STT connection timed out.'); close(1013, 'provider connection timeout'); }, this.connectTimeoutMs);
    connectTimer.unref?.();
    const sessionTimer = setTimeout(() => close(1000, 'maximum session duration reached'), this.sessionTimeoutMs);
    sessionTimer.unref?.();
    const close = (code = 1000, reason = 'session completed') => {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer); clearTimeout(sessionTimer); clearTimeout(idleTimer);
      try { if (upstream.readyState === undefined || upstream.readyState < 2) upstream.close(code, reason); } catch { /* best-effort cleanup */ }
      try { if (clientSocket.readyState === undefined || clientSocket.readyState < 2) clientSocket.close(code, reason); } catch { /* best-effort cleanup */ }
    };
    const sendError = (code, message) => {
      try { if (clientSocket.readyState === undefined || clientSocket.readyState === 1) clientSocket.send(JSON.stringify({ type: 'error', code, message })); } catch { /* socket may be closed */ }
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => close(1000, 'idle timeout'), this.idleTimeoutMs);
      idleTimer.unref?.();
    };
    resetIdle();
    upstream.on('open', () => {
      clearTimeout(connectTimer);
      while (pendingMessages.length && !closed) {
        const pending = pendingMessages.shift();
        upstream.send(pending.value, pending.binary ? { binary: true } : undefined);
      }
    });
    upstream.on('message', (raw) => {
      if (closed || byteLength(raw) > MAX_PROVIDER_EVENT_BYTES) return close(1009, 'provider event too large');
      let event;
      try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); }
      catch { return close(1011, 'invalid provider event'); }
      const safe = sanitizeProviderEvent(event);
      if (!safe) return;
      if (safe.type === 'error') { sendError(safe.code, safe.message); return close(1011, 'provider error'); }
      try { clientSocket.send(JSON.stringify(safe)); } catch { return close(); }
      resetIdle();
    });
    upstream.on('error', () => { sendError('cartesia_stt_session_unavailable', 'Cartesia live STT is temporarily unavailable.'); close(1011, 'provider unavailable'); });
    upstream.on('close', () => close());
    clientSocket.on('message', (raw, isBinary) => {
      if (closed) return;
      resetIdle();
      if (isBinary) {
        const size = byteLength(raw);
        if (!size || size > MAX_AUDIO_FRAME_BYTES) { sendError('cartesia_stt_session_audio_frame_invalid', 'Send non-empty raw audio frames no larger than 32 KiB.'); return; }
        audioBytes += size;
        if (audioBytes > MAX_TOTAL_AUDIO_BYTES) { sendError('cartesia_stt_session_audio_limit', 'This STT session reached its 16 MiB audio limit.'); return close(1008, 'audio limit'); }
        if (upstream.readyState === 1) upstream.send(raw, { binary: true });
        else if (pendingMessages.length < 1000) pendingMessages.push({ value: Buffer.from(raw), binary: true });
        else { sendError('cartesia_stt_session_backpressure', 'Cartesia live STT is still connecting. Retry after it is ready.'); return close(1013, 'audio queue full'); }
        return;
      }
      let message;
      try { message = parseTextMessage(raw); } catch (error) { sendError(error.code, error.message); return; }
      try {
        if (message.type === 'close' && Object.keys(message).length === 1) {
          if (upstream.readyState === 1) upstream.send(JSON.stringify({ type: 'close' }));
          else close(1000, 'client requested close');
          return;
        }
        const config = normalizeTurnConfig(message);
        const value = JSON.stringify(config);
        if (upstream.readyState === 1) upstream.send(value);
        else if (pendingMessages.length < 1000) pendingMessages.push({ value, binary: false });
        else { sendError('cartesia_stt_session_backpressure', 'Cartesia live STT is still connecting. Retry the command.'); return close(1013, 'command queue full'); }
      } catch (error) { sendError(error.code || 'cartesia_stt_session_message_invalid', error.message); }
    });
    clientSocket.on('close', () => close());
    clientSocket.on('error', () => close(1011, 'client socket error'));
    return { close };
  }
}

module.exports = { CartesiaSttSessionRuntime, normalizeSessionQuery, normalizeTurnConfig, sanitizeProviderEvent, selectSessionQuery };
