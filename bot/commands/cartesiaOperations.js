'use strict';

const crypto = require('node:crypto');
const { InlineKeyboard, InputFile } = require('grammy');
const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { buildCallbackData, matchesCallbackPrefix, parseCallbackData, validateCallback } = require('../utils/actions');
const { escapeHtml, renderMenu } = require('../utils/ui');
const { startOperation, ensureOperationActive } = require('../utils/sessionState');

const ACTIONS = new Set([
  'CARTESIA_RECONCILE', 'CARTESIA_CALLS', 'CARTESIA_REVIEW_QUEUE',
  'CARTESIA_REVIEW_RULES', 'CARTESIA_CAMPAIGN_STATUS', 'CARTESIA_CAMPAIGN_RECONCILE',
  'CARTESIA_BATCH_RECONCILE', 'CARTESIA_BATCH_CANCEL', 'CARTESIA_AGENT_HEALTH',
  'CARTESIA_AGENT_RUNTIME', 'CARTESIA_BUSINESS_SCOPE',
  'CARTESIA_DASHBOARD', 'CARTESIA_MANAGE_VOICES', 'CARTESIA_MODELS',
  'CARTESIA_PROFILE_SCOPE',
  'CARTESIA_VOICE_SETTINGS', 'CARTESIA_TEST_VOICE', 'CARTESIA_USAGE',
  'CARTESIA_CONNECTION_STATUS', 'CARTESIA_REFRESH', 'CARTESIA_OPERATIONS'
]);
const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const DESTINATION_PATTERN = /^\+[1-9]\d{7,14}$/;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,180}$/;
const CANCEL_WORDS = new Set(['cancel', 'exit', 'quit']);
const DASHBOARD_PICK_PREFIX = 'cartesia-pick';
const PAGE_SIZE = 8;

function apiRoot() {
  return String(config.apiUrl || '').replace(/\/+$/, '');
}

function buildCartesiaDashboardKeyboard(ctx) {
  return new InlineKeyboard()
    .text('🏢 Business profile', buildCallbackData(ctx, 'CARTESIA_PROFILE_SCOPE')).row()
    .text('🎤 Manage Voices', buildCallbackData(ctx, 'CARTESIA_MANAGE_VOICES')).row()
    .text('🧠 Models', buildCallbackData(ctx, 'CARTESIA_MODELS')).row()
    .text('⚙️ Voice Settings', buildCallbackData(ctx, 'CARTESIA_VOICE_SETTINGS')).row()
    .text('🔊 Test Voice', buildCallbackData(ctx, 'CARTESIA_TEST_VOICE')).row()
    .text('📊 Usage & Activity', buildCallbackData(ctx, 'CARTESIA_USAGE')).row()
    .text('🔌 Connection Status', buildCallbackData(ctx, 'CARTESIA_CONNECTION_STATUS')).row()
    .text('🔄 Refresh', buildCallbackData(ctx, 'CARTESIA_REFRESH')).row()
    .text('↩️ Back to Main Menu', buildCallbackData(ctx, 'MENU')).row();
}

function buildCartesiaKeyboard(ctx) {
  return new InlineKeyboard()
    .text('🏢 Business TTS profile', buildCallbackData(ctx, 'CARTESIA_PROFILE_SCOPE')).row()
    .text('🎤 Manage Voices', buildCallbackData(ctx, 'CARTESIA_MANAGE_VOICES')).row()
    .text('🧠 Models', buildCallbackData(ctx, 'CARTESIA_MODELS')).row()
    .text('⚙️ Voice Settings', buildCallbackData(ctx, 'CARTESIA_VOICE_SETTINGS')).row()
    .text('🔊 Test Voice', buildCallbackData(ctx, 'CARTESIA_TEST_VOICE')).row()
    .text('📊 Usage & Activity', buildCallbackData(ctx, 'CARTESIA_USAGE')).row()
    .text('🔌 Connection Status', buildCallbackData(ctx, 'CARTESIA_CONNECTION_STATUS')).row()
    .text('🔧 Operations & Studio', buildCallbackData(ctx, 'CARTESIA_OPERATIONS')).row()
    .text('🔄 Refresh', buildCallbackData(ctx, 'CARTESIA_REFRESH')).row()
    .text('↩️ Back to Main Menu', buildCallbackData(ctx, 'MENU'));
}

function buildCartesiaSpeechKeyboard(ctx) {
  return new InlineKeyboard()
    .text('🏢 Business TTS profile', buildCallbackData(ctx, 'CARTESIA_PROFILE_SCOPE')).row()
    .text('🎤 Manage Voices', buildCallbackData(ctx, 'CARTESIA_MANAGE_VOICES')).row()
    .text('🧠 Models', buildCallbackData(ctx, 'CARTESIA_MODELS')).row()
    .text('⚙️ Voice Settings', buildCallbackData(ctx, 'CARTESIA_VOICE_SETTINGS')).row()
    .text('🔊 Test Voice', buildCallbackData(ctx, 'CARTESIA_TEST_VOICE')).row()
    .text('🔄 Refresh', buildCallbackData(ctx, 'CARTESIA_REFRESH')).row()
    .text('↩️ Back to Main Menu', buildCallbackData(ctx, 'MENU'));
}

function buildCartesiaOperationsKeyboard(ctx) {
  return new InlineKeyboard()
    .text('📞 Place a single call via /call', buildCallbackData(ctx, 'CALL')).row()
    .text('🔎 Check campaign status', buildCallbackData(ctx, 'CARTESIA_CAMPAIGN_STATUS')).row()
    .text('🔄 Refresh provider progress', buildCallbackData(ctx, 'CARTESIA_CAMPAIGN_RECONCILE')).row()
    .text('🔄 Reconcile batch progress', buildCallbackData(ctx, 'CARTESIA_BATCH_RECONCILE')).row()
    .text('🎛 Cartesia Studio', buildCallbackData(ctx, 'CARTESIA_STUDIO_CENTER')).row()
    .text('⛔ Cancel queued batch calls', buildCallbackData(ctx, 'CARTESIA_BATCH_CANCEL')).row()
    .text('📋 Recent calls', buildCallbackData(ctx, 'CARTESIA_CALLS')).row()
    .text('🧭 Post-call review queue', buildCallbackData(ctx, 'CARTESIA_REVIEW_QUEUE')).row()
    .text('🧭 Post-call review rules', buildCallbackData(ctx, 'CARTESIA_REVIEW_RULES')).row()
    .text('🩺 Agent & deployment health', buildCallbackData(ctx, 'CARTESIA_AGENT_HEALTH')).row()
    .text('🔌 Managed Agent runtime', buildCallbackData(ctx, 'CARTESIA_AGENT_RUNTIME')).row()
    .text('🏢 Assign number to a business', buildCallbackData(ctx, 'CARTESIA_BUSINESS_SCOPE')).row()
    .text('🔎 Reconcile a call', buildCallbackData(ctx, 'CARTESIA_RECONCILE')).row()
    .text('⬅️ Cartesia Dashboard', buildCallbackData(ctx, 'CARTESIA_DASHBOARD'));
}

