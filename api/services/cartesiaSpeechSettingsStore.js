'use strict';

const SETTING_KEY = 'cartesia_tts_speech_profile';
const BUSINESS_SETTING_KEY_PREFIX = `${SETTING_KEY}:`;
const BUSINESS_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const MODEL_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const VOICE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const LANG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const FORMATS = new Set(['wav', 'mp3']);

function isCartesiaTtsModelId(value) {
  const modelId = String(value || '');
  return ['sonic-3.6', 'sonic-3.5', 'sonic-3', 'sonic-latest'].includes(modelId) ||
    /^sonic-3\.6-\d{4}-\d{2}-\d{2}$/.test(modelId);
}

function defaultProfile(config) {
  const cartesia = config.tts?.cartesia || {};
  return {
    provider: ['cartesia', 'deepgram'].includes(String(config.tts?.provider || '').toLowerCase())
      ? String(config.tts.provider).toLowerCase()
      : 'deepgram',
    voice_id: String(cartesia.voiceId || '').trim(),
    model_id: String(cartesia.model || '').trim(),
    language: String(cartesia.language || 'en').trim(),
    speed: Number.isFinite(Number(cartesia.speed)) ? Number(cartesia.speed) : 1,
    volume: Number.isFinite(Number(cartesia.volume)) ? Number(cartesia.volume) : 1,
    output_format: FORMATS.has(String(cartesia.outputFormat || '').toLowerCase())
      ? String(cartesia.outputFormat).toLowerCase()
      : 'wav',
  };
}

function businessSettingKey(businessId) {
  const normalized = String(businessId || '').trim();
  if (!BUSINESS_ID.test(normalized)) {
    throw Object.assign(new Error('A valid business ID is required for Cartesia speech settings'), {
      code: 'cartesia_speech_settings_scope_invalid',
      status: 400,
    });
  }
  return `${BUSINESS_SETTING_KEY_PREFIX}${normalized}`;
}

function resolveCallSpeechProfile(scriptSpeechSettings, businessProfile) {
  const scriptSettings = scriptSpeechSettings && typeof scriptSpeechSettings === 'object' &&
    !Array.isArray(scriptSpeechSettings) ? scriptSpeechSettings : {};
  const businessSettings = businessProfile && businessProfile.source !== 'environment'
    ? { ...businessProfile }
    : {};
  delete businessSettings.source;
  if (!Object.keys(businessSettings).length) return null;
  return { ...businessSettings, ...scriptSettings };
}

function applyBusinessSpeechProfile(scriptPolicy, businessProfile) {
  const policy = scriptPolicy && typeof scriptPolicy === 'object' && !Array.isArray(scriptPolicy)
    ? scriptPolicy
    : {};
  const settings = resolveCallSpeechProfile(policy.agent_config?.speech_settings, businessProfile);
  if (!settings) return policy;
  return {
    ...policy,
    agent_config: {
      ...(policy.agent_config || {}),
      speech_settings: settings,
    },
  };
}

function validateProfile(input, defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Cartesia speech settings must be an object'), { code: 'cartesia_speech_settings_invalid', status: 400 });
  }
  const allowed = new Set(['provider', 'voice_id', 'model_id', 'language', 'speed', 'volume', 'output_format']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error('Cartesia speech settings contain unsupported fields'), { code: 'cartesia_speech_settings_invalid', status: 400 });
  }
  const profile = Object.fromEntries([...allowed].map((key) => [key, input[key] === undefined ? defaults[key] : input[key]]));
  profile.provider = String(profile.provider || '').trim().toLowerCase();
  profile.voice_id = String(profile.voice_id || '').trim();
  profile.model_id = String(profile.model_id || '').trim();
  profile.language = String(profile.language || '').trim();
  profile.output_format = String(profile.output_format || '').trim().toLowerCase();
  profile.speed = Number(profile.speed);
  profile.volume = Number(profile.volume);
  if (!['cartesia', 'deepgram'].includes(profile.provider) ||
      !VOICE_ID.test(profile.voice_id) || !MODEL_ID.test(profile.model_id) ||
      !LANG.test(profile.language) || !Number.isFinite(profile.speed) || profile.speed < 0.6 || profile.speed > 1.5 ||
      !Number.isFinite(profile.volume) || profile.volume < 0.5 || profile.volume > 2 ||
      !FORMATS.has(profile.output_format)) {
    throw Object.assign(new Error('Select a supported Cartesia voice, model, language, speed, volume, and output format'), { code: 'cartesia_speech_settings_invalid', status: 400 });
  }
  return profile;
}

class CartesiaSpeechSettingsStore {
  constructor(options = {}) {
    this.db = options.db;
    this.config = options.config;
    this.defaults = defaultProfile(this.config);
  }

  apply(profile) {
    this.config.tts.provider = profile.provider;
    this.config.tts.cartesia ||= {};
    Object.assign(this.config.tts.cartesia, {
      voiceId: profile.voice_id,
      model: profile.model_id,
      language: profile.language,
      speed: profile.speed,
      volume: profile.volume,
      outputFormat: profile.output_format,
    });
  }

