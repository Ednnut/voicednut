"use strict";

const crypto = require("node:crypto");
const { isIP } = require("node:net");
const { MAX_REALTIME_STT_AUDIO_BYTES } = require("./cartesiaStudioClient");

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;
const WARN_OR_ERROR_PATTERN = /\b(warn(?:ing)?|error|failed|failure|exception|timeout|timed out|denied|rejected)\b/i;
const ERROR_PATTERN = /\b(error|failed|failure|exception|timeout|timed out|denied|rejected)\b/i;
const PRIVATE_HOST_PATTERN = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.test|.*\.invalid|.*\.example)$/i;
const CARTESIA_BUILTIN_METRICS = [
  { id: "system_call_success", name: "System call success", description: "Whether the call ended without an agent failure", type: "boolean" },
  { id: "system_text_to_speech_ttfb", name: "System TTS first-byte latency", description: "Time to the first byte of generated audio on the first assistant turn (milliseconds)", type: "number" },
];

function serviceError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function safeId(value, kind) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) throw serviceError(`cartesia_${kind}_id_invalid`, `A valid Cartesia ${kind} ID is required`, 400);
  return id;
}

function safeConsentId(value) {
  const id = String(value || "").trim();
  if (!/^[a-f0-9]{32}$/.test(id)) throw serviceError("cartesia_voice_consent_id_invalid", "A valid clone-consent ID is required", 400);
  return id;
}

function listFrom(value, ...keys) {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
}

function safeText(value, maxLength, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
}

function safeSttTranscript(value) {
  return String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, 50000);
}

function normalizeManagedWebhook(value = {}) {
  const row = value?.webhook && typeof value.webhook === "object" ? value.webhook : value;
  return {
    id: safeId(row?.id, "webhook"),
    displayName: safeText(row?.display_name || row?.name, 100) || null,
    url: safeText(row?.url, 500) || null,
    createdAt: safeText(row?.created_at, 40) || null,
    updatedAt: safeText(row?.updated_at, 40) || null,
  };
}

function isPublicWebhookHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || PRIVATE_HOST_PATTERN.test(host)) return false;
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0));
  }
  if (version === 6) {
    const firstHextet = Number.parseInt(host.split(":")[0] || "0", 16);
    return firstHextet >= 0x2000 && firstHextet <= 0x3fff && !host.startsWith("2001:db8:");
  }
  return host.includes(".") && !host.endsWith(".");
}

function validateManagedWebhookUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); }
  catch { throw serviceError("cartesia_webhook_url_invalid", "Configure a public HTTPS Cartesia webhook callback URL", 400); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !isPublicWebhookHost(parsed.hostname) ||
      parsed.pathname.replace(/\/+$/, "") !== "/webhook/cartesia") {
    throw serviceError("cartesia_webhook_url_invalid", "Cartesia webhooks must use an HTTPS /webhook/cartesia callback on a public hostname", 400);
  }
  return parsed.toString();
}

function validateManagedAgentConfigPatch(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("cartesia_agent_update_invalid", "Agent config must be an object", 400);
  }
  const allowed = new Set(["audio", "language", "system_tools", "speculative_generation"]);
  if (!Object.keys(value).length || Object.keys(value).some((key) => !allowed.has(key))) {
    throw serviceError("cartesia_agent_update_invalid", "Agent config contains unsupported settings", 400);
  }
  const config = {};
  if (value.speculative_generation !== undefined) {
    if (typeof value.speculative_generation !== "boolean") throw serviceError("cartesia_agent_update_invalid", "speculative_generation must be a boolean", 400);
    config.speculative_generation = value.speculative_generation;
  }
  if (value.audio !== undefined) {
    const audio = value.audio;
    if (!audio || typeof audio !== "object" || Array.isArray(audio) || Object.keys(audio).some((key) => !["input", "output"].includes(key))) {
      throw serviceError("cartesia_agent_update_invalid", "Agent audio config contains unsupported settings", 400);
    }
    config.audio = {};
    if (audio.input !== undefined) {
      const input = audio.input;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["keyterms", "noise_suppression"].includes(key))) {
        throw serviceError("cartesia_agent_update_invalid", "Agent audio input contains unsupported settings", 400);
      }
      config.audio.input = {};
      if (input.keyterms !== undefined) config.audio.input.keyterms = validateSttKeyterms(input.keyterms);
      if (input.noise_suppression !== undefined) {
        if (!["auto", "max", "off"].includes(input.noise_suppression)) throw serviceError("cartesia_agent_update_invalid", "noise_suppression must be auto, max, or off", 400);
        config.audio.input.noise_suppression = input.noise_suppression;
      }
      if (!Object.keys(config.audio.input).length) throw serviceError("cartesia_agent_update_invalid", "Provide at least one agent audio input setting", 400);
    }
    if (audio.output !== undefined) {
      const output = audio.output;
      const fields = ["voice_id", "speed", "volume", "emotion", "pronunciation_dictionary_id", "background_sound"];
      if (!output || typeof output !== "object" || Array.isArray(output) || Object.keys(output).some((key) => !fields.includes(key))) {
        throw serviceError("cartesia_agent_update_invalid", "Agent audio output contains unsupported settings", 400);
      }
      config.audio.output = {};
      if (output.voice_id !== undefined) config.audio.output.voice_id = safeId(output.voice_id, "voice");
      for (const [key, minimum, maximum] of [["speed", 0.6, 1.5], ["volume", 0.5, 2]]) {
        if (output[key] === undefined) continue;
        if (output[key] === null) config.audio.output[key] = null;
        else {
          const number = Number(output[key]);
          if (!Number.isFinite(number) || number < minimum || number > maximum) throw serviceError("cartesia_agent_update_invalid", `Agent audio ${key} must be between ${minimum} and ${maximum}`, 400);
          config.audio.output[key] = number;
        }
      }
      if (output.emotion !== undefined) {
        if (output.emotion !== null && (typeof output.emotion !== "string" || !/^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(output.emotion.trim()))) {
          throw serviceError("cartesia_agent_update_invalid", "Agent audio emotion is invalid", 400);
        }
        config.audio.output.emotion = output.emotion === null ? null : output.emotion.trim();
      }
      if (output.pronunciation_dictionary_id !== undefined) config.audio.output.pronunciation_dictionary_id = output.pronunciation_dictionary_id === null ? null : safeId(output.pronunciation_dictionary_id, "pronunciation_dictionary");
      if (output.background_sound !== undefined) {
        if (output.background_sound === null) config.audio.output.background_sound = null;
        else {
          const sound = output.background_sound;
          if (!sound || typeof sound !== "object" || Array.isArray(sound) || Object.keys(sound).some((key) => !["file_id", "volume"].includes(key))) {
            throw serviceError("cartesia_agent_update_invalid", "background_sound must contain a Cartesia file_id and optional volume", 400);
          }
          const fileId = safeId(sound.file_id, "file");
          const volume = sound.volume === undefined ? 1 : Number(sound.volume);
          if (!Number.isFinite(volume) || volume < 0 || volume > 2) throw serviceError("cartesia_agent_update_invalid", "background_sound volume must be between 0 and 2", 400);
          config.audio.output.background_sound = { file_id: fileId, volume };
        }
      }
      if (!Object.keys(config.audio.output).length) throw serviceError("cartesia_agent_update_invalid", "Provide at least one agent audio output setting", 400);
    }
    if (!Object.keys(config.audio).length) throw serviceError("cartesia_agent_update_invalid", "Provide at least one agent audio setting", 400);
  }
  if (value.language !== undefined) {
    const language = value.language;
    if (!language || typeof language !== "object" || Array.isArray(language) || Object.keys(language).some((key) => key !== "additional")) {
      throw serviceError("cartesia_agent_update_invalid", "Only additional agent language settings can be updated here", 400);
    }
    if (!Array.isArray(language.additional) || language.additional.length > 20) throw serviceError("cartesia_agent_update_invalid", "Provide no more than 20 additional languages", 400);
    const seen = new Set();
    config.language = { additional: language.additional.map((item) => {
      const code = safeText(typeof item === "string" ? item : item?.code, 24);
      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(code) || seen.has(code.toLowerCase())) {
        throw serviceError("cartesia_agent_update_invalid", "Additional language codes must be valid and unique", 400);
      }
      seen.add(code.toLowerCase());
      if (typeof item === "string") return { code };
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["code", "presets"].includes(key))) {
        throw serviceError("cartesia_agent_update_invalid", "Additional language settings contain unsupported fields", 400);
      }
      if (item.presets === undefined) return { code };
      const presets = item.presets;
      if (!presets || typeof presets !== "object" || Array.isArray(presets) || Object.keys(presets).some((key) => key !== "voice_id")) {
        throw serviceError("cartesia_agent_update_invalid", "Additional language presets only support voice_id", 400);
      }
      return { code, presets: { voice_id: safeId(presets.voice_id, "voice") } };
    }) };
  }
  if (value.system_tools !== undefined) {
    const tools = value.system_tools;
    const names = ["end_call", "send_dtmf", "transfer_to_number", "skip_turn", "voicemail_detection"];
    if (!tools || typeof tools !== "object" || Array.isArray(tools) || !Object.keys(tools).length || Object.keys(tools).some((key) => !names.includes(key))) {
      throw serviceError("cartesia_agent_update_invalid", "system_tools contains unsupported actions", 400);
    }
    config.system_tools = {};
    for (const [name, raw] of Object.entries(tools)) {
      if (raw === null) { config.system_tools[name] = null; continue; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw serviceError("cartesia_agent_update_invalid", `system_tools.${name} must be an object or null`, 400);
      const common = ["description", "pre_tool_speech"];
      const fields = name === "transfer_to_number" ? [...common, "transfers"] : name === "skip_turn" ? [...common, "wait_timeout_secs"] : name === "voicemail_detection" ? [...common, "message"] : common;
      if (Object.keys(raw).some((key) => !fields.includes(key))) throw serviceError("cartesia_agent_update_invalid", `system_tools.${name} contains unsupported settings`, 400);
      const tool = {};
      if (raw.description !== undefined) tool.description = raw.description === null ? null : safeText(raw.description, 300);
      if (raw.pre_tool_speech !== undefined) {
        if (!["auto", "force", "off"].includes(raw.pre_tool_speech)) throw serviceError("cartesia_agent_update_invalid", `system_tools.${name}.pre_tool_speech must be auto, force, or off`, 400);
        tool.pre_tool_speech = raw.pre_tool_speech;
      }
      if (name === "skip_turn" && raw.wait_timeout_secs !== undefined) {
        const seconds = Number(raw.wait_timeout_secs);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw serviceError("cartesia_agent_update_invalid", "skip_turn.wait_timeout_secs must be from 1 to 300", 400);
        tool.wait_timeout_secs = seconds;
      }
      if (name === "voicemail_detection" && raw.message !== undefined) {
        if (typeof raw.message !== "string" || raw.message.length > 500) throw serviceError("cartesia_agent_update_invalid", "voicemail_detection.message must be at most 500 characters", 400);
        tool.message = raw.message;
      }
      if (name === "transfer_to_number") {
        if (!Array.isArray(raw.transfers) || raw.transfers.length < 1 || raw.transfers.length > 10) throw serviceError("cartesia_agent_update_invalid", "transfer_to_number needs 1–10 destinations", 400);
        tool.transfers = raw.transfers.map((transfer) => {
          const condition = safeText(transfer?.condition, 300);
          const destination = transfer?.destination;
          if (!condition || !destination || typeof destination !== "object" || Array.isArray(destination)) throw serviceError("cartesia_agent_update_invalid", "Every transfer needs a condition and destination", 400);
          if (destination.type === "phone" && Object.keys(destination).every((key) => ["type", "phone_number"].includes(key)) && (/^\+[1-9]\d{7,14}$/.test(String(destination.phone_number || "")) || /^\{\{[A-Za-z_][A-Za-z0-9_]{0,63}\}\}$/.test(String(destination.phone_number || "")))) {
            return { condition, destination: { type: "phone", phone_number: destination.phone_number } };
          }
          if (destination.type === "sip_uri" && Object.keys(destination).every((key) => ["type", "sip_uri"].includes(key)) && (/^sips?:[^@\s]+@[^@\s]+$/i.test(String(destination.sip_uri || "")) || /^\{\{[A-Za-z_][A-Za-z0-9_]{0,63}\}\}$/.test(String(destination.sip_uri || "")))) {
            return { condition, destination: { type: "sip_uri", sip_uri: destination.sip_uri } };
          }
          throw serviceError("cartesia_agent_update_invalid", "Transfer destinations must be E.164 phone numbers, SIP URIs, or a single Cartesia dynamic variable", 400);
        });
      }
      config.system_tools[name] = tool;
    }
  }
  return config;
}

function summarizeManagedAgentConfig(config = {}) {
  const model = config.model && typeof config.model === "object" ? config.model : {};
  const language = config.language && typeof config.language === "object" ? config.language : {};
  const audio = config.audio && typeof config.audio === "object" ? config.audio : {};
  const audioInput = audio.input && typeof audio.input === "object" ? audio.input : {};
  const audioOutput = audio.output && typeof audio.output === "object" ? audio.output : {};
  const turn = config.turn && typeof config.turn === "object" ? config.turn : {};
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const systemTools = config.system_tools && typeof config.system_tools === "object" && !Array.isArray(config.system_tools) ? config.system_tools : {};
  const safeScalar = (value, maxLength = 80) => typeof value === "string" ? safeText(value, maxLength) || null : typeof value === "number" && Number.isFinite(value) ? value : typeof value === "boolean" ? value : null;
  return {
    model: safeScalar(model.id || model.model || config.model_id || (typeof config.model === "string" ? config.model : null)),
    language: safeScalar(language.primary || config.primary_language, 24),
    additionalLanguages: (Array.isArray(language.additional) ? language.additional : []).slice(0, 20).map((item) => safeScalar(typeof item === "string" ? item : item?.code, 24)).filter(Boolean),
    voiceId: safeScalar(audioOutput.voice_id || config.voice_id, 120),
    voiceSpeed: safeScalar(audioOutput.speed),
    voiceVolume: safeScalar(audioOutput.volume),
    voiceEmotion: safeScalar(audioOutput.emotion, 40),
    pronunciationDictionaryId: safeScalar(audioOutput.pronunciation_dictionary_id, 120),
    backgroundSoundConfigured: Boolean(audioOutput.background_sound?.file_id),
    noiseSuppression: safeScalar(audioInput.noise_suppression, 40),
    keytermCount: Array.isArray(audioInput.keyterms) ? Math.min(audioInput.keyterms.length, 100) : 0,
    timezone: safeScalar(config.timezone, 64),
    inactivityEndCallSecs: safeScalar(turn.inactivity_end_call_secs),
    inactivityCheckInSecs: safeScalar(turn.inactivity_check_in_secs),
    toolIds: tools.slice(0, 100).map((tool) => safeText(tool?.id, 120)).filter((id) => ID_PATTERN.test(id)),
    systemTools: Object.keys(systemTools).filter((name) => /^[a-z][a-z0-9_]{0,63}$/i.test(name)).slice(0, 30).sort(),
    speculativeGeneration: safeScalar(config.speculative_generation),
    promptOptimization: safeScalar(config.prompt_optimization),
    hasInstructions: Boolean(config.instructions),
    hasFirstMessage: Boolean(config.initial_message),
  };
}

