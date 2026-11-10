const fetch = require('node-fetch');
const config = require('../config');

const API_VERSION = '2026-08-14';
const CARTESIA_BASE_URL = 'https://api.cartesia.ai';
const SUPPORTED_LANGUAGES = new Set([
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar',
  'sv', 'it', 'id', 'hi', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu',
  'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk', 'te', 'fa',
  'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn',
  'bs', 'kk', 'sq', 'sw', 'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc',
  'ka', 'be', 'tg', 'gu', 'am', 'yi', 'lo', 'uz', 'fo', 'ht', 'ps', 'tk', 'nn', 'mt',
  'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'yue',
]);
const VOICE_GENDERS = new Set(['masculine', 'feminine', 'gender_neutral']);
const AUDIO_MIME_TYPES = Object.freeze({
  'audio/flac': { extension: 'flac', mime: 'audio/flac' },
  'audio/mp4': { extension: 'mp4', mime: 'audio/mp4' },
  'audio/mpeg': { extension: 'mp3', mime: 'audio/mpeg' },
  'audio/ogg': { extension: 'ogg', mime: 'audio/ogg' },
  'audio/wav': { extension: 'wav', mime: 'audio/wav' },
  'audio/webm': { extension: 'webm', mime: 'audio/webm' },
  'video/mp4': { extension: 'mp4', mime: 'video/mp4' },
});
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

function validateVoiceQuery(query = {}) {
  const result = {};
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw Object.assign(new Error('Voice page limit must be between 1 and 100'), { statusCode: 400 });
  }
  result.limit = limit;
  for (const field of ['q', 'starting_after', 'ending_before', 'language']) {
    if (query[field] === undefined || query[field] === '') continue;
    const value = String(query[field]).trim();
    const max = field === 'q' ? 100 : 256;
    if (!value || value.length > max) {
      throw Object.assign(new Error(`Invalid voice query ${field}`), { statusCode: 400 });
    }
    result[field] = value;
  }
  if (result.starting_after && result.ending_before) {
    throw Object.assign(new Error('Use only one voice pagination cursor'), { statusCode: 400 });
  }
  if (query.is_owner !== undefined) {
    if (!['true', 'false'].includes(String(query.is_owner))) {
      throw Object.assign(new Error('is_owner must be true or false'), { statusCode: 400 });
    }
    result.is_owner = String(query.is_owner);
  }
  if (query.gender !== undefined) {
    if (!VOICE_GENDERS.has(String(query.gender))) {
      throw Object.assign(new Error('Unsupported voice gender filter'), { statusCode: 400 });
    }
    result.gender = String(query.gender);
  }
  if (query.include_archived !== undefined) {
    if (!['true', 'false'].includes(String(query.include_archived))) {
      throw Object.assign(new Error('include_archived must be true or false'), { statusCode: 400 });
    }
    result.include_archived = String(query.include_archived);
  }
  return result;
}

function safeVoice(voice) {
  if (!voice || typeof voice !== 'object') return null;
  return {
    id: typeof voice.id === 'string' ? voice.id : null,
    name: typeof voice.name === 'string' ? voice.name : null,
    description: typeof voice.description === 'string' ? voice.description : null,
    language: typeof voice.language === 'string' ? voice.language : null,
    gender: typeof voice.gender === 'string' ? voice.gender : null,
    ...(typeof voice.is_owner === 'boolean' ? { is_owner: voice.is_owner } : {}),
    ...(Array.isArray(voice.accents)
      ? { accents: voice.accents.filter((accent) => typeof accent === 'string').slice(0, 50) }
      : {}),
  };
}