async function loadCartesiaDashboardSummary(ctx, isAdmin = false) {
  const summary = {
    connection: 'not configured',
    business: String(ctx.session?.cartesiaSpeechBusinessId || '').trim() || 'not selected',
    voice: 'not selected',
    model: 'not selected',
    engine: 'unavailable',
    usage: 'Usage unavailable',
  };
  if (isAdmin) {
    try {
      const statusResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/status`, { timeout: 10000 });
      const payload = statusResponse?.data?.status || {};
      const configured = payload.configured === true;
      summary.connection = configured ? 'configured' : 'not configured';
      summary.engine = payload.enabled === true ? 'enabled' : 'disabled';
    } catch (_) {
      summary.connection = 'not verified';
      summary.engine = 'unavailable';
    }
  } else {
    summary.connection = 'administrator-only status';
    summary.usage = 'administrator-only usage';
  }
  try {
    const businessId = String(ctx.session?.cartesiaSpeechBusinessId || '').trim();
    const profileQuery = BUSINESS_ID_PATTERN.test(businessId)
      ? `?${new URLSearchParams({ business_id: businessId })}`
      : '';
    const profileResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/studio/speech-profile${profileQuery}`, { timeout: 10000 });
    const profile = profileResponse?.data?.profile || {};
    if (profile.voice_id) summary.voice = profile.voice_id;
    if (profile.model_id) summary.model = profile.model_id;
    if (profile.language) summary.voice += ` (${profile.language})`;
    if (profile.provider) summary.engine = `${String(profile.provider).toLowerCase()} TTS selected`;
  } catch (_) {
    summary.voice = 'not selected';
    summary.model = 'not selected';
  }
  if (isAdmin) {
    try {
      const usageResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/studio/usage/credits`, { timeout: 10000 });
      const credits = usageResponse?.data || {};
      const providerBuckets = Array.isArray(credits.credits) ? credits.credits :
        Array.isArray(credits.data) ? credits.data :
          Array.isArray(credits.data?.data) ? credits.data.data : [];
      if (providerBuckets.length) {
        const total = providerBuckets.reduce((sum, item) => sum + (Number(item?.credits) || 0), 0);
        summary.usage = `${total} provider-reported credits`;
      } else {
        summary.usage = 'No provider usage returned';
      }
    } catch (_) {
      summary.usage = 'Usage unavailable';
    }
  }
  return summary;
}

async function renderCartesiaCenter(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAuthorized && !access?.isAdmin) {
    await ctx.reply('Cartesia speech management requires an authorized VOICEDNUT account.');
    return;
  }
  const summary = await loadCartesiaDashboardSummary(ctx, access.isAdmin);
  await renderMenu(ctx,
    '<b>🎙️ VOICEDNUT — Cartesia</b>\n\n' +
      `Connection status: ${escapeHtml(summary.connection)}\n` +
      `Business TTS profile: ${escapeHtml(summary.business)}\n` +
      `Active voice configuration: ${escapeHtml(summary.voice)}\n` +
      `Selected model: ${escapeHtml(summary.model)}\n` +
      `AI voice engine status: ${escapeHtml(summary.engine)}\n` +
      `Usage information: ${escapeHtml(summary.usage)}\n\n` +
      'Manage Cartesia speech separately from the telephony provider. Voice tests generate audio only; they never place a call.',
    access.isAdmin ? buildCartesiaKeyboard(ctx) : buildCartesiaSpeechKeyboard(ctx), { parseMode: 'HTML' });
}

async function renderCartesiaOperations(ctx) {
  await renderMenu(ctx,
    '<b>Cartesia Operations & Studio</b>\nManage existing Cartesia calls, batches, agents, and Studio tools. New telephone calls still start through /call and use the selected telephony provider.',
    buildCartesiaOperationsKeyboard(ctx), { parseMode: 'HTML' });
}

async function askInput(conversation, ctx, prompt, ensureActive) {
  await ctx.reply(`${prompt}\nType cancel to stop.`);
  const update = await conversation.wait();
  ensureActive();
  const value = String(update?.message?.text || '').trim();
  return CANCEL_WORDS.has(value.toLowerCase()) ? null : value;
}

function maskDestination(destination) {
  return `••••${String(destination || '').slice(-4)}`;
}

function normalizeDynamicVariables(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, typeof entry === 'string' ? entry.trim() : entry]));
}

function pendingRequestMatches(pending, input) {
  return Boolean(pending &&
    pending.businessId === input.businessId &&
    pending.destination === input.destination &&
    pending.agentId === input.agentId &&
    pending.fromNumberId === input.fromNumberId &&
    JSON.stringify(normalizeDynamicVariables(pending.dynamicVariables)) === JSON.stringify(normalizeDynamicVariables(input.dynamicVariables)));
}

function buildReconciliationPayload(input, actorId) {
  return {
    business_id: input.businessId,
    actor_id: String(actorId || ''),
    destination: input.destination,
    agent_id: input.agentId,
    from_number_id: input.fromNumberId,
    idempotency_key: input.idempotencyKey,
    ...(Object.keys(normalizeDynamicVariables(input.dynamicVariables)).length ? { dynamic_variables: normalizeDynamicVariables(input.dynamicVariables) } : {}),
    ...(typeof input.requestFingerprint === 'string' && /^[a-f0-9]{64}$/.test(input.requestFingerprint) ? { request_fingerprint: input.requestFingerprint } : {}),
  };
}

function buildAgentChoices(agents) {
  return (Array.isArray(agents) ? agents : []).filter((agent) =>
    agent && agent.ready === true && IDENTIFIER_PATTERN.test(String(agent.id || '')) &&
    Array.isArray(agent.phoneNumbers) && agent.phoneNumbers.some((phone) => IDENTIFIER_PATTERN.test(String(phone?.id || ''))))
    .slice(0, 50);
}

function formatAgentChoices(agents) {
  return agents.map((agent, index) =>
    `${index + 1}. ${escapeHtml(agent.name || 'Cartesia agent')} — <code>${escapeHtml(agent.id)}</code> (${Math.max(0, Number(agent.deploymentCount) || 0)} deployments, ${agent.phoneNumbers.length} attached numbers)`)
    .join('\n');
}

function buildHealthAgentChoices(agents) {
  return (Array.isArray(agents) ? agents : []).filter((agent) => agent && IDENTIFIER_PATTERN.test(String(agent.id || ''))).slice(0, 50);
}

function formatAgentHealth(health) {
  const agent = health?.agent || {};
  const warnings = Array.isArray(health?.warnings) ? health.warnings.slice(0, 12) : [];
  const deployments = (Array.isArray(health?.deployments) ? health.deployments : []).slice(0, 10).map((deployment) => {
    const flags = [deployment.isLive ? 'live' : null, deployment.isPinned ? 'pinned' : null,
      deployment.buildFailed ? 'build failed' : null, deployment.deploymentFailed ? 'deployment failed' : null].filter(Boolean);
    return `• <code>${escapeHtml(String(deployment.id || '').slice(0, 80))}</code> — ${escapeHtml(deployment.status || 'unknown')}${flags.length ? ` (${escapeHtml(flags.join(', '))})` : ''}`;
  }).join('\n');
  return `<b>${escapeHtml(agent.name || 'Cartesia agent')}</b> <code>${escapeHtml(agent.id || '')}</code>\n` +
    `Overall: <b>${health?.ready === true ? 'Ready' : 'Needs attention'}</b>\n` +
    `Attached numbers: ${Math.max(0, Number(agent.attachedNumberCount) || 0)} · Deployments: ${Math.max(0, Number(agent.deploymentCount) || 0)}\n` +
    `Warnings: ${warnings.length ? warnings.map(escapeHtml).join(', ') : 'none'}\n` +
    `Deployment details:\n${deployments || '• No deployments reported.'}`;
}

function dashboardActionKeyboard(ctx, choices, { columns = 1 } = {}) {
  const keyboard = new InlineKeyboard();
  choices.forEach((choice, index) => {
    keyboard.text(choice.label, buildCallbackData(ctx, `${DASHBOARD_PICK_PREFIX}:${choice.id}`));
    if ((index + 1) % columns === 0) keyboard.row();
  });
  if (choices.length % columns !== 0) keyboard.row();
  return keyboard;
}

async function waitDashboardAction(conversation, ctx, prompt, choices, ensureActive, options = {}) {
  await ctx.reply(prompt, {
    parse_mode: options.parseMode || 'HTML',
    reply_markup: dashboardActionKeyboard(ctx, choices, options),
  });
  const opToken = String(ctx.session?.currentOp?.token || '');
  const selection = await conversation.waitFor('callback_query:data', (callbackCtx) => {
    const raw = callbackCtx?.callbackQuery?.data;
    if (!raw || !matchesCallbackPrefix(raw, DASHBOARD_PICK_PREFIX)) return false;
    const validation = validateCallback(callbackCtx, raw);
    if (validation.status !== 'ok') return false;
    const parsed = parseCallbackData(raw);
    return !parsed.token || parsed.token === opToken;
  });
  ensureActive();
  await selection.answerCallbackQuery();
  const action = parseCallbackData(selection.callbackQuery.data).action || '';
  return action.slice(DASHBOARD_PICK_PREFIX.length + 1);
}

async function readCartesiaProfile(ctx) {
  const businessId = String(ctx.session?.cartesiaSpeechBusinessId || '').trim();
  if (!BUSINESS_ID_PATTERN.test(businessId)) {
    throw new Error('Select a registered business profile before managing Cartesia speech settings.');
  }
  const query = new URLSearchParams({ business_id: businessId });
  const response = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/studio/speech-profile?${query}`, { timeout: 15000 });
  const profile = response?.data?.profile;
  if (response?.data?.business_id !== businessId ||
      !profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Cartesia returned an invalid saved speech profile.');
  }
  return profile;
}

async function readCartesiaModels(ctx) {
  const query = new URLSearchParams({ capability: 'tts', business_id: String(ctx.session?.cartesiaSpeechBusinessId || '') });
  const response = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/studio/models?${query}`, { timeout: 15000 });
  return Array.isArray(response?.data?.models) ? response.data.models : [];
}

async function saveCartesiaProfile(ctx, profile) {
  const businessId = String(ctx.session?.cartesiaSpeechBusinessId || '').trim();
  if (!BUSINESS_ID_PATTERN.test(businessId)) {
    throw new Error('Select a registered business profile before saving Cartesia speech settings.');
  }
  const cleanProfile = Object.fromEntries(
    ['provider', 'voice_id', 'model_id', 'language', 'speed', 'volume', 'output_format']
      .filter((key) => profile[key] !== undefined)
      .map((key) => [key, profile[key]]),
  );
  const response = await httpClient.put(ctx, `${apiRoot()}/api/cartesia/studio/speech-profile`, {
    actor_id: String(ctx.from?.id || ''),
    business_id: businessId,
    profile: cleanProfile,
    confirmation_phrase: 'SAVE CARTESIA TTS PROFILE',
  }, { timeout: 20000, retry: { retries: 0 } });
  if (response?.data?.business_id !== businessId) {
    throw new Error('Cartesia did not confirm the requested business profile save.');
  }
  return response;
}

function formatCartesiaProfile(profile) {
  return [
    `AI TTS engine: ${escapeHtml(profile.provider || 'not selected')}`,
    `Voice: <code>${escapeHtml(profile.voice_id || 'not selected')}</code>`,
    `Model: <code>${escapeHtml(profile.model_id || 'not selected')}</code>`,
    `Language: ${escapeHtml(profile.language || 'not selected')}`,
    `Speed: ${escapeHtml(String(profile.speed ?? 'not set'))}`,
    `Volume: ${escapeHtml(String(profile.volume ?? 'not set'))}`,
    `Output: ${escapeHtml(profile.output_format || 'not set')}`,
  ].join('\n');
}

async function generateCartesiaPreview(conversation, ctx, ensureActive, profile, prompt = 'Enter up to 600 characters for a Cartesia audio preview.') {
  if (!profile?.voice_id || !profile?.model_id || !profile?.language) {
    await ctx.reply('Select a Cartesia voice, model, and language in Voice Settings before generating a preview.');
    return false;
  }
  const transcript = await askInput(conversation, ctx, prompt, ensureActive);
  if (transcript === null) return false;
  if (!transcript || transcript.length > 600) {
    await ctx.reply('Preview text must contain 1–600 characters. No Cartesia request was made.');
    return false;
  }
  const container = profile.output_format === 'mp3' ? 'mp3' : 'wav';
  const payload = {
    actor_id: String(ctx.from?.id || ''),
    business_id: String(ctx.session?.cartesiaSpeechBusinessId || ''),
    confirmation_phrase: 'GENERATE CARTESIA TTS PREVIEW',
    transcript,
    voice_id: profile.voice_id,
    model_id: profile.model_id,
    language: profile.language,
    speed: Number(profile.speed),
    volume: Number(profile.volume),
    output_format: container === 'mp3'
      ? { container, sample_rate: 24000, bit_rate: 128000 }
      : { container, encoding: 'pcm_s16le', sample_rate: 24000 },
  };
  const response = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/studio/tts-preview`, payload, {
    timeout: 30000,
    retry: { retries: 0 },
  });
  ensureActive();
  const audioBase64 = response?.data?.audioBase64;
  if (typeof audioBase64 !== 'string' || !audioBase64 ||
      audioBase64.length > 11_200_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audioBase64)) {
    throw new Error('Cartesia preview returned invalid audio. No call was placed.');
  }
  const audio = Buffer.from(audioBase64, 'base64');
  if (!audio.length || audio.length > 8 * 1024 * 1024 || audio.toString('base64') !== audioBase64) {
    throw new Error('Cartesia preview audio was invalid or exceeded the allowed size.');
  }
  await ctx.replyWithAudio(new InputFile(audio, `cartesia-preview.${container}`), {
    caption: `Cartesia audio preview · ${profile.model_id}`,
  });
  return true;
}

