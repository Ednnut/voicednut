'use strict';

const { InlineKeyboard, InputFile } = require('grammy');
const crypto = require('node:crypto');
const fetch = require('node-fetch');
const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { buildCallbackData } = require('../utils/actions');
const { escapeHtml, renderMenu } = require('../utils/ui');
const { startOperation, ensureOperationActive } = require('../utils/sessionState');

const ACTIONS = new Set([
  'CARTESIA_STUDIO_VOICES', 'CARTESIA_STUDIO_CLONE', 'CARTESIA_STUDIO_PVC',
  'CARTESIA_STUDIO_PREVIEW', 'CARTESIA_STUDIO_DICTIONARIES', 'CARTESIA_STUDIO_DICT_CREATE',
  'CARTESIA_STUDIO_QUALITY', 'CARTESIA_STUDIO_LOGS', 'CARTESIA_STUDIO_TOOLS',
  'CARTESIA_STUDIO_TOOL_CREATE', 'CARTESIA_STUDIO_STT', 'CARTESIA_STUDIO_PHRASE_CACHE',
  'CARTESIA_STUDIO_VOICE_MANAGE', 'CARTESIA_STUDIO_STREAMS', 'CARTESIA_STUDIO_INFILL',
  'CARTESIA_STUDIO_AGENTS', 'CARTESIA_STUDIO_USAGE', 'CARTESIA_STUDIO_CONTINUATIONS',
  'CARTESIA_STUDIO_KNOWLEDGE_BASE', 'CARTESIA_STUDIO_SIP_PROVIDERS', 'CARTESIA_STUDIO_ENTERPRISE_PRIVACY',
  'CARTESIA_STUDIO_WEBHOOKS',
  'CARTESIA_STUDIO_READINESS',
]);
const CANCEL_WORDS = new Set(['cancel', 'exit', 'quit']);
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;

function apiRoot() { return String(config.apiUrl || '').replace(/\/+$/, ''); }
function rootPath(...parts) { return `${apiRoot()}/api/cartesia/studio/${parts.map((part) => String(part).replace(/^\/+|\/+$/g, '')).join('/')}`; }
function actorUrl(ctx, rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set('actor_id', String(ctx.from?.id || ''));
  return url.toString();
}

function buildCartesiaStudioKeyboard(ctx) {
  return new InlineKeyboard()
    .text('🎙 Voices & clone', buildCallbackData(ctx, 'CARTESIA_STUDIO_VOICES')).row()
    .text('🔊 Preview and tune speech', buildCallbackData(ctx, 'CARTESIA_STUDIO_PREVIEW')).row()
    .text('🌐 Pronunciations and accents', buildCallbackData(ctx, 'CARTESIA_STUDIO_DICTIONARIES')).row()
    .text('📊 Agent quality scorecard', buildCallbackData(ctx, 'CARTESIA_STUDIO_QUALITY')).row()
    .text('🧾 Call runtime diagnostics', buildCallbackData(ctx, 'CARTESIA_STUDIO_LOGS')).row()
    .text('🩺 Cartesia setup readiness', buildCallbackData(ctx, 'CARTESIA_STUDIO_READINESS')).row()
    .text('🪝 Agent tools', buildCallbackData(ctx, 'CARTESIA_STUDIO_TOOLS')).row()
    .text('📡 Call lifecycle webhooks', buildCallbackData(ctx, 'CARTESIA_STUDIO_WEBHOOKS')).row()
    .text('🎧 STT keyterms and turn settings', buildCallbackData(ctx, 'CARTESIA_STUDIO_STT')).row()
    .text('⚡ Cache a standard phrase', buildCallbackData(ctx, 'CARTESIA_STUDIO_PHRASE_CACHE')).row()
    .text('🌍 Localize and manage voices', buildCallbackData(ctx, 'CARTESIA_STUDIO_VOICE_MANAGE')).row()
    .text('🌊 Streaming TTS and Ink STT', buildCallbackData(ctx, 'CARTESIA_STUDIO_STREAMS')).row()
    .text('🧵 Seamless TTS continuations', buildCallbackData(ctx, 'CARTESIA_STUDIO_CONTINUATIONS')).row()
    .text('📚 Agent Knowledge Base', buildCallbackData(ctx, 'CARTESIA_STUDIO_KNOWLEDGE_BASE')).row()
    .text('☎️ SIP trunk providers', buildCallbackData(ctx, 'CARTESIA_STUDIO_SIP_PROVIDERS')).row()
    .text('🛡 Enterprise privacy & regions', buildCallbackData(ctx, 'CARTESIA_STUDIO_ENTERPRISE_PRIVACY')).row()
    .text('✂ Repair speech with infill', buildCallbackData(ctx, 'CARTESIA_STUDIO_INFILL')).row()
    .text('📞 Agents and phone numbers', buildCallbackData(ctx, 'CARTESIA_STUDIO_AGENTS')).row()
    .text('💳 Cartesia usage', buildCallbackData(ctx, 'CARTESIA_STUDIO_USAGE')).row()
    .url('🎚 Cartesia voice conversion', 'https://www.cartesia.ai/product/voice-conversion').row()
    .text('⬅️ Cartesia Operations', buildCallbackData(ctx, 'CARTESIA_CENTER'));
}

async function renderCartesiaStudio(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) { await ctx.reply('Cartesia Studio is available to administrators only.'); return; }
  await renderMenu(ctx,
    '<b>Cartesia Studio</b>\nManage voices, speech, agents, and usage with the Cartesia API. Provider writes and paid generation require exact confirmation. Voice samples must be authorized by their speaker. Cartesia voice conversion opens on Cartesia’s site because no public conversion API is documented.',
    buildCartesiaStudioKeyboard(ctx), { parseMode: 'HTML' });
}

async function askInput(conversation, ctx, prompt, ensureActive) {
  await ctx.reply(`${prompt}\nType cancel to stop.`);
  const update = await conversation.wait();
  ensureActive();
  const value = String(update?.message?.text || '').trim();
  return CANCEL_WORDS.has(value.toLowerCase()) ? null : value;
}

function readOnlyConfirmation(action, nameOrId) {
  const normalized = String(nameOrId || '').toUpperCase();
  if (action === 'CARTESIA_STUDIO_CLONE') return `I CONFIRM SPEAKER CONSENT AND CREATE CARTESIA CLONE ${normalized}`;
  if (action === 'CARTESIA_STUDIO_PVC') return `CREATE CARTESIA PRO CLONE DATASET ${normalized}`;
  if (action === 'CARTESIA_STUDIO_PREVIEW') return 'GENERATE CARTESIA TTS PREVIEW';
  if (action === 'CARTESIA_STUDIO_DICT_CREATE') return `CREATE CARTESIA PRONUNCIATION DICTIONARY ${normalized}`;
  if (action === 'CARTESIA_STUDIO_TOOL_CREATE') return `CREATE CARTESIA WEBHOOK TOOL ${normalized}`;
  if (action === 'CARTESIA_STUDIO_CLIENT_TOOL_CREATE') return `CREATE CARTESIA CLIENT TOOL ${normalized}`;
  if (action === 'CARTESIA_STUDIO_PHRASE_CACHE') return 'CACHE CARTESIA STOCK PHRASE';
  return '';
}

function safeConfigChanges(before = {}, after = {}) {
  const definitions = [
    ['Model', 'model'], ['Primary language', 'language'], ['Voice ID', 'voiceId'],
    ['Voice speed', 'voiceSpeed'], ['Voice volume', 'voiceVolume'], ['Voice emotion', 'voiceEmotion'],
    ['Pronunciation dictionary', 'pronunciationDictionaryId'], ['Background sound configured', 'backgroundSoundConfigured'],
    ['Recognized keyterms', 'keytermCount'],
    ['Noise suppression', 'noiseSuppression'], ['Time zone', 'timezone'],
    ['Call inactivity limit', 'inactivityEndCallSecs'], ['Check-in interval', 'inactivityCheckInSecs'],
    ['Additional languages', 'additionalLanguages'], ['Tool set', 'toolIds'], ['Built-in tools', 'systemTools'],
    ['Speculative generation', 'speculativeGeneration'], ['Prompt optimization', 'promptOptimization'],
    ['Instructions', 'hasInstructions'], ['First message', 'hasFirstMessage'],
  ];
  const display = (key, value) => {
    if (key === 'toolIds' || key === 'systemTools') return `${Array.isArray(value) ? value.length : 0} configured`;
    if (key === 'additionalLanguages') return Array.isArray(value) && value.length ? value.join(', ') : 'none';
    if (key === 'hasInstructions' || key === 'hasFirstMessage') return value ? 'present (content hidden)' : 'not set';
    return value === null || value === undefined || value === '' ? 'not set' : String(value);
  };
  return definitions.filter(([, key]) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))
    .map(([label, key]) => `${label}: ${escapeHtml(display(key, before[key]))} → ${escapeHtml(display(key, after[key]))}`);
}

function summarizeAgentUpdate(settings = {}) {
  const safe = JSON.parse(JSON.stringify(settings));
  const input = safe?.config?.audio?.input;
  if (Array.isArray(input?.keyterms)) input.keyterms = `[${input.keyterms.length} keyterms]`;
  const transfers = safe?.config?.system_tools?.transfer_to_number?.transfers;
  if (Array.isArray(transfers)) for (const transfer of transfers) {
    const destination = transfer?.destination;
    if (destination?.type === 'phone' && typeof destination.phone_number === 'string') destination.phone_number = `••••${destination.phone_number.slice(-4)}`;
  }
  return JSON.stringify(safe);
}

function applyTtsMarkup(transcript, mode, value, target = '') {
  const text = String(transcript || '').trim();
  if (mode === 'none') return text;
  if (mode === 'pause') {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0.05 || seconds > 5) throw new Error('Pause must be between 0.05 and 5 seconds.');
    return `${text}<break time="${seconds}s"/>`;
  }
  const token = String(target || '').trim();
  if (!token || token.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9 '-]*$/.test(token) || text.split(token).length !== 2) {
    throw new Error('Choose one exact, single-occurrence word or phrase from the transcript.');
  }
  if (mode === 'spell') return text.replace(token, `<spell>${token}</spell>`);
  if (mode === 'ipa') {
    const ipa = String(value || '').trim();
    if (!ipa.includes('|') || ipa.length > 120 || /[<>\u0000-\u001F]/.test(ipa)) throw new Error('Provide pipe-separated IPA phonemes without angle brackets.');
    return text.replace(token, `<<${ipa}>>`);
  }
  throw new Error('Choose none, pause, spell, or ipa.');
}

async function confirm(conversation, ctx, phrase, ensureActive, summary) {
  const response = await askInput(conversation, ctx, `${summary}\nThis contacts Cartesia and may incur usage or create a provider resource. Type this exact phrase to continue: ${phrase}`, ensureActive);
  return response === phrase;
}

async function showVoices(conversation, ctx, ensureActive) {
  const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('voices')), { timeout: 20000 });
  ensureActive();
  const voices = Array.isArray(response?.data?.voices) ? response.data.voices.slice(0, 30) : [];
  if (!voices.length) { await ctx.reply('No Cartesia voices were returned.'); return; }
  const text = voices.map((voice, index) => `${index + 1}. ${escapeHtml(voice.name)} — <code>${escapeHtml(voice.id)}</code> · ${escapeHtml(voice.language || 'language unknown')}${voice.isPro ? ' · Pro clone' : ''}`).join('\n');
  await ctx.reply(`<b>Cartesia voices</b>\n${text}`, { parse_mode: 'HTML' });
  const choice = await askInput(conversation, ctx, 'Enter a voice number to inspect its supported accents/locales, or type done.', ensureActive);
  if (!choice || choice.toLowerCase() === 'done') return;
  const voice = voices[Number(choice) - 1];
  if (!voice) { await ctx.reply('Voice inspection ended. Choose a listed number next time.'); return; }
  const details = await httpClient.get(ctx, actorUrl(ctx, rootPath('voices', encodeURIComponent(voice.id))), { timeout: 15000 });
  ensureActive();
  const accents = Array.isArray(details?.data?.voice?.accents) ? details.data.voice.accents.slice(0, 30) : [];
  await ctx.reply(`Voice: <b>${escapeHtml(voice.name)}</b>\nID: <code>${escapeHtml(voice.id)}</code>\nNative/locales: ${accents.length ? accents.map((entry) => `${escapeHtml(entry.locale || 'unknown')}${entry.isNative ? ' (native)' : ''}`).join(', ') : 'No accent metadata returned.'}\nUse a listed locale for native-sounding output.`, { parse_mode: 'HTML' });
}

async function fetchTelegramAudio(ctx, file) {
  const token = String(config.botToken || '');
  if (!token || !file?.file_path) throw new Error('Telegram sample could not be retrieved.');
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { timeout: 20000, size: 16 * 1024 * 1024 });
  if (!response.ok) throw new Error('Telegram sample download failed.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error('Voice sample must be smaller than 16 MB.');
  return bytes;
}

