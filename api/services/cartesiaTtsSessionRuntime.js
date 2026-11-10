'use strict';

const { cartesiaWebSocketBaseUrl } = require('./cartesiaEndpoints');

const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_UPSTREAM_EVENT_BYTES = 1024 * 1024;
const MAX_REQUESTS_PER_SESSION = 100;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function sessionError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function byteLength(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return Buffer.byteLength(String(value));
}

function parseJson(raw) {
  if (byteLength(raw) > MAX_MESSAGE_BYTES) throw sessionError('cartesia_tts_session_message_too_large', 'TTS session message exceeds the 16 KiB limit', 413);
  try {
    const value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object');
    return value;
  } catch {
    throw sessionError('cartesia_tts_session_message_invalid', 'TTS session messages must be JSON objects');
  }
}

function normalizeGeneration(input) {
  const fields = new Set([
    'model_id', 'transcript', 'voice', 'language', 'locale', 'accent', 'normalization',
    'context_id', 'output_format', 'add_timestamps', 'add_phoneme_timestamps',
    'use_normalized_timestamps', 'pronunciation_dict_id', 'generation_config',
    'max_buffer_delay_ms', 'continue', 'flush',
  ]);
  if (Object.keys(input).some((key) => !fields.has(key))) throw sessionError('cartesia_tts_session_message_invalid', 'TTS generation contains unsupported fields');
  const modelId = typeof input.model_id === 'string' ? input.model_id.trim() : '';
  const transcript = typeof input.transcript === 'string' ? input.transcript : null;
  const voiceInput = input.voice;
  const voice = typeof voiceInput === 'string'
    ? voiceInput.trim()
    : voiceInput && typeof voiceInput === 'object' && !Array.isArray(voiceInput) && typeof voiceInput.id === 'string'
      ? voiceInput.id.trim()
      : '';
  const contextId = typeof input.context_id === 'string' ? input.context_id.trim() : '';
  const language = input.language;
  const locale = input.locale;
  const localePattern = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/;
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(modelId) || transcript === null || transcript.length > 12000 ||
      !ID_PATTERN.test(voice) || !/^[A-Za-z0-9._:-]{1,120}$/.test(contextId) ||
      (language !== undefined && (typeof language !== 'string' || !localePattern.test(language))) ||
      (locale !== undefined && (typeof locale !== 'string' || !localePattern.test(locale))) ||
      (language !== undefined && locale !== undefined)) {
    throw sessionError('cartesia_tts_session_message_invalid', 'Provide valid model, transcript, voice, context, and optional language or locale fields');
  }
  const message = { model_id: modelId, transcript, voice, context_id: contextId };
  if (language !== undefined) message.language = language;
  if (locale !== undefined) message.locale = locale;
  const format = input.output_format;
  const encodings = new Set(['pcm_f32le', 'pcm_s16le', 'pcm_mulaw', 'pcm_alaw']);
  if (!format || typeof format !== 'object' || Array.isArray(format) ||
      Object.keys(format).some((key) => !['container', 'encoding', 'sample_rate'].includes(key)) ||
      format.container !== 'raw' || !encodings.has(format.encoding) ||
      ![8000, 16000, 22050, 24000, 44100, 48000].includes(format.sample_rate)) {
    throw sessionError('cartesia_tts_session_format_invalid', 'TTS sessions require raw PCM output with a documented encoding and sample rate');
  }
  message.output_format = { container: 'raw', encoding: format.encoding, sample_rate: format.sample_rate };
  if (input.accent !== undefined) {
    if (typeof input.accent !== 'string' || !input.accent.trim() || input.accent.length > 80 || /[\u0000-\u001f\u007f]/.test(input.accent)) {
      throw sessionError('cartesia_tts_session_message_invalid', 'accent must be a non-empty string of at most 80 characters');
    }
    message.accent = input.accent.trim();
  }
  if (input.normalization !== undefined) {
    const normalization = input.normalization;
    if (typeof normalization !== 'string' || (normalization !== 'auto' && normalization !== 'off' && !localePattern.test(normalization))) {
      throw sessionError('cartesia_tts_session_message_invalid', 'normalization must be auto, off, or a supported language or locale code');
    }
    message.normalization = normalization;
  }
  if (input.pronunciation_dict_id !== undefined) {
    if (typeof input.pronunciation_dict_id !== 'string' || !ID_PATTERN.test(input.pronunciation_dict_id)) {
      throw sessionError('cartesia_tts_session_message_invalid', 'pronunciation_dict_id is invalid');
    }
    message.pronunciation_dict_id = input.pronunciation_dict_id;
  }
  if (input.generation_config !== undefined) {
    const config = input.generation_config;
    const allowed = new Set(['speed', 'volume', 'emotion']);
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        Object.keys(config).some((key) => !allowed.has(key))) {
      throw sessionError('cartesia_tts_session_message_invalid', 'generation_config contains unsupported fields');
    }
    const normalized = {};
    if (config.speed !== undefined) {
      if (typeof config.speed !== 'number' || !Number.isFinite(config.speed) || config.speed < 0.6 || config.speed > 1.5) {
        throw sessionError('cartesia_tts_session_message_invalid', 'generation_config.speed must be between 0.6 and 1.5');
      }
      normalized.speed = config.speed;
    }
    if (config.volume !== undefined) {
      if (typeof config.volume !== 'number' || !Number.isFinite(config.volume) || config.volume < 0.5 || config.volume > 2) {
        throw sessionError('cartesia_tts_session_message_invalid', 'generation_config.volume must be between 0.5 and 2');
      }
      normalized.volume = config.volume;
    }
    if (config.emotion !== undefined) {
      if (!['neutral', 'calm', 'angry', 'content', 'sad'].includes(config.emotion)) {
        throw sessionError('cartesia_tts_session_message_invalid', 'generation_config.emotion is unsupported');
      }
      normalized.emotion = config.emotion;
    }
    message.generation_config = normalized;
  }
  if (input.max_buffer_delay_ms !== undefined) {
    if (!Number.isSafeInteger(input.max_buffer_delay_ms) || input.max_buffer_delay_ms < 0 || input.max_buffer_delay_ms > 5000) {
      throw sessionError('cartesia_tts_session_message_invalid', 'max_buffer_delay_ms must be an integer from 0 to 5000');
    }
    message.max_buffer_delay_ms = input.max_buffer_delay_ms;
  }
  for (const key of ['add_timestamps', 'add_phoneme_timestamps', 'use_normalized_timestamps', 'continue', 'flush']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw sessionError('cartesia_tts_session_message_invalid', `${key} must be a boolean`);
      message[key] = input[key];
    }
  }
  return message;
}

function safeProviderEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const type = String(event.type || '');
  if (!['chunk', 'done', 'flush_done', 'timestamps', 'phoneme_timestamps', 'error'].includes(type)) return null;
  const result = { type };
  if (event.context_id && /^[A-Za-z0-9._:-]{1,120}$/.test(String(event.context_id))) result.context_id = String(event.context_id);
  if (Number.isInteger(event.status_code) && event.status_code >= 100 && event.status_code <= 599) result.status_code = event.status_code;
  if (typeof event.done === 'boolean') result.done = event.done;
  if (type === 'chunk') {
    if (typeof event.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(event.data) && event.data.length <= MAX_UPSTREAM_EVENT_BYTES * 2) result.data = event.data;
    if (typeof event.step_time === 'number' && Number.isFinite(event.step_time) && event.step_time >= 0) result.step_time = event.step_time;
    if (Number.isSafeInteger(event.flush_id) && event.flush_id >= 0) result.flush_id = event.flush_id;
  }
  const cleanAlignment = (alignment, wordsKey) => {
    if (!alignment || typeof alignment !== 'object' || Array.isArray(alignment)) return null;
    const labels = Array.isArray(alignment[wordsKey]) ? alignment[wordsKey].slice(0, 2000).map((word) => typeof word === 'string' ? word.slice(0, 40) : '') : [];
    const starts = Array.isArray(alignment.start) ? alignment.start.slice(0, 2000) : [];
    const ends = Array.isArray(alignment.end) ? alignment.end.slice(0, 2000) : [];
    if (!labels.length || labels.length !== starts.length || labels.length !== ends.length ||
        starts.some((time) => typeof time !== 'number' || !Number.isFinite(time) || time < 0) ||
        ends.some((time, index) => typeof time !== 'number' || !Number.isFinite(time) || time < starts[index])) return null;
    return { [wordsKey]: labels, start: starts, end: ends };
  };
  if (type === 'timestamps') {
    const alignment = cleanAlignment(event.word_timestamps, 'words');
    if (alignment) result.word_timestamps = alignment;
  }
  if (type === 'phoneme_timestamps') {
    const alignment = cleanAlignment(event.phoneme_timestamps, 'phonemes');
    if (alignment) result.phoneme_timestamps = alignment;
  }
  if (type === 'flush_done') {
    if (Number.isSafeInteger(event.flush_id) && event.flush_id >= 1) result.flush_id = event.flush_id;
    if (typeof event.flush_done === 'boolean') result.flush_done = event.flush_done;
  }
  if (type === 'error') {
    result.error_code = String(event.error_code || 'cartesia_tts_error').slice(0, 80);
    result.message = 'Cartesia could not generate speech for this session message.';
  }
  return result;
}