async function runCartesiaManageVoices(conversation, ctx, ensureActive) {
  try {
    const profile = await readCartesiaProfile(ctx);
    ensureActive();
    const cursorStack = [null];
    let pageIndex = 0;
    let searchQuery = '';
    while (true) {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (searchQuery) params.set('q', searchQuery);
      if (cursorStack[pageIndex]) params.set('starting_after', cursorStack[pageIndex]);
      params.set('business_id', String(ctx.session?.cartesiaSpeechBusinessId || ''));
      const response = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/studio/voices?${params}`, { timeout: 20000 });
      ensureActive();
      const voices = Array.isArray(response?.data?.voices) ? response.data.voices : [];
      if (!voices.length && pageIndex === 0) {
        await ctx.reply('No Cartesia voices match this search. Try another name or language.');
      }
      const choices = voices.map((voice, index) => ({
        id: `voice:${index}`,
        label: `${voice.id === profile.voice_id ? '✓ ' : ''}${String(voice.name || 'Unnamed voice').slice(0, 48)} · ${String(voice.language || voice.accents?.[0]?.locale || 'language ?').slice(0, 16)}`,
      }));
      if (searchQuery) choices.push({ id: 'clear-search', label: 'Clear search' });
      choices.push({ id: 'search', label: '🔎 Search voices' });
      if (pageIndex > 0) choices.push({ id: 'previous', label: '⬅️ Previous page' });
      if (response?.data?.hasMore === true && response?.data?.nextPage) choices.push({ id: 'next', label: '➡️ Next page' });
      choices.push({ id: 'dashboard', label: '↩️ Cartesia Dashboard' });
      choices.push({ id: 'cancel', label: 'Cancel' });
      const selected = await waitDashboardAction(conversation, ctx,
        `<b>Cartesia voices</b>${searchQuery ? ` · search: ${escapeHtml(searchQuery)}` : ''}\nSelect a voice to inspect it. The saved voice is marked ✓.`,
        choices, ensureActive);
      if (selected === 'cancel') return;
      if (selected === 'dashboard') {
        await renderCartesiaCenter(ctx);
        return;
      }
      if (selected === 'search') {
        const query = await askInput(conversation, ctx, 'Search voice name, description, ID, or language (1–100 characters).', ensureActive);
        if (query === null) continue;
        if (!query || query.length > 100) {
          await ctx.reply('Search text must contain 1–100 characters.');
          continue;
        }
        searchQuery = query;
        cursorStack.splice(1);
        pageIndex = 0;
        continue;
      }
      if (selected === 'clear-search') {
        searchQuery = '';
        cursorStack.splice(1);
        pageIndex = 0;
        continue;
      }
      if (selected === 'next') {
        cursorStack.push(response.data.nextPage);
        pageIndex += 1;
        continue;
      }
      if (selected === 'previous') {
        if (pageIndex > 0) pageIndex -= 1;
        continue;
      }
      const match = /^voice:(\d+)$/.exec(selected);
      if (!match || !voices[Number(match[1])]) {
        await ctx.reply('That voice selection expired. Reopen Manage Voices and select an available voice.');
        return;
      }
      const voice = voices[Number(match[1])];
      const detailQuery = new URLSearchParams({ business_id: String(ctx.session?.cartesiaSpeechBusinessId || '') });
      const detailResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/studio/voices/${encodeURIComponent(voice.id)}?${detailQuery}`, { timeout: 15000 });
      ensureActive();
      const detail = detailResponse?.data?.voice || voice;
      const accents = Array.isArray(detail.accents) ? detail.accents.slice(0, 8)
        .map((accent) => `${escapeHtml(accent.locale || 'unknown locale')}${accent.isNative || accent.is_native ? ' (native)' : ''}`).join(', ') : '';
      const selectedAction = await waitDashboardAction(conversation, ctx,
        `<b>${escapeHtml(detail.name || 'Cartesia voice')}</b>\nID: <code>${escapeHtml(detail.id || voice.id)}</code>\nLanguage: ${escapeHtml(detail.language || voice.language || 'not listed')}\n${accents ? `Accents: ${accents}\n` : ''}Access: ${escapeHtml(detail.access || 'not specified')}\n\n${formatCartesiaProfile(profile)}`,
        [
          { id: 'voice-save', label: '✅ Select and save voice' },
          { id: 'voice-preview', label: '🔊 Preview this voice' },
          { id: 'voice-list', label: '⬅️ Back to voices' },
          { id: 'dashboard', label: '↩️ Cartesia Dashboard' },
          { id: 'cancel', label: 'Cancel' },
        ], ensureActive);
      if (selectedAction === 'cancel') return;
      if (selectedAction === 'dashboard') {
        await renderCartesiaCenter(ctx);
        return;
      }
      if (selectedAction === 'voice-list') continue;
      if (selectedAction === 'voice-preview') {
        await generateCartesiaPreview(conversation, ctx, ensureActive, { ...profile, voice_id: voice.id });
        continue;
      }
      if (selectedAction === 'voice-save') {
        if (!profile.model_id || !profile.language) {
          await ctx.reply('Set a TTS model and supported language in Models or Voice Settings before saving a voice.');
          return;
        }
        try {
          await saveCartesiaProfile(ctx, { ...profile, provider: 'cartesia', voice_id: voice.id });
          ensureActive();
          await ctx.reply(`Saved Cartesia voice <b>${escapeHtml(detail.name || voice.id)}</b>.`, { parse_mode: 'HTML' });
        } catch (error) {
          await ctx.reply(httpClient.getUserMessage(error, 'The voice was not saved. Your previous profile remains active.'));
        }
        return;
      }
    }
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia voices could not be loaded.'));
  }
}

async function runCartesiaModels(conversation, ctx, ensureActive) {
  try {
    const [profile, models] = await Promise.all([readCartesiaProfile(ctx), readCartesiaModels(ctx)]);
    ensureActive();
    const ttsModels = models.filter((model) => model?.capability === 'tts' && typeof model.id === 'string');
    if (!ttsModels.length) {
      await ctx.reply('Cartesia returned no callable TTS models. The existing model selection was not changed.');
      return;
    }
    const modelDetails = ttsModels.slice(0, 20).map((model) =>
      `• <code>${escapeHtml(model.id)}</code> · ${escapeHtml((model.supportedLanguages || []).slice(0, 8).join(', ') || 'language metadata unavailable')}${model.callCompatible === false ? ' · not supported by VOICEDNUT calls' : ''}`
    ).join('\n');
    const choices = ttsModels.map((model, index) => ({
      id: `model:${index}`,
      label: `${model.callCompatible === false ? '⚠️ ' : model.id === profile.model_id ? '✓ ' : ''}${model.id}${model.callCompatible === false ? ' · incompatible' : ''}`,
    }));
    choices.push({ id: 'cancel', label: 'Cancel' });
    choices.push({ id: 'dashboard', label: '↩️ Cartesia Dashboard' });
    const selected = await waitDashboardAction(conversation, ctx,
      `<b>Cartesia TTS models</b>\nSelect from Cartesia’s current catalog. Your saved model is marked ✓.\n${modelDetails}\n\n${formatCartesiaProfile(profile)}`,
      choices, ensureActive);
    if (selected === 'cancel') return;
    if (selected === 'dashboard') {
      await renderCartesiaCenter(ctx);
      return;
    }
    const match = /^model:(\d+)$/.exec(selected);
    const model = match && ttsModels[Number(match[1])];
    if (!model) {
      await ctx.reply('That model selection expired. Your existing profile was not changed.');
      return;
    }
    if (model.callCompatible === false) {
      await ctx.reply(`Model ${escapeHtml(model.id)} is callable in Cartesia’s catalog but is not supported by the VOICEDNUT call runtime. Your existing model was not changed.`);
      return;
    }
    let nextProfile = { ...profile, provider: 'cartesia', model_id: model.id };
    if (Array.isArray(model.supportedLanguages) && model.supportedLanguages.length &&
        !model.supportedLanguages.includes(nextProfile.language)) {
      const language = await askInput(conversation, ctx,
        `The saved language is not supported by ${model.id}. Enter one supported language code: ${model.supportedLanguages.join(', ')}`, ensureActive);
      if (language === null) return;
      if (!model.supportedLanguages.includes(language)) {
        await ctx.reply('That language is not listed for the selected model. Your existing profile was not changed.');
        return;
      }
      nextProfile.language = language;
    }
    const confirmChoice = await waitDashboardAction(conversation, ctx,
      `<b>Confirm Cartesia model</b>\nModel: <code>${escapeHtml(model.id)}</code>\nLanguage: ${escapeHtml(nextProfile.language || 'not set')}\n\nThe existing model remains active unless this profile validates and saves.`,
      [
        { id: 'model-save', label: '✅ Confirm and save' },
        { id: 'cancel', label: 'Cancel' },
      ], ensureActive);
    if (confirmChoice !== 'model-save') return;
    try {
      await saveCartesiaProfile(ctx, nextProfile);
      ensureActive();
      await ctx.reply(`Saved Cartesia model <code>${escapeHtml(model.id)}</code>.`, { parse_mode: 'HTML' });
    } catch (error) {
      await ctx.reply(httpClient.getUserMessage(error, 'The model was unavailable or incompatible. Your previous profile remains active.'));
    }
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia models could not be loaded.'));
  }
}