async function runInstantClone(conversation, ctx, ensureActive) {
  const name = await askInput(conversation, ctx, 'Enter a short voice name.', ensureActive);
  if (name === null) return;
  if (!NAME_PATTERN.test(name)) { await ctx.reply('Voice clone canceled. The name contains unsupported characters.'); return; }
  const language = await askInput(conversation, ctx, 'Enter the recording language code, such as en or es.', ensureActive);
  if (language === null) return;
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) { await ctx.reply('Voice clone canceled. Use a language code such as en or en-US.'); return; }
  if (!await confirm(conversation, ctx, readOnlyConfirmation('CARTESIA_STUDIO_CLONE', name), ensureActive,
    'Only upload a clean sample from a speaker who explicitly authorized cloning. Cartesia recommends 10–60 seconds; the upload limit is 16 MB.')) {
    await ctx.reply('Voice clone canceled. No sample was uploaded.'); return;
  }
  await ctx.reply('Send one audio or voice file as the next message. Type cancel to stop.');
  const update = await conversation.wait();
  ensureActive();
  if (String(update?.message?.text || '').toLowerCase() === 'cancel') { await ctx.reply('Voice clone canceled.'); return; }
  const telegramFile = update?.message?.voice || update?.message?.audio || update?.message?.document;
  if (!telegramFile?.file_id || Number(telegramFile.file_size) > 16 * 1024 * 1024) { await ctx.reply('Send one audio file no larger than 16 MB. No provider request was made.'); return; }
  try {
    const file = await ctx.api.getFile(telegramFile.file_id);
    const bytes = await fetchTelegramAudio(ctx, file);
    const query = new URLSearchParams({
      actor_id: String(ctx.from.id), name, language, confirmation_phrase: readOnlyConfirmation('CARTESIA_STUDIO_CLONE', name),
      content_type: String(telegramFile.mime_type || (update.message.voice ? 'audio/ogg' : 'audio/wav')),
    });
    const response = await httpClient.post(ctx, `${rootPath('voices/clone')}?${query}`, bytes, {
      timeout: 45000, headers: { 'Content-Type': 'application/octet-stream' },
    });
    ensureActive();
    const voice = response?.data?.voice;
    await ctx.reply(`Cartesia Instant Voice Clone created privately.\nName: <b>${escapeHtml(voice?.name || name)}</b>\nVoice ID: <code>${escapeHtml(voice?.id || 'unavailable')}</code>\nConsent record: <code>${escapeHtml(response?.data?.consentId || 'unavailable')}</code>\nReview supported locales before using it.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia could not create the voice clone.'));
  }
}

async function runProClone(conversation, ctx, ensureActive) {
  const name = await askInput(conversation, ctx, 'Enter a Pro Voice Clone dataset name.', ensureActive);
  if (name === null) return;
  if (!NAME_PATTERN.test(name)) { await ctx.reply('Pro clone setup canceled. Invalid dataset name.'); return; }
  const language = await askInput(conversation, ctx, 'Enter the training language code.', ensureActive);
  if (language === null) return;
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) { await ctx.reply('Pro clone setup canceled. Invalid language code.'); return; }
  const phrase = readOnlyConfirmation('CARTESIA_STUDIO_PVC', name);
  if (!await confirm(conversation, ctx, phrase, ensureActive, 'This creates a Cartesia dataset. Pro Clone training needs at least 30 minutes of clean single-speaker audio and can take up to 3 hours.')) {
    await ctx.reply('Pro clone setup canceled.'); return;
  }
  try {
    const datasetResponse = await httpClient.post(ctx, rootPath('pro-clones/datasets'), {
      actor_id: String(ctx.from.id), name, description: 'VOICEDNUT-authorized Pro Voice Clone training samples', confirmation_phrase: phrase,
    }, { timeout: 30000 });
    ensureActive();
    const datasetId = String(datasetResponse?.data?.datasetId || '');
    const consentId = String(datasetResponse?.data?.consentId || '');
    if (!ID_PATTERN.test(datasetId)) throw new Error('Cartesia returned no usable dataset ID.');
    if (!/^[a-f0-9]{32}$/.test(consentId)) throw new Error('Cartesia did not return a durable consent record. No samples were uploaded.');
    await ctx.reply(`Dataset <code>${escapeHtml(datasetId)}</code> created. Consent record: <code>${escapeHtml(consentId)}</code>. Upload only the authorized speaker’s recordings as one or more audio files (each up to 16 MB). Send done when samples total at least 30 minutes, or cancel.`, { parse_mode: 'HTML' });
    let fileCount = 0;
    while (fileCount < 20) {
      const update = await conversation.wait();
      ensureActive();
      if (String(update?.message?.text || '').toLowerCase() === 'cancel') { await ctx.reply('Pro clone training canceled. Dataset remains in Cartesia.'); return; }
      if (String(update?.message?.text || '').toLowerCase() === 'done') break;
      const telegramFile = update?.message?.voice || update?.message?.audio || update?.message?.document;
      if (!telegramFile?.file_id || Number(telegramFile.file_size) > 16 * 1024 * 1024) { await ctx.reply('Send an audio file no larger than 16 MB, or type done.'); continue; }
      const file = await ctx.api.getFile(telegramFile.file_id);
      const bytes = await fetchTelegramAudio(ctx, file);
      const uploadPhrase = `UPLOAD CONSENTED CARTESIA PRO CLONE SAMPLE TO ${datasetId}`;
      const query = new URLSearchParams({ actor_id: String(ctx.from.id), consent_id: consentId, filename: String(telegramFile.file_name || 'voice-sample.wav'), content_type: String(telegramFile.mime_type || 'audio/wav'), confirmation_phrase: uploadPhrase });
      await httpClient.post(ctx, `${rootPath('pro-clones/datasets', encodeURIComponent(datasetId), 'files')}?${query}`, bytes,
        { timeout: 60000, headers: { 'Content-Type': 'application/octet-stream' } });
      fileCount += 1;
      await ctx.reply(`Sample ${fileCount} uploaded to the authorized Cartesia dataset.`);
    }
    if (!fileCount) { await ctx.reply('No samples were uploaded; fine-tuning was not started.'); return; }
    if (!await confirm(conversation, ctx, `I CONFIRM SPEAKER CONSENT AND START CARTESIA PRO CLONE TRAINING ${datasetId}`, ensureActive,
      `Start Pro Voice Clone fine-tuning for dataset ${datasetId} with ${fileCount} uploaded file(s)?`)) {
      await ctx.reply('Fine-tuning canceled. Dataset remains available in Cartesia.'); return;
    }
    const tuneResponse = await httpClient.post(ctx, rootPath('pro-clones/fine-tunes'), {
      actor_id: String(ctx.from.id), dataset_id: datasetId, consent_id: consentId, name, language, confirmation_phrase: `I CONFIRM SPEAKER CONSENT AND START CARTESIA PRO CLONE TRAINING ${datasetId}`,
    }, { timeout: 30000 });
    ensureActive();
    const fineTuneId = String(tuneResponse?.data?.fineTuneId || '');
    if (!ID_PATTERN.test(fineTuneId)) throw new Error('Cartesia returned no usable fine-tune ID.');
    await ctx.reply(`Pro Voice Clone training started.\nFine-tune: <code>${escapeHtml(fineTuneId)}</code>\nStatus: <b>${escapeHtml(tuneResponse?.data?.status || 'pending')}</b>\nCheck progress in Cartesia Studio.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Pro Voice Clone setup failed. Check the Cartesia dataset before retrying.'));
  }
}

async function runVoiceGovernance(conversation, ctx, ensureActive) {
  const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('voice-governance')), { timeout: 20000 });
  ensureActive();
  const records = Array.isArray(response?.data?.consents) ? response.data.consents.slice(0, 50) : [];
  const text = records.length
    ? `<b>Cartesia clone consent records</b>\n${records.map((row) => `• <code>${escapeHtml(row.consentId)}</code> · ${escapeHtml(row.operation)} · ${escapeHtml(row.resourceType || 'not linked')} ${row.resourceId ? `<code>${escapeHtml(row.resourceId)}</code>` : ''} · ${escapeHtml(row.status)} · ${Number(row.sampleCount) || 0} samples`).join('\n')}`
    : 'No clone consent records were returned.';
  await ctx.reply(text, { parse_mode: 'HTML' });
  const action = await askInput(conversation, ctx, 'Type status to check Pro Clone training, revoke to block future uploads/training, delete to remove a tracked Instant Clone voice, delete-pro to remove a tracked Pro Clone fine-tune and dataset, or done.', ensureActive);
  if (!action || action.toLowerCase() === 'done') return;
  if (action.toLowerCase() === 'status') {
    const fineTuneId = await askInput(conversation, ctx, 'Enter the Cartesia Pro Clone fine-tune ID.', ensureActive);
    if (!fineTuneId || !ID_PATTERN.test(fineTuneId)) { await ctx.reply('Training status lookup canceled. Invalid fine-tune ID.'); return; }
    const [statusResponse, voicesResponse] = await Promise.all([
      httpClient.get(ctx, actorUrl(ctx, rootPath('pro-clones', 'fine-tunes', encodeURIComponent(fineTuneId))), { timeout: 20000 }),
      httpClient.get(ctx, actorUrl(ctx, rootPath('pro-clones', 'fine-tunes', encodeURIComponent(fineTuneId), 'voices')), { timeout: 20000 }),
    ]);
    ensureActive();
    const tune = statusResponse?.data?.fineTune || {};
    const voices = Array.isArray(voicesResponse?.data?.voices) ? voicesResponse.data.voices.slice(0, 20) : [];
    await ctx.reply(`<b>Cartesia Pro Clone training</b>\nFine-tune: <code>${escapeHtml(tune.id || fineTuneId)}</code> · status: <b>${escapeHtml(tune.status || 'unknown')}</b>\n${voices.length ? `Created voices:\n${voices.map((voice) => `• ${escapeHtml(voice.name || 'Voice')} — <code>${escapeHtml(voice.id)}</code>`).join('\n')}` : 'No resulting voices are available yet.'}`, { parse_mode: 'HTML' });
    return;
  }
  if (!['revoke', 'delete', 'delete-pro'].includes(action.toLowerCase())) { await ctx.reply('No governance change was made.'); return; }
  const consentId = await askInput(conversation, ctx, 'Enter the consent record ID from the list.', ensureActive);
  if (!consentId || !/^[a-f0-9]{32}$/.test(consentId)) { await ctx.reply('Clone governance operation canceled. Invalid consent ID.'); return; }
  if (action.toLowerCase() === 'revoke') {
    const phrase = `REVOKE CARTESIA VOICE CONSENT ${consentId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Revoke consent record ${consentId}? VOICEDNUT blocks further Pro Clone uploads and training for its dataset. Existing provider resources are retained.`)) return;
    await httpClient.post(ctx, rootPath('voice-governance', encodeURIComponent(consentId), 'revoke'), { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, { timeout: 20000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply('Clone consent was revoked. Existing Cartesia resources were retained.'); return;
  }
  if (action.toLowerCase() === 'delete-pro') {
    const phrase = `DELETE CARTESIA PRO CLONE DATA LINKED TO CONSENT ${consentId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Permanently delete the tracked Cartesia Pro Clone fine-tune (if present) and dataset linked to consent ${consentId}? This cannot be undone.`)) return;
    await httpClient.post(ctx, rootPath('voice-governance', encodeURIComponent(consentId), 'delete-pro-data'), { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply('Tracked Cartesia Pro Clone fine-tune and dataset deletion completed.'); return;
  }
  const phrase = `DELETE CARTESIA CLONE LINKED TO CONSENT ${consentId}`;
  if (!await confirm(conversation, ctx, phrase, ensureActive, `Permanently delete the Cartesia Instant Clone voice linked to consent ${consentId}? VOICEDNUT verifies that it is a tracked voice owned by this organization.`)) return;
  await httpClient.post(ctx, rootPath('voice-governance', encodeURIComponent(consentId), 'delete-clone'), { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
  ensureActive(); await ctx.reply('Tracked Cartesia Instant Clone voice deleted.');
}

async function runPreview(conversation, ctx, ensureActive, phraseCache = false) {
  const voiceId = await askInput(conversation, ctx, 'Enter the Cartesia voice ID to preview.', ensureActive);
  if (voiceId === null) return;
  if (!ID_PATTERN.test(voiceId)) { await ctx.reply('Preview canceled. Invalid voice ID.'); return; }
  const locale = await askInput(conversation, ctx, 'Enter a supported locale (for example en-US), or type none to use the voice default.', ensureActive);
  if (locale === null) return;
  if (locale.toLowerCase() !== 'none' && !/^[a-z]{2,3}-[A-Z]{2}$/.test(locale)) { await ctx.reply('Preview canceled. Locale must look like en-US.'); return; }
  let transcript = await askInput(conversation, ctx, 'Enter a short sample phrase (up to 600 characters). You can then add one guided pause, spell-out, or IPA pronunciation.', ensureActive);
  if (transcript === null) return;
  if (!transcript || transcript.length > 600) { await ctx.reply('Preview canceled. Keep the phrase between 1 and 600 characters.'); return; }
  const markup = await askInput(conversation, ctx, 'Optional speech markup: type none, pause, spell, or ipa.', ensureActive);
  if (markup === null) return;
  try {
    const mode = markup.toLowerCase();
    if (mode === 'pause') {
      const seconds = await askInput(conversation, ctx, 'Add a pause at the end in seconds (0.05–5).', ensureActive);
      if (seconds === null) return;
      transcript = applyTtsMarkup(transcript, mode, seconds);
    } else if (mode === 'spell' || mode === 'ipa') {
      const target = await askInput(conversation, ctx, 'Enter the exact word or phrase to mark. It must appear exactly once in the sample.', ensureActive);
      if (target === null) return;
      const value = mode === 'ipa' ? await askInput(conversation, ctx, 'Enter pipe-separated IPA phonemes, for example ˈ|k|æ|t.', ensureActive) : '';
      if (value === null) return;
      transcript = applyTtsMarkup(transcript, mode, value, target);
    } else if (mode === 'none') transcript = applyTtsMarkup(transcript, mode);
    else throw new Error('Choose none, pause, spell, or ipa.');
  } catch (error) { await ctx.reply(`Preview canceled. ${escapeHtml(error.message)}`); return; }
  if (transcript.length > 600) { await ctx.reply('Preview canceled. Markup made the sample longer than 600 characters.'); return; }
  const speedText = await askInput(conversation, ctx, 'Speech speed 0.6–1.5 (enter 1 for normal).', ensureActive);
  if (speedText === null) return;
  const speed = Number(speedText);
  if (!Number.isFinite(speed) || speed < 0.6 || speed > 1.5) { await ctx.reply('Preview canceled. Invalid speed.'); return; }
  const volumeText = await askInput(conversation, ctx, 'Speech volume 0.5–2.0 (enter 1 for normal).', ensureActive);
  if (volumeText === null) return;
  const volume = Number(volumeText);
  if (!Number.isFinite(volume) || volume < 0.5 || volume > 2) { await ctx.reply('Preview canceled. Invalid volume.'); return; }
  const emotion = await askInput(conversation, ctx, 'Optional English emotion tag (neutral, calm, happy, curious, etc.), or type none.', ensureActive);
  if (emotion === null) return;
  const modelId = 'sonic-3.6';
  const payload = {
    voice_id: voiceId, model_id: modelId, transcript,
    locale: locale.toLowerCase() === 'none' ? undefined : locale,
    speed, volume, ...(emotion.toLowerCase() === 'none' ? {} : { emotion: emotion.toLowerCase() }),
  };
  const action = phraseCache ? 'CARTESIA_STUDIO_PHRASE_CACHE' : 'CARTESIA_STUDIO_PREVIEW';
  const phrase = readOnlyConfirmation(action);
  if (!await confirm(conversation, ctx, phrase, ensureActive, phraseCache
    ? 'Generate and cache this standard phrase for later compatible audio streaming.'
    : 'Generate a one-time speech preview. This consumes Cartesia TTS usage.')) {
    await ctx.reply('Speech generation canceled.'); return;
  }
  try {
    const url = phraseCache ? rootPath('phrase-cache') : rootPath('tts-preview');
    const response = await httpClient.post(ctx, url, { ...payload, actor_id: String(ctx.from.id), confirmation_phrase: phrase }, { timeout: 45000 });
    ensureActive();
    const data = response?.data || {};
    if (phraseCache) {
      if (!/^[a-f0-9]{64}$/.test(String(data.cacheKey || ''))) throw new Error('Cartesia phrase cache did not return a cache key.');
      await ctx.reply(`Phrase audio generated and cached.\nCache key: <code>${escapeHtml(data.cacheKey)}</code>\nBytes: ${Number(data.byteLength) || 0}`, { parse_mode: 'HTML' });
      return;
    }
    const audio = Buffer.from(String(data.audioBase64 || ''), 'base64');
    if (!audio.length || audio.length > 8 * 1024 * 1024) throw new Error('Cartesia returned invalid preview audio.');
    await ctx.replyWithAudio(new InputFile(audio, 'cartesia-preview.wav'), { caption: `Cartesia voice preview · ${voiceId} · ${locale}` });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia speech generation failed.'));
  }
}

async function runDictionaryFlow(conversation, ctx, ensureActive, create = false) {
  const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('pronunciation-dictionaries')), { timeout: 20000 });
  ensureActive();
  const dictionaries = Array.isArray(response?.data?.dictionaries) ? response.data.dictionaries : [];
  await ctx.reply(dictionaries.length ? `<b>Cartesia pronunciation dictionaries</b>\n${dictionaries.slice(0, 25).map((dict) => `• ${escapeHtml(dict.name)} — <code>${escapeHtml(dict.id)}</code> (${Number(dict.itemCount) || 0} entries)`).join('\n')}` : 'No Cartesia pronunciation dictionaries were returned.', { parse_mode: 'HTML' });
  if (!create) {
    const operation = await askInput(conversation, ctx, 'Type create, update, delete, or done to manage these dictionaries.', ensureActive);
    if (!operation || operation.toLowerCase() === 'done') return;
    if (operation.toLowerCase() === 'create') return runDictionaryFlow(conversation, ctx, ensureActive, true);
    const dictionaryId = await askInput(conversation, ctx, 'Enter the dictionary ID.', ensureActive);
    if (!dictionaryId) return;
    if (!ID_PATTERN.test(dictionaryId)) { await ctx.reply('Dictionary operation canceled. Invalid ID.'); return; }
    if (operation.toLowerCase() === 'delete') {
      const phrase = `DELETE CARTESIA PRONUNCIATION DICTIONARY ${dictionaryId}`;
      if (!await confirm(conversation, ctx, phrase, ensureActive, `Delete Cartesia dictionary ${dictionaryId}?`)) { await ctx.reply('Dictionary deletion canceled.'); return; }
      await httpClient.del(ctx, rootPath('pronunciation-dictionaries', encodeURIComponent(dictionaryId)), { data: { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, timeout: 25000 });
      ensureActive();
      await ctx.reply('Pronunciation dictionary deleted.');
      return;
    }
    if (operation.toLowerCase() !== 'update') { await ctx.reply('Dictionary operation canceled.'); return; }
    const raw = await askInput(conversation, ctx, 'Paste JSON fields to update, such as {"name":"Product Terms","description":"Brand pronunciations"}.', ensureActive);
    if (raw === null) return;
    let fields;
    try { fields = JSON.parse(raw); } catch { await ctx.reply('Dictionary update canceled. Invalid JSON.'); return; }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { await ctx.reply('Dictionary update canceled. Provide a JSON object.'); return; }
    const phrase = `UPDATE CARTESIA PRONUNCIATION DICTIONARY ${dictionaryId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Update Cartesia dictionary ${dictionaryId}?`)) { await ctx.reply('Dictionary update canceled.'); return; }
    await httpClient.patch(ctx, rootPath('pronunciation-dictionaries', encodeURIComponent(dictionaryId)), { ...fields, actor_id: String(ctx.from.id), confirmation_phrase: phrase }, { timeout: 25000 });
    ensureActive();
    await ctx.reply('Pronunciation dictionary updated.');
    return;
  }
  const name = await askInput(conversation, ctx, 'Enter a name for a new pronunciation dictionary.', ensureActive);
  if (name === null) return;
  if (!NAME_PATTERN.test(name)) { await ctx.reply('Dictionary creation canceled. Invalid name.'); return; }
  const rawItems = await askInput(conversation, ctx, 'Paste a JSON array of {"text":"term","pronunciation":"sounds like..."} entries (maximum 200).', ensureActive);
  if (rawItems === null) return;
  let items;
  try { items = JSON.parse(rawItems); } catch { await ctx.reply('Dictionary creation canceled. The entries were not valid JSON.'); return; }
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) { await ctx.reply('Dictionary creation canceled. Provide 1–200 entries.'); return; }
  const phrase = readOnlyConfirmation('CARTESIA_STUDIO_DICT_CREATE', name);
  if (!await confirm(conversation, ctx, phrase, ensureActive, `Create Cartesia pronunciation dictionary “${name}” with ${items.length} entries?`)) { await ctx.reply('Dictionary creation canceled.'); return; }
  const created = await httpClient.post(ctx, rootPath('pronunciation-dictionaries'), { actor_id: String(ctx.from.id), name, items, confirmation_phrase: phrase }, { timeout: 30000 });
  ensureActive();
  await ctx.reply(`Pronunciation dictionary created. ID: <code>${escapeHtml(created?.data?.dictionary?.id || 'unavailable')}</code>`, { parse_mode: 'HTML' });
}

