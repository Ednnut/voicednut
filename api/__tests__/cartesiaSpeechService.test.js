const assert = require('node:assert/strict');
const {
  CartesiaSpeechService,
  MAX_AUDIO_BYTES,
  validateVoiceQuery,
} = require('../services/cartesiaSpeechService');

function makeConfig(overrides = {}) {
  return {
    tts: {
      cartesia: {
        apiKey: 'cartesia-speech-test-secret',
        apiVersion: '2026-08-14',
        timeoutMs: 5000,
        ...overrides,
      },
    },
  };
}

describe('Cartesia speech service', () => {
  it('lists voices using the documented versioned, paginated query and returns a curated response', async () => {
    let request;
    const service = new CartesiaSpeechService({
      config: makeConfig(),
      fetchFn: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'voice_1', name: 'Example', description: 'Test', language: 'en', gender: 'feminine', preview_file_url: 'https://example.invalid/audio' }],
            has_more: true,
            next_page: 'voice_1',
          }),
        };
      },
    });
    const result = await service.listVoices({ limit: '10', q: 'Example', language: 'en', is_owner: 'true' });
    assert.equal(request.url, 'https://api.cartesia.ai/voices?limit=10&q=Example&language=en&is_owner=true');
    assert.equal(request.options.headers.Authorization, 'Bearer cartesia-speech-test-secret');
    assert.equal(request.options.headers['Cartesia-Version'], '2026-08-14');
    assert.deepEqual(result, {
      data: [{ id: 'voice_1', name: 'Example', description: 'Test', language: 'en', gender: 'feminine' }],
      hasMore: true,
      nextPage: 'voice_1',
    });
    assert.equal(JSON.stringify(result).includes('cartesia-speech-test-secret'), false);
  });

  it('rejects malformed voice filters before provider I/O', async () => {
    let called = false;
    const service = new CartesiaSpeechService({ config: makeConfig(), fetchFn: async () => { called = true; } });
    assert.throws(() => validateVoiceQuery({ limit: 101 }), /between 1 and 100/);
    await assert.rejects(service.listVoices({ starting_after: 'voice_a', ending_before: 'voice_b' }), /only one/);
    assert.equal(called, false);
  });

  it('submits bounded audio to the documented Ink multipart endpoint and normalizes word timestamps', async () => {
    let request;
    const service = new CartesiaSpeechService({
      config: makeConfig(),
      fetchFn: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          json: async () => ({
            type: 'transcript',
            text: 'hello there',
            request_id: 'stt_req_1',
            language: 'en',
            duration: 1.25,
            words: [{ word: 'hello', start: 0, end: 0.5 }, { word: 'there', start: 0.6, end: 1.1 }],
          }),
        };
      },
    });
    const result = await service.transcribeAudio({
      audio: Buffer.from('fake audio'),
      mimeType: 'audio/wav',
      language: 'en',
      wordTimestamps: true,
    });
    assert.equal(request.url, 'https://api.cartesia.ai/stt');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer cartesia-speech-test-secret');
    assert.match(request.options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    const multipart = request.options.body.toString('latin1');
    assert.match(multipart, /name="model"\r\n\r\nink-whisper/);
    assert.match(multipart, /name="timestamp_granularities\[\]"\r\n\r\nword/);
    assert.match(multipart, /filename="audio\.wav"/);
    assert.deepEqual(result, {
      text: 'hello there',
      requestId: 'stt_req_1',
      language: 'en',
      duration: 1.25,
      words: [{ word: 'hello', start: 0, end: 0.5 }, { word: 'there', start: 0.6, end: 1.1 }],
    });
    assert.equal(JSON.stringify(result).includes('cartesia-speech-test-secret'), false);
  });

  it('rejects unsupported media, language and oversized audio before Cartesia I/O', async () => {
    let called = false;
    const service = new CartesiaSpeechService({ config: makeConfig(), fetchFn: async () => { called = true; } });
    await assert.rejects(service.transcribeAudio({ audio: Buffer.from('x'), mimeType: 'application/octet-stream' }), { statusCode: 415 });
    await assert.rejects(service.transcribeAudio({ audio: Buffer.from('x'), mimeType: 'audio/wav', language: 'xx' }), { statusCode: 400 });
    await assert.rejects(service.transcribeAudio({ audio: Buffer.alloc(MAX_AUDIO_BYTES + 1), mimeType: 'audio/wav' }), { statusCode: 400 });
    assert.equal(called, false);
  });

  it('does not return raw provider errors or accept malformed provider results', async () => {
    const errorService = new CartesiaSpeechService({
      config: makeConfig(),
      fetchFn: async () => ({ ok: false, status: 403, text: async () => 'contains private provider details' }),
    });
    await assert.rejects(errorService.listVoices(), (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.message.includes('private provider details'), false);
      return true;
    });
    const malformedService = new CartesiaSpeechService({
      config: makeConfig(),
      fetchFn: async () => ({ ok: true, json: async () => ({ type: 'error', message: 'invalid' }) }),
    });
    await assert.rejects(malformedService.transcribeAudio({ audio: Buffer.from('fake'), mimeType: 'audio/wav' }), /invalid transcription/);
  });
});