async function runCartesiaVoiceSettings(conversation, ctx, ensureActive) {
  try {
    let profile = { ...(await readCartesiaProfile(ctx)) };
    const models = await readCartesiaModels(ctx);
    ensureActive();
    const currentModel = models.find((model) => model.id === profile.model_id && model.capability === 'tts');
    while (true) {
      const selected = await waitDashboardAction(conversation, ctx,
        `<b>Cartesia voice settings</b>\n${formatCartesiaProfile(profile)}\n\nChoose a setting, then save to apply it.`,
        [
          { id: 'engine-cartesia', label: '🎙 Use Cartesia TTS' },
          { id: 'engine-deepgram', label: 'Use Deepgram TTS' },
          { id: 'speed-down', label: '🐢 Speed −0.1' },
          { id: 'speed-up', label: '🐇 Speed +0.1' },
          { id: 'volume-down', label: '🔉 Volume −0.1' },
          { id: 'volume-up', label: '🔊 Volume +0.1' },
          { id: 'language', label: '🌐 Set language' },
          { id: 'format-wav', label: 'WAV output' },
          { id: 'format-mp3', label: 'MP3 output' },
          { id: 'save', label: '✅ Save settings' },
          { id: 'reset', label: '↩️ Reset to defaults' },
          { id: 'dashboard', label: 'Cartesia Dashboard' },
          { id: 'cancel', label: 'Cancel' },
        ], ensureActive, { columns: 2 });
      if (selected === 'cancel') return;
        if (selected === 'dashboard') {
          await renderCartesiaCenter(ctx);
          return;
        }
      if (selected === 'speed-down' || selected === 'speed-up') {
        const delta = selected === 'speed-down' ? -0.1 : 0.1;
        profile.speed = Math.max(0.6, Math.min(1.5, Math.round((Number(profile.speed) + delta) * 10) / 10));
        continue;
      }
      if (selected === 'engine-cartesia' || selected === 'engine-deepgram') {
        profile.provider = selected === 'engine-cartesia' ? 'cartesia' : 'deepgram';
        continue;
      }
      if (selected === 'volume-down' || selected === 'volume-up') {
        const delta = selected === 'volume-down' ? -0.1 : 0.1;
        profile.volume = Math.max(0.5, Math.min(2, Math.round((Number(profile.volume) + delta) * 10) / 10));
        continue;
      }
      if (selected === 'format-wav' || selected === 'format-mp3') {
        profile.output_format = selected === 'format-wav' ? 'wav' : 'mp3';
        continue;
      }
      if (selected === 'language') {
        const supported = currentModel?.supportedLanguages || [];
        if (!supported.length) {
          await ctx.reply('Cartesia did not provide supported language metadata for this model. No language was changed.');
          continue;
        }
        const language = await askInput(conversation, ctx,
          `Enter a supported language code for ${profile.model_id}: ${supported.join(', ')}`, ensureActive);
        if (language === null) continue;
        if (!supported.includes(language)) {
          await ctx.reply('That language is not listed for this model. No settings were changed.');
          continue;
        }
        profile.language = language;
        continue;
      }
      if (selected === 'reset') {
        const confirmation = await waitDashboardAction(conversation, ctx,
          'Reset Cartesia speech settings to the configured defaults? This does not change the telephony provider.',
          [
            { id: 'reset-confirm', label: 'Confirm reset' },
            { id: 'cancel', label: 'Keep current settings' },
          ], ensureActive);
        if (confirmation !== 'reset-confirm') continue;
        const resetResponse = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/studio/speech-profile/reset`, {
          actor_id: String(ctx.from?.id || ''),
          business_id: String(ctx.session?.cartesiaSpeechBusinessId || ''),
          confirmation_phrase: 'RESET CARTESIA TTS PROFILE',
        }, { timeout: 20000, retry: { retries: 0 } });
        ensureActive();
        if (resetResponse?.data?.business_id !== ctx.session?.cartesiaSpeechBusinessId) {
          throw new Error('Cartesia did not confirm the requested business profile reset.');
        }
        await ctx.reply('Cartesia speech settings were reset to the configured defaults.');
        return;
      }
      if (selected === 'save') {
        const confirmation = await waitDashboardAction(conversation, ctx,
          `<b>Save these Cartesia settings?</b>\n${formatCartesiaProfile(profile)}`,
          [
            { id: 'settings-save', label: '✅ Confirm and save' },
            { id: 'cancel', label: 'Cancel' },
          ], ensureActive);
        if (confirmation !== 'settings-save') continue;
        try {
          await saveCartesiaProfile(ctx, profile);
          ensureActive();
          await ctx.reply('Cartesia voice settings saved.');
        } catch (error) {
          await ctx.reply(httpClient.getUserMessage(error, 'Settings were not saved. The previous profile remains active.'));
        }
        return;
      }
    }
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia voice settings are unavailable.'));
  }
}

async function runCartesiaUsage(_conversation, ctx, ensureActive) {
  try {
    const [creditsResult, agentsResult] = await Promise.allSettled([
      httpClient.get(ctx, `${apiRoot()}/api/cartesia/studio/usage/credits`, { timeout: 15000 }),
      httpClient.get(ctx, `${apiRoot()}/api/cartesia/studio/usage/agents`, { timeout: 15000 }),
    ]);
    ensureActive();
    const lines = ['<b>Cartesia usage & activity</b>', 'Usage below is provider-reported; VOICEDNUT call totals are not substituted.'];
    if (creditsResult.status === 'fulfilled') {
      const raw = creditsResult.value?.data?.data;
      const buckets = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
      const total = buckets.reduce((sum, item) => sum + (Number(item?.credits) || 0), 0);
      lines.push(buckets.length
        ? `Cartesia credits: <b>${total}</b> across ${buckets.length} bucket(s), ${escapeHtml(String(buckets[0]?.start_ts || 'time unavailable'))} to ${escapeHtml(String(buckets.at(-1)?.end_ts || 'time unavailable'))}`
        : 'Cartesia credit usage: no buckets returned for the available period.');
    } else {
      lines.push(`Cartesia credit usage unavailable: ${escapeHtml(httpClient.getUserMessage(creditsResult.reason, 'provider request failed'))}`);
    }
    if (agentsResult.status === 'fulfilled') {
      const raw = agentsResult.value?.data?.data;
      const buckets = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data :
        Array.isArray(agentsResult.value?.data?.agents) ? agentsResult.value.data.agents : [];
      const agentCalls = buckets.reduce((sum, item) => sum + (Number(item?.calls) || 0), 0);
      const agentMinutes = buckets.reduce((sum, item) => sum + (Number(item?.minutes) || 0), 0);
      const agentCents = buckets.reduce((sum, item) => sum + (Number(item?.cents) || 0), 0);
      lines.push(buckets.length
        ? `Managed Agent usage: ${agentCalls} calls · ${agentMinutes.toFixed(2)} minutes · $${(agentCents / 100).toFixed(2)} provider-reported cost across ${buckets.length} bucket(s).`
        : 'Agent-level usage: no data returned.');
    } else {
      lines.push(`Agent usage unavailable: ${escapeHtml(httpClient.getUserMessage(agentsResult.reason, 'provider request failed'))}`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia usage data is unavailable right now.'));
  }
}

async function runCartesiaConnectionStatus(_conversation, ctx, ensureActive) {
  try {
    const [statusResponse, readinessResponse] = await Promise.all([
      httpClient.get(ctx, `${apiRoot()}/api/cartesia/status`, { timeout: 15000 }),
      httpClient.get(ctx, `${apiRoot()}/api/cartesia/studio/readiness`, { timeout: 20000 }).catch((error) => ({ error })),
    ]);
    ensureActive();
    const status = statusResponse?.data?.status || {};
    const readiness = readinessResponse?.data || {};
    const probe = readinessResponse?.error ? 'not verified' :
      readiness?.voices?.status || 'not reported';
    const summary = [
      `API key configured: ${status.configured === true ? 'yes' : 'no'}`,
      `Cartesia API version: ${escapeHtml(String(status.apiVersion || 'unknown'))}`,
      `Managed Agent runtime: ${status.enabled === true ? 'enabled' : 'disabled'}`,
      `Voice API connectivity probe: ${escapeHtml(probe)}`,
      `Last checked: ${escapeHtml(String(readiness.generatedAt || 'not reported'))}`,
      `Webhook secret present: ${status.webhookConfigured === true ? 'yes' : 'no'}`,
      ...(status.configured === true ? [] : ['Configure Cartesia credentials through the approved server secret store; do not send secrets in Telegram.']),
    ].join('\n');
    await ctx.reply(`<b>Cartesia connection status</b>\n${summary}`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia connection status is unavailable.'));
  }
}

async function runCartesiaTestVoice(conversation, ctx, ensureActive) {
  try {
    const profile = await readCartesiaProfile(ctx);
    ensureActive();
    let testProfile = { ...profile };
    while (true) {
      const generated = await generateCartesiaPreview(conversation, ctx, ensureActive, testProfile);
      if (!generated) return;
      const selected = await waitDashboardAction(conversation, ctx, 'Audio preview complete. What next?', [
        { id: 'test-again', label: '🔊 Test again' },
        { id: 'dashboard', label: '↩️ Cartesia Dashboard' },
      ], ensureActive);
      if (selected === 'dashboard') {
        await renderCartesiaCenter(ctx);
        return;
      }
      if (selected !== 'test-again') return;
    }
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia voice test could not be generated.'));
  }
}

async function runCartesiaAgentHealth(conversation, ctx, ensureActive) {
  try {
    const response = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/agents`, { timeout: 15000 });
    const agents = buildHealthAgentChoices(response?.data?.agents);
    if (!agents.length) { await ctx.reply('Cartesia returned no agents for health review.'); return; }
    const choice = await askChoice(conversation, ctx, 'Choose a Cartesia Managed Agent to inspect:',
      agents.map((agent, index) => `${index + 1}. ${escapeHtml(agent.name || 'Unnamed agent')} — <code>${escapeHtml(agent.id)}</code>${agent.deleted ? ' (deleted)' : ''}`).join('\n'), ensureActive);
    if (choice === null) return;
    if (choice < 0 || choice >= agents.length) { await ctx.reply('Health review canceled. Choose one of the listed agents.'); return; }
    const agentId = agents[choice].id;
    const healthResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/agents/${encodeURIComponent(agentId)}/health`, { timeout: 20000 });
    ensureActive();
    const health = healthResponse?.data;
    if (!health?.agent || health.agent.id !== agentId || !Array.isArray(health.deployments)) throw new Error('Cartesia health response did not match the selected agent.');
    await ctx.reply(formatAgentHealth(health), { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia agent health is unavailable. No provider settings were changed.'));
  }
}

async function runCartesiaAgentRuntime(conversation, ctx, ensureActive) {
  try {
    const businessId = await askInput(conversation, ctx, 'Enter the business ID with current administrator access.', ensureActive);
    if (businessId === null) return;
    if (!BUSINESS_ID_PATTERN.test(businessId)) { await ctx.reply('Runtime status canceled. The business ID format is invalid.'); return; }
    const response = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/agents`, { timeout: 15000 });
    const agents = buildHealthAgentChoices(response?.data?.agents);
    if (!agents.length) { await ctx.reply('No Cartesia Managed Agents are available for runtime status.'); return; }
    const choice = await askChoice(conversation, ctx, 'Choose the Managed Agent to inspect:',
      agents.map((agent, index) => `${index + 1}. <code>${escapeHtml(agent.id)}</code>${agent.deleted ? ' (deleted)' : ''}`).join('\n'), ensureActive);
    if (choice === null) return;
    if (choice < 0 || choice >= agents.length) { await ctx.reply('Runtime status canceled. Choose one of the listed agents.'); return; }
    const agentId = agents[choice].id;
    const query = new URLSearchParams({ business_id: businessId });
    const statusResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/agents/${encodeURIComponent(agentId)}/runtime?${query}`, { timeout: 15000 });
    ensureActive();
    const status = statusResponse?.data;
    if (status?.agent_id !== agentId || !Array.isArray(status?.supported_tool_handlers)) throw new Error('Runtime status did not match the selected agent.');
    await ctx.reply(`Managed Agent runtime: <b>${status.enabled ? 'enabled' : 'disabled'}</b>\nAgent: <code>${escapeHtml(agentId)}</code>\nWebSocket path: <code>${escapeHtml(status.websocket_path)}</code>\nAudio formats: ${status.audio_input_formats.map(escapeHtml).join(', ')}\nRegistered server tool handlers: ${status.supported_tool_handlers.map(escapeHtml).join(', ') || 'none'}\n\nOnly registered handlers execute server-side. Cartesia client-tool definitions outside this allowlist must run in the connected client.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Managed Agent runtime status is unavailable. No provider session was started.'));
  }
}