function createMultipartAudioBody({ audio, mimeType, language, wordTimestamps }) {
  const boundary = `----voicednut-${require('node:crypto').randomBytes(18).toString('hex')}`;
  const fields = [
    ['model', 'ink-whisper'],
    ['language', language],
    ...(wordTimestamps ? [['timestamp_granularities[]', 'word']] : []),
  ];
  const parts = [];
  for (const [name, value] of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  const safeFilename = `audio.${AUDIO_MIME_TYPES[mimeType].extension}`;
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
  parts.push(audio);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function normalizeTranscription(payload) {
  if (!payload || payload.type !== 'transcript' || typeof payload.text !== 'string') {
    throw Object.assign(new Error('Cartesia returned an invalid transcription response'), { statusCode: 502 });
  }
  const words = Array.isArray(payload.words) ? payload.words.slice(0, 20000).map((word) => ({
    word: typeof word?.word === 'string' ? word.word : '',
    start: Number.isFinite(Number(word?.start)) ? Number(word.start) : null,
    end: Number.isFinite(Number(word?.end)) ? Number(word.end) : null,
  })) : undefined;
  return {
    text: payload.text,
    requestId: typeof payload.request_id === 'string' ? payload.request_id : null,
    language: typeof payload.language === 'string' ? payload.language : null,
    duration: Number.isFinite(Number(payload.duration)) ? Number(payload.duration) : null,
    ...(words ? { words } : {}),
  };
}

class CartesiaSpeechService {
  constructor(options = {}) {
    this.config = options.config || config;
    this.fetch = options.fetchFn || fetch;
  }

  getConfig() {
    const speech = this.config.tts?.cartesia || {};
    const apiKey = String(speech.apiKey || '').trim();
    if (!apiKey) throw Object.assign(new Error('Cartesia speech is not configured'), { statusCode: 503 });
    const apiVersion = String(speech.apiVersion || API_VERSION);
    if (apiVersion !== API_VERSION) {
      throw Object.assign(new Error('Cartesia API version is unsupported by this speech adapter'), { statusCode: 503 });
    }
    return {
      apiKey,
      apiVersion,
      timeoutMs: Math.max(1000, Math.min(30000, Number(speech.timeoutMs) || 10000)),
    };
  }

  async listVoices(rawQuery = {}) {
    const query = validateVoiceQuery(rawQuery);
    const provider = this.getConfig();
    const params = new URLSearchParams(query);
    const response = await this.fetch(`${CARTESIA_BASE_URL}/voices?${params}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Cartesia-Version': provider.apiVersion,
      },
      timeout: provider.timeoutMs,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Cartesia voice list failed (${response.status})`), { statusCode: 502 });
    }
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.data) || typeof payload.has_more !== 'boolean') {
      throw Object.assign(new Error('Cartesia returned an invalid voice list'), { statusCode: 502 });
    }
    return {
      data: payload.data.map(safeVoice).filter((voice) => voice && voice.id),
      hasMore: payload.has_more,
      nextPage: typeof payload.next_page === 'string' ? payload.next_page : null,
    };
  }

  async transcribeAudio({ audio, mimeType, language = 'en', wordTimestamps = false } = {}) {
    const buffer = Buffer.isBuffer(audio) ? audio : null;
    const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (!buffer?.length || buffer.length > MAX_AUDIO_BYTES) {
      throw Object.assign(new Error('Audio must be a non-empty file of at most 15 MB'), { statusCode: 400 });
    }
    if (!AUDIO_MIME_TYPES[normalizedMime]) {
      throw Object.assign(new Error('Unsupported Cartesia Ink audio media type'), { statusCode: 415 });
    }
    const normalizedLanguage = String(language || 'en').trim().toLowerCase();
    if (!SUPPORTED_LANGUAGES.has(normalizedLanguage)) {
      throw Object.assign(new Error('Unsupported Cartesia Ink language'), { statusCode: 400 });
    }
    if (typeof wordTimestamps !== 'boolean') {
      throw Object.assign(new Error('wordTimestamps must be a boolean'), { statusCode: 400 });
    }
    const provider = this.getConfig();
    const multipart = createMultipartAudioBody({
      audio: buffer,
      mimeType: AUDIO_MIME_TYPES[normalizedMime].mime,
      language: normalizedLanguage,
      wordTimestamps,
    });
    const response = await this.fetch(`${CARTESIA_BASE_URL}/stt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Cartesia-Version': provider.apiVersion,
        'Content-Type': multipart.contentType,
        'Content-Length': String(multipart.body.length),
      },
      body: multipart.body,
      timeout: provider.timeoutMs,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Cartesia transcription failed (${response.status})`), { statusCode: 502 });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw Object.assign(new Error('Cartesia returned an invalid transcription response'), { statusCode: 502 });
    }
    return normalizeTranscription(payload);
  }
}

module.exports = {
  API_VERSION,
  AUDIO_MIME_TYPES,
  MAX_AUDIO_BYTES,
  CartesiaSpeechService,
  createMultipartAudioBody,
  normalizeTranscription,
  validateVoiceQuery,
};