function normalizeVoice(voice = {}) {
  const id = String(voice.id || "").trim();
  if (!ID_PATTERN.test(id)) return null;
  return {
    id,
    name: safeText(voice.name, 120, "Unnamed Cartesia voice"),
    language: safeText(voice.language, 20) || null,
    access: ["private", "public"].includes(String(voice.access || "").toLowerCase()) ? String(voice.access).toLowerCase() : null,
    isOwner: voice.is_owner === true || voice.isOwner === true,
    isPro: voice.is_pro === true || voice.isPro === true,
    createdAt: safeText(voice.created_at, 40) || null,
    accents: (Array.isArray(voice.accents) ? voice.accents : []).slice(0, 30).map((accent) => ({
      locale: safeText(accent?.locale, 20) || null,
      accent: safeText(accent?.accent, 60) || null,
      isNative: accent?.is_native === true,
    })).filter((accent) => accent.locale || accent.accent),
  };
}

function validatePronunciationItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) {
    throw serviceError("cartesia_pronunciation_items_invalid", "Provide between 1 and 200 pronunciation entries", 400);
  }
  const seen = new Set();
  return items.map((item) => {
    const text = safeText(item?.text, 120);
    const pronunciation = safeText(item?.pronunciation, 300);
    const caseSensitive = item?.case_sensitive === true || item?.caseSensitive === true;
    if (!text || !pronunciation) throw serviceError("cartesia_pronunciation_items_invalid", "Every entry needs text and pronunciation", 400);
    const key = `${caseSensitive ? "s:" : "i:"}${caseSensitive ? text : text.toLowerCase()}`;
    if (seen.has(key)) throw serviceError("cartesia_pronunciation_items_duplicate", "Pronunciation entries must not duplicate the same term", 400);
    seen.add(key);
    return { text, pronunciation, case_sensitive: caseSensitive };
  });
}

function validateSttKeyterms(keyterms) {
  if (!Array.isArray(keyterms) || keyterms.length > 100) throw serviceError("cartesia_stt_keyterms_invalid", "Provide no more than 100 STT keyterms", 400);
  const normalized = keyterms.map((term) => safeText(term, 120)).filter(Boolean);
  if (normalized.some((term) => /[\r\n]/.test(term)) || normalized.reduce((n, term) => n + term.length, 0) > 1200) {
    throw serviceError("cartesia_stt_keyterms_invalid", "STT keyterms may contain at most 1200 characters total", 400);
  }
  if (new Set(normalized.map((term) => term.toLowerCase())).size !== normalized.length) {
    throw serviceError("cartesia_stt_keyterms_duplicate", "STT keyterms must be unique", 400);
  }
  return normalized;
}

function validateCartesiaSpeechMarkup(transcript) {
  const text = String(transcript || "");
  let cursor = 0;
  const tokenPattern = /<spell>([^<>]{1,120})<\/spell>|<break time="([0-9]+(?:\.[0-9]{1,2})?)(s|ms)"\/>|<<([^<>]{1,120})>>/gy;
  while (cursor < text.length) {
    tokenPattern.lastIndex = cursor;
    const match = tokenPattern.exec(text);
    if (!match) {
      const remainder = text.slice(cursor);
      const nextTag = remainder.search(/[<>]/);
      if (nextTag === -1) break;
      if (remainder[nextTag] === ">") throw serviceError("cartesia_tts_preview_markup_invalid", "Speech preview markup contains an unmatched closing bracket", 400);
      cursor += nextTag;
      tokenPattern.lastIndex = cursor;
      const validTag = tokenPattern.exec(text);
      if (!validTag) throw serviceError("cartesia_tts_preview_markup_invalid", "Speech preview markup contains an unsupported or unbalanced tag", 400);
      tokenPattern.lastIndex = cursor;
      continue;
    }
    if (match.index > cursor && /[<>]/.test(text.slice(cursor, match.index))) {
      throw serviceError("cartesia_tts_preview_markup_invalid", "Speech preview markup contains an unsupported tag", 400);
    }
    if (match[1] !== undefined && (!match[1].trim() || /[\u0000-\u001F]/.test(match[1]))) {
      throw serviceError("cartesia_tts_preview_markup_invalid", "Spell tags must contain plain text", 400);
    }
    if (match[2] !== undefined) {
      const amount = Number(match[2]);
      const milliseconds = match[3] === "ms" ? amount : amount * 1000;
      if (!Number.isFinite(milliseconds) || milliseconds < 50 || milliseconds > 5000) {
        throw serviceError("cartesia_tts_preview_markup_invalid", "Break tags must be between 50 ms and 5 seconds", 400);
      }
    }
    if (match[4] !== undefined && (!match[4].includes("|") || /[\u0000-\u001F]/.test(match[4]))) {
      throw serviceError("cartesia_tts_preview_markup_invalid", "IPA markup must contain pipe-separated phonemes", 400);
    }
    cursor = tokenPattern.lastIndex;
  }
  return text;
}

function normalizeSttTurnSettings(input = {}) {
  const ranges = {
    start_threshold: [0.5, 0.9, 0.8],
    eager_end_threshold: [0.3, 0.8, 0.6],
    end_threshold: [0.05, 0.5, 0.3],
    end_timeout_ms: [640, 11200, 5600],
  };
  const result = {};
  for (const [name, [min, max, fallback]] of Object.entries(ranges)) {
    const source = input[name] ?? input[name.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    const value = source === undefined ? fallback : Number(source);
    if (!Number.isFinite(value) || value < min || value > max) throw serviceError("cartesia_stt_turn_settings_invalid", `Invalid ${name} value`, 400);
    result[name] = value;
  }
  if (result.end_threshold >= result.eager_end_threshold || result.eager_end_threshold >= result.start_threshold) {
    throw serviceError("cartesia_stt_turn_settings_invalid", "Turn thresholds must satisfy end < eager end < start", 400);
  }
  return result;
}

function validateTtsPreview(input = {}) {
  const transcript = safeText(input.transcript, 600);
  const voiceId = String(input.voiceId || input.voice_id || "").trim();
  const modelId = safeText(input.modelId || input.model_id, 80, "sonic-3.6");
  if (!transcript || !ID_PATTERN.test(voiceId) || !/^[A-Za-z0-9._:-]{1,80}$/.test(modelId)) {
    throw serviceError("cartesia_tts_preview_input_invalid", "A valid voice, model, and transcript of 600 characters or less are required", 400);
  }
  validateCartesiaSpeechMarkup(transcript);
  const speed = input.speed === undefined ? 1 : Number(input.speed);
  const volume = input.volume === undefined ? 1 : Number(input.volume);
  if (!Number.isFinite(speed) || speed < 0.6 || speed > 1.5 || !Number.isFinite(volume) || volume < 0.5 || volume > 2) {
    throw serviceError("cartesia_tts_preview_config_invalid", "Speed must be 0.6–1.5 and volume must be 0.5–2", 400);
  }
  const outputFormat = input.outputFormat || { container: "wav", encoding: "pcm_s16le", sample_rate: 24000 };
  const allowedContainers = new Set(["wav", "mp3", "raw"]);
  const allowedEncodings = new Set(["pcm_s16le", "pcm_f32le", "pcm_mulaw", "pcm_alaw"]);
  const allowedRates = new Set([8000, 16000, 22050, 24000, 44100, 48000]);
  if (!allowedContainers.has(outputFormat.container) || !allowedEncodings.has(outputFormat.encoding) || !allowedRates.has(Number(outputFormat.sample_rate))) {
    throw serviceError("cartesia_tts_preview_format_invalid", "Unsupported Cartesia audio output format", 400);
  }
  const body = {
    model_id: modelId,
    transcript,
    voice: voiceId,
    output_format: { container: outputFormat.container, encoding: outputFormat.encoding, sample_rate: Number(outputFormat.sample_rate) },
    generation_config: { speed, volume },
  };
  const emotion = safeText(input.emotion || input.generationConfig?.emotion || input.generation_config?.emotion, 32).toLowerCase();
  const allowedEmotions = new Set([
    "neutral", "happy", "excited", "enthusiastic", "elated", "euphoric", "triumphant", "amazed", "surprised",
    "flirtatious", "curious", "content", "peaceful", "serene", "calm", "grateful", "affectionate", "trust",
    "sympathetic", "anticipation", "mysterious", "angry", "mad", "outraged", "frustrated", "agitated", "threatened",
    "disgusted", "contempt", "envious", "sarcastic", "ironic", "sad", "dejected", "melancholic", "disappointed",
    "hurt", "guilty", "bored", "tired", "rejected", "nostalgic", "wistful", "apologetic", "hesitant", "insecure",
    "confused", "resigned", "anxious", "panicked", "alarmed", "scared", "proud", "confident", "distant", "skeptical",
    "contemplative", "determined",
  ]);
  if (emotion && !allowedEmotions.has(emotion)) throw serviceError("cartesia_tts_preview_emotion_invalid", "Choose a documented Cartesia emotion value", 400);
  if (emotion) body.generation_config.emotion = emotion;
  const language = safeText(input.language, 20);
  const locale = safeText(input.locale, 20);
  if (language && locale) throw serviceError("cartesia_tts_preview_language_invalid", "Choose either language or locale, not both", 400);
  if (emotion && (locale ? !locale.toLowerCase().startsWith("en-") : language ? !language.toLowerCase().startsWith("en") : false)) {
    throw serviceError("cartesia_tts_preview_emotion_language_invalid", "Cartesia emotion guidance is currently supported only for English", 400);
  }
  if (language) body.language = language;
  if (locale) body.locale = locale;
  if (input.pronunciationDictId || input.pronunciation_dict_id) body.pronunciation_dict_id = safeId(input.pronunciationDictId || input.pronunciation_dict_id, "pronunciation_dictionary");
  return body;
}

function sanitizeLogSummary(response = {}) {
  const lines = listFrom(response, "logs").filter((line) => typeof line === "string").slice(0, 1000);
  const warnings = lines.filter((line) => WARN_OR_ERROR_PATTERN.test(line));
  const errors = lines.filter((line) => ERROR_PATTERN.test(line));
  return {
    callId: safeText(response.call_id, 200) || null,
    updatedAt: safeText(response.updated_at, 40) || null,
    lineCount: lines.length,
    warningCount: warnings.length,
    errorCount: errors.length,
    hasWarnings: warnings.length > 0,
    hasErrors: errors.length > 0,
  };
}

function safeWebhookUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || "")); }
  catch { throw serviceError("cartesia_tool_url_invalid", "Webhook tools require a valid HTTPS URL", 400); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || isIP(host) !== 0 || PRIVATE_HOST_PATTERN.test(host) ||
      host === "0.0.0.0" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw serviceError("cartesia_tool_url_invalid", "Webhook tool URL must use HTTPS and a public host", 400);
  }
  return url.toString();
}

function validateWebhookTool(input = {}) {
  const name = safeText(input.name, 64);
  const description = safeText(input.description, 500);
  const schema = input.api_schema || input.apiSchema || {};
  const method = String(schema.method || "GET").toUpperCase();
  if (!NAME_PATTERN.test(name) || !description || method !== "GET") {
    throw serviceError("cartesia_tool_input_invalid", "Provide a valid tool name, description, HTTPS GET endpoint, and read-only webhook configuration", 400);
  }
  const cleanParameters = (parameterSchema = {}, requireList = false) => {
    const properties = parameterSchema.properties && typeof parameterSchema.properties === "object" ? parameterSchema.properties : {};
    const cleanProperties = {};
    for (const [key, value] of Object.entries(properties).slice(0, 30)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !value || typeof value !== "object") continue;
      const type = ["string", "integer", "number", "boolean"].includes(value.type) ? value.type : null;
      const dynamicVariable = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(value.dynamic_variable || "")) ? String(value.dynamic_variable) : null;
      if (!type || !dynamicVariable) continue;
      cleanProperties[key] = { type, dynamic_variable: dynamicVariable, ...(value.description ? { description: safeText(value.description, 120) } : {}) };
    }
    const required = Array.isArray(parameterSchema.required)
      ? parameterSchema.required.filter((key) => Object.hasOwn(cleanProperties, key)).slice(0, 30)
      : [];
    if (requireList && required.some((key) => !Object.hasOwn(cleanProperties, key))) return null;
    return Object.keys(cleanProperties).length ? { properties: cleanProperties, ...(required.length ? { required } : {}) } : null;
  };
  const queryParams = cleanParameters(schema.query_params_schema || schema.queryParamsSchema || {});
  const pathParams = cleanParameters(schema.path_params_schema || schema.pathParamsSchema || {});
  const rawUrl = safeWebhookUrl(schema.url);
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.search || parsedUrl.hash) throw serviceError("cartesia_tool_url_invalid", "Configure webhook query values as dynamic parameters, not as URL literals", 400);
  const safeSchema = { url: rawUrl, method };
  if (queryParams) safeSchema.query_params_schema = queryParams;
  if (pathParams) safeSchema.path_params_schema = pathParams;
  return {
    type: "webhook",
    name,
    description,
    pre_tool_speech: ["auto", "force", "off"].includes(input.pre_tool_speech) ? input.pre_tool_speech : "auto",
    execution_mode: input.execution_mode === "immediate" ? "immediate" : "async",
    response_timeout_secs: Math.max(1, Math.min(120, Number(input.response_timeout_secs) || 20)),
    api_schema: safeSchema,
  };
}