function formatPhoneNumberChoices(phoneNumbers) {
  return phoneNumbers.map((phone, index) =>
    `${index + 1}. ${escapeHtml(phone.displayNumber || 'Number')} — <code>${escapeHtml(phone.id)}</code>`)
    .join('\n');
}

async function selectCartesiaBusinessScope(conversation, ctx, ensureActive) {
  const businessId = await askInput(
    conversation,
    ctx,
    'Enter the registered VOICEDNUT business ID whose Cartesia TTS profile you want to manage.',
    ensureActive,
  );
  if (businessId === null) return false;
  if (!BUSINESS_ID_PATTERN.test(businessId)) {
    await ctx.reply('Business profile selection canceled. Use a valid registered business ID.');
    return false;
  }
  try {
    const query = new URLSearchParams({ business_id: businessId });
    const response = await httpClient.get(
      ctx,
      `${apiRoot()}/api/cartesia/studio/speech-profile?${query}`,
      { timeout: 15000 },
    );
    ensureActive();
    if (response?.data?.business_id !== businessId ||
        !response?.data?.profile || typeof response.data.profile !== 'object') {
      throw new Error('Cartesia did not confirm the requested business profile scope.');
    }
    ctx.session.cartesiaSpeechBusinessId = businessId;
    await ctx.reply(`Cartesia TTS settings are now scoped to business <code>${escapeHtml(businessId)}</code>.`, { parse_mode: 'HTML' });
    return true;
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'That business profile could not be loaded. No settings were changed.'));
    return false;
  }
}

async function askChoice(conversation, ctx, prompt, options, ensureActive) {
  await ctx.reply(`${prompt}\n${options}\nType a number or cancel.`);
  const update = await conversation.wait();
  ensureActive();
  const value = String(update?.message?.text || '').trim();
  if (CANCEL_WORDS.has(value.toLowerCase())) return null;
  const choice = Number(value);
  return Number.isInteger(choice) && choice >= 1 ? choice - 1 : -1;
}

