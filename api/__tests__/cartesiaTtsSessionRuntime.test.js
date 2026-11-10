'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CartesiaTtsSessionRuntime } = require('../services/cartesiaTtsSessionRuntime');

class FakeSocket extends EventEmitter {
  constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 1; this.sent = []; queueMicrotask(() => this.emit('open')); }
  send(value) { this.sent.push(value); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; this.emit('close'); }
}

describe('Cartesia TTS WebSocket session runtime', () => {
  it('keeps one authenticated Cartesia socket open for repeated, bounded generation messages', async () => {
    let upstream;
    class Upstream extends FakeSocket { constructor(url, options) { super(url, options); upstream = this; } }
    const client = new FakeSocket('client', {});
    const runtime = new CartesiaTtsSessionRuntime({ apiKey: 'sk_car_mock', apiBaseUrl: 'https://api.eu.cartesia.ai', WebSocket: Upstream, idleTimeoutMs: 60000 });
    runtime.connect({ clientSocket: client, actor: { id: '7001' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.sent[0], JSON.stringify({ type: 'session_ready' }));
    assert.equal(new URL(upstream.url).host, 'api.eu.cartesia.ai');
    assert.equal(upstream.options.headers.Authorization, 'Bearer sk_car_mock');
    assert.equal(new URL(upstream.url).searchParams.get('cartesia_version'), '2026-08-14');
    const generation = { model_id: 'sonic-3.6', transcript: 'Hello', voice: 'voice_1', language: 'en', context_id: 'context_1', output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 }, add_timestamps: true };
    client.emit('message', Buffer.from(JSON.stringify(generation)), false);
    client.emit('message', Buffer.from(JSON.stringify({ ...generation, transcript: ' again', continue: true })), false);
    assert.equal(upstream.sent.length, 2);
    assert.deepEqual(JSON.parse(upstream.sent[0]), generation);
    assert.deepEqual(JSON.parse(upstream.sent[1]), { ...generation, transcript: ' again', continue: true });
    upstream.emit('message', Buffer.from(JSON.stringify({ type: 'chunk', data: 'AQI=', context_id: 'context_1', status_code: 206 })));
    assert.deepEqual(JSON.parse(client.sent.at(-1)), { type: 'chunk', context_id: 'context_1', status_code: 206, data: 'AQI=' });
    client.emit('message', Buffer.from(JSON.stringify({ ...generation, api_key: 'must_not_forward' })), false);
    assert.equal(upstream.sent.length, 2);
    assert.equal(JSON.parse(client.sent.at(-1)).type, 'error');
    client.emit('message', Buffer.from(JSON.stringify({ context_id: 'context_1', cancel: true })), false);
    assert.deepEqual(JSON.parse(upstream.sent.at(-1)), { context_id: 'context_1', cancel: true });
    client.close();
  });

  it('requires an authenticated actor and rejects invalid audio formats before provider input', () => {
    const client = new FakeSocket('client', {});
    const runtime = new CartesiaTtsSessionRuntime({ apiKey: 'sk_car_mock', WebSocket: FakeSocket });
    assert.throws(() => runtime.connect({ clientSocket: client }), { code: 'cartesia_tts_session_actor_required' });
    client.emit('message', Buffer.from(JSON.stringify({ model_id: 'sonic-3.6', transcript: 'Hello', voice: 'voice_1', language: 'en', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 } })), false);
    assert.throws(() => require('../services/cartesiaTtsSessionRuntime').normalizeGeneration({ model_id: 'sonic-3.6', transcript: 'Hello', voice: 'voice_1', language: 'en', context_id: 'context_1', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 } }), { code: 'cartesia_tts_session_format_invalid' });
  });

  it('accepts documented output formats and optional generation controls', () => {
    const { normalizeGeneration } = require('../services/cartesiaTtsSessionRuntime');
    const normalized = normalizeGeneration({
      model_id: 'sonic-3.6',
      transcript: 'Hello',
      voice: { id: 'voice_1', future_field: 'ignored' },
      locale: 'en_GB',
      context_id: 'context_1',
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
      accent: 'Southern American',
      normalization: 'en-IN',
      pronunciation_dict_id: 'dict_1',
      generation_config: { speed: 1.2, volume: 0.9, emotion: 'calm' },
      add_timestamps: true,
      add_phoneme_timestamps: true,
      use_normalized_timestamps: true,
      max_buffer_delay_ms: 0,
      flush: true,
    });
    assert.deepEqual(normalized, {
      model_id: 'sonic-3.6',
      transcript: 'Hello',
      voice: 'voice_1',
      locale: 'en_GB',
      context_id: 'context_1',
      output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
      accent: 'Southern American',
      normalization: 'en-IN',
      pronunciation_dict_id: 'dict_1',
      generation_config: { speed: 1.2, volume: 0.9, emotion: 'calm' },
      add_timestamps: true,
      add_phoneme_timestamps: true,
      use_normalized_timestamps: true,
      max_buffer_delay_ms: 0,
      flush: true,
    });
    assert.equal(normalizeGeneration({
      model_id: 'sonic-3.6',
      transcript: '',
      voice: 'voice_1',
      context_id: 'context_1',
      output_format: { container: 'raw', encoding: 'pcm_alaw', sample_rate: 48000 },
    }).output_format.encoding, 'pcm_alaw');
    assert.throws(() => normalizeGeneration({
      model_id: 'sonic-3.6',
      transcript: 'Hello',
      voice: 'voice_1',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
    }), { code: 'cartesia_tts_session_message_invalid' });
    assert.throws(() => normalizeGeneration({
      model_id: 'sonic-3.6',
      transcript: 'Hello',
      voice: 'voice_1',
      language: 'en',
      locale: 'en-GB',
      context_id: 'context_1',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
    }), { code: 'cartesia_tts_session_message_invalid' });
    assert.throws(() => normalizeGeneration({
      model_id: 'sonic-3.6',
      transcript: 'Hello',
      voice: 'voice_1',
      context_id: 'context_1',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
      max_buffer_delay_ms: 5001,
    }), { code: 'cartesia_tts_session_message_invalid' });
  });

  it('rejects changes to generation settings within a TTS context', async () => {
    let upstream;
    class Upstream extends FakeSocket { constructor(url, options) { super(url, options); upstream = this; } }
    const client = new FakeSocket('client', {});
    new CartesiaTtsSessionRuntime({ apiKey: 'sk_car_mock', WebSocket: Upstream }).connect({ clientSocket: client, actor: { id: '7001' } });
    await new Promise((resolve) => setImmediate(resolve));
    const initial = {
      model_id: 'sonic-3.6',
      transcript: 'Hello',
      voice: 'voice_1',
      language: 'en',
      context_id: 'context_1',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
      generation_config: { speed: 1 },
    };
    client.emit('message', Buffer.from(JSON.stringify({ ...initial, continue: true })), false);
    client.emit('message', Buffer.from(JSON.stringify({
      ...initial,
      transcript: ' again',
      generation_config: { speed: 1.2 },
    })), false);
    assert.equal(upstream.sent.length, 1);
    assert.equal(JSON.parse(client.sent.at(-1)).code, 'cartesia_tts_session_context_mismatch');
    client.close();
  });

  it('preserves documented completion and flush metadata while sanitizing provider events', () => {
    const { safeProviderEvent } = require('../services/cartesiaTtsSessionRuntime');
    assert.deepEqual(safeProviderEvent({
      type: 'flush_done',
      done: false,
      flush_done: true,
      flush_id: 1,
      status_code: 206,
      context_id: 'context_1',
    }), {
      type: 'flush_done',
      context_id: 'context_1',
      status_code: 206,
      done: false,
      flush_id: 1,
      flush_done: true,
    });
    assert.deepEqual(safeProviderEvent({
      type: 'chunk',
      data: 'AQI=',
      done: true,
      status_code: 200,
      step_time: 12.5,
      context_id: 'context_1',
      secret: 'must not be forwarded',
    }), {
      type: 'chunk',
      context_id: 'context_1',
      status_code: 200,
      done: true,
      data: 'AQI=',
      step_time: 12.5,
    });
  });
});