function validateClientTool(input = {}) {
  const name = safeText(input.name, 64);
  const description = safeText(input.description, 500);
  if (input.type !== undefined && input.type !== "client") throw serviceError("cartesia_tool_input_invalid", "Client tools must use type client", 400);
  if (!NAME_PATTERN.test(name) || !description) throw serviceError("cartesia_tool_input_invalid", "Provide a valid client tool name and description", 400);
  const source = input.parameters;
  if (!source || typeof source !== "object" || Array.isArray(source) || source.type !== "object" || !source.properties || typeof source.properties !== "object" || Array.isArray(source.properties)) {
    throw serviceError("cartesia_tool_input_invalid", "Client tool parameters must be an object JSON Schema with properties", 400);
  }
  const entries = Object.entries(source.properties);
  if (entries.length > 30) throw serviceError("cartesia_tool_input_invalid", "Client tools may define at most 30 parameter properties", 400);
  const properties = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !value || typeof value !== "object" || Array.isArray(value)) throw serviceError("cartesia_tool_input_invalid", "Client tool parameter names and schemas must be valid", 400);
    const type = ["string", "integer", "number", "boolean", "array"].includes(value.type) ? value.type : null;
    if (!type) throw serviceError("cartesia_tool_input_invalid", "Client tool parameters support scalar values and arrays of supported scalar types", 400);
    const property = { type };
    if (type === "array") {
      const itemType = ["string", "integer", "number", "boolean"].includes(value.items?.type) ? value.items.type : null;
      if (!itemType || Object.keys(value.items || {}).some((key) => !["type"].includes(key))) throw serviceError("cartesia_tool_input_invalid", "Client tool arrays must declare one supported scalar item type", 400);
      property.items = { type: itemType };
    }
    if (value.description !== undefined) {
      const itemDescription = safeText(value.description, 160);
      if (!itemDescription) throw serviceError("cartesia_tool_input_invalid", "Parameter descriptions must contain plain text", 400);
      property.description = itemDescription;
    }
    if (value.enum !== undefined) {
      if (type !== "string" || !Array.isArray(value.enum) || !value.enum.length || value.enum.length > 30 || value.enum.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 120) || new Set(value.enum).size !== value.enum.length) {
        throw serviceError("cartesia_tool_input_invalid", "String enums must contain 1–30 unique values of at most 120 characters", 400);
      }
      property.enum = value.enum.map((entry) => entry.trim());
    }
    properties[key] = property;
  }
  const required = source.required === undefined ? [] : source.required;
  if (!Array.isArray(required) || required.length > entries.length || required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)) || new Set(required).size !== required.length) {
    throw serviceError("cartesia_tool_input_invalid", "Client tool required fields must reference declared properties", 400);
  }
  const executionMode = input.execution_mode === undefined ? "async" : input.execution_mode;
  if (!new Set(["async", "immediate"]).has(executionMode)) throw serviceError("cartesia_tool_input_invalid", "Client tool execution_mode must be async or immediate", 400);
  const expectsResponse = input.expects_response === true;
  const responseTimeout = input.response_timeout_secs === undefined ? 20 : Number(input.response_timeout_secs);
  if (!Number.isInteger(responseTimeout) || responseTimeout < 1 || responseTimeout > 120) throw serviceError("cartesia_tool_input_invalid", "Client tool response_timeout_secs must be an integer from 1 to 120", 400);
  return {
    type: "client", name, description,
    pre_tool_speech: ["auto", "force", "off"].includes(input.pre_tool_speech) ? input.pre_tool_speech : "auto",
    execution_mode: executionMode, expects_response: expectsResponse,
    ...(expectsResponse ? { response_timeout_secs: responseTimeout } : {}),
    parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
  };
}

function normalizeMetricResult(row = {}) {
  const value = row.value;
  const safeValue = typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : null;
  return {
    callId: ID_PATTERN.test(String(row.call_id || row.callId || "")) ? String(row.call_id || row.callId) : null,
    agentId: ID_PATTERN.test(String(row.agent_id || row.agentId || "")) ? String(row.agent_id || row.agentId) : null,
    metricId: ID_PATTERN.test(String(row.metric_id || row.metricId || "")) ? String(row.metric_id || row.metricId) : null,
    status: safeText(row.status, 32).toLowerCase() || "unknown",
    value: safeValue,
    createdAt: safeText(row.created_at || row.createdAt, 40) || null,
  };
}

function phraseCacheKey(input = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    modelId: String(input.modelId || input.model_id || ""),
    voiceId: String(input.voiceId || input.voice_id || ""),
    language: String(input.language || ""),
    outputFormat: input.outputFormat || input.output_format || {},
    transcript: String(input.transcript || ""),
    generationConfig: input.generationConfig || input.generation_config || {},
  })).digest("hex");
}

class CartesiaStudioService {
  constructor(options = {}) {
    this.client = options.client;
    this.cacheStore = options.cacheStore || null;
    this.sttProfileStore = options.sttProfileStore || null;
    this.agentProfileStore = options.agentProfileStore || null;
    this.voiceGovernanceStore = options.voiceGovernanceStore || null;
    this.webhookEventStore = options.webhookEventStore || null;
  }

  async _recordVoiceConsent({ actorId, operation, resourceName, phrase }) {
    if (!this.voiceGovernanceStore?.recordCartesiaVoiceConsent) throw serviceError("cartesia_voice_governance_unavailable", "Durable clone consent storage is unavailable", 503);
    const safeActorId = String(actorId || "").trim();
    if (!/^\d{1,20}$/.test(safeActorId)) throw serviceError("cartesia_voice_consent_actor_invalid", "An authenticated administrator is required for clone consent", 403);
    const normalizedName = safeText(resourceName, 80).toUpperCase();
    const expected = operation === "instant_clone"
      ? `I CONFIRM SPEAKER CONSENT AND CREATE CARTESIA CLONE ${normalizedName}`
      : `CREATE CARTESIA PRO CLONE DATASET ${normalizedName}`;
    if (phrase !== expected) throw serviceError("cartesia_voice_consent_required", "Exact speaker-consent confirmation is required", 400);
    const consentId = crypto.randomBytes(16).toString("hex");
    await this.voiceGovernanceStore.recordCartesiaVoiceConsent({ consent_id: consentId, actor_id: safeActorId, operation, resource_name: safeText(resourceName, 80) });
    return consentId;
  }

  async listVoiceGovernance() {
    if (!this.voiceGovernanceStore?.listCartesiaVoiceGovernance) throw serviceError("cartesia_voice_governance_unavailable", "Clone governance storage is unavailable", 503);
    const rows = await this.voiceGovernanceStore.listCartesiaVoiceGovernance(200);
    return { consents: (Array.isArray(rows) ? rows : []).map((row) => ({
      consentId: /^[a-f0-9]{32}$/.test(String(row?.consent_id || "")) ? String(row.consent_id) : null,
      actorId: /^\d{1,20}$/.test(String(row?.actor_id || "")) ? String(row.actor_id) : null,
      operation: ["instant_clone", "pro_clone_dataset"].includes(String(row?.operation)) ? String(row.operation) : "unknown",
      resourceId: ID_PATTERN.test(String(row?.resource_id || "")) ? String(row.resource_id) : null,
      resourceType: ["voice", "dataset", "fine_tune"].includes(String(row?.resource_type)) ? String(row.resource_type) : null,
      fineTuneId: ID_PATTERN.test(String(row?.fine_tune_id || "")) ? String(row.fine_tune_id) : null,
      resourceName: safeText(row?.resource_name, 80) || null,
      sampleCount: Math.max(0, Math.min(20, Number(row?.sample_count) || 0)),
      status: ["active", "revoked", "deleted", "provider_failed"].includes(String(row?.status)) ? String(row.status) : "unknown",
      consentedAt: safeText(row?.consented_at, 40) || null,
      revokedAt: safeText(row?.revoked_at, 40) || null,
      deletedAt: safeText(row?.deleted_at, 40) || null,
    })).filter((row) => row.consentId) };
  }

  async revokeVoiceConsent(consentId) {
    const id = safeConsentId(consentId);
    if (!this.voiceGovernanceStore?.revokeCartesiaVoiceConsent) throw serviceError("cartesia_voice_governance_unavailable", "Clone governance storage is unavailable", 503);
    const changed = await this.voiceGovernanceStore.revokeCartesiaVoiceConsent(id);
    if (!changed) throw serviceError("cartesia_voice_consent_not_active", "Active clone consent was not found", 404);
    return { revoked: true, consentId: id };
  }

  async deleteGovernedClone(consentId) {
    const id = safeConsentId(consentId);
    const row = await this.voiceGovernanceStore?.getCartesiaVoiceGovernance?.(id);
    if (!row || row.operation !== "instant_clone" || row.resource_type !== "voice" || !ID_PATTERN.test(String(row.resource_id || "")) || !["active", "revoked", "provider_failed"].includes(String(row.status))) {
      throw serviceError("cartesia_voice_governance_resource_not_found", "A tracked Instant Voice Clone was not found for this consent record", 404);
    }
    const operationToken = crypto.randomUUID();
    const claimed = await this.voiceGovernanceStore.claimCartesiaVoiceGovernanceResourceCleanup(id, row.resource_id, "voice", operationToken);
    if (!claimed) throw serviceError("cartesia_voice_governance_operation_active", "A clone creation or cleanup operation is already in progress", 409);
    try {
      await this.deleteVoice(row.resource_id);
      const marked = await this.voiceGovernanceStore.markCartesiaVoiceResourceDeleted(id, operationToken);
      if (!marked) throw serviceError("cartesia_voice_governance_state_conflict", "The clone was deleted but its governance record could not be updated", 409);
      return { deleted: true, consentId: id, voiceId: row.resource_id };
    } catch (error) {
      await this.voiceGovernanceStore.finishCartesiaVoiceGovernanceOperation(id, operationToken).catch(() => {});
      throw error;
    }
  }

  async deleteGovernedProCloneData(consentId) {
    const id = safeConsentId(consentId);
    const row = await this.voiceGovernanceStore?.getCartesiaVoiceGovernance?.(id);
    if (!row || row.operation !== "pro_clone_dataset" || row.resource_type !== "dataset" || !ID_PATTERN.test(String(row.resource_id || "")) || !["active", "revoked", "provider_failed"].includes(String(row.status))) {
      throw serviceError("cartesia_voice_governance_resource_not_found", "A tracked Pro Clone dataset was not found for this consent record", 404);
    }
    const operationToken = crypto.randomUUID();
    const claimed = await this.voiceGovernanceStore.claimCartesiaVoiceGovernanceCleanup(id, row.resource_id, operationToken);
    if (!claimed) throw serviceError("cartesia_voice_governance_operation_active", "A Pro Clone upload, training, or cleanup operation is already in progress", 409);
    const fineTuneId = row.fine_tune_id;
    try {
      if (fineTuneId && ID_PATTERN.test(String(fineTuneId))) {
        try { await this.client.deleteFineTune(fineTuneId); }
        catch (error) { if (Number(error?.status) !== 404) throw error; }
        await this.voiceGovernanceStore.clearCartesiaFineTuneLink(id, fineTuneId);
      }
      try { await this.client.deleteDataset(row.resource_id); }
      catch (error) { if (Number(error?.status) !== 404) throw error; }
      const marked = await this.voiceGovernanceStore.markCartesiaVoiceResourceDeleted(id, operationToken);
      if (!marked) throw serviceError("cartesia_voice_governance_state_conflict", "Provider clone data was deleted but its governance record could not be updated", 409);
      return { deleted: true, consentId: id, datasetId: row.resource_id, fineTuneDeleted: Boolean(fineTuneId) };
    } catch (error) {
      await this.voiceGovernanceStore.finishCartesiaVoiceGovernanceOperation(id, operationToken).catch(() => {});
      throw error;
    }
  }