async function runQuality(conversation, ctx, ensureActive) {
  const agentId = await askInput(conversation, ctx, 'Enter the Cartesia agent ID for its quality scorecard.', ensureActive);
  if (agentId === null) return;
  if (!ID_PATTERN.test(agentId)) { await ctx.reply('Quality lookup canceled. Invalid agent ID.'); return; }
  const query = new URLSearchParams({ agent_id: agentId, limit: '50', actor_id: String(ctx.from.id) });
  const response = await httpClient.get(ctx, `${rootPath('quality')}?${query}`, { timeout: 25000 });
  ensureActive();
  const results = Array.isArray(response?.data?.results) ? response.data.results : [];
  const summary = response?.data?.summary || {};
  const rows = results.slice(0, 20).map((result) => `• <code>${escapeHtml(result.callId || 'call unavailable')}</code> — ${escapeHtml(result.status)} · ${result.value === null ? 'no value' : escapeHtml(String(result.value))}`).join('\n');
  await ctx.reply(`<b>Cartesia quality scorecard</b>\nCompleted results: ${Number(summary.resultCount) || 0}\nBoolean passes: ${Number(summary.booleanPassCount) || 0} · fails: ${Number(summary.booleanFailCount) || 0}\n${rows || 'No quality metric results found.'}\nTranscript content is not returned to Telegram.`, { parse_mode: 'HTML' });
  const next = await askInput(conversation, ctx, 'Type metric to create and attach a custom quality metric, or done.', ensureActive);
  if (next?.toLowerCase() !== 'metric') return;
  const name = await askInput(conversation, ctx, 'Enter a metric name.', ensureActive);
  if (name === null) return;
  const prompt = await askInput(conversation, ctx, 'Enter one concrete call-quality question and expected output.', ensureActive);
  if (prompt === null) return;
  const createPhrase = `CREATE CARTESIA METRIC ${name.toUpperCase()}`;
  if (!await confirm(conversation, ctx, createPhrase, ensureActive, `Create Cartesia metric “${name}”? It will evaluate subsequent calls assigned to it.`)) { await ctx.reply('Quality metric creation canceled.'); return; }
  const metricResponse = await httpClient.post(ctx, rootPath('metrics'), { actor_id: String(ctx.from.id), name, prompt, confirmation_phrase: createPhrase }, { timeout: 30000 });
  ensureActive();
  const metricId = String(metricResponse?.data?.metric?.id || '');
  if (!ID_PATTERN.test(metricId)) { await ctx.reply('Metric was created without a usable ID; inspect Cartesia before retrying.'); return; }
  const assignment = await askInput(conversation, ctx, `Enter the Cartesia agent ID to attach metric ${metricId}, or type done.`, ensureActive);
  if (!assignment || assignment.toLowerCase() === 'done') { await ctx.reply(`Metric ${escapeHtml(metricId)} was created but not assigned.`, { parse_mode: 'HTML' }); return; }
  if (!ID_PATTERN.test(assignment)) { await ctx.reply(`Metric ${escapeHtml(metricId)} was created but assignment was canceled because the agent ID was invalid.`, { parse_mode: 'HTML' }); return; }
  const assignPhrase = `ASSIGN CARTESIA METRIC ${metricId} TO AGENT ${assignment}`;
  if (!await confirm(conversation, ctx, assignPhrase, ensureActive, `Attach metric ${metricId} to agent ${assignment}?`)) { await ctx.reply(`Metric ${escapeHtml(metricId)} was created but not assigned.`, { parse_mode: 'HTML' }); return; }
  await httpClient.post(ctx, rootPath('agents', encodeURIComponent(assignment), 'metrics', encodeURIComponent(metricId)), { actor_id: String(ctx.from.id), confirmation_phrase: assignPhrase }, { timeout: 25000 });
  ensureActive();
  await ctx.reply(`Metric <code>${escapeHtml(metricId)}</code> was attached to agent <code>${escapeHtml(assignment)}</code>.`, { parse_mode: 'HTML' });
}

async function runLogs(conversation, ctx, ensureActive) {
  const callId = await askInput(conversation, ctx, 'Enter the Cartesia call ID to inspect.', ensureActive);
  if (callId === null) return;
  if (!ID_PATTERN.test(callId)) { await ctx.reply('Log lookup canceled. Invalid call ID.'); return; }
  const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('calls', encodeURIComponent(callId), 'logs')), { timeout: 25000 });
  ensureActive();
  const logs = response?.data?.logs;
  await ctx.reply(`Call <code>${escapeHtml(logs?.callId || callId)}</code> runtime diagnostics\nLines: ${Number(logs?.lineCount) || 0} · Warnings: ${Number(logs?.warningCount) || 0} · Errors: ${Number(logs?.errorCount) || 0}\n${logs?.hasErrors ? 'Runtime errors were recorded.' : logs?.hasWarnings ? 'Runtime warnings were recorded.' : 'No warning or error indicators were found.'}\nRaw log lines are intentionally hidden.`, { parse_mode: 'HTML' });
}

async function runTools(conversation, ctx, ensureActive, create = false) {
  const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('tools')), { timeout: 20000 });
  ensureActive();
  const tools = Array.isArray(response?.data?.tools) ? response.data.tools : [];
  await ctx.reply(tools.length ? `<b>Cartesia tools</b>\n${tools.slice(0, 25).map((tool) => `• ${escapeHtml(tool.name)} — <code>${escapeHtml(tool.id)}</code> · ${escapeHtml(tool.type || 'unknown')} (${escapeHtml(tool.executionMode || 'unknown')})`).join('\n')}` : 'No Cartesia tools were returned.', { parse_mode: 'HTML' });
  if (!create) {
    const operation = await askInput(conversation, ctx, 'Type create for a read-only webhook, client for a WebSocket client-tool definition, update or delete for a webhook, or done.', ensureActive);
    if (!operation || operation.toLowerCase() === 'done') return;
    if (operation.toLowerCase() === 'create') return runTools(conversation, ctx, ensureActive, true);
    if (operation.toLowerCase() === 'client') return runClientToolCreate(conversation, ctx, ensureActive);
    const toolId = await askInput(conversation, ctx, 'Enter the webhook tool ID.', ensureActive);
    if (!toolId) return;
    if (!ID_PATTERN.test(toolId)) { await ctx.reply('Webhook tool operation canceled. Invalid ID.'); return; }
    if (operation.toLowerCase() === 'delete') {
      const phrase = `DELETE CARTESIA WEBHOOK TOOL ${toolId}`;
      if (!await confirm(conversation, ctx, phrase, ensureActive, `Delete webhook tool ${toolId}?`)) { await ctx.reply('Webhook tool deletion canceled.'); return; }
    await httpClient.del(ctx, rootPath('tools', encodeURIComponent(toolId)), { data: { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, timeout: 25000 });
      ensureActive();
      await ctx.reply('Cartesia webhook tool deleted.');
      return;
    }
    if (operation.toLowerCase() !== 'update') { await ctx.reply('Webhook tool operation canceled.'); return; }
    const raw = await askInput(conversation, ctx, 'Paste JSON update fields: name, description, response_timeout_secs, execution_mode.', ensureActive);
    if (raw === null) return;
    let fields;
    try { fields = JSON.parse(raw); } catch { await ctx.reply('Webhook update canceled. Invalid JSON.'); return; }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { await ctx.reply('Webhook update canceled. Provide a JSON object.'); return; }
    const phrase = `UPDATE CARTESIA WEBHOOK TOOL ${toolId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Update Cartesia webhook tool ${toolId}?`)) { await ctx.reply('Webhook update canceled.'); return; }
    await httpClient.patch(ctx, rootPath('tools', encodeURIComponent(toolId)), { ...fields, actor_id: String(ctx.from.id), confirmation_phrase: phrase }, { timeout: 25000 });
    ensureActive();
    await ctx.reply('Cartesia webhook tool updated.');
    return;
  }
  const name = await askInput(conversation, ctx, 'Enter a new read-only webhook tool name.', ensureActive);
  if (name === null) return;
  const description = await askInput(conversation, ctx, 'Enter a short description telling the agent when it may use this tool.', ensureActive);
  if (description === null) return;
  const url = await askInput(conversation, ctx, 'Enter a public HTTPS GET endpoint. Private networks and write methods are blocked.', ensureActive);
  if (url === null) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
  } catch { await ctx.reply('Tool creation canceled. Supply a clean public HTTPS URL without embedded credentials, query, or fragment.'); return; }
  const phrase = readOnlyConfirmation('CARTESIA_STUDIO_TOOL_CREATE', name);
  if (!await confirm(conversation, ctx, phrase, ensureActive, `Create a read-only Cartesia webhook tool named “${name}” for ${url}?`)) { await ctx.reply('Webhook tool creation canceled.'); return; }
  const created = await httpClient.post(ctx, rootPath('tools'), {
    actor_id: String(ctx.from.id), type: 'webhook', name, description, api_schema: { url, method: 'GET' }, confirmation_phrase: phrase,
  }, { timeout: 30000 });
  ensureActive();
  await ctx.reply(`Read-only webhook tool created. ID: <code>${escapeHtml(created?.data?.tool?.id || 'unavailable')}</code>\nAttach it to an agent separately in Cartesia.`, { parse_mode: 'HTML' });
}