class CartesiaTtsSessionRuntime {
  constructor(options = {}) {
    this.WebSocket = options.WebSocket || require('ws');
    this.apiKey = String(options.apiKey || '').trim();
    this.apiVersion = String(options.apiVersion || '2026-08-14').trim();
    this.websocketBaseUrl = cartesiaWebSocketBaseUrl(options.apiBaseUrl);
    this.idleTimeoutMs = Math.max(10000, Math.min(120000, Number(options.idleTimeoutMs) || 60000));
    this.sessionTimeoutMs = Math.max(this.idleTimeoutMs, Math.min(30 * 60 * 1000, Number(options.sessionTimeoutMs) || 15 * 60 * 1000));
    this.connectTimeoutMs = Math.max(1000, Math.min(30000, Number(options.connectTimeoutMs) || 10000));
    if (!this.apiKey) throw sessionError('cartesia_tts_session_not_configured', 'Cartesia TTS session is not configured', 503);
  }

  connect({ clientSocket, actor } = {}) {
    if (!actor?.id) throw sessionError('cartesia_tts_session_actor_required', 'An authenticated administrator is required', 401);
    if (!clientSocket || typeof clientSocket.on !== 'function') throw sessionError('cartesia_tts_session_socket_required', 'A client WebSocket is required');
    const params = new URLSearchParams({ cartesia_version: this.apiVersion });
    const upstream = new this.WebSocket(`${this.websocketBaseUrl}/tts/websocket?${params}`, { headers: { Authorization: `Bearer ${this.apiKey}` }, maxPayload: MAX_UPSTREAM_EVENT_BYTES });
    let closed = false;
    let requests = 0;
    const pending = [];
    const contextConfigurations = new Map();
    let idleTimer;
    const connectTimer = setTimeout(() => {
      sendError('cartesia_tts_session_connect_timeout', 'Cartesia TTS session connection timed out.');
      close(1013, 'provider connection timeout');
    }, this.connectTimeoutMs);
    connectTimer.unref?.();
    const sessionTimer = setTimeout(() => close(1000, 'maximum session duration reached'), this.sessionTimeoutMs);
    sessionTimer.unref?.();
    const close = (code = 1000, reason = 'session completed') => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(connectTimer);
      clearTimeout(sessionTimer);
      try { if (upstream.readyState === undefined || upstream.readyState < 2) upstream.close(code, reason); } catch { /* best-effort socket cleanup */ }
      try { if (clientSocket.readyState === undefined || clientSocket.readyState < 2) clientSocket.close(code, reason); } catch { /* best-effort socket cleanup */ }
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => close(1000, 'idle timeout'), this.idleTimeoutMs);
      idleTimer.unref?.();
    };
    const sendError = (code, message) => {
      try { if (clientSocket.readyState === undefined || clientSocket.readyState === 1) clientSocket.send(JSON.stringify({ type: 'error', code, message })); } catch { /* socket may be closed */ }
    };
    resetIdle();
    upstream.on('open', () => {
      if (closed) return;
      clearTimeout(connectTimer);
      try { clientSocket.send(JSON.stringify({ type: 'session_ready' })); } catch { return close(); }
      while (pending.length && !closed) upstream.send(pending.shift());
    });
    upstream.on('message', (raw) => {
      if (closed || byteLength(raw) > MAX_UPSTREAM_EVENT_BYTES) return close(1009, 'provider event too large');
      let event;
      try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch { return close(1011, 'invalid provider event'); }
      const safe = safeProviderEvent(event);
      if (!safe) return;
      try { clientSocket.send(JSON.stringify(safe)); } catch { return close(); }
      resetIdle();
    });
    upstream.on('error', () => { sendError('cartesia_tts_session_unavailable', 'Cartesia TTS is temporarily unavailable.'); close(1011, 'provider unavailable'); });
    upstream.on('close', () => close());
    clientSocket.on('message', (raw, isBinary) => {
      if (closed) return;
      resetIdle();
      if (isBinary) { sendError('cartesia_tts_session_message_invalid', 'TTS session accepts JSON text messages only.'); return; }
      let message;
      try { message = parseJson(raw); } catch (error) { sendError(error.code, error.message); return; }
      if (message.cancel === true) {
        if (Object.keys(message).some((key) => !['context_id', 'cancel'].includes(key)) || !/^[A-Za-z0-9._:-]{1,120}$/.test(String(message.context_id || ''))) {
          sendError('cartesia_tts_session_message_invalid', 'A cancel request needs only a valid context_id and cancel=true.'); return;
        }
        if (upstream.readyState === 1) upstream.send(JSON.stringify({ context_id: message.context_id, cancel: true }));
        else if (pending.length < 10) pending.push(JSON.stringify({ context_id: message.context_id, cancel: true }));
        return;
      }
      if (++requests > MAX_REQUESTS_PER_SESSION) { sendError('cartesia_tts_session_limit', 'This TTS session reached its 100-message limit.'); return close(1008, 'message limit'); }
      try {
        const generation = normalizeGeneration(message);
        const contextSettings = { ...generation };
        delete contextSettings.transcript;
        delete contextSettings.continue;
        delete contextSettings.flush;
        const signature = JSON.stringify(contextSettings);
        const previousSignature = contextConfigurations.get(generation.context_id);
        if (previousSignature && previousSignature !== signature) {
          sendError('cartesia_tts_session_context_mismatch', 'Generation settings must remain unchanged within a TTS context.');
          return;
        }
        const payload = JSON.stringify(generation);
        if (upstream.readyState === 1) {
          upstream.send(payload);
          contextConfigurations.set(generation.context_id, signature);
        } else if (pending.length < 10) {
          pending.push(payload);
          contextConfigurations.set(generation.context_id, signature);
        } else {
          sendError('cartesia_tts_session_not_ready', 'Cartesia TTS session is still connecting. Retry this message.');
        }
      } catch (error) { sendError(error.code || 'cartesia_tts_session_message_invalid', error.message); }
    });
    clientSocket.on('close', () => close());
    clientSocket.on('error', () => close(1011, 'client socket error'));
    return { close };
  }
}

module.exports = { CartesiaTtsSessionRuntime, normalizeGeneration, safeProviderEvent };
