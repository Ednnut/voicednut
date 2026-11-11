const { Buffer } = require('node:buffer');
const EventEmitter = require('events');
const fetch = require('node-fetch');
const config = require('../config');
const { sanitizeVoiceOutputText } = require('../utils/voiceOutputGuard');

const TTS_CACHE_TTL_MS = 15 * 60 * 1000;
const TTS_CACHE_MAX_ITEMS = 200;
const ttsCache = new Map(); // key -> { audio, at }
const ttsInflight = new Map(); // key -> Promise
const CARTESIA_EMOTIONS = new Set([
  'neutral', 'happy', 'excited', 'enthusiastic', 'elated', 'euphoric', 'triumphant', 'amazed', 'surprised',
  'flirtatious', 'curious', 'content', 'peaceful', 'serene', 'calm', 'grateful', 'affectionate', 'trust',
  'sympathetic', 'anticipation', 'mysterious', 'angry', 'mad', 'outraged', 'frustrated', 'agitated',
  'threatened', 'disgusted', 'contempt', 'envious', 'sarcastic', 'ironic', 'sad', 'dejected', 'melancholic',
  'disappointed', 'hurt', 'guilty', 'bored', 'tired', 'rejected', 'nostalgic', 'wistful', 'apologetic',
  'hesitant', 'insecure', 'confused', 'resigned', 'anxious', 'panicked', 'alarmed', 'scared', 'proud',
  'confident', 'distant', 'skeptical', 'contemplative', 'determined',
]);

function buildTtsCacheKey(text, voiceModel, audioSpec = {}, provider = 'deepgram') {
  const cleanText = String(text || '').trim();
  const encoding = String(audioSpec.encoding || 'mulaw').toLowerCase();
  const sampleRate = Number(audioSpec.sampleRate) || 8000;
  const container = String(audioSpec.container || 'none').toLowerCase();
  const locale = String(audioSpec.language || audioSpec.locale || '').toLowerCase();
  const generation = audioSpec.generationConfig && typeof audioSpec.generationConfig === 'object'
    ? JSON.stringify(audioSpec.generationConfig)
    : '';
  const pronunciation = String(audioSpec.pronunciationDictId || '');
  const accent = String(audioSpec.accent || '');
  const normalization = String(audioSpec.normalization || '');
  const transport = String(audioSpec.transport || 'default');
  return `${provider}:${voiceModel || 'default'}::${encoding}:${sampleRate}:${container}:${locale}:${accent}:${normalization}:${pronunciation}:${transport}:${generation}::${cleanText}`;
}

function encodeMuLawSample(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let value = Math.max(-CLIP, Math.min(CLIP, sample));
  const sign = value < 0 ? 0x80 : 0;
  if (value < 0) value = -value;
  value += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (value & mask) === 0; mask >>= 1) exponent -= 1;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function pcm16ToMuLaw(buffer) {
  if (buffer.length % 2 !== 0) {
    throw new Error('Cartesia returned incomplete PCM16 audio');
  }
  const output = Buffer.alloc(Math.floor(buffer.length / 2));
  for (let i = 0; i < output.length; i += 1) {
    output[i] = encodeMuLawSample(buffer.readInt16LE(i * 2));
  }
  return output;
}

async function* iterateCartesiaSseAudio(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new Error('Cartesia streaming response body is unavailable');
  }
  let pending = '';
  const consumeFrame = (frame) => {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('Cartesia returned an invalid streaming event');
    }
    if (event.type === 'error') {
      const error = new Error('Cartesia TTS request failed');
      error.code = String(event.error_code || 'cartesia_tts_error').replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
      throw error;
    }
    if (event.type !== 'chunk') return;
    const encoded = String(event.data || '');
    if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('Cartesia returned an invalid audio chunk');
    }
    const audioChunk = Buffer.from(encoded, 'base64');
    if (!audioChunk.length) return;
    return audioChunk;
  };

  for await (const part of body) {
    pending += Buffer.from(part).toString('utf8');
    let boundary;
    while ((boundary = pending.search(/\r?\n\r?\n/)) !== -1) {
      const frame = pending.slice(0, boundary);
      const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)[0];
      pending = pending.slice(boundary + separator.length);
      const audioChunk = consumeFrame(frame);
      if (audioChunk) yield audioChunk;
    }
  }
  if (pending.trim()) {
    const audioChunk = consumeFrame(pending);
    if (audioChunk) yield audioChunk;
  }
}