  async getProfile() {
    const raw = await this.db?.getSetting?.(SETTING_KEY);
    if (raw === null || raw === undefined || raw === '') {
      return { ...this.defaults, source: 'environment' };
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      throw Object.assign(new Error('Saved Cartesia speech settings are invalid; reset them before saving a new profile'), { code: 'cartesia_speech_settings_corrupt', status: 503 });
    }
    const profile = validateProfile(parsed, this.defaults);
    return { ...profile, source: 'saved' };
  }

  async getBusinessProfile(businessId) {
    const key = businessSettingKey(businessId);
    const raw = await this.db?.getSetting?.(key);
    if (raw !== null && raw !== undefined && raw !== '') {
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch {
        throw Object.assign(new Error('Saved Cartesia business speech settings are invalid; reset them before saving a new profile'), {
          code: 'cartesia_speech_settings_corrupt',
          status: 503,
        });
      }
      return { ...validateProfile(parsed, this.defaults), source: 'business' };
    }
    const fallback = await this.getProfile();
    return {
      ...fallback,
      source: fallback.source === 'saved' ? 'global_fallback' : 'environment',
    };
  }

  async save(input, studio) {
    if (!this.db?.setSetting) {
      throw Object.assign(new Error('Cartesia speech settings storage is unavailable'), { code: 'cartesia_speech_settings_unavailable', status: 503 });
    }
    const current = await this.getProfile();
    const profile = validateProfile(input, current);
    const models = await studio.listModels({ capability: 'tts' });
    if (!models.models.some((model) => model.id === profile.model_id && model.capability === 'tts' && isCartesiaTtsModelId(model.id))) {
      throw Object.assign(new Error('That Cartesia model is unavailable for text-to-speech. Your saved settings were not changed.'), { code: 'cartesia_model_unavailable', status: 409 });
    }
    const model = models.models.find((entry) => entry.id === profile.model_id);
    if (!Array.isArray(model?.supportedLanguages) || !model.supportedLanguages.includes(profile.language)) {
      throw Object.assign(new Error('That language is not listed as supported by the selected Cartesia model. Your saved settings were not changed.'), { code: 'cartesia_language_unsupported', status: 400 });
    }
    await studio.getVoice(profile.voice_id);
    await this.db.setSetting(SETTING_KEY, JSON.stringify(profile));
    this.apply(profile);
    return { profile: { ...profile, source: 'saved' } };
  }

  async saveBusinessProfile(businessId, input, studio) {
    const key = businessSettingKey(businessId);
    if (!this.db?.setSetting) {
      throw Object.assign(new Error('Cartesia speech settings storage is unavailable'), {
        code: 'cartesia_speech_settings_unavailable',
        status: 503,
      });
    }
    const current = await this.getBusinessProfile(businessId);
    const profile = validateProfile(input, current);
    const models = await studio.listModels({ capability: 'tts' });
    if (!models.models.some((model) => model.id === profile.model_id && model.capability === 'tts' && isCartesiaTtsModelId(model.id))) {
      throw Object.assign(new Error('That Cartesia model is unavailable for text-to-speech. Your saved settings were not changed.'), {
        code: 'cartesia_model_unavailable',
        status: 409,
      });
    }
    const model = models.models.find((entry) => entry.id === profile.model_id);
    if (!Array.isArray(model?.supportedLanguages) || !model.supportedLanguages.includes(profile.language)) {
      throw Object.assign(new Error('That language is not listed as supported by the selected Cartesia model. Your saved settings were not changed.'), {
        code: 'cartesia_language_unsupported',
        status: 400,
      });
    }
    await studio.getVoice(profile.voice_id);
    await this.db.setSetting(key, JSON.stringify(profile));
    return { profile: { ...profile, source: 'business' } };
  }

  async reset() {
    if (!this.db?.setSetting) {
      throw Object.assign(new Error('Cartesia speech settings storage is unavailable'), { code: 'cartesia_speech_settings_unavailable', status: 503 });
    }
    await this.db.setSetting(SETTING_KEY, null);
    this.apply(this.defaults);
    return { profile: { ...this.defaults, source: 'environment' } };
  }

  async resetBusinessProfile(businessId) {
    const key = businessSettingKey(businessId);
    if (!this.db?.setSetting) {
      throw Object.assign(new Error('Cartesia speech settings storage is unavailable'), {
        code: 'cartesia_speech_settings_unavailable',
        status: 503,
      });
    }
    await this.db.setSetting(key, null);
    return { profile: await this.getBusinessProfile(businessId) };
  }

  async load() {
    const profile = await this.getProfile();
    this.apply(profile);
    return profile;
  }
}

module.exports = {
  CartesiaSpeechSettingsStore,
  SETTING_KEY,
  BUSINESS_SETTING_KEY_PREFIX,
  businessSettingKey,
  resolveCallSpeechProfile,
  applyBusinessSpeechProfile,
  defaultProfile,
  validateProfile,
  isCartesiaTtsModelId,
};