async function runClientToolCreate(conversation, ctx, ensureActive) {
  const name = await askInput(conversation, ctx, 'Enter a client tool name (letters, numbers, spaces, dot, underscore, hyphen).', ensureActive);
  if (name === null) return;
  const description = await askInput(conversation, ctx, 'Describe when Cartesia should invoke this client function.', ensureActive);
  if (description === null) return;
  const parametersText = await askInput(conversation, ctx, 'Paste its JSON Schema parameters object, e.g. {"type":"object","properties":{"order_id":{"type":"string","description":"Order to look up"}},"required":["order_id"]}.', ensureActive);
  if (parametersText === null) return;
  let parameters;
  try { parameters = JSON.parse(parametersText); } catch { await ctx.reply('Client tool creation canceled. The parameters schema is not valid JSON.'); return; }
  const modeText = await askInput(conversation, ctx, 'Type async (default) or immediate. Use async when the connected app must return a result.', ensureActive);
  if (modeText === null) return;
  const expectsText = await askInput(conversation, ctx, 'Should Cartesia wait for a client_tool_result? Type yes or no.', ensureActive);
  if (expectsText === null) return;
  const expectsResponse = expectsText.toLowerCase() === 'yes';
  if (!['yes', 'no'].includes(expectsText.toLowerCase())) { await ctx.reply('Client tool creation canceled. Answer yes or no.'); return; }
  const phrase = readOnlyConfirmation('CARTESIA_STUDIO_CLIENT_TOOL_CREATE', name);
  const preview = JSON.stringify(parameters);
  if (!await confirm(conversation, ctx, phrase, ensureActive, `Create Cartesia client tool “${name}” (expects response: ${expectsResponse}) with parameters ${preview}? This registers a Cartesia definition. The VOICEDNUT Managed Agent WebSocket runtime only executes its explicit safe allowlist (currently get_campaign_status); other definitions require a handler in your connected client. VOICEDNUT phone calls do not execute client_tool_call events.`)) { await ctx.reply('Client tool definition was not created.'); return; }
  const created = await httpClient.post(ctx, rootPath('tools', 'client'), {
    actor_id: String(ctx.from.id), type: 'client', name, description, parameters,
    execution_mode: modeText.toLowerCase() === 'immediate' ? 'immediate' : 'async',
    expects_response: expectsResponse, confirmation_phrase: phrase,
  }, { timeout: 30000, retry: { retries: 0 } });
  ensureActive();
  await ctx.reply(`Cartesia client tool definition created. ID: <code>${escapeHtml(created?.data?.tool?.id || 'unavailable')}</code>\nAttach it to a Managed Agent in Cartesia. VOICEDNUT's API WebSocket runtime supports only its registered safe handler allowlist; other tools need a handler in your connected client. Phone-call integrations do not execute client_tool_call events.`, { parse_mode: 'HTML' });
}

