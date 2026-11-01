'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CartesiaSttSessionRuntime, normalizeSessionQuery, sanitizeProviderEvent, selectSessionQuery } = require('../services/cartesiaSttSessionRuntime');

class FakeSocket extends EventEmitter {
  constructor(url = 'client', options = {}) { super(); this.url = url; this.options = options; this.readyState = 1; this.sent = []; }
  send(value, options) { this.sent.push({ value, options }); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; this.emit('close'); }
}

describe('Cartesia live STT WebSocket session runtime', () => {
  it('proxies raw audio and safe turn events through one authenticated server socket', async () => {
    let upstream;
    class Upstream extends FakeSocket { constructor(url, options) { super(url, options); upstream = this; queueMicrotask(() => this.emit('open')); } }
    const client = new FakeSocket();
    const runtime = new CartesiaSttSessionRuntime({ apiKey: 'sk_car_mock', apiBaseUrl: 'https://api.eu.cartesia.ai', WebSocket: Upstream });
    runtime.connect({ clientSocket: client, actor: { id: '7001' }, query: { model: 'ink-2', encoding: 'pcm_s16le', sample_rate: '16000', keyterm: ['VOICEDNUT'] } });
    client.emit('message', Buffer.from([1, 2, 3, 4]), true);
    await new Promise((resolve) => setImmediate(resolve));
    const url = new URL(upstream.url);
    assert.equal(url.host, 'api.eu.cartesia.ai');
    assert.equal(url.pathname, '/stt/turns/websocket');
    assert.equal(url.searchParams.get('cartesia_version'), '2026-08-14');
    assert.equal(url.searchParams.get('keyterm'), 'VOICEDNUT');
    assert.equal(upstream.options.headers['X-API-Key'], 'sk_car_mock');
    assert.deepEqual(upstream.sent[0], { value: Buffer.from([1, 2, 3, 4]), options: { binary: true } });
    client.emit('message', Buffer.from(JSON.stringify({ type: 'config', turn: { start_threshold: 0.8, eager_end_threshold: 0.6, end_threshold: 0.3, end_timeout_ms: 5600 } })), false);
    assert.deepEqual(JSON.parse(upstream.sent[1].value), { type: 'config', turn: { start_threshold: 0.8, eager_end_threshold: 0.6, end_threshold: 0.3, end_timeout_ms: 5600 } });
    upstream.emit('message', Buffer.from(JSON.stringify({ type: 'turn.update', transcript: 'hello', request_id: 'request_1', api_key: 'must_not_forward' })));
    assert.deepEqual(JSON.parse(client.sent.at(-1).value), { type: 'turn.update', transcript: 'hello', request_id: 'request_1' });
    client.emit('message', Buffer.from(JSON.stringify({ type: 'close' })), false);
    assert.deepEqual(JSON.parse(upstream.sent.at(-1).value), { type: 'close' });
    client.close();
  });

  it('bounds formats, turn thresholds, frame sizes, and actor requirements', () => {
    assert.deepEqual(selectSessionQuery({ actor_id: '7001', api_auth_ts: '123', model: 'ink-2', sample_rate: '16000' }), { model: 'ink-2', sample_rate: '16000' });
    assert.deepEqual(normalizeSessionQuery({ encoding: 'pcm_mulaw', sample_rate: '8000' }).sampleRate, 8000);
    assert.throws(() => normalizeSessionQuery({ encoding: 'pcm_mulaw', sample_rate: '16000' }), { code: 'cartesia_stt_session_format_invalid' });
    assert.equal(sanitizeProviderEvent({ type: 'turn.update', transcript: 'secret', api_key: 'not-forwarded' }).api_key, undefined);
    const client = new FakeSocket();
    const runtime = new CartesiaSttSessionRuntime({ apiKey: 'sk_car_mock', WebSocket: FakeSocket });
    assert.throws(() => runtime.connect({ clientSocket: client }), { code: 'cartesia_stt_session_actor_required' });
    runtime.connect({ clientSocket: client, actor: { id: '7001' } });
    client.emit('message', Buffer.from(JSON.stringify({ type: 'config', turn: { start_threshold: 0.5, eager_end_threshold: 0.6, end_threshold: 0.3, end_timeout_ms: 5600 } })), false);
    assert.equal(JSON.parse(client.sent.at(-1).value).code, 'cartesia_stt_session_turn_config_invalid');
    client.emit('message', Buffer.alloc(32 * 1024 + 1), true);
    assert.equal(JSON.parse(client.sent.at(-1).value).code, 'cartesia_stt_session_audio_frame_invalid');
    client.close();
  });
});