  async listVoices(query = {}) {
    const result = await this.client.listVoices({ isOwner: query.isOwner !== false, limit: query.limit, startingAfter: query.startingAfter });
    return { voices: listFrom(result, "voices", "data", "summaries").slice(0, 100).map(normalizeVoice).filter(Boolean) };
  }
  async getVoice(id) {
    const voice = normalizeVoice(await this.client.getVoice(safeId(id, "voice")));
    if (!voice) throw serviceError("cartesia_voice_response_invalid", "Cartesia returned an invalid voice", 502);
    return { voice };
  }
  async listAccents(query = {}) {
    const result = await this.client.listAccents({ isLocalizable: query.isLocalizable === true || query.is_localizable === "true", limit: query.limit });
    return { accents: listFrom(result, "data", "accents").slice(0, 200).map((accent) => ({
      id: safeText(accent?.id || accent?.accent, 80),
      name: safeText(accent?.name || accent?.display_name, 100),
      locale: safeText(accent?.locale, 20) || null,
      isLocalizable: accent?.is_localizable === true,
    })).filter((accent) => accent.id) };
  }
  async localizeVoice(input = {}) {
    const voiceId = safeId(input.voiceId || input.voice_id, "voice");
    const name = safeText(input.name, 80);
    const accent = safeText(input.accent, 80);
    if (!NAME_PATTERN.test(name) || !/^[A-Za-z0-9_-]{1,80}$/.test(accent)) throw serviceError("cartesia_voice_localize_input_invalid", "A valid voice name and accent ID are required", 400);
    const accents = await this.listAccents({ isLocalizable: true });
    if (!accents.accents.some((entry) => entry.id === accent)) throw serviceError("cartesia_voice_accent_not_localizable", "Choose an accent Cartesia lists as localizable", 400);
    const voice = normalizeVoice(await this.client.localizeVoice({ voice_id: voiceId, name, accent, access: "private", ...(input.description ? { description: safeText(input.description, 300) } : {}) }));
    if (!voice) throw serviceError("cartesia_voice_localize_response_invalid", "Cartesia returned an invalid localized voice", 502);
    return { voice };
  }
  async updateVoice(id, input = {}) {
    const voiceId = safeId(id, "voice");
    const current = await this.client.getVoice(voiceId);
    if (!(current?.is_owner === true || current?.isOwner === true)) throw serviceError("cartesia_voice_not_owned", "Only voices owned by this Cartesia organization can be changed", 403);
    const patch = {};
    if (input.name !== undefined) {
      patch.name = safeText(input.name, 80);
      if (!NAME_PATTERN.test(patch.name)) throw serviceError("cartesia_voice_update_invalid", "A valid voice name is required", 400);
    }
    if (input.description !== undefined) patch.description = safeText(input.description, 300);
    if (input.tagline !== undefined) patch.tagline = safeText(input.tagline, 32);
    if (input.access !== undefined) {
      if (!new Set(["private", "public"]).has(input.access)) throw serviceError("cartesia_voice_update_invalid", "Voice access must be private or public", 400);
      patch.access = input.access;
    }
    if (!Object.keys(patch).length) throw serviceError("cartesia_voice_update_invalid", "Provide a voice field to update", 400);
    const voice = normalizeVoice(await this.client.updateVoice(voiceId, patch));
    if (!voice) throw serviceError("cartesia_voice_update_response_invalid", "Cartesia returned an invalid updated voice", 502);
    return { voice };
  }
  async deleteVoice(id) {
    const voiceId = safeId(id, "voice");
    const current = await this.client.getVoice(voiceId);
    if (!(current?.is_owner === true || current?.isOwner === true)) throw serviceError("cartesia_voice_not_owned", "Only voices owned by this Cartesia organization can be deleted", 403);
    await this.client.deleteVoice(voiceId);
    return { deleted: true, voiceId };
  }
  async addVoiceAccents(id, input = {}) {
    const voiceId = safeId(id, "voice");
    const current = await this.client.getVoice(voiceId);
    if (!(current?.is_owner === true || current?.isOwner === true)) throw serviceError("cartesia_voice_not_owned", "Only voices owned by this Cartesia organization can be changed", 403);
    const accents = Array.isArray(input.accents) ? [...new Set(input.accents.map((accent) => safeText(accent, 80)).filter((accent) => /^[A-Za-z0-9_-]{1,80}$/.test(accent)))].slice(0, 9) : [];
    if (!accents.length || accents.length !== input.accents?.length) throw serviceError("cartesia_voice_accents_invalid", "Choose between 1 and 9 valid accent IDs without duplicates", 400);
    const existingAccents = Array.isArray(current.accents) ? current.accents.map((entry) => String(entry?.accent || "")).filter(Boolean) : [];
    if (!existingAccents.length) throw serviceError("cartesia_voice_accents_missing_native", "This voice needs native accent metadata before localized accents can be added", 409);
    if (existingAccents.length + accents.length > 10 || accents.some((accent) => existingAccents.includes(accent))) {
      throw serviceError("cartesia_voice_accents_invalid", "The voice already has that accent or would exceed Cartesia's 10-accent limit", 400);
    }
    const catalog = await this.listAccents({ isLocalizable: true });
    const localizable = new Set(catalog.accents.map((accent) => accent.id));
    if (accents.some((accent) => !localizable.has(accent))) throw serviceError("cartesia_voice_accent_not_localizable", "Every accent must be listed as localizable by Cartesia", 400);
    const result = await this.client.addVoiceAccents(voiceId, { accents });
    return { voice: normalizeVoice(result) };
  }
  async deleteVoiceAccent(id, accentId) {
    const voiceId = safeId(id, "voice");
    const accent = safeId(accentId, "accent");
    const current = await this.client.getVoice(voiceId);
    if (!(current?.is_owner === true || current?.isOwner === true)) throw serviceError("cartesia_voice_not_owned", "Only voices owned by this Cartesia organization can be changed", 403);
    await this.client.deleteVoiceAccent(voiceId, accent);
    return { deleted: true, voiceId, accentId: accent };
  }
  async cloneVoice(input = {}) {
    const name = safeText(input.name, 80);
    const language = safeText(input.language, 20);
    const clip = Buffer.isBuffer(input.clip) ? input.clip : Buffer.from(input.clip || "");
    if (!NAME_PATTERN.test(name) || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language) || clip.length === 0 || clip.length > 16 * 1024 * 1024) {
      throw serviceError("cartesia_voice_clone_input_invalid", "Voice name, language, and an audio sample up to 16 MB are required", 400);
    }
    const consentId = await this._recordVoiceConsent({ actorId: input.consentActorId, operation: "instant_clone", resourceName: name, phrase: input.consentPhrase });
    let createdVoiceId = null;
    try {
      const voice = normalizeVoice(await this.client.cloneVoice({ ...input, name, language, clip, access: "private" }));
      if (!voice) throw serviceError("cartesia_voice_clone_response_invalid", "Cartesia returned an invalid cloned voice", 502);
      createdVoiceId = voice.id;
      const linked = await this.voiceGovernanceStore.linkCartesiaVoiceGovernanceResource({ consent_id: consentId, resource_id: voice.id, resource_type: "voice" });
      if (!linked) throw serviceError("cartesia_voice_governance_state_conflict", "Clone was created but its consent record could not be linked", 409);
      if (!await this.voiceGovernanceStore.finishCartesiaVoiceGovernanceCreation(consentId, consentId)) throw serviceError("cartesia_voice_governance_state_conflict", "Clone was created but its consent operation could not be completed", 409);
      return { voice, consentId };
    } catch (error) {
      await this.voiceGovernanceStore.markCartesiaVoiceGovernanceFailure(consentId, createdVoiceId ? { resource_id: createdVoiceId, resource_type: "voice" } : {}, consentId).catch(() => {});
      throw error;
    }
  }
  createInstantVoiceClone(input = {}) { return this.cloneVoice(input); }
  async createDataset(input = {}) {
    const name = safeText(input.name, 80);
    if (!NAME_PATTERN.test(name)) throw serviceError("cartesia_dataset_input_invalid", "A valid dataset name is required", 400);
    const consentId = await this._recordVoiceConsent({ actorId: input.consentActorId, operation: "pro_clone_dataset", resourceName: name, phrase: input.consentPhrase });
    let createdDatasetId = null;
    try {
      const result = await this.client.createDataset({ name, description: safeText(input.description, 300) });
      const datasetId = safeId(result?.id, "dataset");
      createdDatasetId = datasetId;
      const linked = await this.voiceGovernanceStore.linkCartesiaVoiceGovernanceResource({ consent_id: consentId, resource_id: datasetId, resource_type: "dataset" });
      if (!linked) throw serviceError("cartesia_voice_governance_state_conflict", "Dataset was created but its consent record could not be linked", 409);
      if (!await this.voiceGovernanceStore.finishCartesiaVoiceGovernanceCreation(consentId, consentId)) throw serviceError("cartesia_voice_governance_state_conflict", "Dataset was created but its consent operation could not be completed", 409);
      return { datasetId, consentId, name: safeText(result?.name, 80, name) };
    } catch (error) {
      await this.voiceGovernanceStore.markCartesiaVoiceGovernanceFailure(consentId, createdDatasetId ? { resource_id: createdDatasetId, resource_type: "dataset" } : {}, consentId).catch(() => {});
      throw error;
    }
  }
  async uploadDatasetFile(datasetId, input = {}) {
    const file = Buffer.isBuffer(input.file) ? input.file : Buffer.from(input.file || "");
    if (!file.length || file.length > 100 * 1024 * 1024) throw serviceError("cartesia_dataset_file_invalid", "Dataset audio file must be between 1 byte and 100 MB", 400);
    const consentId = safeConsentId(input.consentId || input.consent_id);
    const consent = await this.voiceGovernanceStore?.getCartesiaVoiceGovernance?.(consentId);
    if (!consent || consent.status !== "active" || consent.operation !== "pro_clone_dataset" || consent.resource_type !== "dataset" || consent.resource_id !== safeId(datasetId, "dataset")) {
      throw serviceError("cartesia_voice_consent_not_active", "Active speaker consent must be recorded for this Pro Clone dataset", 403);
    }
    const operationToken = crypto.randomUUID();
    const claimed = await this.voiceGovernanceStore.beginCartesiaVoiceGovernanceOperation(consentId, datasetId, operationToken);
    if (!claimed) throw serviceError("cartesia_voice_consent_not_active", "Active speaker consent is required before uploading Pro Clone samples", 403);
    let uploaded = false;
    try {
      const result = await this.client.uploadDatasetFile(safeId(datasetId, "dataset"), input);
      uploaded = true;
      const recorded = await this.voiceGovernanceStore.finishCartesiaVoiceGovernanceOperation(consentId, operationToken, { sampleUploaded: true });
      if (!recorded) throw serviceError("cartesia_voice_governance_state_conflict", "Sample uploaded but clone governance could not record the upload", 409);
      return { fileId: ID_PATTERN.test(String(result?.id || "")) ? String(result.id) : null, uploaded: true, sampleCount: Number(consent.sample_count || 0) + 1 };
    } catch (error) {
      await this.voiceGovernanceStore.finishCartesiaVoiceGovernanceOperation(consentId, operationToken).catch(() => {});
      throw error;
    }
  }
  async createFineTune(input = {}) {
    const datasetId = safeId(input.datasetId || input.dataset_id, "dataset");
    const name = safeText(input.name, 80);
    const language = safeText(input.language, 20);
    if (!NAME_PATTERN.test(name) || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) throw serviceError("cartesia_fine_tune_input_invalid", "A valid fine-tune name and language are required", 400);
    const consentId = safeConsentId(input.consentId || input.consent_id);
    const consent = await this.voiceGovernanceStore?.getCartesiaVoiceGovernance?.(consentId);
    if (!consent || consent.status !== "active" || consent.operation !== "pro_clone_dataset" || consent.resource_type !== "dataset" || consent.resource_id !== datasetId || Number(consent.sample_count) < 1) {
      throw serviceError("cartesia_voice_consent_not_active", "Active speaker consent and uploaded Pro Clone samples are required", 403);
    }
    const operationToken = crypto.randomUUID();
    const claimed = await this.voiceGovernanceStore.beginCartesiaVoiceGovernanceOperation(consentId, datasetId, operationToken);
    if (!claimed) throw serviceError("cartesia_voice_consent_not_active", "Active speaker consent is required before Pro Clone training", 403);
    let fineTuneId = null;
    try {
      const result = await this.client.createFineTune({ name, description: safeText(input.description, 300), language, dataset: datasetId });
      fineTuneId = safeId(result?.id, "fine_tune");
      const recorded = await this.voiceGovernanceStore.finishCartesiaVoiceGovernanceOperation(consentId, operationToken, { fineTuneId });
      if (!recorded) throw serviceError("cartesia_voice_governance_state_conflict", "Fine-tune was created but clone governance could not record it", 409);
      return { fineTuneId, consentId, status: safeText(result?.status, 32, "pending").toLowerCase() };
    } catch (error) {
      if (fineTuneId) await this.voiceGovernanceStore.markCartesiaVoiceGovernanceFailure(consentId, { fine_tune_id: fineTuneId }, operationToken).catch(() => {});
      else await this.voiceGovernanceStore.finishCartesiaVoiceGovernanceOperation(consentId, operationToken).catch(() => {});
      throw error;
    }
  }
  async getFineTune(id) {
    const result = await this.client.getFineTune(safeId(id, "fine_tune"));
    return { fineTune: { id: safeId(result?.id, "fine_tune"), status: safeText(result?.status, 32, "unknown").toLowerCase(), name: safeText(result?.name, 80) || null } };
  }
  async listFineTuneVoices(id) {
    const result = await this.client.listFineTuneVoices(safeId(id, "fine_tune"));
    return { voices: listFrom(result, "data", "voices").slice(0, 30).map(normalizeVoice).filter(Boolean) };
  }
  async previewSpeech(input = {}) {
    const body = validateTtsPreview(input);
    await this.assertLocaleSupported(body);
    const result = await this.client.generateSpeech(body);
    const bytes = Buffer.isBuffer(result?.bytes) ? result.bytes : Buffer.from(result?.bytes || "");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw serviceError("cartesia_tts_preview_response_invalid", "Cartesia returned invalid or oversized preview audio", 502);
    return { audioBase64: bytes.toString("base64"), contentType: safeText(result?.contentType, 80, "audio/wav"), byteLength: bytes.length };
  }
  async streamSpeech(input = {}) {
    const body = validateTtsPreview(input);
    await this.assertLocaleSupported(body);
    const result = await this.client.streamSpeech(body);
    if (!result?.stream || typeof result.stream.pipe !== "function") throw serviceError("cartesia_tts_stream_invalid", "Cartesia returned an invalid speech stream", 502);
    return result;
  }
  async synthesizeContinuations(input = {}) {
    const transcripts = Array.isArray(input.transcripts) ? input.transcripts.map((part) => typeof part === "string" ? part : "").filter((part) => part.trim()) : [];
    if (transcripts.length < 2 || transcripts.length > 10 || transcripts.reduce((sum, part) => sum + part.length, 0) > 3000) {
      throw serviceError("cartesia_tts_continuations_invalid", "Provide 2–10 transcript parts and no more than 3,000 characters total", 400);
    }
    const body = validateTtsPreview({ ...input, transcript: transcripts.join("") });
    await this.assertLocaleSupported(body);
    const result = await this.client.streamSpeechContinuations({
      voice: body.voice, model_id: body.model_id, language: input.language || input.locale || "en", transcripts,
    });
    const bytes = Buffer.isBuffer(result?.bytes) ? result.bytes : Buffer.from(result?.bytes || "");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw serviceError("cartesia_tts_continuations_response_invalid", "Cartesia returned invalid or oversized continuation audio", 502);
    return { audioBase64: bytes.toString("base64"), contentType: "audio/pcm", byteLength: bytes.length };
  }
  async transcribeAudio(input = {}) {
    const file = Buffer.isBuffer(input.file) ? input.file : Buffer.from(input.file || "");
    if (!file.length || file.length > 25 * 1024 * 1024) throw serviceError("cartesia_stt_audio_invalid", "STT audio must be between 1 byte and 25 MB", 400);
    const result = await this.client.transcribeAudio({ ...input, file });
    const text = safeText(result?.text, 50000);
    if (!text) throw serviceError("cartesia_stt_response_invalid", "Cartesia returned no transcript", 502);
    const words = Array.isArray(result?.words) ? result.words.slice(0, 10000).map((word) => ({
      word: safeText(word?.word, 200), start: Number.isFinite(Number(word?.start)) ? Number(word.start) : null,
      end: Number.isFinite(Number(word?.end)) ? Number(word.end) : null,
    })).filter((word) => word.word) : [];
    const duration = Number.isFinite(Number(result?.duration)) ? Number(result.duration) : null;
    return { transcript: text, language: safeText(result?.language, 20) || null, duration, durationSeconds: duration, words };
  }
  async transcribeAudioRealtime(input = {}) {
    const audioInput = input.file ?? input.audio;
    const file = Buffer.isBuffer(audioInput) ? audioInput : Buffer.from(audioInput || "");
    if (!file.length || file.length > MAX_REALTIME_STT_AUDIO_BYTES || file.length % 2 !== 0) throw serviceError("cartesia_stt_realtime_audio_invalid", "Realtime STT requires raw PCM16 audio of no more than 50 seconds (1.6 MB)", 400);
    const keyterms = validateSttKeyterms(input.keyterms || []);
    const rawTurnSettings = input.turnSettings || input.turn_settings || {};
    const turnSettingsInput = Object.fromEntries(Object.entries(rawTurnSettings).filter(([, value]) => value !== undefined && value !== null && Number.isFinite(Number(value))));
    const turnSettings = Object.keys(turnSettingsInput).length ? normalizeSttTurnSettings(turnSettingsInput) : undefined;
    const result = await this.client.transcribeAudioRealtime({ ...input, file, keyterms, ...(turnSettings ? { turnSettings } : {}) });
    const transcript = safeSttTranscript(result?.transcript);
    if (!transcript) throw serviceError("cartesia_stt_realtime_response_invalid", "Cartesia returned no completed transcript", 502);
    const events = Array.isArray(result?.events) ? result.events.slice(0, 500).map((event) => ({
      type: safeText(event?.type, 32) || "event",
      ...(typeof event?.transcript === "string" ? { transcript: safeSttTranscript(event.transcript) } : {}),
    })) : [];
    return { transcript, language: safeText(result?.language, 20) || null, durationSeconds: null, events };
  }
  async transcribeAudioManual(input = {}) {
    const audioInput = input.file ?? input.audio;
    const file = Buffer.isBuffer(audioInput) ? audioInput : Buffer.from(audioInput || "");
    if (!file.length || file.length > MAX_REALTIME_STT_AUDIO_BYTES || file.length % 2 !== 0) {
      throw serviceError("cartesia_stt_manual_audio_invalid", "Manual STT requires raw PCM16 audio of no more than 50 seconds (1.6 MB)", 400);
    }
    const keyterms = validateSttKeyterms(input.keyterms || []);
    const result = await this.client.transcribeAudioManual({ ...input, file, keyterms });
    const transcript = safeSttTranscript(result?.transcript);
    const durationValue = result?.durationSeconds;
    const durationSeconds = durationValue !== null && durationValue !== undefined && Number.isFinite(Number(durationValue))
      ? Number(durationValue)
      : null;
    return {
      transcript,
      language: safeText(result?.language, 20) || null,
      durationSeconds,
    };
  }
  async infillSpeech(input = {}) {
    const transcript = safeText(input.transcript, 1000);
    if (!transcript || !(input.leftAudio || input.rightAudio)) throw serviceError("cartesia_infill_input_invalid", "An infill phrase and at least one surrounding audio clip are required", 400);
    const voiceId = safeId(input.voiceId || input.voice_id, "voice");
    const normalizeAudio = (source) => Buffer.isBuffer(source)
      ? { data: source, filename: safeText(input.filename, 120, "context.wav"), contentType: safeText(input.contentType, 80, "audio/wav") }
      : source;
    const result = await this.client.infillSpeech({ ...input, leftAudio: normalizeAudio(input.leftAudio), rightAudio: normalizeAudio(input.rightAudio), transcript, voiceId });
    const bytes = Buffer.isBuffer(result?.bytes) ? result.bytes : Buffer.from(result?.bytes || "");
    if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw serviceError("cartesia_infill_response_invalid", "Cartesia returned invalid or oversized infill audio", 502);
    bytes.contentType = safeText(result?.contentType, 80, "audio/wav");
    return bytes;
  }
  async assertLocaleSupported(body) {
    // A locale absent from a voice's native accents may still be spoken using
    // the original accent. Do not reject it based on accent metadata alone.
    return true;
  }
  async synthesizePreview(input = {}) {
    return this.previewSpeech({
      ...input,
      voiceId: input.voiceId || input.voice_id,
      modelId: input.modelId || input.model_id,
      speed: input.generationConfig?.speed ?? input.generation_config?.speed ?? input.speed,
      volume: input.generationConfig?.volume ?? input.generation_config?.volume ?? input.volume,
      pronunciationDictId: input.pronunciationDictId || input.pronunciation_dict_id,
    });
  }
  async listPronunciationDictionaries() {
    const result = await this.client.listPronunciationDictionaries();
    return { dictionaries: listFrom(result, "data", "dictionaries").slice(0, 100).map((dict) => ({
      id: ID_PATTERN.test(String(dict?.id || "")) ? String(dict.id) : null,
      name: safeText(dict?.name, 80), description: safeText(dict?.description, 200) || null,
      itemCount: Array.isArray(dict?.items) ? Math.min(dict.items.length, 200) : Math.max(0, Number(dict?.item_count) || 0),
    })).filter((dict) => dict.id) };
  }
  listPronunciationDictionary() { return this.listPronunciationDictionaries(); }
  async getPronunciationDictionary(id) {
    const dict = await this.client.getPronunciationDictionary(safeId(id, "pronunciation_dictionary"));
    return { dictionary: { id: safeId(dict?.id, "pronunciation_dictionary"), name: safeText(dict?.name, 80), description: safeText(dict?.description, 200) || null, items: validatePronunciationItems(listFrom(dict, "items").slice(0, 200)) } };
  }
  async createPronunciationDictionary(input = {}) {
    const name = safeText(input.name, 80);
    if (!NAME_PATTERN.test(name)) throw serviceError("cartesia_pronunciation_dict_input_invalid", "A valid pronunciation dictionary name is required", 400);
    const result = await this.client.createPronunciationDictionary({ name, description: safeText(input.description, 200), items: validatePronunciationItems(input.items) });
    return { dictionary: { id: safeId(result?.id, "pronunciation_dictionary"), name: safeText(result?.name, 80, name), itemCount: Array.isArray(result?.items) ? result.items.length : input.items.length } };
  }
  async updatePronunciationDictionary(id, input = {}) {
    const body = {};
    if (input.name !== undefined) {
      body.name = safeText(input.name, 80);
      if (!NAME_PATTERN.test(body.name)) throw serviceError("cartesia_pronunciation_dict_input_invalid", "A valid pronunciation dictionary name is required", 400);
    }
    if (input.description !== undefined) body.description = safeText(input.description, 200);
    if (input.items !== undefined) body.items = validatePronunciationItems(input.items);
    if (!Object.keys(body).length) throw serviceError("cartesia_pronunciation_dict_input_invalid", "Provide a dictionary field to update", 400);
    const result = await this.client.updatePronunciationDictionary(safeId(id, "pronunciation_dictionary"), body);
    return { dictionary: { id: safeId(result?.id || id, "pronunciation_dictionary"), name: safeText(result?.name, 80, body.name || ""), itemCount: Array.isArray(result?.items) ? result.items.length : body.items?.length ?? null } };
  }
  async deletePronunciationDictionary(id) { await this.client.deletePronunciationDictionary(safeId(id, "pronunciation_dictionary")); return { deleted: true }; }
  async listMetrics() {
    const result = await this.client.listMetrics();
    const custom = listFrom(result, "data", "metrics").slice(0, 100).map((metric) => ({ id: ID_PATTERN.test(String(metric?.id || "")) ? String(metric.id) : null, name: safeText(metric?.name, 80), description: safeText(metric?.description, 240) || null, type: safeText(metric?.type || metric?.output_type, 32) || null })).filter((metric) => metric.id);
    const byId = new Map(custom.map((metric) => [metric.id, metric]));
    for (const metric of CARTESIA_BUILTIN_METRICS) if (!byId.has(metric.id)) byId.set(metric.id, metric);
    return { metrics: [...byId.values()] };
  }
  async createMetric(input = {}) {
    const name = safeText(input.name, 80);
    const prompt = safeText(input.prompt, 2000);
    if (!NAME_PATTERN.test(name) || !prompt) throw serviceError("cartesia_metric_input_invalid", "A valid metric name and evaluation prompt are required", 400);
    const result = await this.client.createMetric({ name, description: safeText(input.description, 300), prompt });
    return { metric: { id: safeId(result?.id, "metric"), name: safeText(result?.name, 80, name) } };
  }
  async assignMetric(agentId, metricId) {
    await this.client.assignMetric(safeId(agentId, "agent"), safeId(metricId, "metric"));
    return { assigned: true };
  }
  async listMetricResults(query = {}) {
    const result = await this.client.listMetricResults(query);
    const results = listFrom(result, "data", "results").slice(0, 100).map(normalizeMetricResult).filter((row) => row.callId || row.metricId);
    const valued = results.filter((row) => row.value !== null);
    return { results, summary: { resultCount: results.length, valuedCount: valued.length, booleanPassCount: valued.filter((row) => row.value === true).length, booleanFailCount: valued.filter((row) => row.value === false).length }, hasMore: result?.has_more === true, nextCursor: safeText(result?.next_cursor || result?.next_page, 200) || null };
  }
  async evaluateAgentVersionGate(agentId, versionId, input = {}) {
    const safeAgentId = safeId(agentId, "agent");
    const safeVersionId = safeId(versionId, "version");
    const versionResponse = await this.client.getAgentVersion(safeAgentId, safeVersionId);
    const version = versionResponse?.version || versionResponse?.data?.version || versionResponse?.data || versionResponse;
    if (String(version?.id || "") !== safeVersionId || !version?.config || typeof version.config !== "object" || Array.isArray(version.config)) {
      throw serviceError("cartesia_agent_version_response_invalid", "Cartesia returned an invalid agent version", 502);
    }
    const callIds = Array.isArray(input.callIds) ? input.callIds.map((id) => String(id || "").trim()) : [];
    const metricIds = Array.isArray(input.metricIds) ? input.metricIds.map((id) => String(id || "").trim()) : [];
    if (input.metricThresholds !== undefined && (!input.metricThresholds || typeof input.metricThresholds !== "object" || Array.isArray(input.metricThresholds))) {
      throw serviceError("cartesia_agent_evaluation_thresholds_invalid", "Numeric metric thresholds must be an object keyed by metric ID", 400);
    }
    const rawThresholds = input.metricThresholds || {};
    if (callIds.length < 1 || callIds.length > 20 || callIds.some((id) => !ID_PATTERN.test(id)) || new Set(callIds).size !== callIds.length) {
      throw serviceError("cartesia_agent_evaluation_calls_invalid", "Provide 1–20 unique completed Cartesia test call IDs", 400);
    }
    if (metricIds.length < 1 || metricIds.length > 20 || metricIds.some((id) => !ID_PATTERN.test(id)) || new Set(metricIds).size !== metricIds.length) {
      throw serviceError("cartesia_agent_evaluation_metrics_invalid", "Provide 1–20 unique Cartesia metric IDs", 400);
    }
    const minimumSamples = input.minimumSamples === undefined ? 3 : Number(input.minimumSamples);
    const minimumPassRate = input.minimumPassRate === undefined ? 0.9 : Number(input.minimumPassRate);
    if (!Number.isInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > 20 ||
        !Number.isFinite(minimumPassRate) || minimumPassRate < 0.5 || minimumPassRate > 1) {
      throw serviceError("cartesia_agent_evaluation_policy_invalid", "Evaluation requires 1–20 samples and a pass rate from 0.5 to 1", 400);
    }
    const metricCatalog = await this.listMetrics();
    const knownMetrics = new Set(metricCatalog.metrics.map((metric) => metric.id));
    if (metricIds.some((id) => !knownMetrics.has(id))) {
      throw serviceError("cartesia_agent_evaluation_metrics_invalid", "Every evaluation metric must exist in the Cartesia metric catalog", 400);
    }
    const metricThresholds = {};
    for (const [metricId, rawThreshold] of Object.entries(rawThresholds)) {
      if (!metricIds.includes(metricId)) throw serviceError("cartesia_agent_evaluation_thresholds_invalid", "Numeric thresholds can only reference selected metrics", 400);
      const maxValue = Number(rawThreshold);
      if (!Number.isFinite(maxValue) || maxValue <= 0 || maxValue > 600000) throw serviceError("cartesia_agent_evaluation_thresholds_invalid", "Numeric metric thresholds must be greater than 0 and at most 600000", 400);
      metricThresholds[metricId] = maxValue;
    }
    const calls = await Promise.all(callIds.map(async (callId) => {
      const result = await this.client.listMetricResults({ agentId: safeAgentId, callId, limit: 100 });
      const rows = listFrom(result, "data", "results").map(normalizeMetricResult)
        .filter((row) => row.agentId === safeAgentId && row.callId === callId && metricIds.includes(row.metricId));
      const byMetric = new Map();
      for (const row of rows) {
        if (byMetric.has(row.metricId)) byMetric.set(row.metricId, null);
        else byMetric.set(row.metricId, row);
      }
      const complete = metricIds.every((id) => {
        const row = byMetric.get(id);
        return row && row.status === "completed" && (typeof row.value === "boolean" || (typeof row.value === "number" && Object.hasOwn(metricThresholds, id)));
      });
      return { callId, complete, passed: complete && metricIds.every((id) => {
        const value = byMetric.get(id).value;
        return typeof value === "boolean" ? value : value <= metricThresholds[id];
      }) };
    }));
    const passedSamples = calls.filter((call) => call.passed).length;
    const passRate = calls.length ? passedSamples / calls.length : 0;
    const passed = calls.length >= minimumSamples && passRate >= minimumPassRate && calls.every((call) => call.complete);
    return {
      gate: passed ? "passed" : "blocked", passed, agentId: safeAgentId, versionId: safeVersionId,
      sampleCount: calls.length, completeSampleCount: calls.filter((call) => call.complete).length,
      passedSampleCount: passedSamples, passRate, minimumSamples, minimumPassRate, metricIds, metricThresholds,
      versionBinding: "operator_attested",
      limitations: ["Cartesia metric results do not include an agent version ID; the operator must attest that each test call used the selected version."],
    };
  }
  async getCallRuntimeLogs(callId) {
    const result = await this.client.getCallRuntimeLogs(safeId(callId, "call"));
    if (String(result?.call_id || "") !== String(callId)) throw serviceError("cartesia_call_logs_response_invalid", "Cartesia returned logs for a different call", 502);
    return { logs: sanitizeLogSummary(result) };
  }
  async listTools() {
    const result = await this.client.listTools();
    return { tools: listFrom(result, "data", "tools").slice(0, 100).map((tool) => ({ id: ID_PATTERN.test(String(tool?.id || "")) ? String(tool.id) : null, type: safeText(tool?.type, 24), name: safeText(tool?.name, 64), description: safeText(tool?.description, 240), executionMode: safeText(tool?.execution_mode, 32) || null, expectsResponse: tool?.expects_response === true, updatedAt: safeText(tool?.updated_at, 40) || null })).filter((tool) => tool.id) };
  }
  async listAgentWebhooks() {
    if (typeof this.client?.listAgentWebhooks !== "function") throw serviceError("cartesia_webhook_unavailable", "Cartesia webhook management is unavailable", 503);
    const result = await this.client.listAgentWebhooks();
    return { webhooks: listFrom(result, "webhooks", "data").slice(0, 100).map(normalizeManagedWebhook) };
  }
  async getAgentWebhook(id) {
    if (typeof this.client?.getAgentWebhook !== "function") throw serviceError("cartesia_webhook_unavailable", "Cartesia webhook management is unavailable", 503);
    return { webhook: normalizeManagedWebhook(await this.client.getAgentWebhook(safeId(id, "webhook"))) };
  }
  async createAgentWebhook(input = {}) {
    const displayName = safeText(input.display_name ?? input.displayName, 100);
    if (!NAME_PATTERN.test(displayName)) throw serviceError("cartesia_webhook_name_invalid", "Provide a valid Cartesia webhook display name", 400);
    const secret = String(this.client?.webhookSecret || "").trim();
    if (secret.length < 32 || !this.client?.webhookUrl) throw serviceError("cartesia_webhook_not_configured", "Configure the Cartesia webhook secret and public callback URL before creating event webhooks", 503);
    let url;
    try { url = validateManagedWebhookUrl(this.client.webhookUrl); }
    catch { throw serviceError("cartesia_webhook_not_configured", "Configured Cartesia webhook URL must be public HTTPS and end in /webhook/cartesia", 503); }
    if (typeof this.client?.createAgentWebhook !== "function") throw serviceError("cartesia_webhook_unavailable", "Cartesia webhook management is unavailable", 503);
    const result = await this.client.createAgentWebhook({ url, secret, display_name: displayName });
    return { webhook: normalizeManagedWebhook(result) };
  }
  async updateAgentWebhook(id, input = {}) {
    const patch = {};
    if (input.display_name !== undefined || input.displayName !== undefined) {
      patch.display_name = safeText(input.display_name ?? input.displayName, 100);
      if (!NAME_PATTERN.test(patch.display_name)) throw serviceError("cartesia_webhook_name_invalid", "Provide a valid Cartesia webhook display name", 400);
    }
    if (!this.client?.webhookUrl) throw serviceError("cartesia_webhook_not_configured", "Configure the public callback URL before updating Cartesia event webhooks", 503);
    let configuredUrl;
    try { configuredUrl = validateManagedWebhookUrl(this.client.webhookUrl); }
    catch { throw serviceError("cartesia_webhook_not_configured", "Configured Cartesia webhook URL must be public HTTPS and end in /webhook/cartesia", 503); }
    if (input.url !== undefined) {
      let candidate;
      try { candidate = validateManagedWebhookUrl(input.url); }
      catch { throw serviceError("cartesia_webhook_url_invalid", "Webhook URL must match the configured VOICEDNUT callback URL", 400); }
      if (candidate !== configuredUrl) throw serviceError("cartesia_webhook_url_invalid", "Webhook URL must match the configured VOICEDNUT callback URL", 400);
      patch.url = candidate;
    }
    if (input.rotate_secret === true || input.rotateSecret === true) {
      const secret = String(this.client?.webhookSecret || "").trim();
      if (secret.length < 32) throw serviceError("cartesia_webhook_not_configured", "Configure a Cartesia webhook secret of at least 32 characters before rotating it", 503);
      patch.secret = secret;
    }
    if (!Object.keys(patch).length) throw serviceError("cartesia_webhook_update_invalid", "Provide a webhook display name or the configured callback URL", 400);
    patch.url = configuredUrl;
    if (typeof this.client?.updateAgentWebhook !== "function") throw serviceError("cartesia_webhook_unavailable", "Cartesia webhook management is unavailable", 503);
    const webhookId = safeId(id, "webhook");
    const result = await this.client.updateAgentWebhook(webhookId, patch);
    const confirmedId = typeof result === "string" ? result : result?.id;
    if (confirmedId !== webhookId) {
      throw serviceError("cartesia_webhook_update_unconfirmed", "Cartesia did not confirm the expected webhook update", 502);
    }
    return { webhook: normalizeManagedWebhook({
      ...(result && typeof result === "object" ? result : {}),
      id: confirmedId,
      display_name: result?.display_name || patch.display_name,
      url: result?.url || patch.url,
    }) };
  }
  async deleteAgentWebhook(id) {
    if (typeof this.client?.deleteAgentWebhook !== "function") throw serviceError("cartesia_webhook_unavailable", "Cartesia webhook management is unavailable", 503);
    await this.client.deleteAgentWebhook(safeId(id, "webhook"));
    return { deleted: true };
  }
  async createWebhookTool(input = {}) {
    const result = await this.client.createTool(validateWebhookTool(input));
    return { tool: { id: safeId(result?.id, "tool"), type: "webhook", name: safeText(result?.name, 64), description: safeText(result?.description, 240) } };
  }
  createTool(input = {}) { return this.createWebhookTool(input); }
  async createClientTool(input = {}) {
    const result = await this.client.createTool(validateClientTool({ ...input, type: "client" }));
    return { tool: { id: safeId(result?.id, "tool"), type: "client", name: safeText(result?.name, 64), description: safeText(result?.description, 240), executionMode: safeText(result?.execution_mode, 32) || null, expectsResponse: result?.expects_response === true } };
  }
  async updateWebhookTool(id, input = {}) {
    const payload = {};
    if (input.name !== undefined) {
      payload.name = safeText(input.name, 64);
      if (!NAME_PATTERN.test(payload.name)) throw serviceError("cartesia_tool_input_invalid", "Provide a valid webhook tool name", 400);
    }
    if (input.description !== undefined) {
      payload.description = safeText(input.description, 500);
      if (!payload.description) throw serviceError("cartesia_tool_input_invalid", "Provide a valid webhook tool description", 400);
    }
    if (input.api_schema || input.apiSchema) {
      const normalized = validateWebhookTool({ name: payload.name || "update_tool", description: payload.description || "Update webhook tool", ...input });
      payload.api_schema = normalized.api_schema;
    }
    if (input.response_timeout_secs !== undefined) payload.response_timeout_secs = Math.max(1, Math.min(120, Number(input.response_timeout_secs) || 20));
    if (input.execution_mode !== undefined) {
      if (!new Set(["immediate", "async"]).has(input.execution_mode)) throw serviceError("cartesia_tool_input_invalid", "Invalid webhook execution mode", 400);
      payload.execution_mode = input.execution_mode;
    }
    if (!Object.keys(payload).length) throw serviceError("cartesia_tool_input_invalid", "Provide at least one webhook tool field to update", 400);
    const result = await this.client.updateTool(safeId(id, "tool"), payload);
    return { tool: { id: safeId(result?.id || id, "tool"), type: "webhook", name: safeText(result?.name, 64), description: safeText(result?.description, 240) } };
  }
  updateTool(id, input = {}) { return this.updateWebhookTool(id, input); }
  async deleteTool(id) { await this.client.deleteTool(safeId(id, "tool")); return { deleted: true }; }
  deleteWebhookTool(id) { return this.deleteTool(id); }
  async listAgents() {
    const result = await this.client.listAgents();
    return { agents: listFrom(result, "data", "agents").slice(0, 100).map((agent) => ({
      id: ID_PATTERN.test(String(agent?.id || "")) ? String(agent.id) : null,
      name: safeText(agent?.name, 120), status: safeText(agent?.status, 32) || null,
      webhookId: ID_PATTERN.test(String(agent?.webhook_id || "")) ? String(agent.webhook_id) : null,
      createdAt: safeText(agent?.created_at, 40) || null, updatedAt: safeText(agent?.updated_at, 40) || null,
      currentVersionId: ID_PATTERN.test(String(agent?.current_version_id || agent?.version_id || "")) ? String(agent.current_version_id || agent.version_id) : null,
    })).filter((agent) => agent.id) };
  }

  async getReadiness() {
    const client = this.client || {};
    const apiKeyPresent = Boolean(String(client.apiKey || "").trim());
    const adminCredentialPresent = Boolean(String(client.adminApiKey || client.apiKey || "").trim());
    const enabled = client.enabled === true;
    const apiConfigured = typeof client.isConfigured === "function" && client.isConfigured();
    const secretConfigured = String(client.webhookSecret || "").trim().length >= 32;
    let configuredCallbackUrl = null;
    try {
      configuredCallbackUrl = validateManagedWebhookUrl(client.webhookUrl);
    } catch { /* report configuration state without echoing the supplied URL */ }
    const callbackConfigured = Boolean(configuredCallbackUrl);

    const classifyFailure = (error) => {
      const status = Number(error?.status) || 0;
      if (status === 401 || status === 403) return "authentication_failed";
      if (status === 429) return "rate_limited";
      if (status >= 500 || !status) return "provider_unavailable";
      return "provider_error";
    };
    const probe = async (run) => {
      try { return { status: "ok", value: await run() }; }
      catch (error) { return { status: classifyFailure(error), value: null }; }
    };

    const [voiceProbe, agentProbe, webhookProbe] = await Promise.all([
      apiConfigured ? probe(async () => {
        if (typeof client.listVoices !== "function") throw serviceError("cartesia_readiness_voice_check_unavailable", "Voice inventory check unavailable", 503);
        const response = await client.listVoices({ limit: 1 });
        return listFrom(response, "voices", "data").length;
      }) : { status: "skipped", value: null },
      apiConfigured ? probe(async () => (await this.listAgents()).agents) : { status: "skipped", value: null },
      enabled && adminCredentialPresent ? probe(async () => (await this.listAgentWebhooks()).webhooks) : { status: "skipped", value: null },
    ]);
    const agents = agentProbe.status === "ok" ? agentProbe.value : [];
    const webhooks = webhookProbe.status === "ok" ? webhookProbe.value : [];
    const matchingWebhookIds = new Set(callbackConfigured
      ? webhooks.filter((webhook) => webhook.url === configuredCallbackUrl).map((webhook) => webhook.id)
      : []);
    const attachedAgentCount = agents.filter((agent) => agent.webhookId && matchingWebhookIds.has(agent.webhookId)).length;

    let recentReceipts = { status: "unavailable", count: 0, latestReceivedAt: null, eventTypes: {}, sampleLimit: null };
    if (typeof this.webhookEventStore?.summarizeCartesiaWebhookEvents === "function") {
      try {
        const summary = await this.webhookEventStore.summarizeCartesiaWebhookEvents();
        recentReceipts = {
          status: Number(summary?.count) > 0 ? "received" : "none_in_30_days",
          count: Math.max(0, Number(summary?.count) || 0),
          latestReceivedAt: safeText(summary?.latestReceivedAt, 40) || null,
          eventTypes: summary?.eventTypes && typeof summary.eventTypes === "object" ? summary.eventTypes : {},
        };
      } catch { /* local receipt status must not make the provider checks unavailable */ }
    } else if (typeof this.webhookEventStore?.listCartesiaWebhookEvents === "function") {
      try {
        const rows = await this.webhookEventStore.listCartesiaWebhookEvents({ limit: 25 });
        const eventTypes = {};
        for (const row of rows) {
          const type = safeText(row?.event_type, 40);
          if (type) eventTypes[type] = (eventTypes[type] || 0) + 1;
        }
        recentReceipts = {
          status: rows.length ? "sampled" : "none_in_30_days",
          count: rows.length,
          latestReceivedAt: safeText(rows[0]?.received_at, 40) || null,
          eventTypes,
          sampleLimit: 25,
        };
      } catch { /* optional local receipt diagnostics */ }
    }

    const webhookStatus = !enabled ? "disabled" : !secretConfigured || !callbackConfigured ? "configuration_incomplete" : webhookProbe.status !== "ok" ? webhookProbe.status : matchingWebhookIds.size === 0 ? "not_registered" : attachedAgentCount === 0 ? "not_attached" : "ready";
    const recommendations = [];
    if (!enabled) recommendations.push("Set CARTESIA_ENABLED=true to enable Cartesia features.");
    if (enabled && !apiKeyPresent) recommendations.push("Configure CARTESIA_API_KEY in the API environment.");
    if (apiConfigured && voiceProbe.status === "authentication_failed") recommendations.push("Check the Cartesia API key and account access.");
    if (apiConfigured && voiceProbe.status === "rate_limited") recommendations.push("Wait for Cartesia rate limits to clear, then rerun readiness.");
    if (apiConfigured && voiceProbe.status === "provider_unavailable") recommendations.push("Check Cartesia API reachability and the configured API endpoint, then retry.");
    if (voiceProbe.status === "empty") recommendations.push("Add or grant access to at least one Cartesia voice.");
    if (agentProbe.status === "empty") recommendations.push("Create or grant access to a Cartesia Managed Agent.");
    if (webhookStatus === "configuration_incomplete") recommendations.push("Configure a public HTTPS CARTESIA_WEBHOOK_URL and a CARTESIA_WEBHOOK_SECRET of at least 32 characters.");
    if (webhookStatus === "authentication_failed") recommendations.push("Check CARTESIA_ADMIN_API_KEY access to Cartesia webhook management.");
    if (webhookStatus === "rate_limited") recommendations.push("Wait for Cartesia rate limits to clear, then rerun readiness.");
    if (webhookStatus === "provider_unavailable") recommendations.push("Check Cartesia API reachability and retry the webhook inventory check.");
    if (webhookStatus === "not_registered") recommendations.push("Create a Cartesia lifecycle webhook using the configured VOICEDNUT callback.");
    if (webhookStatus === "not_attached") recommendations.push("Attach the registered lifecycle webhook to at least one Managed Agent.");
    if (recentReceipts.status === "none_in_30_days" && webhookStatus === "ready") recommendations.push("No event reached VOICEDNUT in 30 days; check agent activity and webhook attachment. This does not reveal Cartesia delivery attempts.");

    return {
      generatedAt: new Date().toISOString(),
      configuration: {
        enabled,
        apiKeyPresent,
        adminCredentialPresent,
        apiConfigured,
        apiVersion: safeText(client.apiVersion, 40) || null,
        endpointStatus: String(client.apiBaseUrl || "https://api.cartesia.ai").replace(/\/+$/, "") === "https://api.cartesia.ai" ? "default_endpoint" : "custom_endpoint",
      },
      credentials: {
        api: !enabled ? "disabled" : !apiKeyPresent ? "missing" : !apiConfigured ? "configuration_mismatch" : voiceProbe.status,
        webhookManagement: adminCredentialPresent && enabled ? webhookProbe.status : "missing_or_disabled",
      },
      voices: {
        status: voiceProbe.status === "ok" ? voiceProbe.value > 0 ? "available" : "empty" : voiceProbe.status,
        sampleCount: voiceProbe.status === "ok" ? voiceProbe.value : null,
      },
      agents: {
        status: agentProbe.status === "ok" ? agentProbe.value.length > 0 ? "available" : "empty" : agentProbe.status,
        count: agentProbe.status === "ok" ? agentProbe.value.length : null,
        attachedWebhookCount: attachedAgentCount,
      },
      webhook: {
        secretConfigured,
        callbackConfigured,
        registered: webhookProbe.status === "ok" ? matchingWebhookIds.size > 0 : null,
        attachedAgentCount: webhookProbe.status === "ok" ? attachedAgentCount : null,
        status: webhookStatus,
      },
      webhookReceipts: {
        ...recentReceipts,
        source: "VOICEDNUT received-event history; Cartesia delivery attempts are not exposed by the documented API",
      },
      remoteDeliveryHistoryAvailable: false,
      recommendations,
    };
  }
  async listAgentTemplates() {
    const result = await this.client.listAgentTemplates();
    return { templates: listFrom(result, "templates", "data").slice(0, 100).map((template) => {
      let repositoryUrl = null;
      try {
        const url = new URL(String(template?.repo_url || ""));
        if (url.protocol === "https:" && !url.username && !url.password && ["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) repositoryUrl = url.toString();
      } catch { /* omit malformed provider URLs */ }
      return {
        id: ID_PATTERN.test(String(template?.id || "")) ? String(template.id) : null,
        name: safeText(template?.name, 100),
        description: safeText(template?.description, 500) || null,
        repositoryUrl,
        rootDirectory: safeText(template?.root_dir, 160) || null,
        requiredEnvironmentVariables: listFrom(template, "required_env_vars").slice(0, 30).map((name) => safeText(name, 80)).filter(Boolean),
        dependencies: listFrom(template, "dependencies").slice(0, 30).map((name) => safeText(name, 120)).filter(Boolean),
      };
    }).filter((template) => template.id && template.name) };
  }
  async listDeployments(agentId) {
    const result = await this.client.listDeployments(safeId(agentId, "agent"));
    return { deployments: listFrom(result, "data", "deployments").slice(0, 100).map((row) => ({
      id: ID_PATTERN.test(String(row?.id || "")) ? String(row.id) : null,
      versionId: ID_PATTERN.test(String(row?.version_id || "")) ? String(row.version_id) : null,
      status: safeText(row?.status, 32) || null, isLive: row?.is_live === true, isPinned: row?.is_pinned === true,
      createdAt: safeText(row?.created_at, 40) || null, updatedAt: safeText(row?.updated_at, 40) || null,
      buildStartedAt: safeText(row?.build_started_at, 40) || null, buildCompletedAt: safeText(row?.build_completed_at, 40) || null,
      deploymentCompletedAt: safeText(row?.deployment_completed_at, 40) || null,
    })).filter((row) => row.id) };
  }
  async listAgentVersions(agentId) {
    const result = await this.client.listAgentVersions(safeId(agentId, "agent"));
    const rows = Array.isArray(result) ? result : Array.isArray(result?.versions) ? result.versions : Array.isArray(result?.data?.versions) ? result.data.versions : Array.isArray(result?.data) ? result.data : [];
    return { versions: rows.slice(0, 100).map((row) => ({
      id: ID_PATTERN.test(String(row?.id || "")) ? String(row.id) : null,
      description: safeText(row?.description, 240) || null,
      createdAt: safeText(row?.created_at || row?.createdAt, 40) || null,
      createdBy: safeText(row?.created_by || row?.createdBy, 80) || null,
    })).filter((row) => row.id) };
  }
  async getAgentVersion(agentId, versionId) {
    const safeAgentId = safeId(agentId, "agent");
    const safeVersionId = safeId(versionId, "version");
    const result = await this.client.getAgentVersion(safeAgentId, safeVersionId);
    const version = result?.version || result?.data?.version || result?.data || result;
    if (String(version?.id || "") !== safeVersionId || !version?.config || typeof version.config !== "object" || Array.isArray(version.config)) {
      throw serviceError("cartesia_agent_version_response_invalid", "Cartesia returned an invalid agent version", 502);
    }
    const config = version.config;
    const configSummary = summarizeManagedAgentConfig(config);
    const tools = Array.isArray(config.tools) ? config.tools : [];
    configSummary.toolCount = Math.min(tools.length, 100);
    configSummary.toolNames = tools.slice(0, 20).map((tool) => safeText(tool?.name || tool?.id || tool?.type, 64)).filter(Boolean);
    return { version: {
      id: safeVersionId,
      description: safeText(version.description, 240) || null,
      createdAt: safeText(version.created_at || version.createdAt, 40) || null,
      createdBy: safeText(version.created_by || version.createdBy, 80) || null,
      configSummary,
    } };
  }
  async getManagedAgentConfigSummary(agentId) {
    const safeAgentId = safeId(agentId, "agent");
    const result = await this.client.getManagedAgent(safeAgentId);
    const agent = result?.agent || result?.data?.agent || result?.data || result;
    if (String(agent?.id || "") !== safeAgentId || !agent?.config || typeof agent.config !== "object" || Array.isArray(agent.config)) {
      throw serviceError("cartesia_managed_agent_response_invalid", "Cartesia returned an invalid managed agent", 502);
    }
    const versionId = agent.version?.id || agent.current_version_id || agent.version_id;
    if (!ID_PATTERN.test(String(versionId || ""))) throw serviceError("cartesia_managed_agent_version_invalid", "Cartesia did not return the current agent version", 502);
    const summary = summarizeManagedAgentConfig(agent.config);
    const tools = Array.isArray(agent.config.tools) ? agent.config.tools : [];
    summary.toolCount = Math.min(tools.length, 100);
    summary.toolNames = tools.slice(0, 20).map((tool) => safeText(tool?.name || tool?.id || tool?.type, 64)).filter(Boolean);
    return { currentVersionId: String(versionId), configSummary: summary };
  }
  async restoreAgentVersion(agentId, versionId, evaluation = {}) {
    const safeAgentId = safeId(agentId, "agent");
    const safeVersionId = safeId(versionId, "version");
    const result = await this.client.getAgentVersion(safeAgentId, safeVersionId);
    const version = result?.version || result?.data?.version || result?.data || result;
    if (String(version?.id || "") !== safeVersionId || !version?.config || typeof version.config !== "object" || Array.isArray(version.config)) {
      throw serviceError("cartesia_agent_version_response_invalid", "Cartesia returned an invalid agent version", 502);
    }
    let serialized;
    try { serialized = JSON.stringify(version.config); } catch {
      throw serviceError("cartesia_agent_version_config_invalid", "Cartesia returned an invalid agent configuration", 502);
    }
    if (!serialized || Buffer.byteLength(serialized) > 128 * 1024) {
      throw serviceError("cartesia_agent_version_config_invalid", "Cartesia agent configuration exceeds the safe restore limit", 502);
    }
    const gate = await this.evaluateAgentVersionGate(safeAgentId, safeVersionId, evaluation);
    if (!gate.passed) throw serviceError("cartesia_agent_restore_evaluation_blocked", "Cartesia agent version did not pass the required evaluation gate", 409);
    const updated = await this.client.restoreAgentVersion(safeAgentId, version.config, `Restored from ${safeVersionId}`);
    const agent = updated?.agent || updated?.data?.agent || updated?.data || updated;
    const currentVersionId = agent?.current_version_id || agent?.version_id || agent?.id && agent?.id !== safeAgentId && agent?.id;
    return { restoredFromVersionId: safeVersionId, agentId: safeAgentId, currentVersionId: ID_PATTERN.test(String(currentVersionId || "")) ? String(currentVersionId) : null, evaluation: gate };
  }
  async getAgentLanguageReadiness(agentId) {
    const safeAgentId = safeId(agentId, "agent");
    const response = await this.client.getManagedAgent(safeAgentId);
    const agent = response?.agent || response?.data?.agent || response?.data || response;
    if (String(agent?.id || "") !== safeAgentId || !agent?.config || typeof agent.config !== "object" || Array.isArray(agent.config)) {
      throw serviceError("cartesia_managed_agent_response_invalid", "Cartesia returned an invalid managed agent", 502);
    }
    const config = agent.config;
    const language = config.language && typeof config.language === "object" ? config.language : {};
    const requested = [language.primary, ...(Array.isArray(language.additional) ? language.additional.map((item) => typeof item === "string" ? item : item?.code) : [])]
      .map((value) => safeText(value, 24)).filter(Boolean).slice(0, 20);
    const voiceId = safeText(config.audio?.output?.voice_id, 200);
    let voice = null;
    if (voiceId && typeof this.client?.getVoice === "function") {
      try { voice = await this.client.getVoice(voiceId); } catch { /* Missing metadata is reported as unknown, not unsupported. */ }
    }
    const accents = Array.isArray(voice?.accents) ? voice.accents : [];
    const nativeAccents = accents.filter((accent) => accent?.is_native === true || accent?.isNative === true);
    const languages = requested.map((code) => {
      const normalized = code.toLowerCase();
      const native = accents.some((accent) => {
        const locale = String(accent?.locale || "").toLowerCase();
        return locale === normalized || (normalized.length === 2 && locale.startsWith(`${normalized}-`));
      });
      return { code, voiceAccent: !accents.length ? "metadata_unavailable" : native ? "native_accent_listed" : "original_accent_fallback" };
    });
    return {
      agentId: safeAgentId, voiceId: ID_PATTERN.test(voiceId) ? voiceId : null, languages,
      originalAccent: safeText(nativeAccents[0]?.locale, 24) || null,
      notes: [
        "A locale missing from the voice accent list uses the voice's original accent; it does not by itself mean the language is unsupported.",
        "This check reports voice-accent metadata only. It does not certify Managed Agent language or speech-recognition support.",
      ],
    };
  }
  async updateAgent(id, input = {}) {
    const agentId = safeId(id, "agent");
    const patch = {};
    for (const key of ["name", "description", "tts_language"]) {
      const value = input[key] ?? input[key.replace(/_([a-z])/g, (_, character) => character.toUpperCase())];
      if (value === undefined) continue;
      const maxLength = key === "description" ? 2000 : key === "name" ? 120 : 35;
      const clean = safeText(value, maxLength);
      if (!clean || /[\u0000-\u001F]/.test(clean)) throw serviceError("cartesia_agent_update_invalid", `A valid ${key} value is required`, 400);
      patch[key] = clean;
    }
    const voice = input.tts_voice ?? input.ttsVoice;
    if (voice !== undefined) patch.tts_voice = safeId(voice, "voice");
    const webhook = input.webhook_id ?? input.webhookId;
    if (webhook !== undefined) patch.webhook_id = webhook === null || webhook === "" ? null : safeId(webhook, "webhook");
    const noiseLevel = input.noise_suppression_level ?? input.noiseSuppressionLevel;
    if (noiseLevel !== undefined) {
      const value = Number(noiseLevel);
      if (!Number.isInteger(value) || value < 0 || value > 100) throw serviceError("cartesia_agent_update_invalid", "Noise suppression level must be an integer from 0 to 100", 400);
      patch.noise_suppression_level = value;
    }
    if (input.config !== undefined) patch.config = validateManagedAgentConfigPatch(input.config);
    if (input.version_description !== undefined || input.versionDescription !== undefined) {
      const description = safeText(input.version_description ?? input.versionDescription, 240);
      if (!description || /[\u0000-\u001F]/.test(description)) throw serviceError("cartesia_agent_update_invalid", "A valid version_description is required", 400);
      patch.version_description = description;
    }
    if (!Object.keys(patch).length) throw serviceError("cartesia_agent_update_invalid", "Provide at least one supported agent setting", 400);
    const result = await this.client.updateAgent(agentId, patch);
    return { agent: {
      id: safeId(result?.id || agentId, "agent"), name: safeText(result?.name, 120) || patch.name || null,
      currentVersionId: ID_PATTERN.test(String(result?.current_version_id || result?.version_id || "")) ? String(result.current_version_id || result.version_id) : null,
      updatedAt: safeText(result?.updated_at, 40) || null,
    } };
  }
  async listAgentProfiles(actorId) {
    if (!this.agentProfileStore?.list) throw serviceError("cartesia_agent_profile_unavailable", "Reusable Cartesia agent profile storage is unavailable", 503);
    const owner = String(actorId || "").trim();
    if (!/^\d{1,20}$/.test(owner)) throw serviceError("cartesia_agent_profile_actor_invalid", "A verified administrator is required to access agent profiles", 403);
    const profiles = (await this.agentProfileStore.list()).filter((profile) => String(profile.updatedBy || "") === owner);
    return { profiles: profiles.slice(0, 50).map((profile) => ({
      id: safeId(profile.id, "agent_profile"), name: safeText(profile.name, 80),
      configSummary: summarizeManagedAgentConfig(profile.config),
      updatedAt: safeText(profile.updatedAt, 40) || null,
    })) };
  }
  async saveAgentProfile(input = {}, actorId) {
    if (!this.agentProfileStore?.set) throw serviceError("cartesia_agent_profile_unavailable", "Reusable Cartesia agent profile storage is unavailable", 503);
    const owner = String(actorId || "").trim();
    if (!/^\d{1,20}$/.test(owner)) throw serviceError("cartesia_agent_profile_actor_invalid", "A verified administrator is required to access agent profiles", 403);
    const name = safeText(input.name, 80);
    if (!NAME_PATTERN.test(name)) throw serviceError("cartesia_agent_profile_invalid", "Profile name must use letters, numbers, spaces, dots, dashes, or underscores", 400);
    const config = validateManagedAgentConfigPatch(input.config);
    if (!config.audio) throw serviceError("cartesia_agent_profile_invalid", "A reusable voice profile must include audio settings", 400);
    const profile = {
      id: crypto.randomUUID(), name, config,
      updatedAt: new Date().toISOString(), updatedBy: owner,
    };
    const stored = await this.agentProfileStore.set(profile);
    return { profile: { id: safeId(stored.id, "agent_profile"), name: safeText(stored.name, 80), configSummary: summarizeManagedAgentConfig(stored.config), updatedAt: safeText(stored.updatedAt, 40) || null } };
  }
  async deleteAgentProfile(id, actorId) {
    if (!this.agentProfileStore?.delete) throw serviceError("cartesia_agent_profile_unavailable", "Reusable Cartesia agent profile storage is unavailable", 503);
    const profileId = safeId(id, "agent_profile");
    const owner = String(actorId || "").trim();
    if (!/^\d{1,20}$/.test(owner)) throw serviceError("cartesia_agent_profile_actor_invalid", "A verified administrator is required to access agent profiles", 403);
    const profile = await this.agentProfileStore.get?.(profileId);
    if (!profile || String(profile.updatedBy || "") !== owner) throw serviceError("cartesia_agent_profile_not_found", "Reusable Cartesia agent profile was not found", 404);
    if (!await this.agentProfileStore.delete(profileId)) throw serviceError("cartesia_agent_profile_not_found", "Reusable Cartesia agent profile was not found", 404);
    return { deleted: true, profileId };
  }
  async applyAgentProfile(agentId, profileId, actorId) {
    if (!this.agentProfileStore?.get) throw serviceError("cartesia_agent_profile_unavailable", "Reusable Cartesia agent profile storage is unavailable", 503);
    const profile = await this.agentProfileStore.get(safeId(profileId, "agent_profile"));
    const owner = String(actorId || "").trim();
    if (!/^\d{1,20}$/.test(owner)) throw serviceError("cartesia_agent_profile_actor_invalid", "A verified administrator is required to access agent profiles", 403);
    if (!profile || String(profile.updatedBy || "") !== owner) throw serviceError("cartesia_agent_profile_not_found", "Reusable Cartesia agent profile was not found", 404);
    const result = await this.updateAgent(agentId, { config: profile.config, version_description: `Applied profile ${safeText(profile.name, 80)}` });
    return { ...result, profile: { id: profile.id, name: safeText(profile.name, 80) } };
  }
  async listPhoneNumbers() {
    const result = await this.client.listPhoneNumbers();
    return { phoneNumbers: listFrom(result, "data", "phone_numbers", "phoneNumbers").slice(0, 100).map((row) => {
      const rawNumber = String(row?.number || "");
      return {
        id: ID_PATTERN.test(String(row?.id || "")) ? String(row.id) : null,
        number: rawNumber ? `••••${rawNumber.slice(-4)}` : null,
        label: safeText(row?.label, 80) || null,
        agentId: ID_PATTERN.test(String(row?.agent?.id || row?.agent_id || "")) ? String(row?.agent?.id || row.agent_id) : null,
        agentName: safeText(row?.agent?.name, 100) || null,
        providerType: safeText(row?.provider?.type, 32) || null,
        createdAt: safeText(row?.created_at, 40) || null,
      };
    }).filter((row) => row.id) };
  }
  async importPhoneNumber(input = {}) {
    const number = safeText(input.number, 24);
    const providerId = safeId(input.providerId || input.provider_id || input.provider?.id, "provider");
    const label = safeText(input.label, 80);
    const agentId = input.agentId || input.agent_id ? safeId(input.agentId || input.agent_id, "agent") : undefined;
    if (!/^\+[1-9]\d{7,14}$/.test(number) || !NAME_PATTERN.test(label)) {
      throw serviceError("cartesia_phone_number_import_invalid", "A valid E.164 number and label are required", 400);
    }
    const result = await this.client.importPhoneNumber({ number, label, provider: { id: providerId }, ...(agentId ? { agent_id: agentId } : {}) });
    return { phoneNumber: {
      id: safeId(result?.id, "phone_number"),
      number: result?.number ? `••••${String(result.number).slice(-4)}` : `••••${number.slice(-4)}`,
      label: safeText(result?.label, 80, label) || label,
      agentId: ID_PATTERN.test(String(result?.agent?.id || result?.agent_id || agentId || "")) ? String(result?.agent?.id || result?.agent_id || agentId) : null,
    } };
  }
  async provisionPhoneNumber(input = {}) {
    const label = safeText(input.label, 80);
    const agentId = input.agentId || input.agent_id ? safeId(input.agentId || input.agent_id, "agent") : undefined;
    if (!NAME_PATTERN.test(label)) throw serviceError("cartesia_phone_number_label_invalid", "A valid phone-number label is required", 400);
    const result = await this.client.provisionPhoneNumber({ label, ...(agentId ? { agent_id: agentId } : {}) });
    return { phoneNumber: {
      id: safeId(result?.id, "phone_number"),
      number: result?.number ? `••••${String(result.number).slice(-4)}` : null,
      label: safeText(result?.label, 80, label) || label,
      agentId: ID_PATTERN.test(String(result?.agent?.id || result?.agent_id || agentId || "")) ? String(result?.agent?.id || result?.agent_id || agentId) : null,
    } };
  }
  async updatePhoneNumber(id, input = {}) {
    const phoneNumberId = safeId(id, "phone_number");
    const patch = {};
    if (input.label !== undefined) {
      patch.label = safeText(input.label, 80);
      if (!patch.label) throw serviceError("cartesia_phone_number_label_invalid", "A non-empty phone-number label is required", 400);
    }
    if (input.agentId !== undefined || input.agent_id !== undefined) {
      const value = input.agentId ?? input.agent_id;
      patch.agent_id = value === null || value === "" ? null : safeId(value, "agent");
    }
    if (!Object.keys(patch).length) throw serviceError("cartesia_phone_number_update_invalid", "Provide a label or agent assignment to update", 400);
    const result = await this.client.updatePhoneNumber(phoneNumberId, patch);
    return { phoneNumber: {
      id: safeId(result?.id || phoneNumberId, "phone_number"),
      number: result?.number ? `••••${String(result.number).slice(-4)}` : null,
      label: safeText(result?.label, 80) || null,
      agentId: ID_PATTERN.test(String(result?.agent?.id || result?.agent_id || "")) ? String(result?.agent?.id || result.agent_id) : null,
    } };
  }
  assignPhoneNumber(id, agentId) { return this.updatePhoneNumber(id, { agentId }); }
  async getCreditUsage(query = {}) {
    const result = await this.client.getCreditUsage(query);
    return { usage: listFrom(result, "data", "usage").slice(0, 366).map((row) => ({
      startAt: safeText(row?.start_ts, 40) || null, endAt: safeText(row?.end_ts, 40) || null,
      credits: Number.isFinite(Number(row?.credits)) ? Number(row.credits) : null,
    })).filter((row) => row.credits !== null) };
  }
  async getAgentUsage(query = {}) {
    const result = await this.client.getAgentUsage(query);
    return { usage: listFrom(result, "data", "usage").slice(0, 500).map((row) => ({
      agentId: ID_PATTERN.test(String(row?.agent_id || row?.agent?.id || "")) ? String(row.agent_id || row.agent.id) : null,
      agentName: safeText(row?.agent_name || row?.agent?.name, 120) || null,
      startAt: safeText(row?.start_ts, 40) || null, endAt: safeText(row?.end_ts, 40) || null,
      cents: Number.isFinite(Number(row?.cents)) ? Number(row.cents) : null,
      minutes: Number.isFinite(Number(row?.minutes)) ? Number(row.minutes) : null,
      calls: Number.isFinite(Number(row?.calls)) ? Number(row.calls) : null,
    })).filter((row) => row.cents !== null || row.minutes !== null || row.calls !== null) };
  }
  getEnterpriseDataReadiness() {
    const defaultEndpoint = String(this.client?.apiBaseUrl || "https://api.cartesia.ai").replace(/\/+$/, "") === "https://api.cartesia.ai";
    let configuredHostname = null;
    try { configuredHostname = new URL(String(this.client?.apiBaseUrl || "https://api.cartesia.ai")).hostname; } catch { /* malformed endpoints are rejected at client construction */ }
    let websocketHostname = null;
    try { websocketHostname = new URL(String(this.client?.websocketBaseUrl || "wss://api.cartesia.ai")).hostname; } catch { /* no provider hostname is returned */ }
    return {
      providerConfigured: typeof this.client?.isConfigured === "function" && this.client.isConfigured(),
      apiVersion: safeText(this.client?.apiVersion, 40) || null,
      endpointStatus: defaultEndpoint ? "default_endpoint" : "custom_endpoint_unverified",
      zeroDataRetention: {
        status: "manual_account_verification_required",
        remotelyVerifiable: false,
        enterpriseOnly: true,
        coveredWorkflows: ["tts", "stt"],
        excludedWorkflows: ["instant_voice_clone", "pro_voice_clone", "voice_creation"],
      },
      regionalEndpoint: {
        status: defaultEndpoint ? "requires_cartesia_provisioning" : "custom_endpoint_unverified",
        configuredHostname,
        websocketHostMatches: configuredHostname !== null && configuredHostname === websocketHostname,
      },
    };
  }
  validateSttSettings(input = {}) { return { keyterms: validateSttKeyterms(input.keyterms || []), turnSettings: normalizeSttTurnSettings(input.turnSettings || input.turn_settings || input.turnDetection || {}) }; }
  validateSttProfile(input = {}) { return this.validateSttSettings(input); }
  normalizeSttSettings(input = {}) { return this.validateSttSettings(input); }
  async getSttProfile() {
    if (!this.sttProfileStore?.get) throw serviceError("cartesia_stt_profile_unavailable", "Cartesia STT profile storage is unavailable", 503);
    const stored = await this.sttProfileStore.get();
    return { profile: stored?.profile || null, updatedAt: stored?.updatedAt || null };
  }
  async saveSttProfile(input = {}, actorId) {
    if (!this.sttProfileStore?.set) throw serviceError("cartesia_stt_profile_unavailable", "Cartesia STT profile storage is unavailable", 503);
    const profile = this.validateSttProfile(input);
    const stored = await this.sttProfileStore.set(profile, actorId);
    return { profile: stored.profile, updatedAt: stored.updatedAt };
  }
  async getCachedPhrase(key) {
    const cacheKey = key && typeof key === "object" ? this.getPhraseCacheKey(key) : String(key || "");
    if (!/^[a-f0-9]{64}$/.test(cacheKey)) throw serviceError("cartesia_phrase_cache_key_invalid", "A valid phrase cache key is required", 400);
    if (!this.cacheStore?.get) throw serviceError("cartesia_phrase_cache_unavailable", "Cartesia phrase cache is not configured", 503);
    const result = await this.cacheStore.get(cacheKey);
    return result ? {
      cacheKey,
      audioBase64: Buffer.from(result.audio || result).toString("base64"),
      byteLength: Buffer.from(result.audio || result).length,
      contentType: safeText(result.contentType, 80, "audio/wav"),
    } : null;
  }
  async cachePhrase(input = {}, audio, contentType = "audio/wav") {
    if (!this.cacheStore?.set) throw serviceError("cartesia_phrase_cache_unavailable", "Cartesia phrase cache is not configured", 503);
    const normalized = validateTtsPreview(input);
    const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || "", "base64");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw serviceError("cartesia_phrase_audio_invalid", "Cached phrase audio must be between 1 byte and 8 MB", 400);
    const cacheKey = phraseCacheKey({ ...normalized, voiceId: normalized.voice, modelId: normalized.model_id, outputFormat: normalized.output_format, generationConfig: normalized.generation_config });
    await this.cacheStore.set(cacheKey, { audio: bytes, contentType: safeText(contentType, 80, "audio/wav") });
    return { cacheKey, byteLength: bytes.length };
  }
  getPhraseCacheKey(input = {}) {
    const normalized = validateTtsPreview(input);
    return phraseCacheKey({ ...normalized, voiceId: normalized.voice, modelId: normalized.model_id, outputFormat: normalized.output_format, generationConfig: normalized.generation_config });
  }
  async createPhraseCache(input = {}) {
    const normalized = validateTtsPreview(input);
    await this.assertLocaleSupported(normalized);
    const result = await this.client.generateSpeech(normalized);
    const cached = await this.cachePhrase({ ...normalized, voiceId: normalized.voice, modelId: normalized.model_id }, result?.bytes, result?.contentType);
    return { ...cached, contentType: safeText(result?.contentType, 80, "audio/wav") };
  }
  async getOrCreatePhraseCache(input = {}) {
    const existing = await this.getCachedPhrase(input);
    if (existing) return { ...existing, cached: true };
    return { ...(await this.createPhraseCache(input)), cached: false };
  }
}

module.exports = {
  CartesiaStudioService,
  validatePronunciationItems,
  validateSttKeyterms,
  validateCartesiaSpeechMarkup,
  normalizeSttTurnSettings,
  validateTtsPreview,
  sanitizeLogSummary,
  validateWebhookTool,
  validateClientTool,
  normalizeMetricResult,
  phraseCacheKey,
};