async function uploadedAudio(conversation, ctx, ensureActive, prompt, maxBytes = 16 * 1024 * 1024) {
  await ctx.reply(`${prompt}\nSend one supported audio document, or type cancel.`);
  const update = await conversation.wait();
  ensureActive();
  if (String(update?.message?.text || '').toLowerCase() === 'cancel') return null;
  const file = update?.message?.voice || update?.message?.audio || update?.message?.document;
  if (!file?.file_id || Number(file.file_size) > maxBytes) throw new Error(`Send a supported audio file no larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
  const telegramFile = await ctx.api.getFile(file.file_id);
  const bytes = await fetchTelegramAudio(ctx, telegramFile);
  ensureActive();
  return { bytes, filename: String(file.file_name || (update.message.voice ? 'voice.ogg' : 'audio.wav')).slice(0, 120), contentType: String(file.mime_type || (update.message.voice ? 'audio/ogg' : 'audio/wav')) };
}

function audioFromSse(stream, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    let pending = '';
    const finishEvent = (block) => {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') return;
      let event;
      try { event = JSON.parse(data); } catch { throw new Error('Cartesia returned an invalid speech stream event.'); }
      if (event.type === 'error') throw new Error('Cartesia reported an error while streaming speech.');
      if (event.type === 'chunk' && typeof event.data === 'string') {
        const chunk = Buffer.from(event.data, 'base64');
        total += chunk.length;
        if (total > maxBytes) throw new Error('Cartesia streaming audio exceeded the 8 MB limit.');
        if (chunk.length) parts.push(chunk);
      }
    };
    stream.on('data', (chunk) => {
      try {
        pending += Buffer.from(chunk).toString('utf8');
        let boundary;
        while ((boundary = pending.search(/\r?\n\r?\n/)) >= 0) {
          const block = pending.slice(0, boundary);
          const sep = pending.slice(boundary).match(/^\r?\n\r?\n/)[0];
          pending = pending.slice(boundary + sep.length);
          finishEvent(block);
        }
      } catch (error) { stream.destroy(); reject(error); }
    });
    stream.on('error', reject);
    stream.on('end', () => {
      try { if (pending.trim()) finishEvent(pending); } catch (error) { reject(error); return; }
      if (!total) { reject(new Error('Cartesia returned no speech audio.')); return; }
      resolve(Buffer.concat(parts, total));
    });
  });
}

function pcm16ToWav(pcm, sampleRate = 24000) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || '');
  if (!data.length || data.length % 2 !== 0 || data.length > 8 * 1024 * 1024) throw new Error('Audio data is empty, malformed, or too large.');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function runVoiceManagement(conversation, ctx, ensureActive) {
  const [voiceResponse, accentResponse] = await Promise.all([
    httpClient.get(ctx, actorUrl(ctx, rootPath('voices')), { timeout: 20000 }),
    httpClient.get(ctx, actorUrl(ctx, rootPath('accents')), { timeout: 20000 }),
  ]);
  ensureActive();
  const voices = Array.isArray(voiceResponse?.data?.voices) ? voiceResponse.data.voices.slice(0, 30) : [];
  const accents = Array.isArray(accentResponse?.data?.accents) ? accentResponse.data.accents.slice(0, 40) : [];
  const voiceSummary = voices.map((voice) => `• ${escapeHtml(voice.name)} <code>${escapeHtml(voice.id)}</code> · ${escapeHtml((voice.accents || []).map((item) => item.locale).filter(Boolean).join(', ') || voice.language || 'locale unknown')}`).join('\n');
  const accentSummary = accents.slice(0, 20).map((accent) => `${escapeHtml(accent.name || accent.id)} (<code>${escapeHtml(accent.id)}</code>)`).join(', ');
  await ctx.reply(`<b>Cartesia voice library</b>\n${voiceSummary || 'No voices returned.'}\n\nAccents: ${accentSummary || 'No localizable accents returned.'}`, { parse_mode: 'HTML' });
  const operation = await askInput(conversation, ctx, 'Type localize, update, delete, add-accent, remove-accent, or done.', ensureActive);
  if (!operation || operation.toLowerCase() === 'done') return;
  const voiceId = await askInput(conversation, ctx, 'Enter the Cartesia voice ID.', ensureActive);
  if (!voiceId) return;
  if (!ID_PATTERN.test(voiceId)) { await ctx.reply('Voice operation canceled. Invalid voice ID.'); return; }
  const op = operation.toLowerCase();
  if (op === 'localize') {
    const accentId = await askInput(conversation, ctx, `Enter an accent ID from the list above. ${accentSummary}`, ensureActive);
    if (!accentId) return;
    const name = await askInput(conversation, ctx, 'Enter a name for the new localized voice.', ensureActive);
    if (!name) return;
    const phrase = `LOCALIZE CARTESIA VOICE ${voiceId} TO ${accentId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Create a private localized voice from ${voiceId} for accent ${accentId}? It creates a separate voice and may consume credits.`)) return;
    const result = await httpClient.post(ctx, rootPath('voices/localize'), { actor_id: String(ctx.from.id), voice_id: voiceId, accent: accentId, name, access: 'private', confirmation_phrase: phrase }, { timeout: 45000, retry: { retries: 0 } });
    ensureActive();
    await ctx.reply(`Localized Cartesia voice created privately: <b>${escapeHtml(result?.data?.voice?.name || name)}</b> · <code>${escapeHtml(result?.data?.voice?.id || 'unavailable')}</code>`, { parse_mode: 'HTML' });
    return;
  }
  if (op === 'update') {
    const raw = await askInput(conversation, ctx, 'Enter JSON with name and/or description to update.', ensureActive);
    if (raw === null) return;
    let fields;
    try { fields = JSON.parse(raw); } catch { await ctx.reply('Voice update canceled. Invalid JSON.'); return; }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { await ctx.reply('Voice update canceled. Provide a JSON object.'); return; }
    const phrase = `UPDATE CARTESIA VOICE ${voiceId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Update Cartesia voice ${voiceId}?`)) return;
    await httpClient.patch(ctx, rootPath('voices', encodeURIComponent(voiceId)), { actor_id: String(ctx.from.id), ...fields, confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply('Cartesia voice details updated.'); return;
  }
  if (op === 'delete') {
    const phrase = `DELETE CARTESIA VOICE ${voiceId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Permanently delete Cartesia voice ${voiceId}? This cannot be undone.`)) return;
    await httpClient.del(ctx, rootPath('voices', encodeURIComponent(voiceId)), { data: { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply('Cartesia voice deleted.'); return;
  }
  if (op === 'add-accent') {
    const accentIds = await askInput(conversation, ctx, `Enter accent IDs separated by commas. Available: ${accents.map((accent) => accent.id).slice(0, 30).join(', ')}`, ensureActive);
    if (!accentIds) return;
    const phrase = `ADD ACCENTS TO CARTESIA VOICE ${voiceId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Add these accents to voice ${voiceId}? ${accentIds}`)) return;
    await httpClient.patch(ctx, rootPath('voices', encodeURIComponent(voiceId), 'accents'), { actor_id: String(ctx.from.id), accents: accentIds.split(',').map((id) => id.trim()), confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply('Cartesia voice accents updated.'); return;
  }
  if (op === 'remove-accent') {
    const accentId = await askInput(conversation, ctx, 'Enter the accent ID to remove from this voice.', ensureActive);
    if (!accentId) return;
    const phrase = `REMOVE CARTESIA ACCENT ${accentId} FROM VOICE ${voiceId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Remove accent ${accentId} from voice ${voiceId}?`)) return;
    await httpClient.del(ctx, rootPath('voices', encodeURIComponent(voiceId), 'accents', encodeURIComponent(accentId)), { data: { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply('Cartesia voice accent removed.'); return;
  }
  await ctx.reply('Voice operation canceled. Choose one of the listed operations.');
}

async function runStreamingSpeech(conversation, ctx, ensureActive) {
  const voiceId = await askInput(conversation, ctx, 'Enter the Cartesia voice ID.', ensureActive);
  if (!voiceId) return;
  if (!ID_PATTERN.test(voiceId)) { await ctx.reply('Streaming speech canceled. Invalid voice ID.'); return; }
  const transcript = await askInput(conversation, ctx, 'Enter the text to stream as speech (up to 600 characters).', ensureActive);
  if (!transcript || transcript.length > 600) return;
  const phrase = 'STREAM CARTESIA TTS PREVIEW';
  if (!await confirm(conversation, ctx, phrase, ensureActive, 'Stream Cartesia speech and send the completed audio file here? This uses TTS credits.')) return;
  const query = actorUrl(ctx, rootPath('tts-stream'));
  const response = await httpClient.post(ctx, query, { actor_id: String(ctx.from.id), voice_id: voiceId, model_id: 'sonic-3.6', transcript, language: 'en', output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 }, confirmation_phrase: phrase }, { timeout: 60000, responseType: 'stream', retry: { retries: 0 } });
  ensureActive();
  const pcm = await audioFromSse(response.data);
  ensureActive();
  await ctx.replyWithAudio(new InputFile(pcm16ToWav(pcm), 'cartesia-stream.wav'), { caption: `Cartesia streamed voice · ${voiceId}` });
}

async function runSpeechContinuations(conversation, ctx, ensureActive) {
  const voiceId = await askInput(conversation, ctx, 'Enter the Cartesia voice ID.', ensureActive);
  if (!voiceId) return;
  if (!ID_PATTERN.test(voiceId)) { await ctx.reply('TTS continuations canceled. Invalid voice ID.'); return; }
  await ctx.reply('Enter the first transcript segment. Preserve spaces at segment boundaries (include a trailing space when the next segment continues a word sequence). Type cancel to stop.');
  const transcripts = [];
  while (transcripts.length < 10) {
    const update = await conversation.wait();
    ensureActive();
    const part = String(update?.message?.text || '');
    if (CANCEL_WORDS.has(part.trim().toLowerCase())) return;
    if (part.trim().toLowerCase() === 'done') {
      if (transcripts.length >= 2) break;
      await ctx.reply('Add at least two segments before typing done.');
      continue;
    }
    if (!part.trim() || part.length > 600 || transcripts.reduce((sum, item) => sum + item.length, part.length) > 3000) {
      await ctx.reply('Each segment must contain 1–600 characters and all segments together must stay under 3,000 characters.');
      continue;
    }
    transcripts.push(part);
    await ctx.reply(transcripts.length < 10 ? `Segment ${transcripts.length} added. Send another segment, or type done to finish.` : 'Maximum of 10 segments reached.');
    if (transcripts.length === 10) break;
  }
  if (transcripts.length < 2) { await ctx.reply('TTS continuations canceled. At least two segments are required.'); return; }
  const phrase = 'GENERATE CARTESIA TTS CONTINUATIONS';
  if (!await confirm(conversation, ctx, phrase, ensureActive, `Generate a seamless ${transcripts.length}-part speech preview? This uses Cartesia TTS credits.`)) return;
  try {
    const response = await httpClient.post(ctx, rootPath('tts-continuations'), {
      actor_id: String(ctx.from.id), voice_id: voiceId, model_id: 'sonic-3.6', language: 'en',
      transcripts, confirmation_phrase: phrase,
    }, { timeout: 60000 });
    ensureActive();
    const pcm = Buffer.from(String(response?.data?.audioBase64 || ''), 'base64');
    if (!pcm.length || pcm.length > 8 * 1024 * 1024) throw new Error('Cartesia returned invalid continuation audio.');
    await ctx.replyWithAudio(new InputFile(pcm16ToWav(pcm), 'cartesia-continuations.wav'), { caption: `Cartesia seamless TTS · ${voiceId} · ${transcripts.length} segments` });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia TTS continuations failed.'));
  }
}

async function runInkTranscription(conversation, ctx, ensureActive) {
  const mode = await askInput(conversation, ctx, 'Type batch for Cartesia batch transcription, or realtime to transcribe an uploaded raw PCM clip with Ink turn detection. This upload flow is not a live microphone stream.', ensureActive);
  if (!mode) return;
  const realtime = mode.toLowerCase() === 'realtime';
  if (!realtime && mode.toLowerCase() !== 'batch') { await ctx.reply('Choose batch or realtime.'); return; }
  const file = await uploadedAudio(conversation, ctx, ensureActive, realtime
    ? 'Upload mono 16 kHz signed 16-bit PCM audio as a .pcm document for Ink realtime transcription.'
    : 'Upload an audio file for Cartesia Ink batch transcription.');
  if (!file) return;
  if (realtime && !/\.pcm$/i.test(file.filename)) { await ctx.reply('Realtime Ink mode requires raw PCM bytes in a .pcm document. Use batch mode for voice notes or WAV/MP3 files.'); return; }
  const phrase = realtime ? 'TRANSCRIBE AUDIO WITH CARTESIA INK REALTIME' : 'TRANSCRIBE AUDIO WITH CARTESIA INK';
  if (!await confirm(conversation, ctx, phrase, ensureActive, `Transcribe ${file.filename} with Cartesia Ink? The audio will be sent to Cartesia.`)) return;
  const extension = String(file.filename.split('.').pop() || 'wav').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'wav';
  const params = new URLSearchParams({ actor_id: String(ctx.from.id), filename: `audio.${extension}`, content_type: file.contentType, confirmation_phrase: phrase });
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (realtime) {
    params.set('encoding', 'pcm_s16le'); params.set('sample_rate', '16000');
    const loadedProfile = await httpClient.get(ctx, actorUrl(ctx, rootPath('stt-profile')), { timeout: 15000 });
    ensureActive();
    const profile = loadedProfile?.data?.profile || {};
    const profileJson = JSON.stringify({
      keyterms: Array.isArray(profile.keyterms) ? profile.keyterms.slice(0, 100) : [],
      turnSettings: profile.turnSettings && typeof profile.turnSettings === 'object' ? profile.turnSettings : {},
    });
    headers['x-cartesia-stt-profile'] = Buffer.from(profileJson).toString('base64url');
    params.set('stt_profile_sha256', crypto.createHash('sha256').update(profileJson).digest('hex'));
  }
  else params.set('timestamps', 'word');
  const response = await httpClient.post(ctx, `${rootPath('stt', realtime ? 'realtime' : 'transcribe')}?${params}`, file.bytes, { timeout: 90000, headers, retry: { retries: 0 } });
  ensureActive();
  const transcript = String(response?.data?.transcript || '').slice(0, 12000);
  await ctx.reply(`<b>Cartesia Ink ${realtime ? 'uploaded PCM clip with realtime turn detection' : 'batch'} transcript</b>\nLanguage: ${escapeHtml(response?.data?.language || 'unknown')} · Duration: ${Number(response?.data?.durationSeconds || 0).toFixed(1)}s\n\n${escapeHtml(transcript || 'No speech detected.')}`, { parse_mode: 'HTML' });
}

async function runInfill(conversation, ctx, ensureActive) {
  const voiceId = await askInput(conversation, ctx, 'Enter the Cartesia voice ID for the replacement speech.', ensureActive);
  if (!voiceId) return;
  if (!ID_PATTERN.test(voiceId)) { await ctx.reply('Speech infill canceled. Invalid voice ID.'); return; }
  const transcript = await askInput(conversation, ctx, 'Enter the words to generate between the supplied audio context clips.', ensureActive);
  if (!transcript || transcript.length > 600) return;
  const side = await askInput(conversation, ctx, 'Will your context clip come before the replacement (left) or after it (right)?', ensureActive);
  if (!['left', 'right'].includes(String(side).toLowerCase())) return;
  const file = await uploadedAudio(conversation, ctx, ensureActive, 'Upload the audio context clip. Keep it close to a natural pause.');
  if (!file) return;
  const phrase = `GENERATE CARTESIA INFILL FOR VOICE ${voiceId}`;
  if (!await confirm(conversation, ctx, phrase, ensureActive, `Generate “${transcript}” in the gap using the provided ${side.toLowerCase()} context? This uses TTS credits.`)) return;
  const transcriptHash = crypto.createHash('sha256').update(transcript).digest('hex');
  const extension = String(file.filename.split('.').pop() || 'wav').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'wav';
  const params = new URLSearchParams({ actor_id: String(ctx.from.id), side: String(side).toLowerCase(), voice_id: voiceId, transcript_sha256: transcriptHash, language: 'en', filename: `context.${extension}`, content_type: file.contentType, confirmation_phrase: phrase });
  const response = await httpClient.post(ctx, `${rootPath('infill')}?${params}`, file.bytes, { timeout: 60000, responseType: 'arraybuffer', headers: { 'Content-Type': 'application/octet-stream', 'x-cartesia-infill-transcript': transcript }, retry: { retries: 0 } });
  ensureActive();
  const audio = Buffer.from(response.data || '');
  if (!audio.length || audio.length > 8 * 1024 * 1024) throw new Error('Cartesia returned invalid speech infill audio.');
  await ctx.replyWithAudio(new InputFile(audio, 'cartesia-infill.wav'), { caption: `Cartesia speech infill · ${voiceId}` });
}

async function collectGuidedAudioConfig(conversation, ctx, ensureActive) {
  const voiceId = await askInput(conversation, ctx, 'Enter the Cartesia voice ID. Use /cartesia → voices to find one.', ensureActive);
  if (!voiceId || !ID_PATTERN.test(voiceId)) { if (voiceId !== null) await ctx.reply('Configuration canceled. Invalid voice ID.'); return null; }
  const speedText = await askInput(conversation, ctx, 'Voice speed 0.6–1.5 (default 1).', ensureActive);
  if (speedText === null) return null;
  const speed = speedText ? Number(speedText) : 1;
  if (!Number.isFinite(speed) || speed < 0.6 || speed > 1.5) { await ctx.reply('Configuration canceled. Speed must be 0.6–1.5.'); return null; }
  const volumeText = await askInput(conversation, ctx, 'Voice volume 0.5–2 (default 1).', ensureActive);
  if (volumeText === null) return null;
  const volume = volumeText ? Number(volumeText) : 1;
  if (!Number.isFinite(volume) || volume < 0.5 || volume > 2) { await ctx.reply('Configuration canceled. Volume must be 0.5–2.'); return null; }
  const suppression = await askInput(conversation, ctx, 'Noise suppression: auto, max, or off.', ensureActive);
  if (!suppression || !['auto', 'max', 'off'].includes(suppression.toLowerCase())) { if (suppression !== null) await ctx.reply('Configuration canceled. Choose auto, max, or off.'); return null; }
  const keytermText = await askInput(conversation, ctx, 'Optional recognized keyterms, comma-separated (or none).', ensureActive);
  if (keytermText === null) return null;
  const keyterms = /^none$/i.test(keytermText.trim()) || !keytermText.trim()
    ? [] : keytermText.split(',').map((value) => value.trim()).filter(Boolean);
  if (keyterms.length > 100 || keyterms.some((term) => term.length > 120 || /[\u0000-\u001f]/.test(term))) {
    await ctx.reply('Configuration canceled. Use at most 100 keyterms, each 120 characters or less.'); return null;
  }
  return { audio: {
    input: { noise_suppression: suppression.toLowerCase(), ...(keyterms.length ? { keyterms } : {}) },
    output: { voice_id: voiceId, speed, volume },
  } };
}

async function runAgentAndPhoneOperations(conversation, ctx, ensureActive) {
  const [agentResponse, phoneResponse] = await Promise.all([
    httpClient.get(ctx, actorUrl(ctx, rootPath('agents')), { timeout: 20000 }),
    httpClient.get(ctx, actorUrl(ctx, rootPath('phone-numbers')), { timeout: 20000 }),
  ]);
  ensureActive();
  const agents = Array.isArray(agentResponse?.data?.agents) ? agentResponse.data.agents.slice(0, 30) : [];
  const numbers = Array.isArray(phoneResponse?.data?.phoneNumbers) ? phoneResponse.data.phoneNumbers.slice(0, 30) : [];
  const agentText = agents.map((agent) => `• ${escapeHtml(agent.name)} · <code>${escapeHtml(agent.id)}</code>`).join('\n');
  const phoneText = numbers.map((number) => `• ${escapeHtml(number.phoneNumber || number.number || 'number unavailable')} · <code>${escapeHtml(number.id)}</code> · agent ${escapeHtml(number.agentId || 'unassigned')}`).join('\n');
  await ctx.reply(`<b>Cartesia agents and phone numbers</b>\n${agentText || 'No agents returned.'}\n\n${phoneText || 'No phone numbers returned.'}`, { parse_mode: 'HTML' });
  const agentId = await askInput(conversation, ctx, 'Enter an agent ID to inspect deployment versions, type templates to browse Cartesia starter repositories, or done.', ensureActive);
  if (!agentId || agentId.toLowerCase() === 'done') return;
  if (agentId.toLowerCase() === 'templates') {
    const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('agent-templates')), { timeout: 25000 });
    ensureActive();
    const templates = Array.isArray(response?.data?.templates) ? response.data.templates.slice(0, 50) : [];
    const rows = templates.map((template) => {
      const env = Array.isArray(template.requiredEnvironmentVariables) && template.requiredEnvironmentVariables.length
        ? `\n  Required environment variable names: ${template.requiredEnvironmentVariables.map(escapeHtml).join(', ')}` : '';
      const repo = template.repositoryUrl ? `\n  Repository: ${escapeHtml(template.repositoryUrl)}` : '';
      return `• <b>${escapeHtml(template.name)}</b> · <code>${escapeHtml(template.id)}</code>\n  ${escapeHtml(template.description || 'Cartesia starter template')}${env}${repo}`;
    }).join('\n');
    await ctx.reply(`<b>Cartesia Managed Agent templates</b>\n${rows || 'No templates returned.'}\n\nThese are starter repositories; browsing them does not create or deploy an agent.`, { parse_mode: 'HTML' });
    return;
  }
  if (!ID_PATTERN.test(agentId)) { await ctx.reply('Deployment lookup canceled. Invalid agent ID.'); return; }
  const deployments = await httpClient.get(ctx, actorUrl(ctx, rootPath('agents', encodeURIComponent(agentId), 'deployments')), { timeout: 25000 });
  ensureActive();
  const rows = Array.isArray(deployments?.data?.deployments) ? deployments.data.deployments.slice(0, 20) : [];
  await ctx.reply(`<b>Cartesia deployments for ${escapeHtml(agentId)}</b>\n${rows.map((row) => `• version <code>${escapeHtml(row.versionId || 'unknown')}</code> · ${escapeHtml(row.status || 'unknown')} · ${row.isLive ? 'live' : row.isPinned ? 'pinned' : 'inactive'}`).join('\n') || 'No deployments returned.'}`, { parse_mode: 'HTML' });
  const operation = await askInput(conversation, ctx, 'Managed agent and phone administration: type language-readiness to inspect configured locales, versions to review or restore an agent version, update-agent for voice/audio/system-tool settings, profiles to manage reusable agent voice profiles, assign, import, provision, or done.', ensureActive);
  if (!operation || operation.toLowerCase() === 'done') return;
  if (operation.toLowerCase() === 'profiles') {
    const profileResponse = await httpClient.get(ctx, actorUrl(ctx, rootPath('agent-profiles')), { timeout: 20000 });
    ensureActive();
    const profiles = Array.isArray(profileResponse?.data?.profiles) ? profileResponse.data.profiles.slice(0, 50) : [];
    const profileRows = profiles.map((profile) => {
      const summary = profile.configSummary || {};
      return `• ${escapeHtml(profile.name)} · <code>${escapeHtml(profile.id)}</code> · voice <code>${escapeHtml(summary.voiceId || 'unset')}</code> · speed ${escapeHtml(String(summary.voiceSpeed ?? 'default'))} · ${Number(summary.keytermCount) || 0} keyterms`;
    }).join('\n');
    await ctx.reply(`<b>Reusable Cartesia agent voice profiles</b>\n${profileRows || 'No saved profiles.'}`, { parse_mode: 'HTML' });
    const profileOperation = await askInput(conversation, ctx, 'Type create to build a reusable voice/audio profile with guided prompts, apply to apply a saved profile to the selected agent, delete to remove a profile, or done.', ensureActive);
    if (!profileOperation || profileOperation.toLowerCase() === 'done') return;
    if (profileOperation.toLowerCase() === 'create') {
      const name = await askInput(conversation, ctx, 'Enter a profile name (up to 80 characters).', ensureActive);
      if (!name) return;
      const config = await collectGuidedAudioConfig(conversation, ctx, ensureActive);
      if (!config) return;
      const phrase = `SAVE CARTESIA AGENT PROFILE ${name.toUpperCase()}`;
      if (!await confirm(conversation, ctx, phrase, ensureActive, `Save reusable profile “${name}”? The API validates all settings and excludes credentials.`)) return;
      const result = await httpClient.post(ctx, rootPath('agent-profiles'), { actor_id: String(ctx.from.id), name, config, confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
      ensureActive(); await ctx.reply(`Saved profile ${escapeHtml(result?.data?.profile?.name || name)} · <code>${escapeHtml(result?.data?.profile?.id || 'ID unavailable')}</code>.`, { parse_mode: 'HTML' });
      return;
    }
    if (profileOperation.toLowerCase() === 'apply') {
      const profileId = await askInput(conversation, ctx, 'Enter the saved profile ID to apply.', ensureActive);
      if (!profileId || !ID_PATTERN.test(profileId)) { await ctx.reply('Profile application canceled. Invalid profile ID.'); return; }
      const phrase = `APPLY CARTESIA AGENT PROFILE ${profileId} TO AGENT ${agentId}`;
      if (!await confirm(conversation, ctx, phrase, ensureActive, `Apply profile ${profileId} to agent ${agentId}? Cartesia will create a new agent configuration version.`)) return;
      const result = await httpClient.post(ctx, rootPath('agents', encodeURIComponent(agentId), 'profiles', encodeURIComponent(profileId), 'apply'), { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, { timeout: 45000, retry: { retries: 0 } });
      ensureActive(); await ctx.reply(`Applied ${escapeHtml(result?.data?.profile?.name || profileId)} to ${escapeHtml(agentId)}. New version: ${escapeHtml(result?.data?.agent?.currentVersionId || 'not returned')}.`, { parse_mode: 'HTML' });
      return;
    }
    if (profileOperation.toLowerCase() === 'delete') {
      const profileId = await askInput(conversation, ctx, 'Enter the saved profile ID to delete.', ensureActive);
      if (!profileId || !ID_PATTERN.test(profileId)) { await ctx.reply('Profile deletion canceled. Invalid profile ID.'); return; }
      const phrase = `DELETE CARTESIA AGENT PROFILE ${profileId}`;
      if (!await confirm(conversation, ctx, phrase, ensureActive, `Delete reusable profile ${profileId}? This does not change agents that already use it.`)) return;
      await httpClient.del(ctx, actorUrl(ctx, rootPath('agent-profiles', encodeURIComponent(profileId))), { data: { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, timeout: 30000, retry: { retries: 0 } });
      ensureActive(); await ctx.reply(`Deleted profile ${escapeHtml(profileId)}.`); return;
    }
    await ctx.reply('Choose create, apply, delete, or done.'); return;
  }
  if (operation.toLowerCase() === 'language-readiness') {
    const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('agents', encodeURIComponent(agentId), 'language-readiness')), { timeout: 25000 });
    ensureActive();
    const readiness = response?.data || {};
    const rows = Array.isArray(readiness.languages) ? readiness.languages.map((item) => `• ${escapeHtml(item.code)} — ${item.voiceAccent === 'native_accent_listed' ? 'native voice accent listed' : item.voiceAccent === 'original_accent_fallback' ? `falls back to original accent${readiness.originalAccent ? ` (${escapeHtml(readiness.originalAccent)})` : ''}` : 'voice accent metadata unavailable'}`).join('\n') : '';
    await ctx.reply(`<b>Cartesia language readiness</b>\nAgent: <code>${escapeHtml(agentId)}</code> · Voice: <code>${escapeHtml(readiness.voiceId || 'not configured')}</code>\n${rows || 'No primary or additional language was returned.'}\n\nAccent fallback does not by itself mean a language is unsupported. This check does not certify recognition or Managed Agent language support.`, { parse_mode: 'HTML' });
    return;
  }
  if (operation.toLowerCase() === 'versions') {
    const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('agents', encodeURIComponent(agentId), 'versions')), { timeout: 25000 });
    ensureActive();
    const versions = Array.isArray(response?.data?.versions) ? response.data.versions.slice(0, 30) : [];
    if (!versions.length) { await ctx.reply('No Cartesia agent versions were returned.'); return; }
    await ctx.reply(`<b>Agent versions for ${escapeHtml(agentId)}</b>\n${versions.map((version) => `• <code>${escapeHtml(version.id)}</code> · ${escapeHtml(version.description || 'no description')} · ${escapeHtml(version.createdAt || 'date unavailable')}`).join('\n')}`, { parse_mode: 'HTML' });
    const versionId = await askInput(conversation, ctx, 'Enter a version ID to inspect its safe configuration summary, or type done.', ensureActive);
    if (!versionId || versionId.toLowerCase() === 'done') return;
    if (!ID_PATTERN.test(versionId)) { await ctx.reply('Version inspection canceled. Invalid version ID.'); return; }
    const [detail, current] = await Promise.all([
      httpClient.get(ctx, actorUrl(ctx, rootPath('agents', encodeURIComponent(agentId), 'versions', encodeURIComponent(versionId))), { timeout: 25000 }),
      httpClient.get(ctx, actorUrl(ctx, rootPath('agents', encodeURIComponent(agentId), 'config-summary')), { timeout: 25000 }),
    ]);
    ensureActive();
    const summary = detail?.data?.version?.configSummary || {};
    const currentVersionId = current?.data?.currentVersionId;
    const currentSummary = current?.data?.configSummary;
    if (!ID_PATTERN.test(String(currentVersionId || '')) || !currentSummary || typeof currentSummary !== 'object' || Array.isArray(currentSummary)
      || !summary || typeof summary !== 'object' || Array.isArray(summary) || String(detail?.data?.version?.id || '') !== versionId) {
      await ctx.reply('Restore canceled. Cartesia did not return both version summaries, so I cannot show a before-and-after review.'); return;
    }
    const changes = safeConfigChanges(currentSummary, summary);
    const changeText = changes.length ? changes.map((change) => `• ${change}`).join('\n') : '• No differences in the tracked summary fields.';
    await ctx.reply(`<b>Restore review</b>\nCurrent <code>${escapeHtml(currentVersionId)}</code> → selected <code>${escapeHtml(versionId)}</code>\n${changeText}\nPrompt contents and detailed tool configuration are hidden; only the tracked settings above are compared.`, { parse_mode: 'HTML' });
    if (String(currentVersionId) === String(versionId)) { await ctx.reply('This version is already current. No restore was submitted.'); return; }
    const metricsResponse = await httpClient.get(ctx, actorUrl(ctx, rootPath('metrics')), { timeout: 20000 });
    ensureActive();
    const availableMetrics = Array.isArray(metricsResponse?.data?.metrics) ? metricsResponse.data.metrics.slice(0, 50) : [];
    if (!availableMetrics.length) { await ctx.reply('Restore blocked: assign Cartesia quality metrics and evaluate completed test calls for the selected version.'); return; }
    await ctx.reply(`<b>Evaluation metrics</b>\n${availableMetrics.map((metric) => `• ${escapeHtml(metric.name || 'Metric')} — <code>${escapeHtml(metric.id)}</code>`).join('\n')}\nBoolean judge metrics must pass; numeric metrics need an explicit maximum. Cartesia metric results do not expose the agent version, so the operator must attest which version the calls tested.`, { parse_mode: 'HTML' });
    const metricText = await askInput(conversation, ctx, 'Enter one or more metric IDs separated by commas.', ensureActive);
    if (!metricText) return;
    const metricIds = metricText.split(',').map((value) => value.trim()).filter(Boolean);
    const callText = await askInput(conversation, ctx, 'Enter 3–20 completed Cartesia test call IDs for this candidate version, separated by commas. The bot will not start calls.', ensureActive);
    if (!callText) return;
    const callIds = callText.split(',').map((value) => value.trim()).filter(Boolean);
    const policyText = await askInput(conversation, ctx, 'Minimum passing sample rate from 50 to 100 percent (default 90).', ensureActive);
    if (policyText === null) return;
    const minimumPassRate = policyText.trim() ? Number(policyText) / 100 : 0.9;
    const thresholdText = await askInput(conversation, ctx, 'Optional numeric metric maximums as JSON keyed by metric ID, for example {"system_text_to_speech_ttfb":800}. Use {} if all selected metrics return booleans.', ensureActive);
    if (thresholdText === null) return;
    let metricThresholds;
    try { metricThresholds = thresholdText.trim() ? JSON.parse(thresholdText) : {}; } catch { metricThresholds = null; }
    if (!metricThresholds || typeof metricThresholds !== 'object' || Array.isArray(metricThresholds) ||
        Object.keys(metricThresholds).some((id) => !metricIds.includes(id) || !Number.isFinite(Number(metricThresholds[id])) || Number(metricThresholds[id]) <= 0 || Number(metricThresholds[id]) > 600000)) {
      await ctx.reply('Restore blocked: numeric metric maximums must be a JSON object with selected metric IDs and values from 0 to 600000.'); return;
    }
    if (callIds.length < 3 || callIds.length > 20 || metricIds.length < 1 || metricIds.length > 20 || !Number.isFinite(minimumPassRate) || minimumPassRate < 0.5 || minimumPassRate > 1) {
      await ctx.reply('Restore blocked: the evaluation inputs are outside the allowed ranges.'); return;
    }
    const evaluation = { call_ids: callIds, metric_ids: metricIds, metric_thresholds: metricThresholds, minimum_samples: 3, minimum_pass_rate: minimumPassRate };
    const operatorAttestation = `I ATTEST CARTESIA TEST CALLS ${callIds.join(',')} USED VERSION ${versionId}`;
    if (!await confirm(conversation, ctx, operatorAttestation, ensureActive, `Attest that all ${callIds.length} supplied completed test calls used candidate version ${versionId}? Cartesia results do not independently identify the version.`)) return;
    evaluation.operator_attestation = operatorAttestation;
    const gateResponse = await httpClient.post(ctx, rootPath('agents', encodeURIComponent(agentId), 'versions', encodeURIComponent(versionId), 'evaluation-gate'), {
      actor_id: String(ctx.from.id), ...evaluation,
    }, { timeout: 45000, retry: { retries: 0 } });
    ensureActive();
    const gate = gateResponse?.data || {};
    await ctx.reply(`<b>Version evaluation gate: ${gate.passed ? 'PASSED' : 'BLOCKED'}</b>\nComplete samples: ${Number(gate.completeSampleCount) || 0}/${Number(gate.sampleCount) || 0} · passing: ${Number(gate.passedSampleCount) || 0} · pass rate: ${(Number(gate.passRate) * 100 || 0).toFixed(0)}% · required: ${(minimumPassRate * 100).toFixed(0)}%.\n${(gate.limitations || []).map(escapeHtml).join('\n')}`, { parse_mode: 'HTML' });
    if (gate.passed !== true) return;
    const phrase = `RESTORE CARTESIA AGENT ${agentId} FROM VERSION ${versionId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Restore Cartesia agent ${agentId} from version ${versionId}? This creates a new configuration version; existing version history is retained and active calls continue on their starting version.`)) return;
    const restored = await httpClient.post(ctx, rootPath('agents', encodeURIComponent(agentId), 'versions', encodeURIComponent(versionId), 'restore'), { actor_id: String(ctx.from.id), confirmation_phrase: phrase, evaluation }, { timeout: 45000, retry: { retries: 0 } });
    ensureActive();
    await ctx.reply(`Restored configuration from ${escapeHtml(restored?.data?.restoredFromVersionId || versionId)}. New version: ${escapeHtml(restored?.data?.currentVersionId || 'not returned')}.`);
    return;
  }
  if (operation.toLowerCase() === 'update-agent') {
    const mode = await askInput(conversation, ctx, 'Type guided to set voice, speed, volume, noise suppression, and keyterms through prompts, or advanced for a validated JSON update.', ensureActive);
    if (!mode) return;
    let settings;
    if (mode.toLowerCase() === 'guided') {
      const config = await collectGuidedAudioConfig(conversation, ctx, ensureActive);
      if (!config) return;
      settings = { config };
    } else if (mode.toLowerCase() === 'advanced') {
      const raw = await askInput(conversation, ctx, 'Enter a JSON object of supported agent settings. Example: {"config":{"audio":{"output":{"voice_id":"voice_1","speed":1.0}},"system_tools":{"send_dtmf":{},"voicemail_detection":null}}}', ensureActive);
      try { settings = JSON.parse(raw || ''); } catch { settings = null; }
    }
    const allowed = new Set(['name', 'description', 'tts_voice', 'tts_language', 'noise_suppression_level', 'webhook_id', 'config', 'version_description']);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Object.keys(settings).length || Object.keys(settings).some((key) => !allowed.has(key))) {
      await ctx.reply('Agent update canceled. Provide a JSON object containing only supported keys.'); return;
    }
    const summary = summarizeAgentUpdate(settings);
    const phrase = `UPDATE CARTESIA AGENT ${agentId}`;
    const transferWarning = settings.config?.system_tools?.transfer_to_number ? ' Transfers work only for Twilio or SIP-trunked phone calls; they do not work in Playground or Cartesia v1 WebSocket calls.' : '';
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Update Cartesia agent ${agentId} with settings ${summary}? This changes the agent configuration.${transferWarning}`)) return;
    const result = await httpClient.patch(ctx, rootPath('agents', encodeURIComponent(agentId)), { actor_id: String(ctx.from.id), ...settings, confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply(`Updated Cartesia agent ${escapeHtml(result?.data?.agent?.name || agentId)}. Current version: ${escapeHtml(result?.data?.agent?.currentVersionId || 'not returned')}.`, { parse_mode: 'HTML' });
    return;
  }
  if (operation.toLowerCase() === 'assign') {
    const phoneId = await askInput(conversation, ctx, 'Enter the phone-number ID to assign to this agent.', ensureActive);
    if (!phoneId || !ID_PATTERN.test(phoneId)) { await ctx.reply('Phone-number assignment canceled. Invalid ID.'); return; }
    const phrase = `ASSIGN CARTESIA PHONE ${phoneId} TO AGENT ${agentId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Assign phone number ${phoneId} to Cartesia agent ${agentId}? This changes inbound routing.`)) return;
    await httpClient.patch(ctx, rootPath('phone-numbers', encodeURIComponent(phoneId)), { actor_id: String(ctx.from.id), agent_id: agentId, confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply(`Phone number ${escapeHtml(phoneId)} is assigned to agent ${escapeHtml(agentId)}.`, { parse_mode: 'HTML' });
    return;
  }
  if (operation.toLowerCase() === 'import') {
    const number = await askInput(conversation, ctx, 'Enter the existing E.164 number to import (for example +14155550123).', ensureActive);
    const providerId = await askInput(conversation, ctx, 'Enter its Cartesia phone-provider ID. No provider credentials are requested here.', ensureActive);
    const label = await askInput(conversation, ctx, 'Enter a short label for the number.', ensureActive);
    if (!number || !providerId || !label || !/^\+[1-9]\d{7,14}$/.test(number) || !ID_PATTERN.test(providerId)) { await ctx.reply('Phone-number import canceled. Check the E.164 number and provider ID.'); return; }
    const phrase = `IMPORT CARTESIA PHONE ENDING ${number.slice(-4)} FROM PROVIDER ${providerId} LABEL ${label.toUpperCase()} FOR AGENT ${agentId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Import the existing number ending ${number.slice(-4)} from provider ${providerId} with label “${label}” and assign it to agent ${agentId}?`)) return;
    const result = await httpClient.post(ctx, rootPath('phone-numbers', 'import'), { actor_id: String(ctx.from.id), number, provider: { id: providerId }, label, agent_id: agentId, confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply(`Imported Cartesia phone number ${escapeHtml(result?.data?.phoneNumber?.number || `••••${number.slice(-4)}`)}.`, { parse_mode: 'HTML' });
    return;
  }
  if (operation.toLowerCase() === 'provision') {
    const label = await askInput(conversation, ctx, 'Enter a label for the new Cartesia-managed US phone number.', ensureActive);
    if (!label || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/.test(label)) { await ctx.reply('Number provisioning canceled. Invalid label.'); return; }
    const phrase = `PROVISION CARTESIA US PHONE ${label.toUpperCase()} FOR AGENT ${agentId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Request a Cartesia-managed US phone number labeled “${label}” and assign it to agent ${agentId}? Cartesia may charge for phone-number service.`)) return;
    const result = await httpClient.post(ctx, rootPath('phone-numbers', 'provision'), { actor_id: String(ctx.from.id), label, agent_id: agentId, confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply(`Provisioned Cartesia phone number ${escapeHtml(result?.data?.phoneNumber?.number || 'number unavailable')} for agent ${escapeHtml(agentId)}.`, { parse_mode: 'HTML' });
    return;
  }
  await ctx.reply('No change was made. Choose update-agent, assign, import, provision, or done.');
}

async function runUsage(conversation, ctx, ensureActive) {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const query = new URLSearchParams({ actor_id: String(ctx.from.id), start_ts: start.toISOString(), end_ts: end.toISOString(), interval: 'day' });
  const [credits, agents] = await Promise.all([
    httpClient.get(ctx, actorUrl(ctx, `${rootPath('usage', 'credits')}?${query}`), { timeout: 25000 }),
    httpClient.get(ctx, actorUrl(ctx, `${rootPath('usage', 'agents')}?${query}`), { timeout: 25000 }),
  ]);
  ensureActive();
  const creditRows = Array.isArray(credits?.data?.usage) ? credits.data.usage.slice(-7) : [];
  const agentRows = Array.isArray(agents?.data?.usage) ? agents.data.usage.slice(-7) : [];
  const creditSum = creditRows.reduce((sum, item) => sum + (Number(item.credits) || 0), 0);
  const costCents = agentRows.reduce((sum, item) => sum + (Number(item.cents) || 0), 0);
  const minutes = agentRows.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
  const calls = agentRows.reduce((sum, item) => sum + (Number(item.calls) || 0), 0);
  await ctx.reply(`<b>Cartesia usage · last 7 days</b>\nCredits consumed: ${creditSum.toLocaleString()}\nAgent usage: $${(costCents / 100).toFixed(2)} · ${minutes.toFixed(1)} minutes · ${calls} calls\n\n${agentRows.map((item) => `${escapeHtml(item.startAt || 'period')}: ${Number(item.cents) || 0}¢ · ${(Number(item.minutes) || 0).toFixed(1)} min · ${Number(item.calls) || 0} calls`).join('\n') || 'No agent usage returned.'}`, { parse_mode: 'HTML' });
}

async function runKnowledgeBase(conversation, ctx, ensureActive) {
  const mode = await askInput(conversation, ctx, 'Type folders, documents, create-folder, create-document, or attach-folder.', ensureActive);
  if (!mode) return;
  const choice = mode.toLowerCase();
  if (choice === 'folders') {
    const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('knowledge-base', 'folders')), { timeout: 20000 });
    ensureActive();
    const folders = Array.isArray(response?.data?.folders) ? response.data.folders : [];
    await ctx.reply(folders.length ? `<b>Cartesia Knowledge Base folders</b>\n${folders.slice(0, 30).map((item) => `• ${escapeHtml(item.name)} — <code>${escapeHtml(item.id)}</code> · ${Number(item.documentCount) || 0} docs · agents ${item.agentIds?.length || 0}`).join('\n')}` : 'No Cartesia Knowledge Base folders found.', { parse_mode: 'HTML' });
    return;
  }
  if (choice === 'documents') {
    const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('knowledge-base', 'documents')), { timeout: 20000 });
    ensureActive();
    const documents = Array.isArray(response?.data?.documents) ? response.data.documents : [];
    await ctx.reply(documents.length ? `<b>Cartesia Knowledge Base documents</b>\n${documents.slice(0, 30).map((item) => `• ${escapeHtml(item.name)} — <code>${escapeHtml(item.id)}</code> · ${Number(item.contentLength) || 0} chars · ${escapeHtml(item.status)}`).join('\n')}` : 'No Cartesia Knowledge Base documents found. Document contents are never shown here.', { parse_mode: 'HTML' });
    return;
  }
  if (choice === 'create-folder') {
    const name = await askInput(conversation, ctx, 'Enter the folder name (up to 120 characters).', ensureActive);
    if (!name) return;
    const phrase = `CREATE CARTESIA KB FOLDER ${name.trim().toUpperCase()}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Create the Cartesia Knowledge Base folder “${name.slice(0, 120)}”?`)) return;
    await httpClient.post(ctx, rootPath('knowledge-base', 'folders'), { actor_id: String(ctx.from.id), name, confirmation_phrase: phrase }, { timeout: 20000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply('Cartesia Knowledge Base folder created.'); return;
  }
  if (choice === 'create-document') {
    const folderId = await askInput(conversation, ctx, 'Enter an existing Cartesia folder ID.', ensureActive);
    if (!folderId || !ID_PATTERN.test(folderId)) return;
    const name = await askInput(conversation, ctx, 'Enter a document title (up to 120 characters).', ensureActive);
    if (!name) return;
    const content = await askInput(conversation, ctx, 'Enter the document content (up to 65,536 characters). Do not include passwords, API keys, or unnecessary personal data.', ensureActive);
    if (!content || content.length > 65536) { await ctx.reply('Document creation canceled. Content must be 1–65,536 characters.'); return; }
    const contentFingerprint = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const phrase = `CREATE CARTESIA KB DOCUMENT ${name.trim().toUpperCase()} IN FOLDER ${folderId} CONTENT SHA256 ${contentFingerprint}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Create document “${name.slice(0, 120)}” in folder ${folderId}? The content will be sent to Cartesia and will not be echoed in bot responses.`)) return;
    await httpClient.post(ctx, rootPath('knowledge-base', 'documents'), {
      actor_id: String(ctx.from.id), folder_id: folderId, name, content, confirmation_phrase: phrase,
    }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply('Cartesia Knowledge Base document created. Content was not returned.'); return;
  }
  if (choice === 'attach-folder') {
    const folderId = await askInput(conversation, ctx, 'Enter the Cartesia folder ID to attach to Managed Agents.', ensureActive);
    if (!folderId || !ID_PATTERN.test(folderId)) return;
    const agentText = await askInput(conversation, ctx, 'Enter agent IDs separated by commas. Enter none to detach all agents.', ensureActive);
    if (agentText === null) return;
    const agentIds = agentText.toLowerCase() === 'none' ? [] : agentText.split(',').map((id) => id.trim()).filter(Boolean);
    if (agentIds.length > 100 || agentIds.some((id) => !ID_PATTERN.test(id))) { await ctx.reply('Folder attachment canceled. Check the agent IDs.'); return; }
    const phrase = `SET CARTESIA KB AGENTS FOR FOLDER ${folderId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Set this folder’s searchable agents to ${agentIds.length || 'none'}?`)) return;
    await httpClient.put(ctx, rootPath('knowledge-base', 'folders', encodeURIComponent(folderId), 'agents'), {
      actor_id: String(ctx.from.id), agent_ids: agentIds, confirmation_phrase: phrase,
    }, { timeout: 20000, retry: { retries: 0 } });
    ensureActive(); await ctx.reply('Cartesia Knowledge Base folder agent assignment updated.'); return;
  }
  await ctx.reply('No change was made. Choose folders, documents, create-folder, create-document, or attach-folder.');
}