async function collectCartesiaSseAudio(body) {
  const chunks = [];
  for await (const chunk of iterateCartesiaSseAudio(body)) chunks.push(chunk);
  if (!chunks.length) throw new Error('Cartesia returned no audio data');
  return Buffer.concat(chunks);
}

function pruneTtsCache() {
  if (ttsCache.size <= TTS_CACHE_MAX_ITEMS) return;
  const entries = [...ttsCache.entries()].sort((a, b) => a[1].at - b[1].at);
  const overflow = entries.length - TTS_CACHE_MAX_ITEMS;
  for (let i = 0; i < overflow; i += 1) {
    ttsCache.delete(entries[i][0]);
  }
}

class TextToSpeechService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = options.config || config;
    this.fetch = options.fetchFn || fetch;
    this.provider = String(options.provider || this.config.tts?.provider || 'deepgram').trim().toLowerCase();
    this.voiceModel = options.voiceModel || null;
    this.voiceId = options.voiceId || null;
    this.encoding = String(options.encoding || 'mulaw')
      .toLowerCase()
      .trim();
    this.sampleRate = Number.isFinite(Number(options.sampleRate))
      ? Number(options.sampleRate)
      : 8000;
    this.container = String(options.container || 'none')
      .toLowerCase()
      .trim();
    this.streamPlayback = options.streamPlayback === true;
    this.activeStreamControllers = new Map();

    if (!['deepgram', 'cartesia'].includes(this.provider)) {
      throw new Error(`Unsupported TTS provider: ${this.provider}`);
    }
    if (this.provider === 'deepgram' && !this.config.deepgram.apiKey) {
      console.error('❌ DEEPGRAM_API_KEY is not set');
    }
    if (this.provider === 'deepgram' && !this.config.deepgram.voiceModel) {
      console.warn('⚠️ VOICE_MODEL not set, using default');
    }
  }

  configureSpeechProfile(settings) {
    if (settings === undefined || settings === null) return;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        String(settings.provider || '').trim().toLowerCase() !== 'cartesia' ||
        typeof settings.voice_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(settings.voice_id.trim())) {
      const error = new Error('Cartesia speech profile is invalid');
      error.code = 'cartesia_speech_profile_invalid';
      throw error;
    }
    this.provider = 'cartesia';
    this.voiceId = settings.voice_id.trim();
  }

  async fetchSpeechAudio(text, voiceModel, audioSpec = {}, provider = this.provider) {
    if (provider === 'cartesia') {
      return this.fetchCartesiaSpeechAudio(text, voiceModel, audioSpec);
    }
    return this.fetchDeepgramSpeechAudio(text, voiceModel, audioSpec);
  }

  async fetchDeepgramSpeechAudio(text, voiceModel, audioSpec = {}) {
    const encoding = String(audioSpec.encoding || this.encoding || 'mulaw')
      .toLowerCase()
      .trim();
    const sampleRate = Number.isFinite(Number(audioSpec.sampleRate))
      ? Number(audioSpec.sampleRate)
      : this.sampleRate;
    const container = String(audioSpec.container || this.container || 'none')
      .toLowerCase()
      .trim();
    const query = new URLSearchParams({
      model: voiceModel,
      encoding,
      sample_rate: String(sampleRate),
      container,
    });
    const url = `https://api.deepgram.com/v1/speak?${query.toString()}`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${this.config.deepgram.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      timeout: 10000
    });

    if (response.status !== 200) {
      // Provider error bodies can contain request details. Keep diagnostics safe.
      const error = new Error(`Deepgram TTS request failed (${response.status})`);
      error.statusCode = response.status;
      throw error;
    }

    const audioBuffer = await response.buffer();
    return Buffer.from(audioBuffer).toString('base64');
  }

  async fetchCartesiaSpeechAudio(text, modelId, audioSpec = {}, onAudioChunk = null, signal = undefined) {
    const cartesia = this.config.tts?.cartesia || {};
    const apiKey = String(cartesia.apiKey || '').trim();
    const voiceId = String(audioSpec.voiceId || cartesia.voiceId || '').trim();
    if (!apiKey) throw new Error('Cartesia TTS is selected but CARTESIA_API_KEY is not configured');
    if (!voiceId) throw new Error('Cartesia TTS is selected but CARTESIA_VOICE_ID is not configured');
    const requestedContainer = String(audioSpec.container || this.container || 'none').toLowerCase();
    if (!['none', 'raw'].includes(requestedContainer)) {
      throw new Error('Cartesia TTS only supports raw audio in the current call pipeline');
    }
    const encoding = String(audioSpec.encoding || this.encoding || 'mulaw').toLowerCase();
    if (!['mulaw', 'ulaw', 'linear16', 'pcm_s16le'].includes(encoding)) {
      throw new Error(`Cartesia output encoding ${encoding} is not supported`);
    }
    if (!['sonic-3.6', 'sonic-3.5', 'sonic-3', 'sonic-latest'].includes(modelId || cartesia.model || 'sonic-3.6')) {
      throw new Error('Cartesia TTS model is not in the supported model set');
    }
    if ((cartesia.apiVersion || '2026-08-14') !== '2026-08-14') {
      throw new Error('Cartesia API version is unsupported by the current adapter');
    }
    const sampleRate = Number.isFinite(Number(audioSpec.sampleRate)) ? Number(audioSpec.sampleRate) : this.sampleRate;
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error('Cartesia output sample rate must be a positive integer');
    }
    const requestBody = {
      model_id: modelId || cartesia.model || 'sonic-3.6',
      transcript: text,
      voice: voiceId,
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: sampleRate },
    };
    const transport = String(audioSpec.transport || cartesia.transport || 'sse').toLowerCase();
    if (!['sse', 'bytes'].includes(transport)) {
      throw new Error('Cartesia TTS transport must be sse or bytes');
    }
    if (audioSpec.language) requestBody.language = String(audioSpec.language);
    if (audioSpec.locale) requestBody.locale = String(audioSpec.locale);
    if (requestBody.language && requestBody.locale) {
      throw new Error('Cartesia TTS accepts either language or locale, not both');
    }
    if (audioSpec.accent) requestBody.accent = String(audioSpec.accent);
    if (audioSpec.normalization) requestBody.normalization = String(audioSpec.normalization);
    if (audioSpec.pronunciationDictId) {
      requestBody.pronunciation_dict_id = String(audioSpec.pronunciationDictId);
    }
    if (audioSpec.generationConfig && typeof audioSpec.generationConfig === 'object') {
      const generationConfig = {};
      for (const field of ['speed', 'volume']) {
        if (audioSpec.generationConfig[field] === undefined) continue;
        const value = Number(audioSpec.generationConfig[field]);
        const minimum = field === 'speed' ? 0.6 : 0.5;
        const maximum = field === 'speed' ? 1.5 : 2;
        if (!Number.isFinite(value) || value < minimum || value > maximum) {
          throw new Error(`Cartesia ${field} must be between ${minimum} and ${maximum}`);
        }
        generationConfig[field] = value;
      }
      if (audioSpec.generationConfig.emotion !== undefined) {
        const emotion = String(audioSpec.generationConfig.emotion).toLowerCase();
        if (!CARTESIA_EMOTIONS.has(emotion)) throw new Error('Cartesia emotion is unsupported');
        generationConfig.emotion = emotion;
      }
      if (Object.keys(generationConfig).length) requestBody.generation_config = generationConfig;
    }
    const response = await this.fetch(`https://api.cartesia.ai/tts/${transport}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Cartesia-Version': cartesia.apiVersion || '2026-08-14',
        'Content-Type': 'application/json',
        ...(transport === 'sse' ? { Accept: 'text/event-stream' } : {}),
      },
      body: JSON.stringify(requestBody),
      timeout: Math.max(1000, Number(cartesia.timeoutMs) || 10000),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const error = new Error(`Cartesia TTS request failed (${response.status})`);
      error.statusCode = response.status;
      throw error;
    }
    let pcmAudio;
    if (transport === 'sse' && typeof onAudioChunk === 'function') {
      const chunks = [];
      let carry = Buffer.alloc(0);
      for await (const pcmChunk of iterateCartesiaSseAudio(response.body)) {
        const combined = carry.length ? Buffer.concat([carry, pcmChunk]) : pcmChunk;
        const usableLength = combined.length - (combined.length % 2);
        carry = usableLength < combined.length ? combined.subarray(usableLength) : Buffer.alloc(0);
        if (usableLength) {
          const part = combined.subarray(0, usableLength);
          chunks.push(part);
          const output = ['mulaw', 'ulaw'].includes(encoding) ? pcm16ToMuLaw(part) : part;
          onAudioChunk(output.toString('base64'));
        }
      }
      if (carry.length) throw new Error('Cartesia returned incomplete PCM16 audio');
      pcmAudio = Buffer.concat(chunks);
    } else {
      pcmAudio = transport === 'sse'
        ? await collectCartesiaSseAudio(response.body)
        : Buffer.from(await response.buffer());
    }
    if (!pcmAudio.length || pcmAudio.length % 2 !== 0) {
      throw new Error('Cartesia returned incomplete PCM16 audio');
    }
    const outputAudio = ['mulaw', 'ulaw'].includes(encoding) ? pcm16ToMuLaw(pcmAudio) : pcmAudio;
    return outputAudio.toString('base64');
  }

  cancelStreaming(index = undefined) {
    const keys = index === undefined ? [...this.activeStreamControllers.keys()] : [String(index)];
    for (const key of keys) this.activeStreamControllers.get(key)?.abort();
  }

  async generate(gptReply, interactionCount, options = {}) {
    const { partialResponseIndex, partialResponse } = gptReply || {};
    const silent = !!options.silent;

    if (!partialResponse) {
      console.warn('⚠️ TTS: No partialResponse provided');
      return { ok: false, reason: 'missing_partial_response' };
    }

    const sanitized = sanitizeVoiceOutputText(partialResponse, {
      maxChars: Number(options.maxChars || this.config.openRouter?.voiceOutputMaxChars || 260),
      fallbackText: 'Let me help you with that.'
    });
    const speechText = String(sanitized.text || '').trim();
    if (!speechText) {
      console.warn('⚠️ TTS: Sanitized response is empty');
      return { ok: false, reason: 'empty_speech_text' };
    }

    try {
      const provider = String(options.provider || this.provider || 'deepgram').trim().toLowerCase();
      const streamPlayback = !silent && provider === 'cartesia' &&
        (options.streamPlayback === true || this.streamPlayback === true);
      const providerConfig = provider === 'cartesia' ? this.config.tts?.cartesia || {} : {};
      const voiceModel = options.voiceModel || this.voiceModel || (provider === 'cartesia'
        ? providerConfig.model || 'sonic-3.6'
        : this.config.deepgram.voiceModel || 'aura-2-andromeda-en');
      const audioSpec = {
        encoding: options.encoding || this.encoding,
        sampleRate: options.sampleRate || this.sampleRate,
        container: options.container || this.container,
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.voiceId || this.voiceId ? { voiceId: options.voiceId || this.voiceId } : {}),
        ...(options.language ? { language: options.language } : {}),
        ...(options.locale ? { locale: options.locale } : {}),
        ...(options.accent ? { accent: options.accent } : {}),
        ...(options.normalization ? { normalization: options.normalization } : {}),
        ...(options.pronunciationDictId ? { pronunciationDictId: options.pronunciationDictId } : {}),
        ...(options.speed !== undefined || options.volume !== undefined || options.emotion !== undefined
          ? { generationConfig: { speed: options.speed, volume: options.volume, emotion: options.emotion } }
          : {}),
      };
      const key = buildTtsCacheKey(speechText, `${voiceModel}:${audioSpec.voiceId || providerConfig.voiceId || ''}`, audioSpec, provider);
      const cached = ttsCache.get(key);
      const now = Date.now();
      if (cached && now - cached.at < TTS_CACHE_TTL_MS) {
        if (!silent) {
          this.emit('speech', partialResponseIndex, cached.audio, speechText, interactionCount);
        }
        return {
          ok: true,
          cached: true,
          voiceModel,
          text: speechText
        };
      }
      if (cached) {
        ttsCache.delete(key);
      }

      if (ttsInflight.has(key)) {
        const sharedAudio = await ttsInflight.get(key);
        if (sharedAudio && !silent) {
          this.emit('speech', partialResponseIndex, sharedAudio, speechText, interactionCount);
        }
        return {
          ok: Boolean(sharedAudio),
          shared: true,
          voiceModel,
          text: speechText
        };
      }

      let usedDeepgramFallback = false;
      let streamedChunks = 0;
      const streamController = streamPlayback ? new AbortController() : null;
      const streamKey = String(partialResponseIndex ?? 'unindexed');
      if (streamController) this.activeStreamControllers.set(streamKey, streamController);
      const requestPromise = (async () => {
        try {
          if (streamPlayback && String(audioSpec.transport || providerConfig.transport || 'sse') === 'sse') {
            return await this.fetchCartesiaSpeechAudio(speechText, voiceModel, audioSpec, (audio) => {
              streamedChunks += 1;
              this.emit('speech_chunk', partialResponseIndex, audio, speechText, interactionCount);
            }, streamController.signal);
          }
          return await this.fetchSpeechAudio(
            speechText,
            voiceModel,
            audioSpec,
            provider,
          );
        } catch (primaryError) {
          const fallbackVoice = this.config.deepgram.voiceModel || 'aura-2-andromeda-en';
          if (provider === 'cartesia' && (streamedChunks > 0 || streamController?.signal.aborted)) {
            this.emit('speech_complete', partialResponseIndex, speechText, interactionCount, { incomplete: true });
            throw primaryError;
          }
          if (provider === 'cartesia' && providerConfig.fallbackToDeepgram !== false) {
            try {
              console.warn('Cartesia TTS failed; using configured Deepgram fallback');
              const fallbackAudio = await this.fetchDeepgramSpeechAudio(speechText, fallbackVoice, audioSpec);
              ttsCache.set(buildTtsCacheKey(speechText, fallbackVoice, audioSpec, 'deepgram'), { audio: fallbackAudio, at: Date.now() });
              pruneTtsCache();
              usedDeepgramFallback = true;
              return fallbackAudio;
            } catch {
              // Preserve the Cartesia error if both providers fail.
            }
          }
          if (provider === 'deepgram' && fallbackVoice && fallbackVoice !== voiceModel) {
            try {
              const base64String = await this.fetchSpeechAudio(
                speechText,
                fallbackVoice,
                audioSpec,
              );
              const fallbackKey = buildTtsCacheKey(
                speechText,
                fallbackVoice,
                audioSpec,
                'deepgram',
              );
              ttsCache.set(fallbackKey, { audio: base64String, at: Date.now() });
              pruneTtsCache();
              return base64String;
            } catch {
              // Fallback voice failed too; rethrow primaryError below.
            }
          }
          throw primaryError;
        }
      })();

      ttsInflight.set(key, requestPromise);
      const base64String = await requestPromise.finally(() => {
        ttsInflight.delete(key);
        if (streamController && this.activeStreamControllers.get(streamKey) === streamController) {
          this.activeStreamControllers.delete(streamKey);
        }
      });
      if (!usedDeepgramFallback) {
        ttsCache.set(key, { audio: base64String, at: Date.now() });
        pruneTtsCache();
      }
      if (base64String && !silent) {
        console.log(`✅ TTS audio generated, size: ${base64String.length} chars`.green);
        if (streamPlayback && streamedChunks > 0) {
          this.emit('speech_complete', partialResponseIndex, speechText, interactionCount, { incomplete: false });
        } else {
          this.emit('speech', partialResponseIndex, base64String, speechText, interactionCount);
        }
      }
      return {
        ok: Boolean(base64String),
        voiceModel,
        text: speechText
      };
    } catch (err) {
      console.error('TTS generation failed', {
        provider: String(options.provider || this.provider || 'deepgram'),
        code: String(err?.code || 'tts_generation_failed').slice(0, 64),
        statusCode: Number.isInteger(err?.statusCode) ? err.statusCode : undefined,
      });

      // Keep runtime behavior deterministic:
      // - Throw only when caller explicitly asks for strict failure semantics.
      // - Emit error only when a listener exists to avoid unhandled EventEmitter errors.
      if (options.throwOnError === true) {
        throw err;
      }
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      return {
        ok: false,
        error: err
      };
    }
  }
}

module.exports = { TextToSpeechService, iterateCartesiaSseAudio };
