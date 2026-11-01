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
    assert.equal(upstream.options.headers['X-API-Key'], 'sk_car_mock');
    const generation = { model_id: 'sonic-3.6', transcript: 'Hello', voice: 'voice_1', language: 'en', context_id: 'context_1', output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 }, add_timestamps: true };
    client.emit('message', Buffer.from(JSON.stringify(generation)), false);
    client.emit('message', Buffer.from(JSON.stringify({ ...generation, transcript: ' again', continue: true })), false);
    assert.equal(upstream.sent.length, 2);
    assert.deepEqual(JSON.parse(upstream.sent[0]), generation);
    assert.deepEqual(JSON.parse(upstream.sent[1]), { ...generation, transcript: ' again', continue: true });
    upstream.emit('message', Buffer.from(JSON.stringify({ type: 'chunk', data: 'AQI=', context_id: 'context_1', status_code: 206 })));
    assert.deepEqual(JSON.parse(client.sent.at(-1)), { type: 'chunk', context_id: 'context_1', data: 'AQI=' });
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
    assert.throws(() => require('../services/cartesiaTtsSessionRuntime').normalizeGeneration({ model_id: 'sonic-3.6', transcript: 'Hello', voice: 'voice_1', language: 'en', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 } }), { code: 'cartesia_tts_session_format_invalid' });
  });
});