async function runCartesiaReconciliation(conversation, ctx, ensureActive) {
  const pending = ctx.session?.cartesiaCallPending;
  let input = pending ? {
    businessId: String(pending.businessId || ''),
    destination: String(pending.destination || ''),
    agentId: String(pending.agentId || ''),
    fromNumberId: String(pending.fromNumberId || ''),
    idempotencyKey: String(pending.idempotencyKey || ''),
    requestFingerprint: String(pending.requestFingerprint || ''),
  } : null;
  if (!input) {
    const businessId = await askInput(conversation, ctx, 'Enter the business ID for the pending Cartesia request.', ensureActive);
    if (businessId === null) return;
    const destination = await askInput(conversation, ctx, 'Enter the original destination in E.164 format.', ensureActive);
    if (destination === null) return;
    const agentId = await askInput(conversation, ctx, 'Enter the original Cartesia Managed Agent ID.', ensureActive);
    if (agentId === null) return;
    const fromNumberId = await askInput(conversation, ctx, 'Enter the original Cartesia source phone-number ID.', ensureActive);
    if (fromNumberId === null) return;
    const idempotencyKey = await askInput(conversation, ctx, 'Enter the original Cartesia request key.', ensureActive);
    if (idempotencyKey === null) return;
    const variablesText = await askInput(conversation, ctx, 'Enter the original dynamic variables JSON, or {} if the request had none.', ensureActive);
    if (variablesText === null) return;
    let dynamicVariables;
    try {
      const parsed = JSON.parse(variablesText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
      dynamicVariables = normalizeDynamicVariables(parsed);
    }
    catch { await ctx.reply('Cartesia reconciliation canceled. Provide the original JSON object of dynamic variables.'); return; }
    input = { businessId, destination, agentId, fromNumberId, idempotencyKey, dynamicVariables };
  }
  if (!BUSINESS_ID_PATTERN.test(input.businessId) || !DESTINATION_PATTERN.test(input.destination) ||
      !IDENTIFIER_PATTERN.test(input.agentId) || !IDENTIFIER_PATTERN.test(input.fromNumberId) ||
      !REQUEST_KEY_PATTERN.test(input.idempotencyKey)) {
    await ctx.reply('Cartesia reconciliation needs the original business, destination, agent, source number, and request key. No call was submitted.');
    return;
  }
  try {
    const response = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/call-reconcile`,
      buildReconciliationPayload(input, ctx.from?.id), { timeout: 30000 });
    ensureActive();
    const result = response?.data || {};
    if (result.outcome === 'reconciled' && result.call) {
      const callId = String(result.call.call_id || '').trim();
      const status = String(result.call.status || 'unknown').trim().toLowerCase();
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(callId)) {
        await ctx.reply('Cartesia returned an unusable call reference. Keep this request unresolved and do not submit it again.');
        return;
      }
      if (pendingRequestMatches(pending, input) && pending?.idempotencyKey === input.idempotencyKey) {
        ctx.session.cartesiaCallPending = null;
      }
      await ctx.reply(
        `Cartesia request reconciled to one provider call.\nCall: <code>${escapeHtml(callId)}</code>\nStatus: <b>${escapeHtml(status)}</b>\nDestination: ${escapeHtml(maskDestination(input.destination))}\nNo additional call was submitted.`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    if (result.outcome === 'rejected') {
      if (pendingRequestMatches(pending, input) && pending?.idempotencyKey === input.idempotencyKey) {
        ctx.session.cartesiaCallPending = null;
      }
      await ctx.reply('The saved Cartesia request was recorded as rejected. No provider call was found and reconciliation did not submit a call.');
      return;
    }
    const reasons = {
      no_matching_call_yet: 'No matching provider call is visible yet.',
      multiple_matching_calls: 'More than one provider call matches this request.',
      search_incomplete: 'The provider search was incomplete.',
      outside_reconciliation_window: 'The request is outside the safe provider search window.',
      provider_call_id_unavailable: 'The request has no saved provider call reference.',
    };
    await ctx.reply(`${reasons[result.reason] || 'The request is still unresolved'} Keep the same request key and do not start another call. No call was submitted by reconciliation.`);
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia reconciliation is unavailable. Keep the same request key and do not submit another call.'));
  }
}

function formatCallChoices(calls) {
  return calls.map((call, index) =>
    `${index + 1}. <b>${escapeHtml(call.status || 'unknown')}</b> — <code>${escapeHtml(call.callId)}</code> — ${escapeHtml(call.startTime || 'time unknown')} — ${escapeHtml(call.to || 'number unavailable')}`)
    .join('\n');
}

function formatCallDetails(call) {
  const reviewReasons = Array.isArray(call.review?.reasons) ? call.review.reasons.map(escapeHtml).join(', ') : '';
  return `Call: <code>${escapeHtml(call.callId)}</code>\nAgent: <code>${escapeHtml(call.agentId)}</code>${call.agentName ? ` (${escapeHtml(call.agentName)})` : ''}${call.agentVersionId ? `\nAgent version: <code>${escapeHtml(call.agentVersionId)}</code>` : ''}\nStatus: <b>${escapeHtml(call.status || 'unknown')}</b>\nStarted: ${escapeHtml(call.startTime || 'unknown')}\nEnded: ${escapeHtml(call.endTime || '—')}\nFrom: ${escapeHtml(call.from || 'unavailable')}\nTo: ${escapeHtml(call.to || 'unavailable')}\nEnd reason: ${escapeHtml(call.endReason || '—')}\nReview: <b>${call.review?.required === true ? 'required' : 'not flagged'}</b>${reviewReasons ? ` (${reviewReasons})` : ''}${call.zdrEnabled ? '\nRetention: ZDR enabled; Cartesia does not retain transcript or summary.' : call.redactedAt ? `\nRedacted: ${escapeHtml(call.redactedAt)}; transcript and summary are unavailable.` : ''}${call.summary ? `\nSummary: ${escapeHtml(call.summary)}` : ''}${call.toolNames?.length ? `\nTools used: ${call.toolNames.map(escapeHtml).join(', ')}` : ''}`;
}

function formatCallTranscript(call) {
  const turns = Array.isArray(call?.transcript) ? call.transcript.slice(0, 20) : [];
  if (!turns.length) return ['Cartesia has no transcript available for this call.'];
  const chunks = [];
  let chunk = '';
  for (const turn of turns) {
    const role = escapeHtml(String(turn?.role || 'unknown').slice(0, 24));
    const text = escapeHtml(String(turn?.text || '').slice(0, 900));
    const tools = Array.isArray(turn?.toolNames) && turn.toolNames.length ? `\nTools: ${turn.toolNames.map(escapeHtml).join(', ')}` : '';
    const line = `<b>${role}</b>: ${text || '(no text)'}${tools}`;
    if (chunk && chunk.length + line.length + 2 > 3500) { chunks.push(chunk); chunk = ''; }
    chunk += `${chunk ? '\n\n' : ''}${line}`;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

async function runCartesiaReviewRules(conversation, ctx, ensureActive) {
  const labels = [
    ['review_failed_calls', 'Flag failed calls for review'],
    ['review_tool_calls', 'Flag calls that used tools for review'],
    ['review_missing_summary', 'Flag completed calls with no summary'],
  ];
  try {
    const businessId = await askInput(conversation, ctx, 'Enter the business ID whose Cartesia review rules you want to change.', ensureActive);
    if (businessId === null) return;
    if (!BUSINESS_ID_PATTERN.test(businessId)) { await ctx.reply('Review rule update canceled. The business ID format is invalid.'); return; }
    const query = new URLSearchParams({ business_id: businessId });
    const response = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/review-rules?${query}`, { timeout: 15000 });
    const current = response?.data?.rules;
    if (!current || labels.some(([key]) => typeof current[key] !== 'boolean')) throw new Error('Cartesia review rules response was invalid.');
    const next = {};
    for (const [key, label] of labels) {
      const selected = await askChoice(conversation, ctx, `${label}? Current setting: ${current[key] ? 'On' : 'Off'}. Choose:`, '1. On\n2. Off', ensureActive);
      if (selected === null) { await ctx.reply('Review rule update canceled.'); return; }
      if (![0, 1].includes(selected)) { await ctx.reply('Review rule update canceled. Choose On or Off for each setting.'); return; }
      next[key] = selected === 0;
    }
    const saved = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/review-rules`, { business_id: businessId, rules: next }, { timeout: 15000 });
    ensureActive();
    if (JSON.stringify(saved?.data?.rules && labels.map(([key]) => saved.data.rules[key])) !== JSON.stringify(labels.map(([key]) => next[key]))) {
      throw new Error('Cartesia did not confirm the saved review rules.');
    }
    await ctx.reply(`Cartesia post-call review rules saved for business <code>${escapeHtml(businessId)}</code>:\n${labels.map(([key, label]) => `• ${escapeHtml(label)}: <b>${next[key] ? 'On' : 'Off'}</b>`).join('\n')}`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia post-call review rules could not be loaded or saved.'));
  }
}

function formatCampaignOutcomes(campaign) {
  const outcomes = campaign?.outcome_summary;
  if (!outcomes || !Number.isFinite(Number(outcomes.total))) return '';
  return `\nOutcomes: ${Number(outcomes.completed) || 0} completed · ${Number(outcomes.failed) || 0} failed · ${Number(outcomes.unanswered) || 0} unanswered · ${Number(outcomes.pending) || 0} pending · ${Number(outcomes.not_started) || 0} not started · ${Number(outcomes.blocked) || 0} blocked · ${Number(outcomes.unknown) || 0} unknown\nCompletion rate: ${Number(outcomes.completion_rate_percent) || 0}% (${Number(outcomes.completed) || 0}/${Number(outcomes.eligible) || 0} eligible recipients)`;
}

function formatCampaignStatus(campaign) {
  const status = String(campaign?.status || 'unknown');
  let nextStep = 'Refresh status before taking another action.';
  if (status === 'approved' && campaign?.dispatch_queued === true) {
    nextStep = 'Queued on VOICEDNUT for background dispatch. Check this campaign again; do not create a duplicate.';
  } else if (status === 'approved' && campaign?.scheduled_at) {
    nextStep = `Scheduled locally for ${String(campaign.scheduled_at)} UTC. Cancel before dispatch if plans change.`;
  } else if (status === 'approved') {
    nextStep = 'Approved and awaiting dispatch. Check this campaign again; do not create a duplicate.';
  } else if (status === 'submitted') {
    nextStep = 'The provider batch was accepted. Refresh provider progress to reconcile recipient outcomes.';
  } else if (status === 'unknown' || status === 'submitting') {
    nextStep = 'Provider outcome is unresolved. Refresh provider progress or inspect Cartesia; do not resubmit or create another campaign.';
  } else if (status === 'blocked') {
    nextStep = 'Dispatch is blocked. Resolve the reported issue and review consent and business policy before creating a new campaign.';
  } else if (status === 'draft') {
    nextStep = 'This draft has not been approved or submitted.';
  }
  const errorCode = campaign?.error_code
    ? `\nIssue code: <code>${escapeHtml(campaign.error_code)}</code>`
    : '';
  return `Campaign: <code>${escapeHtml(campaign?.campaign_id || 'unknown')}</code>\nStatus: <b>${escapeHtml(status)}</b>\nRecipients: ${Number(campaign?.ready_count) || 0}/${Number(campaign?.recipient_count) || 0} ready${formatCampaignOutcomes(campaign)}\nBatch: <code>${escapeHtml(campaign?.provider_batch_id || 'not confirmed')}</code>${errorCode}\nNext: ${escapeHtml(nextStep)}`;
}

async function getCampaignReference(conversation, ctx, ensureActive) {
  const pending = ctx.session?.cartesiaCampaignPending;
  const businessId = pending?.businessId || await askInput(conversation, ctx, 'Enter the business ID for the saved Cartesia campaign.', ensureActive);
  if (businessId === null) return null;
  const campaignId = pending?.campaignId || await askInput(conversation, ctx, 'Enter the campaign ID (cartesia_campaign_…).', ensureActive);
  if (campaignId === null) return null;
  if (!BUSINESS_ID_PATTERN.test(String(businessId || '')) || !/^cartesia_campaign_[a-f0-9]{64}$/.test(String(campaignId || ''))) {
    await ctx.reply('Campaign lookup needs the original business ID and a valid campaign ID.');
    return null;
  }
  return { businessId: String(businessId), campaignId: String(campaignId) };
}

async function runCartesiaCallOperations(conversation, ctx, ensureActive, options = {}) {
  try {
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Cartesia call records, transcripts, and recordings can only be reviewed in a private admin chat.');
      return;
    }
    const businessId = await askInput(conversation, ctx, `Enter the business ID with current operator access${options.reviewQueue ? ' whose flagged calls you want to review' : ' for call history'}.`, ensureActive);
    if (businessId === null) return;
    if (!BUSINESS_ID_PATTERN.test(businessId)) { await ctx.reply('Cartesia call review canceled. The business ID format is invalid.'); return; }
    const inventory = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/agents`, { timeout: 15000 });
    const agents = buildAgentChoices(inventory?.data?.agents);
    if (!agents.length) {
      await ctx.reply('No active Cartesia agent with an attached source number is available for call history.');
      return;
    }
    const agentChoice = await askChoice(conversation, ctx, 'Choose the Cartesia Managed Agent whose recent calls you want to review:', formatAgentChoices(agents), ensureActive);
    if (agentChoice === null) return;
    if (agentChoice < 0 || agentChoice >= agents.length) {
      await ctx.reply('Cartesia call review canceled. Choose one of the listed agents.');
      return;
    }
    const agent = agents[agentChoice];
    const query = new URLSearchParams({ agent_id: agent.id, business_id: businessId, limit: '25', ...(options.reviewQueue ? { review_queue: 'true' } : {}) });
    const listResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/calls?${query.toString()}`, { timeout: 20000 });
    ensureActive();
    const calls = (Array.isArray(listResponse?.data?.calls) ? listResponse.data.calls : [])
      .filter((call) => call && IDENTIFIER_PATTERN.test(String(call.callId || ''))).slice(0, 25);
    if (!calls.length) {
      await ctx.reply(options.reviewQueue ? 'No calls match this business’s current review rules in the first recent-call page.' : 'No recent Cartesia calls associated with this business were found for that agent. The call list is limited to the last 24 hours.');
      return;
    }
    const callChoice = await askChoice(conversation, ctx, options.reviewQueue ? 'Choose a flagged call to review:' : 'Choose a call to inspect:', formatCallChoices(calls), ensureActive);
    if (callChoice === null) return;
    if (callChoice < 0 || callChoice >= calls.length) {
      await ctx.reply('Cartesia call review canceled. Choose one of the listed calls.');
      return;
    }
    const callId = String(calls[callChoice].callId);
    const detailQuery = new URLSearchParams({ business_id: businessId });
    const detailResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/calls/${encodeURIComponent(callId)}?${detailQuery}`, { timeout: 15000 });
    ensureActive();
    const call = detailResponse?.data?.call;
    if (!call || call.callId !== callId) {
      await ctx.reply('Cartesia call details did not match the selected call.');
      return;
    }
    await ctx.reply(formatCallDetails(call), { parse_mode: 'HTML' });
    if (call.status === 'completed' && call.zdrEnabled !== true && !call.redactedAt) {
      const phrase = `SHOW CARTESIA TRANSCRIPT ${callId}`;
      const confirmation = await askInput(conversation, ctx,
        `Transcript content may contain sensitive personal information. It will be fetched only if you type this exact phrase in this private admin chat: ${phrase}`, ensureActive);
      if (confirmation === phrase) {
        const transcriptQuery = new URLSearchParams({ business_id: businessId, include_transcript: 'true' });
        const transcriptResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/calls/${encodeURIComponent(callId)}?${transcriptQuery}`, { timeout: 15000 });
        ensureActive();
        const reviewedCall = transcriptResponse?.data?.call;
        if (!reviewedCall || reviewedCall.callId !== callId) throw new Error('Cartesia transcript response did not match the selected call.');
        for (const transcriptChunk of formatCallTranscript(reviewedCall)) {
          ensureActive();
          await ctx.reply(transcriptChunk, { parse_mode: 'HTML' });
        }
      } else if (confirmation !== null) {
        await ctx.reply('Transcript display canceled. No transcript was returned to the bot.');
      }
    }
    if (['completed', 'failed'].includes(String(call.status).toLowerCase()) && call.zdrEnabled !== true && !call.redactedAt) {
      const audioPhrase = `DOWNLOAD CARTESIA CALL AUDIO ${callId}`;
      const audioConfirmation = await askInput(conversation, ctx,
        `The WAV recording may contain sensitive personal information. Type this exact phrase to download it to this private chat: ${audioPhrase}`, ensureActive);
      if (audioConfirmation === audioPhrase) {
        const audioResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/calls/${encodeURIComponent(callId)}/audio?${new URLSearchParams({ business_id: businessId })}`, {
          timeout: 30000, responseType: 'arraybuffer', retry: { retries: 0 },
        });
        ensureActive();
        const audio = Buffer.from(audioResponse?.data || '');
        if (!audio.length || audio.length > 25 * 1024 * 1024) throw new Error('Cartesia returned an invalid or oversized call recording.');
        await ctx.replyWithAudio(new InputFile(audio, `cartesia-call-${callId}.wav`), { caption: `Cartesia call recording · ${callId}` });
      } else if (audioConfirmation !== null && audioConfirmation !== 'done') {
        await ctx.reply('Recording download canceled.');
      }
      const deletePhrase = `DELETE CARTESIA CALL DATA ${callId} CONSENT WITHDRAWN`;
      const deleteConfirmation = await askInput(conversation, ctx,
        `If recording consent was withdrawn, this permanently deletes Cartesia’s transcript, audio, and logs for the ended call. This cannot be undone. Type this exact phrase to confirm: ${deletePhrase}`, ensureActive);
      if (deleteConfirmation === deletePhrase) {
        const deleted = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/calls/${encodeURIComponent(callId)}/redact`, {
          business_id: businessId, confirmation_phrase: deleteConfirmation,
        }, { timeout: 20000, retry: { retries: 0 } });
        ensureActive();
        if (deleted?.data?.deleted !== true) throw new Error('Cartesia did not confirm call-data deletion. Refresh call status before retrying.');
        await ctx.reply(`Cartesia call transcript, recording, and logs were removed for <code>${escapeHtml(callId)}</code>.`, { parse_mode: 'HTML' });
        return;
      }
      if (deleteConfirmation !== null && deleteConfirmation !== 'done') await ctx.reply('Call-data deletion canceled. No provider data was deleted.');
    }
    if (call.canCancel !== true || String(call.status).toLowerCase() !== 'started') return;
    const phrase = `CANCEL CARTESIA CALL ${callId}`;
    const confirmation = await askInput(conversation, ctx,
      `This will terminate the active call. Cartesia allows cancellation only while it is started; its data will remain stored. Type this exact phrase to confirm: ${phrase}`,
      ensureActive);
    if (confirmation !== phrase) {
      await ctx.reply('Cancellation canceled. The call was not changed.');
      return;
    }
    const result = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/calls/${encodeURIComponent(callId)}/cancel`, {
      business_id: businessId,
      confirmation_phrase: confirmation,
    }, { timeout: 20000 });
    ensureActive();
    if (result?.data?.cancelled !== true) {
      await ctx.reply('Cartesia did not confirm cancellation. Refresh the call status before taking further action.');
      return;
    }
    await ctx.reply(`Cartesia call <code>${escapeHtml(callId)}</code> was canceled. Its call data was retained.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Cartesia call operations are unavailable. Refresh status before retrying a cancellation.'));
  }
}

async function runCartesiaCampaignStatus(conversation, ctx, ensureActive) {
  const pending = await getCampaignReference(conversation, ctx, ensureActive);
  if (!pending) return;
  try {
    const query = new URLSearchParams({ business_id: pending.businessId });
    const response = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/campaigns/${encodeURIComponent(pending.campaignId)}?${query}`, { timeout: 20000 });
    ensureActive();
    const campaign = response?.data?.campaign;
    if (!campaign || campaign.campaign_id !== pending.campaignId) throw new Error('Cartesia campaign response did not match the saved campaign.');
    await ctx.reply(formatCampaignStatus(campaign), { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Campaign status is unavailable. Keep the same campaign ID; do not create another batch while its outcome is unresolved.'));
  }
}