async function runSipProviders(ctx, ensureActive) {
  const response = await httpClient.get(ctx, actorUrl(ctx, `${apiRoot()}/api/cartesia/providers`), { timeout: 20000 });
  ensureActive();
  const providers = Array.isArray(response?.data?.providers) ? response.data.providers : [];
  const summary = providers.length ? providers.slice(0, 30).map((item) =>
    `• ${escapeHtml(item.label || 'Provider')} — ${escapeHtml(item.type)} · ${Number(item.phone_number_count) || 0} numbers · <code>${escapeHtml(item.id)}</code>`).join('\n') : 'No Cartesia telephony providers found.';
  await ctx.reply(`<b>Cartesia SIP / telephony providers</b>\n${summary}\n\nCredentialed provider changes must use the authenticated API. Do not send SIP passwords, Twilio secrets, or API keys in Telegram.`, { parse_mode: 'HTML' });
}

async function runEnterprisePrivacy(ctx, ensureActive = () => {}) {
  try {
    const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('privacy-readiness')), { timeout: 15000 });
    ensureActive();
    const status = response?.data || {};
    const zdr = status.zeroDataRetention || {};
    const regional = status.regionalEndpoint || {};
    const endpointLabel = status.endpointStatus === 'default_endpoint' ? 'Cartesia default endpoint' : `custom endpoint${regional.websocketHostMatches ? ' · REST/WebSocket host aligned' : ' · verify REST/WebSocket host alignment'}`;
    const regionalStatus = regional.status === 'custom_endpoint_unverified' ? 'configured endpoint is custom; verify provisioning with Cartesia' : 'requires Cartesia Enterprise provisioning';
    await ctx.reply(`<b>Cartesia enterprise data controls</b>\nAPI setup: ${status.providerConfigured ? 'configured' : 'not configured'} · API version: ${escapeHtml(status.apiVersion || 'unknown')}\nEndpoint: ${escapeHtml(endpointLabel)}\nZero Data Retention: ${escapeHtml(String(zdr.status || 'unknown').replace(/_/g, ' '))} · Enterprise-only · account setting cannot be read through this API.\nCovered inference: ${(Array.isArray(zdr.coveredWorkflows) ? zdr.coveredWorkflows : []).map(escapeHtml).join(', ') || 'TTS/STT'}\nExcluded: ${(Array.isArray(zdr.excludedWorkflows) ? zdr.excludedWorkflows : []).map(escapeHtml).join(', ') || 'voice cloning and voice creation'}\nRegional endpoint: ${escapeHtml(regionalStatus)}; account entitlement and hostname must be confirmed with Cartesia.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia data-control readiness is unavailable. Confirm ZDR and regional endpoint status with Cartesia.'));
  }
}

async function runCartesiaReadiness(ctx, ensureActive = () => {}) {
  try {
    const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('readiness')), { timeout: 30000, retry: { retries: 0 } });
    ensureActive();
    const result = response?.data || {};
    const configuration = result.configuration || {};
    const credentials = result.credentials || {};
    const voices = result.voices || {};
    const agents = result.agents || {};
    const webhook = result.webhook || {};
    const receipts = result.webhookReceipts || {};
    const attachedCount = Number.isFinite(Number(webhook.attachedAgentCount)) ? Number(webhook.attachedAgentCount) : null;
    const apiStatus = credentials.api === 'ok' ? 'verified' : credentials.api || (configuration.apiConfigured ? 'configured' : 'not configured');
    const receiptWindow = Number(receipts.sampleLimit) > 0 ? `latest ${Number(receipts.count) || 0} receipts (sample capped at ${Number(receipts.sampleLimit)})` : `${Number(receipts.count) || 0} in 30 days`;
    const eventSummary = Object.entries(receipts.eventTypes || {}).map(([type, count]) => `${escapeHtml(type)}: ${Number(count) || 0}`).join(', ') || 'none recorded';
    const recommendations = Array.isArray(result.recommendations) ? result.recommendations.slice(0, 8).map((line) => `• ${escapeHtml(line)}`).join('\n') : '';
    await ctx.reply(`<b>Cartesia integration readiness</b>\nProvider: ${configuration.enabled ? 'enabled' : 'disabled'} · API: ${escapeHtml(apiStatus)} · version ${escapeHtml(configuration.apiVersion || 'unknown')}\nAPI credential: ${configuration.apiKeyPresent ? 'present' : 'missing'} · Admin credential: ${configuration.adminCredentialPresent ? 'present' : 'missing'}\nVoices: ${escapeHtml(voices.status || 'unknown')}${voices.sampleCount === null || voices.sampleCount === undefined ? '' : ` · at least ${Number(voices.sampleCount) || 0} returned`}\nAgents: ${escapeHtml(agents.status || 'unknown')}${agents.count === null || agents.count === undefined ? '' : ` · ${Number(agents.count) || 0} listed`}\nWebhook: ${escapeHtml(webhook.status || 'unknown')} · secret ${webhook.secretConfigured ? 'configured' : 'missing/too short'} · callback ${webhook.callbackConfigured ? 'URL valid; reachability untested' : 'missing/invalid'} · registered ${webhook.registered === null ? 'not checked' : webhook.registered ? 'yes' : 'no'} · attached agents ${attachedCount ?? 'not checked'}\nVOICEDNUT webhook receipts (${escapeHtml(receiptWindow)}): latest ${escapeHtml(receipts.latestReceivedAt || 'none')} · ${eventSummary}\n${recommendations ? `<b>Recommended actions</b>\n${recommendations}\n` : ''}<i>${escapeHtml(receipts.source || 'Provider delivery attempts are not available through this check.')}</i>\nChecked: ${escapeHtml(result.generatedAt || 'unknown')}`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia readiness could not be checked. Review API configuration and try again.'));
  }
}

async function runSttProfile(conversation, ctx, ensureActive) {
  const loaded = await httpClient.get(ctx, actorUrl(ctx, rootPath('stt-profile')), { timeout: 15000 });
  const existing = loaded?.data?.profile;
  if (existing) {
    await ctx.reply(`<b>Saved Cartesia STT profile</b>\nKeyterms: ${(existing.keyterms || []).map(escapeHtml).join(', ') || 'none'}\nTurn thresholds: start ${Number(existing.turnSettings?.start_threshold)}, eager end ${Number(existing.turnSettings?.eager_end_threshold)}, end ${Number(existing.turnSettings?.end_threshold)}\nEnd timeout: ${Number(existing.turnSettings?.end_timeout_ms)} ms`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply('No saved Cartesia STT profile was found.');
  }
  const termsText = await askInput(conversation, ctx, 'Enter up to 100 uncommon keyterms separated by commas (or none).', ensureActive);
  if (termsText === null) return;
  const keyterms = termsText.toLowerCase() === 'none' ? [] : termsText.split(',').map((term) => term.trim()).filter(Boolean);
  const startText = await askInput(conversation, ctx, 'Turn start threshold, 0.5–0.9 (default 0.8).', ensureActive);
  if (startText === null) return;
  const eagerText = await askInput(conversation, ctx, 'Eager-end threshold, 0.3–0.8 (default 0.6).', ensureActive);
  if (eagerText === null) return;
  const endText = await askInput(conversation, ctx, 'End threshold, 0.05–0.5 (default 0.3).', ensureActive);
  if (endText === null) return;
  const timeoutText = await askInput(conversation, ctx, 'Turn-end timeout in ms, 640–11200 (default 5600).', ensureActive);
  if (timeoutText === null) return;
  const response = await httpClient.post(ctx, rootPath('stt-profile/validate'), {
    actor_id: String(ctx.from.id), keyterms,
    turn_settings: {
      start_threshold: startText ? Number(startText) : 0.8,
      eager_end_threshold: eagerText ? Number(eagerText) : 0.6,
      end_threshold: endText ? Number(endText) : 0.3,
      end_timeout_ms: timeoutText ? Number(timeoutText) : 5600,
    },
  }, { timeout: 20000 });
  ensureActive();
  const profile = response?.data || {};
  await ctx.reply(`<b>Validated Cartesia Realtime STT profile</b>\nKeyterms: ${profile.keyterms?.length ? profile.keyterms.map(escapeHtml).join(', ') : 'none'}\nTurn thresholds: start ${profile.turnSettings?.start_threshold}, eager end ${profile.turnSettings?.eager_end_threshold}, end ${profile.turnSettings?.end_threshold}\nEnd timeout: ${Number(profile.turnSettings?.end_timeout_ms) || 0} ms\nUse these values when opening Cartesia Ink Realtime STT. This validates the profile; it does not change an existing Cartesia agent.`, { parse_mode: 'HTML' });
  const save = await askInput(conversation, ctx, 'Type save to persist this reusable profile in VOICEDNUT, or done.', ensureActive);
  if (save?.toLowerCase() !== 'save') return;
  const phrase = 'SAVE CARTESIA STT PROFILE';
  if (!await confirm(conversation, ctx, phrase, ensureActive, 'Save this reusable Cartesia STT profile in VOICEDNUT? It will not change existing agents or initiate a call.')) {
    await ctx.reply('STT profile was validated but not saved.');
    return;
  }
  const saved = await httpClient.post(ctx, rootPath('stt-profile'), {
    actor_id: String(ctx.from.id), keyterms: profile.keyterms, turn_settings: profile.turnSettings, confirmation_phrase: phrase,
  }, { timeout: 20000 });
  ensureActive();
  await ctx.reply(`STT profile saved in VOICEDNUT at ${escapeHtml(saved?.data?.updatedAt || 'unknown time')}. Apply these values when opening Cartesia Ink Realtime STT; the current Managed Agent call path is unchanged.`, { parse_mode: 'HTML' });
}

async function runAgentWebhookOperations(conversation, ctx, ensureActive) {
  const response = await httpClient.get(ctx, actorUrl(ctx, rootPath('webhooks')), { timeout: 20000 });
  ensureActive();
  const webhooks = Array.isArray(response?.data?.webhooks) ? response.data.webhooks.slice(0, 50) : [];
  await ctx.reply(`<b>Cartesia call lifecycle webhooks</b>\n${webhooks.map((row) => `• ${escapeHtml(row.displayName || 'Unnamed')} · <code>${escapeHtml(row.id || '')}</code>\n  ${escapeHtml(row.url || 'callback URL hidden')}`).join('\n') || 'No event webhooks are configured.'}\n\nSecrets are stored on the server and are never returned by Cartesia.`, { parse_mode: 'HTML' });
  const operation = (await askInput(conversation, ctx, 'Type create, rename, rotate-secret, delete, attach, detach, or done.', ensureActive))?.toLowerCase();
  if (!operation || operation === 'done') return;
  if (operation === 'create') {
    const name = await askInput(conversation, ctx, 'Enter a short display name for this call lifecycle webhook.', ensureActive);
    if (!name || !NAME_PATTERN.test(name)) { if (name !== null) await ctx.reply('Webhook creation canceled. Use a name with letters, numbers, spaces, dots, underscores, or hyphens.'); return; }
    const phrase = `CREATE CARTESIA AGENT WEBHOOK ${name.toUpperCase()}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, 'Create a Cartesia agent event webhook pointing at the server-configured VOICEDNUT callback?')) return;
    const created = await httpClient.post(ctx, actorUrl(ctx, rootPath('webhooks')), { actor_id: String(ctx.from.id), display_name: name, confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive();
    await ctx.reply(`Cartesia lifecycle webhook created: <code>${escapeHtml(created?.data?.webhook?.id || 'ID unavailable')}</code>. Attach it to an agent using this menu.`, { parse_mode: 'HTML' });
    return;
  }
  if (operation === 'attach' || operation === 'detach') {
    const agentId = await askInput(conversation, ctx, 'Enter the Cartesia agent ID.', ensureActive);
    if (!agentId || !ID_PATTERN.test(agentId)) { if (agentId !== null) await ctx.reply('Agent update canceled. Invalid ID.'); return; }
    let webhookId = null;
    if (operation === 'attach') {
      if (!webhooks.length) { await ctx.reply('Create or list a Cartesia webhook before attaching one.'); return; }
      const selected = await askInput(conversation, ctx, `Enter one webhook ID from the list: ${webhooks.map((row) => row.id).join(', ')}`, ensureActive);
      if (!selected || !webhooks.some((row) => row.id === selected)) { if (selected !== null) await ctx.reply('Agent update canceled. Choose a listed webhook ID.'); return; }
      webhookId = selected;
    }
    const phrase = `UPDATE CARTESIA AGENT ${agentId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `${operation === 'attach' ? 'Attach' : 'Detach'} the lifecycle webhook ${operation === 'attach' ? webhookId : 'currently assigned'} ${operation === 'attach' ? 'to' : 'from'} agent ${agentId}?`)) return;
    await httpClient.patch(ctx, rootPath('agents', encodeURIComponent(agentId)), { actor_id: String(ctx.from.id), webhook_id: webhookId, confirmation_phrase: phrase }, { timeout: 30000, retry: { retries: 0 } });
    ensureActive();
    await ctx.reply(`Cartesia lifecycle webhook ${operation === 'attach' ? 'attached' : 'detached'} for agent <code>${escapeHtml(agentId)}</code>.`, { parse_mode: 'HTML' });
    return;
  }
  const webhookId = await askInput(conversation, ctx, `Enter a webhook ID from the list: ${webhooks.map((row) => row.id).join(', ')}`, ensureActive);
  if (!webhookId || !webhooks.some((row) => row.id === webhookId)) { if (webhookId !== null) await ctx.reply('Webhook operation canceled. Choose an ID from the list.'); return; }
  if (operation === 'rename' || operation === 'rotate-secret') {
    let name;
    if (operation === 'rename') {
      name = await askInput(conversation, ctx, 'Enter its new display name.', ensureActive);
      if (!name || !NAME_PATTERN.test(name)) { if (name !== null) await ctx.reply('Webhook update canceled. Invalid display name.'); return; }
    }
    const phrase = `UPDATE CARTESIA AGENT WEBHOOK ${webhookId}`;
    const body = { actor_id: String(ctx.from.id), confirmation_phrase: phrase,
      ...(operation === 'rename' ? { display_name: name } : { rotate_secret: true }) };
    if (!await confirm(conversation, ctx, phrase, ensureActive, operation === 'rename'
      ? `Rename Cartesia lifecycle webhook ${webhookId}?`
      : `Rotate the Cartesia webhook secret for ${webhookId} to the currently configured server secret? The secret will not be displayed.`)) return;
    await httpClient.patch(ctx, actorUrl(ctx, rootPath('webhooks', encodeURIComponent(webhookId))), body, { timeout: 30000, retry: { retries: 0 } });
    ensureActive();
    await ctx.reply(`Cartesia lifecycle webhook <code>${escapeHtml(webhookId)}</code> ${operation === 'rename' ? 'renamed' : 'secret rotated'}.`, { parse_mode: 'HTML' });
    return;
  }
  if (operation === 'delete') {
    const phrase = `DELETE CARTESIA AGENT WEBHOOK ${webhookId}`;
    if (!await confirm(conversation, ctx, phrase, ensureActive, `Delete Cartesia lifecycle webhook ${webhookId}? Detach it from agents first; Cartesia rejects deletion while it is assigned.`)) return;
    await httpClient.del(ctx, actorUrl(ctx, rootPath('webhooks', encodeURIComponent(webhookId))), { data: { actor_id: String(ctx.from.id), confirmation_phrase: phrase }, timeout: 30000, retry: { retries: 0 } });
    ensureActive();
    await ctx.reply(`Cartesia lifecycle webhook <code>${escapeHtml(webhookId)}</code> deleted.`, { parse_mode: 'HTML' });
    return;
  }
  await ctx.reply('Choose create, rename, rotate-secret, delete, attach, detach, or done.');
}

async function cartesiaStudioFlow(conversation, ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) { await ctx.reply('Cartesia Studio is available to administrators only.'); return; }
  if (ctx.chat?.type !== 'private') { await ctx.reply('Open a private chat with the bot before managing voice resources or samples.'); return; }
  const action = String(ctx.session?.cartesiaStudioAction || '');
  if (!ACTIONS.has(action)) { await ctx.reply('That Cartesia Studio action expired. Reopen /cartesia and select it again.'); return; }
  const token = startOperation(ctx, `cartesia-studio:${action.toLowerCase()}`);
  const ensureActive = () => ensureOperationActive(ctx, token);
  try {
    if (action === 'CARTESIA_STUDIO_VOICES') {
      await showVoices(conversation, ctx, ensureActive);
      const next = await askInput(conversation, ctx, 'Type clone for Instant Voice Clone, pro for Pro Voice Clone, governance to review/revoke clone consent or delete a tracked Instant Clone, or done.', ensureActive);
      if (next?.toLowerCase() === 'clone') await runInstantClone(conversation, ctx, ensureActive);
      else if (next?.toLowerCase() === 'pro') await runProClone(conversation, ctx, ensureActive);
      else if (next?.toLowerCase() === 'governance') await runVoiceGovernance(conversation, ctx, ensureActive);
      return;
    }
    if (action === 'CARTESIA_STUDIO_PREVIEW') return await runPreview(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_PHRASE_CACHE') return await runPreview(conversation, ctx, ensureActive, true);
    if (action === 'CARTESIA_STUDIO_DICTIONARIES') {
      const next = await askInput(conversation, ctx, 'Type create to add pronunciation entries, or list to only review dictionaries.', ensureActive);
      if (next === null) return;
      return await runDictionaryFlow(conversation, ctx, ensureActive, next.toLowerCase() === 'create');
    }
    if (action === 'CARTESIA_STUDIO_QUALITY') return await runQuality(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_LOGS') return await runLogs(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_TOOLS') {
      const next = await askInput(conversation, ctx, 'Type create to add a read-only webhook, client to define a WebSocket client tool, or list to review existing tools.', ensureActive);
      if (next === null) return;
      if (next.toLowerCase() === 'client') return await runClientToolCreate(conversation, ctx, ensureActive);
      return await runTools(conversation, ctx, ensureActive, next.toLowerCase() === 'create');
    }
    if (action === 'CARTESIA_STUDIO_WEBHOOKS') return await runAgentWebhookOperations(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_READINESS') return await runCartesiaReadiness(ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_STT') return await runSttProfile(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_VOICE_MANAGE') return await runVoiceManagement(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_STREAMS') {
      await ctx.reply('Continuous live microphone transcription is available to trusted clients through VOICEDNUT’s authenticated Cartesia STT WebSocket API. Telegram bot transcription below works from uploaded audio clips.');
      const mode = await askInput(conversation, ctx, 'Type tts to stream speech, stt to transcribe with Cartesia Ink, or cancel.', ensureActive);
      if (mode?.toLowerCase() === 'tts') return await runStreamingSpeech(conversation, ctx, ensureActive);
      if (mode?.toLowerCase() === 'stt') return await runInkTranscription(conversation, ctx, ensureActive);
      return;
    }
    if (action === 'CARTESIA_STUDIO_CONTINUATIONS') return await runSpeechContinuations(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_KNOWLEDGE_BASE') return await runKnowledgeBase(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_SIP_PROVIDERS') return await runSipProviders(ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_ENTERPRISE_PRIVACY') return await runEnterprisePrivacy(ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_INFILL') return await runInfill(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_AGENTS') return await runAgentAndPhoneOperations(conversation, ctx, ensureActive);
    if (action === 'CARTESIA_STUDIO_USAGE') return await runUsage(conversation, ctx, ensureActive);
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia Studio could not complete that action.'));
  }
}

function registerCartesiaStudioCommand(bot) {
  bot.command('cartesia', async (ctx) => renderCartesiaStudio(ctx));
}

module.exports = {
  ACTIONS,
  buildCartesiaStudioKeyboard,
  renderCartesiaStudio,
  cartesiaStudioFlow,
  registerCartesiaStudioCommand,
  __testables: { readOnlyConfirmation, safeConfigChanges, summarizeAgentUpdate, applyTtsMarkup, runVoiceGovernance, runClientToolCreate, runSttProfile, showVoices, runQuality, runLogs, runVoiceManagement, runStreamingSpeech, runSpeechContinuations, runInkTranscription, runInfill, runAgentAndPhoneOperations, runUsage, runKnowledgeBase, runSipProviders, runEnterprisePrivacy, runCartesiaReadiness, audioFromSse, pcm16ToWav },
};
