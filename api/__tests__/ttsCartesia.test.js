const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { TextToSpeechService, iterateCartesiaSseAudio } = require('../routes/tts');

function makeConfig(overrides = {}) {
  return {
    deepgram: { apiKey: 'deepgram-test-key', voiceModel: 'aura-2-andromeda-en' },
    openRouter: { voiceOutputMaxChars: 260 },
    tts: {
      provider: 'cartesia',
      cartesia: {
        apiKey: 'cartesia-test-secret',
        voiceId: 'voice-test-id',
        model: 'sonic-3.6',
        apiVersion: '2026-08-14',
        timeoutMs: 5000,
        fallbackToDeepgram: false,
        ...overrides,
      },
    },
  };
}

function sseChunk(audio) {
  return `data: ${JSON.stringify({ type: 'chunk', done: false, data: audio.toString('base64') })}\n\n`;
}

describe('Cartesia TTS adapter', () => {
  it('uses a script Cartesia speech profile even when the global TTS default is another engine', async () => {
    let request;
    const config = makeConfig();
    config.tts.provider = 'deepgram';
    const service = new TextToSpeechService({
      config,
      fetchFn: async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return { ok: true, status: 200, body: Readable.from([sseChunk(Buffer.from([1, 0]))]) };
      },
    });

    service.configureSpeechProfile({ provider: 'cartesia', voice_id: 'script_voice_01' });
    const result = await service.generate(
      { partialResponseIndex: 9, partialResponse: 'Use the script profile.' },
      1,
      { encoding: 'linear16' },
    );

    assert.equal(result.ok, true);
    assert.equal(request.url, 'https://api.cartesia.ai/tts/sse');
    assert.equal(request.body.voice, 'script_voice_01');
  });

  it('rejects malformed per-call speech profiles before changing the selected TTS provider', () => {
    const config = makeConfig();
    config.tts.provider = 'deepgram';
    const service = new TextToSpeechService({ config });

    assert.throws(
      () => service.configureSpeechProfile({ provider: 'cartesia', voice_id: 'https://invalid.example' }),
      { code: 'cartesia_speech_profile_invalid' },
    );
    assert.equal(service.provider, 'deepgram');
  });

  it('uses a validated per-call Cartesia voice profile override', async () => {
    let body;
    const service = new TextToSpeechService({
      config: makeConfig(),
      voiceId: 'voice-script_01',
      fetchFn: async (_url, options) => {
        body = JSON.parse(options.body);
        return { ok: true, status: 200, body: Readable.from([sseChunk(Buffer.from([1, 0]))]) };
      },
    });
    const result = await service.generate({ partialResponseIndex: 8, partialResponse: 'Profile voice.' }, 1, { encoding: 'linear16' });
    assert.equal(result.ok, true);
    assert.equal(body.voice, 'voice-script_01');
  });

  it('exposes validated SSE audio frames incrementally while retaining the buffered API', async () => {
    const first = Buffer.from([0x10, 0x00]);
    const second = Buffer.from([0x20, 0x00]);
    const body = Readable.from([`${sseChunk(first)}${sseChunk(second)}data: {"type":"done","done":true}\n\n`]);
    const chunks = [];
    for await (const chunk of iterateCartesiaSseAudio(body)) chunks.push(chunk);
    assert.deepEqual(chunks, [first, second]);
  });

  it('emits Cartesia chunks to opt-in playback and signals response completion without a duplicate full buffer', async () => {
    const first = Buffer.from([0x10, 0x00]);
    const second = Buffer.from([0x20, 0x00]);
    const service = new TextToSpeechService({
      config: makeConfig(),
      streamPlayback: true,
      fetchFn: async () => ({ ok: true, status: 200, body: Readable.from([`${sseChunk(first)}${sseChunk(second)}`]) }),
    });
    const chunks = [];
    let completed = false;
    let fullSpeech = false;
    service.on('speech_chunk', (_index, audio) => chunks.push(Buffer.from(audio, 'base64')));
    service.on('speech_complete', (_index, _text, _count, metadata) => { completed = metadata.incomplete === false; });
    service.on('speech', () => { fullSpeech = true; });
    const result = await service.generate({ partialResponseIndex: 4, partialResponse: 'Stream me.' }, 1, { encoding: 'linear16' });
    assert.equal(result.ok, true);
    assert.deepEqual(chunks, [first, second]);
    assert.equal(completed, true);
    assert.equal(fullSpeech, false);
  });

  it('does not run full-response fallback after partial Cartesia playback has started', async () => {
    const calls = [];
    const audio = Buffer.from([1, 0]);
    const service = new TextToSpeechService({
      config: makeConfig({ fallbackToDeepgram: true }),
      streamPlayback: true,
      fetchFn: async (url) => {
        calls.push(url);
        if (url.includes('cartesia.ai')) {
          return { ok: true, status: 200, body: Readable.from([`${sseChunk(audio)}data: {"type":"error","error_code":"provider_error"}\n\n`]) };
        }
        return { status: 200, buffer: async () => Buffer.from([1, 2]) };
      },
    });
    let incomplete = false;
    service.on('speech_complete', (_i, _text, _count, metadata) => { incomplete = metadata.incomplete; });
    const result = await service.generate({ partialResponseIndex: 5, partialResponse: 'Do not repeat.' }, 1, { encoding: 'linear16' });
    assert.equal(result.ok, false);
    assert.equal(incomplete, true);
    assert.deepEqual(calls, ['https://api.cartesia.ai/tts/sse']);
  });

  it('aborts an active stream and completes its response slot without fallback', async () => {
    let signal;
    const service = new TextToSpeechService({
      config: makeConfig({ fallbackToDeepgram: true }),
      streamPlayback: true,
      fetchFn: async (_url, options) => {
        signal = options.signal;
        return { ok: true, status: 200, body: Readable.from((async function* () {
          yield sseChunk(Buffer.from([1, 0]));
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        })()) };
      },
    });
    let incomplete = false;
    service.on('speech_complete', (_i, _text, _count, metadata) => { incomplete = metadata.incomplete; });
    const resultPromise = service.generate({ partialResponseIndex: 6, partialResponse: 'Cancel me.' }, 2, { encoding: 'linear16' });
    await new Promise((resolve) => setImmediate(resolve));
    service.cancelStreaming(6);
    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.equal(signal.aborted, true);
    assert.equal(incomplete, true);
  });

  it('uses the versioned SSE contract, combines streamed PCM chunks, and keeps the existing speech event shape', async () => {
    const sourceAudio = Buffer.from([0x10, 0x00, 0x20, 0x00]);
    const frames = `${sseChunk(sourceAudio.subarray(0, 2))}${sseChunk(sourceAudio.subarray(2))}data: {"type":"done","done":true}\n\n`;
    let request;
    const service = new TextToSpeechService({
      config: makeConfig(),
      fetchFn: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, body: Readable.from([frames.slice(0, 19), frames.slice(19)]) };
      },
    });
    let emitted;
    service.on('speech', (...args) => { emitted = args; });

    const result = await service.generate(
      { partialResponseIndex: 7, partialResponse: 'Hello there.' },
      2,
      { encoding: 'linear16', sampleRate: 8000, language: 'en' },
    );

    assert.equal(result.ok, true);
    assert.equal(request.url, 'https://api.cartesia.ai/tts/sse');
    assert.equal(request.options.headers.Authorization, 'Bearer cartesia-test-secret');
    assert.equal(request.options.headers['Cartesia-Version'], '2026-08-14');
    assert.equal(request.options.headers.Accept, 'text/event-stream');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model_id, 'sonic-3.6');
    assert.equal(body.voice, 'voice-test-id');
    assert.deepEqual(body.output_format, { container: 'raw', encoding: 'pcm_s16le', sample_rate: 8000 });
    assert.equal(body.language, 'en');
    assert.deepEqual(emitted.slice(0, 2), [7, sourceAudio.toString('base64')]);
    assert.equal(JSON.stringify(result).includes('cartesia-test-secret'), false);
  });

  it('passes only documented Sonic generation options and keeps option variants out of the same cache entry', async () => {
    const sourceAudio = Buffer.from([0x10, 0x00]);
    let body;
    const service = new TextToSpeechService({
      config: makeConfig(),
      fetchFn: async (_url, options) => {
        body = JSON.parse(options.body);
        return { ok: true, status: 200, body: Readable.from([sseChunk(sourceAudio)]) };
      },
    });
    const result = await service.generate(
      { partialResponseIndex: 0, partialResponse: 'Configured speech.' },
      0,
      {
        encoding: 'linear16',
        accent: 'French',
        normalization: 'auto',
        pronunciationDictId: 'dict_test_01',
        speed: 1.1,
        volume: 0.8,
        emotion: 'curious',
      },
    );
    assert.equal(result.ok, true);
    assert.equal(body.accent, 'French');
    assert.equal(body.normalization, 'auto');
    assert.equal(body.pronunciation_dict_id, 'dict_test_01');
    assert.deepEqual(body.generation_config, { speed: 1.1, volume: 0.8, emotion: 'curious' });
  });

  it('rejects invalid Sonic generation options before calling Cartesia', async () => {
    let called = false;
    const service = new TextToSpeechService({
      config: makeConfig(),
      fetchFn: async () => { called = true; },
    });
    await assert.rejects(service.generate(
      { partialResponseIndex: 0, partialResponse: 'Invalid speed.' },
      0,
      { speed: 2.1, throwOnError: true },
    ), /speed must be between/);
    assert.equal(called, false);
  });

  it('converts Cartesia PCM16 output to raw μ-law for the existing telephony stream', async () => {
    const audio = Buffer.from([0, 0, 0xff, 0x7f]);
    const service = new TextToSpeechService({
      config: makeConfig(),
      fetchFn: async () => ({ ok: true, status: 200, body: Readable.from([sseChunk(audio)]) }),
    });
    let emittedAudio;
    service.on('speech', (_index, base64Audio) => { emittedAudio = base64Audio; });
    const result = await service.generate(
      { partialResponseIndex: 0, partialResponse: 'Audio format test.' },
      0,
      { encoding: 'mulaw', sampleRate: 8000 },
    );
    const output = Buffer.from(emittedAudio || '', 'base64');
    assert.equal(result.ok, true);
    assert.equal(output.length, 2);
    assert.notDeepEqual(output, audio);
  });

  it('supports the documented Cartesia bytes endpoint while preserving raw PCM output', async () => {
    const pcm = Buffer.from([0x10, 0x00, 0x20, 0x00]);
    let request;
    const service = new TextToSpeechService({
      config: makeConfig(),
      fetchFn: async (url, options) => {
        request = { url, options };
        return { ok: true, status: 200, buffer: async () => pcm };
      },
    });
    let emitted;
    service.on('speech', (_index, audio) => { emitted = audio; });
    const result = await service.generate(
      { partialResponseIndex: 1, partialResponse: 'Bytes transport.' },
      0,
      { transport: 'bytes', encoding: 'linear16', sampleRate: 8000 },
    );
    assert.equal(result.ok, true);
    assert.equal(request.url, 'https://api.cartesia.ai/tts/bytes');
    assert.equal(request.options.headers.Accept, undefined);
    assert.deepEqual(JSON.parse(request.options.body).output_format, {
      container: 'raw', encoding: 'pcm_s16le', sample_rate: 8000,
    });
    assert.equal(emitted, pcm.toString('base64'));
  });

  it('rejects unsupported Cartesia TTS transports before provider I/O', async () => {
    let called = false;
    const service = new TextToSpeechService({ config: makeConfig(), fetchFn: async () => { called = true; } });
    await assert.rejects(service.generate(
      { partialResponseIndex: 1, partialResponse: 'Unsupported transport.' },
      0,
      { transport: 'websocket', throwOnError: true },
    ), /transport must be sse or bytes/);
    assert.equal(called, false);
  });

  it('rejects container output that the current call bridge cannot play', async () => {
    let called = false;
    const service = new TextToSpeechService({
      config: makeConfig(),
      fetchFn: async () => { called = true; },
    });
    await assert.rejects(
      service.generate(
        { partialResponseIndex: 1, partialResponse: 'Container test.' },
        0,
        { container: 'wav', throwOnError: true },
      ),
      /only supports raw audio/,
    );
    assert.equal(called, false);
  });

  it('falls back to Deepgram on a Cartesia service error when enabled', async () => {
    const calls = [];
    const service = new TextToSpeechService({
      config: makeConfig({ fallbackToDeepgram: true }),
      fetchFn: async (url) => {
        calls.push(url);
        if (url.includes('cartesia.ai')) return { ok: false, status: 503 };
        return { status: 200, buffer: async () => Buffer.from([1, 2, 3]) };
      },
    });
    const result = await service.generate(
      { partialResponseIndex: 3, partialResponse: 'Fallback test.' },
      1,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      'https://api.cartesia.ai/tts/sse',
      'https://api.deepgram.com/v1/speak?model=aura-2-andromeda-en&encoding=mulaw&sample_rate=8000&container=none',
    ]);
  });
});