async function runCartesiaCampaignReconciliation(conversation, ctx, ensureActive) {
  const pending = await getCampaignReference(conversation, ctx, ensureActive);
  if (!pending) return;
  try {
    const response = await httpClient.post(ctx,
      `${apiRoot()}/api/cartesia/campaigns/${encodeURIComponent(pending.campaignId)}/reconcile`,
      { business_id: pending.businessId },
      { timeout: 20000 });
    ensureActive();
    const campaign = response?.data?.campaign;
    if (!campaign || campaign.campaign_id !== pending.campaignId) {
      throw new Error('Cartesia campaign reconciliation response did not match the saved campaign.');
    }
    await ctx.reply(`Provider progress refreshed.\n${formatCampaignStatus(campaign)}`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error,
      `Provider progress could not be confirmed for ${pending.campaignId}. Do not resubmit; check the same campaign again.`));
  }
}

async function runCartesiaBatchControl(conversation, ctx, ensureActive, action) {
  let pending = ctx.session?.cartesiaCampaignPending;
  if (!pending) {
    const businessId = await askInput(conversation, ctx, 'Enter the business ID for the saved Cartesia campaign.', ensureActive);
    if (businessId === null) return;
    const campaignId = await askInput(conversation, ctx, 'Enter the campaign ID (cartesia_campaign_…).', ensureActive);
    if (campaignId === null) return;
    pending = { businessId, campaignId };
  }
  if (!BUSINESS_ID_PATTERN.test(String(pending.businessId || '')) || !/^cartesia_campaign_[a-f0-9]{64}$/.test(String(pending.campaignId || ''))) {
    await ctx.reply('Batch operation needs the original business ID and a valid campaign ID.'); return;
  }
  try {
    if (action === 'CARTESIA_BATCH_RECONCILE') {
      const response = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/campaigns/${encodeURIComponent(pending.campaignId)}/reconcile`,
        { business_id: pending.businessId }, { timeout: 30000 });
      ensureActive();
      const campaign = response?.data?.campaign;
      if (!campaign || campaign.campaign_id !== pending.campaignId) throw new Error('Campaign reconciliation response did not match the saved campaign.');
      const rows = (campaign.recipients || []).map((row) => `${escapeHtml(row.destination_masked)} — ${escapeHtml(row.provider_status || row.status || 'pending')}${row.provider_call_id ? ` (call <code>${escapeHtml(row.provider_call_id)}</code>)` : ''}`).join('\n');
      await ctx.reply(`Batch: <code>${escapeHtml(campaign.provider_batch_id || 'unresolved')}</code>\nStatus: <b>${escapeHtml(campaign.provider_status || campaign.status)}</b>${formatCampaignOutcomes(campaign)}\n${rows || 'No recipient progress available.'}`, { parse_mode: 'HTML' });
      return;
    }
    const statusResponse = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/campaigns/${encodeURIComponent(pending.campaignId)}?${new URLSearchParams({ business_id: pending.businessId })}`, { timeout: 20000 });
    ensureActive();
    const savedCampaign = statusResponse?.data?.campaign;
    if (action === 'CARTESIA_BATCH_CANCEL' && savedCampaign?.status === 'approved' && savedCampaign?.scheduled_at && !savedCampaign?.provider_batch_id) {
      const phrase = `CANCEL CARTESIA CAMPAIGN ${savedCampaign.campaign_id} BEFORE DISPATCH`;
      const confirmation = await askInput(conversation, ctx,
        `This cancels the locally held campaign before any batch is sent to Cartesia. Type this exact phrase: ${phrase}`, ensureActive);
      if (confirmation !== phrase) { await ctx.reply('Cancellation not confirmed. The campaign remains scheduled.'); return; }
      const result = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/campaigns/${encodeURIComponent(pending.campaignId)}/cancel`,
        { business_id: pending.businessId, confirmation_phrase: confirmation }, { timeout: 30000 });
      ensureActive();
      await ctx.reply(`Local campaign status: <b>${escapeHtml(result?.data?.campaign?.status || 'unknown')}</b>. No provider batch was sent.`, { parse_mode: 'HTML' });
      return;
    }
    if (!savedCampaign?.provider_batch_id) {
      await ctx.reply('This campaign has no confirmed provider batch. Reconcile its submission outcome before taking a batch action.'); return;
    }
    const freshResponse = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/campaigns/${encodeURIComponent(pending.campaignId)}/reconcile`,
      { business_id: pending.businessId }, { timeout: 30000 });
    ensureActive();
    const campaign = freshResponse?.data?.campaign;
    if (!campaign || campaign.campaign_id !== pending.campaignId || campaign.provider_batch_id !== savedCampaign.provider_batch_id) {
      throw new Error('Fresh Cartesia batch reconciliation did not match the saved campaign.');
    }
    if (!campaign?.provider_batch_id || !['pending', 'in_progress'].includes(String(campaign.provider_status))) {
      await ctx.reply('This campaign has no confirmed queued batch to cancel. Reconcile its status before acting.'); return;
    }
    const phrase = `CANCEL CARTESIA CAMPAIGN ${campaign.campaign_id} BATCH ${campaign.provider_batch_id}`;
    const confirmation = await askInput(conversation, ctx,
      `This stops queued calls; calls already in progress may finish. Type this exact phrase to confirm: ${phrase}`, ensureActive);
    if (confirmation !== phrase) { await ctx.reply('Cancellation not confirmed. No batch operation was sent.'); return; }
    const result = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/campaigns/${encodeURIComponent(pending.campaignId)}/cancel`,
      { business_id: pending.businessId, confirmation_phrase: confirmation }, { timeout: 30000 });
    ensureActive();
    await ctx.reply(`Cartesia batch cancellation result: <b>${escapeHtml(result?.data?.campaign?.provider_status || 'check status')}</b>. Refresh batch progress to confirm.`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'The Cartesia batch action could not be confirmed. Reconcile the saved campaign before repeating an operation.')); }
}

async function runCartesiaBusinessScope(conversation, ctx, ensureActive) {
  const phoneNumberId = await askInput(conversation, ctx, 'Enter the Cartesia phone-number ID to scope to one business.', ensureActive);
  if (phoneNumberId === null) return;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(phoneNumberId)) {
    await ctx.reply('Business scoping canceled. The phone-number ID format is invalid.');
    return;
  }
  const businessId = await askInput(conversation, ctx, 'Enter the VOICEDNUT business ID that owns this inbound number.', ensureActive);
  if (businessId === null) return;
  if (!BUSINESS_ID_PATTERN.test(businessId)) {
    await ctx.reply('Business scoping canceled. The business ID format is invalid.');
    return;
  }

  const path = `/api/cartesia/phone-numbers/${encodeURIComponent(phoneNumberId)}/business-scope`;
  const previewResponse = await httpClient.post(ctx, `${apiRoot()}${path}/preview`, { business_id: businessId }, { timeout: 15000 });
  ensureActive();
  const preview = previewResponse?.data?.preview;
  if (!preview || preview.phoneNumberId !== phoneNumberId || preview.businessId !== businessId ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(String(preview.agentId || '')) ||
      !/^[a-f0-9]{64}$/.test(String(preview.requestFingerprint || ''))) {
    throw new Error('Cartesia returned an invalid business-scope preview.');
  }
  const lastFour = String(preview.phoneNumber || '').replace(/\D/g, '').slice(-4);
  const phrase = `SET CARTESIA BUSINESS SCOPE ${phoneNumberId} TO ${businessId}`;
  const confirmation = await askInput(conversation, ctx,
    `This will make inbound calls to ••••${lastFour || '????'} from agent ${preview.agentId} visible only to business ${businessId}. Current scope: ${preview.currentBusinessId || 'unassigned'}. To approve this local tenant mapping, type exactly: ${phrase}`,
    ensureActive);
  if (confirmation === null) return;
  if (confirmation !== phrase) {
    await ctx.reply('Business-scope change canceled. No mapping was saved.');
    return;
  }

  const result = await httpClient.put(ctx, `${apiRoot()}${path}`, {
    business_id: businessId,
    approved: true,
    confirmed_fingerprint: preview.requestFingerprint,
    idempotency_key: `scope-${crypto.randomUUID()}`,
  }, { timeout: 15000 });
  ensureActive();
  const scope = result?.data?.scope;
  if (!scope || scope.phoneNumberId !== phoneNumberId || scope.businessId !== businessId) {
    throw new Error('Cartesia business-scope confirmation did not match the approved mapping.');
  }
  await ctx.reply(`Inbound number ••••${lastFour || '????'} is now scoped to business ${businessId}. ${scope.idempotentReplay ? 'The saved operation was confirmed.' : 'The mapping was saved.'}`);
}

async function cartesiaOperationFlow(conversation, ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAuthorized && !access?.isAdmin) {
    await ctx.reply('Cartesia speech management requires an authorized VOICEDNUT account.');
    return;
  }
  const action = String(ctx.session?.cartesiaOperationAction || '');
  if (action === 'CARTESIA_CALL') {
    await ctx.reply('Start a single call with /call. The selected telephony provider carries it; Cartesia speech is selected through a compatible script profile.');
    return;
  }
  if (action === 'CARTESIA_CAMPAIGN' || action === 'CARTESIA_BATCH_RETRY') {
    await ctx.reply('Cartesia-managed dialing and batch retries are disabled. Start new calls with /call using the selected telephony provider; existing batches remain available for status, reconciliation, and cancellation.');
    return;
  }
  if (!ACTIONS.has(action)) {
    await ctx.reply('That Cartesia action expired. Reopen /cartesia and choose the action again.');
    return;
  }
  const speechActions = new Set([
    'CARTESIA_DASHBOARD', 'CARTESIA_PROFILE_SCOPE', 'CARTESIA_MANAGE_VOICES',
    'CARTESIA_MODELS', 'CARTESIA_VOICE_SETTINGS', 'CARTESIA_TEST_VOICE', 'CARTESIA_REFRESH',
  ]);
  if (!access.isAdmin && !speechActions.has(action)) {
    await ctx.reply('That Cartesia operation is restricted to administrators.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the bot before entering a destination or approving a call.');
    return;
  }

  const operationId = `cartesia:${action.toLowerCase()}`;
  const token = startOperation(ctx, operationId);
  const ensureActive = () => ensureOperationActive(ctx, token);

  if (action === 'CARTESIA_PROFILE_SCOPE') {
    if (await selectCartesiaBusinessScope(conversation, ctx, ensureActive)) {
      await renderCartesiaCenter(ctx);
    }
    return;
  }
  const scopedProfileActions = new Set([
    'CARTESIA_MANAGE_VOICES', 'CARTESIA_MODELS', 'CARTESIA_VOICE_SETTINGS', 'CARTESIA_TEST_VOICE',
  ]);
  if (scopedProfileActions.has(action) &&
      !BUSINESS_ID_PATTERN.test(String(ctx.session?.cartesiaSpeechBusinessId || '').trim()) &&
      !await selectCartesiaBusinessScope(conversation, ctx, ensureActive)) {
    return;
  }

  if (action === 'CARTESIA_DASHBOARD' || action === 'CARTESIA_REFRESH') {
    await renderCartesiaCenter(ctx);
    return;
  }
  if (action === 'CARTESIA_OPERATIONS') {
    await renderCartesiaOperations(ctx);
    return;
  }
  if (action === 'CARTESIA_MANAGE_VOICES') {
    await runCartesiaManageVoices(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_MODELS') {
    await runCartesiaModels(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_VOICE_SETTINGS') {
    await runCartesiaVoiceSettings(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_TEST_VOICE') {
    await runCartesiaTestVoice(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_USAGE') {
    await runCartesiaUsage(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_CONNECTION_STATUS') {
    await runCartesiaConnectionStatus(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_RECONCILE') {
    await runCartesiaReconciliation(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_CALLS') {
    await runCartesiaCallOperations(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_REVIEW_QUEUE') {
    await runCartesiaCallOperations(conversation, ctx, ensureActive, { reviewQueue: true });
    return;
  }
  if (action === 'CARTESIA_REVIEW_RULES') {
    await runCartesiaReviewRules(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_AGENT_HEALTH') {
    await runCartesiaAgentHealth(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_AGENT_RUNTIME') {
    await runCartesiaAgentRuntime(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_BUSINESS_SCOPE') {
    try { await runCartesiaBusinessScope(conversation, ctx, ensureActive); }
    catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Cartesia business scoping failed. Refresh the number mapping before trying again.')); }
    return;
  }
  if (action === 'CARTESIA_CAMPAIGN_STATUS') {
    await runCartesiaCampaignStatus(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_CAMPAIGN_RECONCILE') {
    await runCartesiaCampaignReconciliation(conversation, ctx, ensureActive);
    return;
  }
  if (action === 'CARTESIA_BATCH_RECONCILE' || action === 'CARTESIA_BATCH_CANCEL') {
    await runCartesiaBatchControl(conversation, ctx, ensureActive, action);
    return;
  }
}

function registerCartesiaCommand(bot) {
  bot.command('cartesia', async (ctx) => {
    const access = await getAccessProfile(ctx);
    if (!access?.isAuthorized && !access?.isAdmin) {
      await ctx.reply('Cartesia speech management requires an authorized VOICEDNUT account.');
      return;
    }
    await renderCartesiaCenter(ctx);
  });
}

module.exports = {
  ACTIONS,
  buildCartesiaKeyboard,
  buildCartesiaOperationsKeyboard,
  normalizeDynamicVariables,
  renderCartesiaCenter,
  registerCartesiaCommand,
  cartesiaOperationFlow,
  __testables: {
    buildReconciliationPayload,
    buildAgentChoices,
    formatAgentChoices,
    buildHealthAgentChoices,
    formatAgentHealth,
    runCartesiaManageVoices,
    runCartesiaModels,
    runCartesiaVoiceSettings,
    runCartesiaUsage,
    runCartesiaConnectionStatus,
    runCartesiaTestVoice,
    runCartesiaAgentHealth,
    runCartesiaAgentRuntime,
    runCartesiaBusinessScope,
    formatPhoneNumberChoices,
    askChoice,
    maskDestination,
    pendingRequestMatches,
    runCartesiaReconciliation,
    formatCallChoices,
    formatCallDetails,
    runCartesiaCallOperations,
    runCartesiaReviewRules,
    formatCallTranscript,
    formatCampaignOutcomes,
    formatCampaignStatus,
    runCartesiaCampaignStatus,
    runCartesiaCampaignReconciliation,
    runCartesiaBatchControl,
  },
};
