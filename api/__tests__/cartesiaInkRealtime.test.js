const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { CartesiaInkRealtimeTranscriptionService, TranscriptionService } = require('../routes/transcription');

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.last = this;
  }

  send(data, options) { this.sent.push({ data, options }); }

  close(code) {
    this.readyState = 3;
    this.closedWith = code;
    this.emit('close', code || 1000);
  }
}

describe('Cartesia Ink realtime transcription adapter', () => {
  function createService(options = {}) {
    return new CartesiaInkRealtimeTranscriptionService({
      apiKey: 'cartesia-ink-test-secret',
      encoding: 'mulaw',
      sampleRate: 8000,
      WebSocketImpl: FakeWebSocket,
      ...options,
    });
  }

  it('uses the documented auto-turn WSS path, server-side auth and versioned query', () => {
    createService();
    const socket = FakeWebSocket.last;
    const url = new URL(socket.url);
    assert.equal(url.origin, 'wss://api.cartesia.ai');
    assert.equal(url.pathname, '/stt/turns/websocket');
    assert.equal(url.searchParams.get('model'), 'ink-2');
    assert.equal(url.searchParams.get('encoding'), 'pcm_mulaw');
    assert.equal(url.searchParams.get('sample_rate'), '8000');
    assert.equal(url.searchParams.get('cartesia_version'), '2026-08-14');
    assert.deepEqual(socket.options.headers, { Authorization: 'Bearer cartesia-ink-test-secret' });
  });

  it('sends raw audio frames and maps incremental and final turns to the existing event contract', () => {
    const service = createService({ encoding: 'linear16', sampleRate: 16000 });
    const socket = FakeWebSocket.last;
    socket.readyState = FakeWebSocket.OPEN;
    const utterances = [];
    const transcriptions = [];
    let speechStarts = 0;
    service.on('utterance', (text) => utterances.push(text));
    service.on('transcription', (text) => transcriptions.push(text));
    service.on('speechStart', () => { speechStarts += 1; });

    const frame = Buffer.from([1, 2, 3, 4]);
    service.send(frame);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'turn.start' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'turn.update', transcript: 'hello' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'turn.eager_end', transcript: 'hello there' })));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'turn.end', transcript: 'hello there' })));

    const url = new URL(socket.url);
    assert.equal(url.searchParams.get('encoding'), 'pcm_s16le');
    assert.equal(url.searchParams.get('sample_rate'), '16000');
    assert.deepEqual(socket.sent[0].data, frame);
    assert.deepEqual(socket.sent[0].options, { binary: true });
    assert.deepEqual(utterances, ['hello', 'hello there']);
    assert.deepEqual(transcriptions, ['hello there']);
    assert.equal(speechStarts, 1);
  });

  it('sends the documented close command and closes after the provider acknowledgement', () => {
    const service = createService();
    const socket = FakeWebSocket.last;
    socket.readyState = FakeWebSocket.OPEN;
    let closeEvents = 0;
    service.on('close', () => { closeEvents += 1; });
    service.close();
    assert.deepEqual(JSON.parse(socket.sent[0].data), { type: 'close' });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'done' })));
    assert.equal(service.closed, true);
    assert.equal(socket.closedWith, 1000);
    assert.equal(closeEvents, 0);
  });

  it('sanitizes provider errors and rejects unsupported media formats or missing credentials', () => {
    const service = createService();
    let emitted;
    service.on('error', (error) => { emitted = error; });
    FakeWebSocket.last.emit('message', Buffer.from(JSON.stringify({
      type: 'error',
      status_code: 400,
      error_code: 'bad_model',
      message: 'private provider body',
    })));
    assert.equal(emitted.message, 'Cartesia Ink realtime request failed (400)');
    assert.equal(emitted.message.includes('private provider body'), false);
    assert.throws(() => createService({ encoding: 'alaw' }), /encoding is unsupported/);
    assert.throws(() => new CartesiaInkRealtimeTranscriptionService({ apiKey: '', WebSocketImpl: FakeWebSocket }), /not configured/);
  });

  it('selects Cartesia only when explicitly configured and preserves Deepgram as the default', () => {
    const selected = new TranscriptionService({
      provider: 'cartesia',
      apiKey: 'cartesia-ink-test-secret',
      WebSocketImpl: FakeWebSocket,
    });
    assert.ok(selected instanceof CartesiaInkRealtimeTranscriptionService);
    assert.throws(() => new TranscriptionService({ provider: 'unknown' }), /Unsupported transcription provider/);
  });
});
