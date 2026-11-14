const config = require('../config');
const { createHash, randomUUID } = require('node:crypto');
const botDb = require('../db/db');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const {
  getBusinessOptions,
  findBusinessOption,
  MOOD_OPTIONS,
  URGENCY_OPTIONS,
  TECH_LEVEL_OPTIONS,
  askOptionWithButtons,
  getOptionLabel
} = require('../utils/persona');
const { extractScriptVariables } = require('../utils/scripts');
const {
  fetchVoiceModelCatalog,
  askVoiceModelWithPagination,
} = require('../utils/voiceModels');
const {
  startOperation,
  ensureOperationActive,
  registerAbortController,
  OperationCancelledError,
  ensureFlow,
  safeReset,
  guardAgainstCommandInterrupt
} = require('../utils/sessionState');
const {
  PROFILE_FLOW_TYPES,
  deriveConversationProfile,
} = require('../../api/functions/Dating');
const {
  getCallScriptFlowTypes: getCallScriptFlowTypesShared,
  getPrimaryFlowType: getPrimaryFlowTypeShared,
  getEffectiveObjectiveTags: getEffectiveObjectiveTagsShared,
  getAutoAttachedScriptProfileFlow: getAutoAttachedScriptProfileFlowShared,
  resolveScriptProfileRouting: resolveScriptProfileRoutingShared,
  isProfileFlowType,
} = require('../../api/functions/FlowMetadata');
const {
  section,
  escapeMarkdown,
  tipLine,
  buildLine,
  renderMenu,
  dismissMenuMessage,
  sendEphemeral,
  buildBackToMenuReplyMarkup,
  cancelledMessage,
  setupStepMessage
} = require('../utils/ui');

async function notifyCallError(ctx, lines = []) {
  const body = Array.isArray(lines) ? lines : [lines];
  await ctx.reply(section('❌ Call Alert', body), {
    reply_markup: buildBackToMenuReplyMarkup(ctx, {
      backAction: 'CALL',
      backLabel: '⬅️ Back to Call'
    })
  });
}

function formatCallAcceptedMessage(data = {}) {
  const destination = String(data.to || '').trim();
  const maskedDestination = /^\+[1-9]\d{1,14}$/.test(destination)
    ? `••••${destination.slice(-4)}`
    : '••••';
  const statuses = {
    queued: '🟡 Queued',
    initiated: '🔵 Initiated',
    ringing: '🟡 Ringing',
    answered: '🟢 Answered',
    'in-progress': '🔵 In progress',
    in_progress: '🔵 In progress',
    completed: '✅ Completed',
    busy: '📵 Busy',
    'no-answer': '⚪ No answer',
    no_answer: '⚪ No answer',
    failed: '🔴 Failed',
    canceled: '⚪ Canceled',
    cancelled: '⚪ Canceled'
  };
  const providers = {
    twilio: 'Twilio',
    plivo: 'Plivo',
    vonage: 'Vonage',
    vapi: 'Vapi',
    cartesia: 'Cartesia Managed Agent'
  };
  const aiEngines = {
    cartesia: 'Cartesia',
    deepgram: 'Deepgram',
    vapi: 'Vapi'
  };
  const callId = String(data.call_sid || '').replace(/[^A-Za-z0-9]/g, '');
  const callReference = callId ? `VN-${callId.slice(-8)}` : 'unavailable';
  const provider = providers[String(data.provider || '').trim().toLowerCase()];
  const aiVoiceEngine = aiEngines[String(data.ai_voice_engine || '').trim().toLowerCase()];
  const lines = [
    '📞 VOICEDNUT — Outgoing Call',
    `Status: ${statuses[String(data.status || '').trim().toLowerCase()] || '🟡 Submitted'}`,
    `Destination: ${maskedDestination}`,
    provider ? `Telephony: ${provider}` : null,
    aiVoiceEngine ? `AI Voice: ${aiVoiceEngine}` : null,
    `Call ID: ${callReference}`,
    'Live status updates will continue in the call monitor.'
  ].filter(Boolean);
  return lines.join('\n');
}

function getReconciliationInstruction(provider) {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'vapi') return 'Open /vapi, choose the call activity, and reconcile the call before retrying.';
  if (normalized === 'cartesia') return 'Open /cartesia, choose Managed Agent call reconciliation, and verify the original request before retrying.';
  return 'Open /callmonitor and verify the call with the selected provider before retrying.';
}

function resolveCallProviderDefaults(status = {}) {
  const callState = status.providers?.call || {};
  const telephonyProvider = String(status.provider || callState.provider || '').trim().toLowerCase();
  const supportedProviders = Array.isArray(status.supported_providers)
    ? status.supported_providers
    : callState.supported_providers;
  const supported = Array.isArray(supportedProviders)
    ? supportedProviders.map((provider) => String(provider || '').trim().toLowerCase())
    : [];
  if (!telephonyProvider || !supported.includes(telephonyProvider)) {
    throw Object.assign(new Error('The configured telephony provider is unavailable or unsupported. Review /provider settings.'), {
      code: 'call_provider_config_invalid'
    });
  }

  const descriptor = Array.isArray(status.voice_provider_capabilities)
    ? status.voice_provider_capabilities.find((item) => String(item?.provider || '').toLowerCase() === telephonyProvider)
    : null;
  if (!descriptor || descriptor.operations?.['outbound_call.create'] !== true) {
    throw Object.assign(new Error('The configured provider does not support direct /call requests. Select a direct-call provider in /provider.'), {
      code: 'call_provider_operation_unsupported'
    });
  }
  const providerReady = typeof callState.readiness?.[telephonyProvider] === 'boolean'
    ? callState.readiness[telephonyProvider]
    : typeof status[`${telephonyProvider}_ready`] === 'boolean'
      ? status[`${telephonyProvider}_ready`]
      : null;
  if (providerReady === false) {
    throw Object.assign(new Error(`The configured ${toTitleCase(telephonyProvider)} provider is not ready. Review /provider settings before starting a call.`), {
      code: 'call_provider_not_ready'
    });
  }

  const aiVoiceEngine = String(status.tts_provider || '').trim().toLowerCase();
  if (!['cartesia', 'deepgram'].includes(aiVoiceEngine)) {
    throw Object.assign(new Error('The configured AI voice engine is unavailable or unsupported. Review /provider settings.'), {
      code: 'call_voice_engine_config_invalid'
    });
  }

  const cartesiaProfile = status.cartesia_tts_profile && typeof status.cartesia_tts_profile === 'object'
    ? status.cartesia_tts_profile
    : null;
  if (aiVoiceEngine === 'cartesia' &&
      (cartesiaProfile?.provider !== 'cartesia' ||
       !String(cartesiaProfile.voice_id || '').trim() ||
       !String(cartesiaProfile.model_id || '').trim())) {
    throw Object.assign(new Error('The Cartesia speech profile is incomplete. Review Voice Settings in /cartesia before calling.'), {
      code: 'call_cartesia_profile_incomplete'
    });
  }

  const providerHealth = status.provider_health?.[telephonyProvider] || null;
  return {
    telephonyProvider,
    aiVoiceEngine,
    cartesiaProfile,
    supportedProviders: supported,
    readiness: callState.readiness || {},
    providerReady,
    providerHealth,
  };
}

function resolveCallVoiceModel({ aiVoiceEngine, scriptVoiceModel, configuredVoice } = {}) {
  if (String(aiVoiceEngine || '').trim().toLowerCase() === 'cartesia') return null;
  return String(scriptVoiceModel || configuredVoice || '').trim() || null;
}

function prepareCallSubmission(session, payload, createKey = randomUUID) {
  const requestFingerprint = createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
  const existing = session?.outboundCallSubmission;
  if (existing?.outcomeUncertain === true && existing.requestFingerprint !== requestFingerprint) {
    return { blocked: true, reason: 'previous_submission_uncertain' };
  }
  if (existing?.requestFingerprint === requestFingerprint && /^[A-Za-z0-9._:-]{8,128}$/.test(String(existing.idempotencyKey || ''))) {
    return { blocked: false, reused: true, idempotencyKey: existing.idempotencyKey };
  }
  const idempotencyKey = String(createKey() || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw new Error('Could not create a safe call submission key');
  }
  if (session && typeof session === 'object') {
    session.outboundCallSubmission = {
      requestFingerprint,
      idempotencyKey,
      outcomeUncertain: true,
      createdAt: Date.now(),
    };
  }
  return { blocked: false, reused: false, idempotencyKey };
}

function resolveCallSubmissionOutcome(session, idempotencyKey, outcomeUncertain, acceptedResult = null) {
  const pending = session?.outboundCallSubmission;
  if (!pending || pending.idempotencyKey !== idempotencyKey) return false;
  if (outcomeUncertain) {
    pending.outcomeUncertain = true;
    delete pending.acceptedResult;
  } else if (acceptedResult && typeof acceptedResult === 'object') {
    pending.outcomeUncertain = false;
    pending.acceptedResult = {
      call_sid: String(acceptedResult.call_sid || '').slice(0, 160),
      status: String(acceptedResult.status || '').slice(0, 40),
      provider: String(acceptedResult.provider || '').slice(0, 40),
    };
    pending.updatedAt = Date.now();
  } else {
    delete session.outboundCallSubmission;
  }
  return true;
}

async function persistCallSubmission(ctx, idempotencyKey) {
  const userId = ctx?.from?.id;
  const pending = ctx?.session?.outboundCallSubmission;
  if (pending?.idempotencyKey === idempotencyKey) {
    await botDb.saveOutboundCallSubmission(userId, pending);
    return;
  }
  await botDb.clearOutboundCallSubmission(userId, idempotencyKey);
}

function isUncertainCallSubmissionError(error) {
  const status = Number(error?.response?.status);
  if (!Number.isFinite(status)) return true;
  const code = String(error?.response?.data?.code || '').toLowerCase();
  if (['idempotency_conflict', 'idempotency_in_progress', 'provider_submission_ambiguous', 'outbound_persistence_failed'].includes(code)) {
    return true;
  }
  return status >= 500 || status === 408 || status === 429;
}

async function selectCallProvider(conversation, ctx, ensureActive, callDefaults) {
  const options = [];
  const directProviders = ['twilio', 'plivo', 'vonage'];
  for (const provider of directProviders) {
    const supported = provider === callDefaults.telephonyProvider ||
      (Array.isArray(callDefaults.supportedProviders) && callDefaults.supportedProviders.includes(provider));
    const ready = callDefaults.readiness?.[provider];
    if (!supported || ready === false) continue;
    options.push({ id: provider, label: `${provider === callDefaults.telephonyProvider ? '⭐ ' : ''}${toTitleCase(provider)}${ready === true ? ' · ready' : ''}` });
  }

  const apiBase = config.apiUrl.replace(/\/+$/, '');
  const authHeaders = config.admin.apiToken ? { 'x-admin-token': config.admin.apiToken } : {};
  try {
    const response = await httpClient.get(ctx, `${apiBase}/api/vapi/status`, { timeout: 8000, headers: authHeaders, retry: { retries: 0 } });
    const status = response?.data?.status || {};
    if (status.enabled === true && status.configured === true) options.push({ id: 'vapi', label: 'Vapi · ready' });
  } catch (_) { /* A provider that cannot pass its status check is not selectable. */ }
  try {
    const response = await httpClient.get(ctx, `${apiBase}/api/cartesia/call-readiness`, { timeout: 8000, retry: { retries: 0 } });
    if (response?.data?.enabled === true) options.push({ id: 'cartesia', label: 'Cartesia Managed Agent · ready' });
  } catch (_) { /* A provider that cannot pass its status check is not selectable. */ }
  options.push({ id: 'cancel', label: '❌ Cancel' });

  const selection = await askOptionWithButtons(conversation, ctx,
    '📡 *Call provider*\nChoose the provider for this call. Provider setup is checked before launch.',
    options, { prefix: 'call-provider', columns: 1 });
  ensureActive();
  return selection?.id || null;
}

async function selectVapiCallSetup(conversation, ctx, ensureActive, script) {
  const apiBase = config.apiUrl.replace(/\/+$/, '');
  const headers = config.admin.apiToken ? { 'x-admin-token': config.admin.apiToken } : {};
  const [mappingResponse, phoneResponse] = await Promise.all([
    httpClient.get(ctx, `${apiBase}/api/call-scripts/${encodeURIComponent(script.id)}/vapi-mappings`, { timeout: 12000, headers }),
    httpClient.get(ctx, `${apiBase}/api/vapi/phone-numbers`, { params: { page: 1, limit: 100 }, timeout: 12000, headers }),
  ]);
  ensureActive();
  const mappings = (Array.isArray(mappingResponse?.data?.mappings) ? mappingResponse.data.mappings : [])
    .filter((item) => Number(item.template_version) === Number(mappingResponse?.data?.current_template_version) &&
      item.compatibility_status === 'compatible' && item.mapping_status === 'provisioned' && item.sync_status === 'synced');
  if (!mappings.length) throw Object.assign(new Error('This script has no current, synced Vapi mapping. Ask an administrator to sync a compatible mapping in /vapi.'), { code: 'call_vapi_mapping_unavailable' });
  const mappingChoice = await askOptionWithButtons(conversation, ctx,
    '🔗 *Vapi assistant mapping*\nChoose the synced assistant version for this script.',
    [...mappings.map((mapping) => ({ id: String(mapping.id), label: `${mapping.vapi_assistant_name || 'Assistant'} · v${mapping.template_version}` })), { id: 'cancel', label: '❌ Cancel' }],
    { prefix: 'call-vapi-mapping', columns: 1 });
  ensureActive();
  if (!mappingChoice?.id || mappingChoice.id === 'cancel') return null;
  const numbers = (Array.isArray(phoneResponse?.data?.phoneNumbers) ? phoneResponse.data.phoneNumbers : [])
    .filter((item) => item?.id && item?.number && item.status !== 'inactive' && item.outboundCapable !== false);
  if (!numbers.length) throw Object.assign(new Error('Vapi has no active caller numbers. Add or activate a phone number in /vapi first.'), { code: 'call_vapi_number_unavailable' });
  const phoneChoice = await askOptionWithButtons(conversation, ctx,
    '☎️ *Vapi caller number*\nChoose the number Vapi will present to the recipient.',
    [...numbers.map((item) => ({ id: String(item.id), label: `${item.name || item.number} · ${String(item.number).slice(-4)}` })), { id: 'cancel', label: '❌ Cancel' }],
    { prefix: 'call-vapi-number', columns: 1 });
  ensureActive();
  if (!phoneChoice?.id || phoneChoice.id === 'cancel') return null;
  return { mapping_id: Number(mappingChoice.id), phone_number_id: phoneChoice.id, script_version: Number(script.version) || Number(mappingResponse?.data?.current_template_version) || 1 };
}

function buildCartesiaConfirmationPhrase(payload) {
  const phrase = `PLACE CARTESIA CALL TO ${payload.number} FROM ${payload.from_number_id} WITH AGENT ${payload.agent_id}`;
  const variables = payload.dynamic_variables && typeof payload.dynamic_variables === 'object' ? payload.dynamic_variables : {};
  if (!Object.keys(variables).length) return phrase;
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const fingerprint = createHash('sha256').update(stable(variables)).digest('hex').slice(0, 12);
  return `${phrase} WITH VARIABLES ${fingerprint}`;
}

const { buildCallbackData } = require('../utils/actions');

const scriptsApiBase = config.scriptsApiUrl.replace(/\/+$/, '');
const DEFAULT_FIRST_MESSAGE = 'Hello! This is an automated call. How can I help you today?';
const PROFILE_FLOW_TYPE_SET = new Set(PROFILE_FLOW_TYPES);

const CORE_FLOW_LABELS = Object.freeze({
  payment_collection: 'Payment collection',
  identity_verification: 'Identity verification',
  appointment_confirmation: 'Appointment confirmation',
  service_recovery: 'Service recovery',
  general_outreach: 'General outreach',
  general: 'General'
});

const CORE_FLOW_BADGES = Object.freeze({
  payment_collection: '💳',
  identity_verification: '🔐',
  appointment_confirmation: '📅',
  service_recovery: '🛠️',
  general_outreach: '📣',
  general: '🧩'
});

const PROFILE_FLOW_LABEL_OVERRIDES = Object.freeze({
  dating: 'Dating',
  celebrity: 'Celebrity fan engagement',
  fan: 'Fan engagement',
  creator: 'Creator collaboration',
  friendship: 'Friendship',
  networking: 'Networking',
  community: 'Community engagement',
  marketplace_seller: 'Marketplace seller',
  real_estate_agent: 'Real estate outreach'
});

const PROFILE_FLOW_BADGE_OVERRIDES = Object.freeze({
  dating: '💕',
  celebrity: '⭐',
  fan: '🌟',
  creator: '🎬',
  friendship: '🤝',
  networking: '📇',
  community: '👥',
  marketplace_seller: '🛍️',
  real_estate_agent: '🏡'
});

function toTitleCase(value = '') {
  return String(value || '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const PROFILE_FLOW_LABELS = Object.freeze(
  PROFILE_FLOW_TYPES.reduce((acc, flowType) => {
    acc[flowType] = PROFILE_FLOW_LABEL_OVERRIDES[flowType] || toTitleCase(flowType);
    return acc;
  }, {})
);

const PROFILE_FLOW_BADGES = Object.freeze(
  PROFILE_FLOW_TYPES.reduce((acc, flowType) => {
    acc[flowType] = PROFILE_FLOW_BADGE_OVERRIDES[flowType] || '💬';
    return acc;
  }, {})
);

const CALL_SCRIPT_FLOW_LABELS = Object.freeze({
  ...CORE_FLOW_LABELS,
  ...PROFILE_FLOW_LABELS
});

const CALL_SCRIPT_FLOW_BADGES = Object.freeze({
  ...CORE_FLOW_BADGES,
  ...PROFILE_FLOW_BADGES
});

const FOLLOW_UP_MODE_LABELS = Object.freeze({
  tax_support: 'Callback or review case',
  tax_resolution: 'Review case, callback, or secure follow-up',
  bank_servicing: 'Secure follow-up, callback, or review case',
  fraud_review: 'Secure follow-up, callback, or review case',
  collections_servicing: 'Callback, review case, or secure follow-up',
  identity_verification_plus: 'Secure follow-up or callback'
});

function isValidPhoneNumber(number) {
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  return e164Regex.test((number || '').trim());
}

function getCallScriptFlowTypes(script = {}) {
  return getCallScriptFlowTypesShared(script);
}

function getPrimaryCallScriptFlowType(script = {}) {
  return getPrimaryFlowTypeShared(script);
}

function getEffectiveObjectiveTags(script = {}) {
  return getEffectiveObjectiveTagsShared(script);
}

function getAutoAttachedScriptProfileFlow(script = {}) {
  return getAutoAttachedScriptProfileFlowShared(script);
}

function resolveScriptProfileRouting(script = {}, overrides = {}) {
  return resolveScriptProfileRoutingShared(script, overrides);
}

function getCallScriptFlowLabel(script = {}) {
  const flowType = getPrimaryCallScriptFlowType(script);
  return CALL_SCRIPT_FLOW_LABELS[flowType] || CALL_SCRIPT_FLOW_LABELS.general;
}

function getCallScriptFlowBadge(script = {}) {
  const flowType = getPrimaryCallScriptFlowType(script);
  return CALL_SCRIPT_FLOW_BADGES[flowType] || CALL_SCRIPT_FLOW_BADGES.general;
}

function formatCallProfileLockState(lockValue) {
  if (lockValue === true) {
    return 'Locked';
  }
  if (lockValue === false) {
    return 'Unlocked';
  }
  return 'Not set';
}

function formatPlaceholderSummary(placeholderValues = {}) {
  const entries = Object.entries(placeholderValues || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) {
    return 'None';
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

function getExpectedFollowUpMode(profileFlow) {
  if (!profileFlow) {
    return 'Runtime-managed';
  }
  return FOLLOW_UP_MODE_LABELS[profileFlow] || 'Runtime-managed';
}

function replacePlaceholders(text = '', values = {}) {
  let output = text;
  for (const [token, value] of Object.entries(values)) {
    const pattern = new RegExp(`{${token}}`, 'g');
    output = output.replace(pattern, value);
  }
  return output;
}

function sanitizeVictimName(rawName) {
  if (!rawName) {
    return null;
  }
  const cleaned = rawName.replace(/[^a-zA-Z0-9\\s'\\-]/g, '').trim();
  return cleaned || null;
}

function buildPersonalizedFirstMessage(baseMessage, victimName, personaLabel) {
  if (!victimName) {
    return baseMessage;
  }
  const greeting = `Hello ${victimName}!`;
  const trimmedBase = (baseMessage || '').trim();
  if (!trimmedBase) {
    const brandLabel = personaLabel || 'our team';
    return `${greeting} Welcome to ${brandLabel}! For your security, we'll complete a quick verification to help protect your account from online fraud. If you've received your 6-digit one-time password by SMS, please enter it now.`;
  }
  const withoutExistingGreeting = trimmedBase.replace(/^hello[^.!?]*[.!?]?\\s*/i, '').trim();
  const remainder = withoutExistingGreeting.length ? withoutExistingGreeting : trimmedBase;
  return `${greeting} ${remainder}`;
}

async function getCallScriptById(scriptId) {
  const response = await httpClient.get(null, `${scriptsApiBase}/api/call-scripts/${scriptId}`, { timeout: 12000 });
  return response.data;
}

async function getCallScripts() {
  const response = await httpClient.get(null, `${scriptsApiBase}/api/call-scripts`, { timeout: 12000 });
  return response.data;
}

async function getCallProviderStatus() {
  const response = await httpClient.get(null, `${scriptsApiBase}/admin/provider`, {
    timeout: 10000,
    headers: {
      'x-admin-token': config.admin.apiToken
    },
    params: {
      channel: 'call'
    }
  });
  return response?.data || {};
}

function getCallProviderSelectionState(status = {}) {
  const call = status.providers?.call || {};
  const supportedProviders = Array.isArray(call.supported_providers)
    ? call.supported_providers.map((item) => String(item || '').toLowerCase())
    : Array.isArray(status.supported_providers)
      ? status.supported_providers.map((item) => String(item || '').toLowerCase())
      : [];
  return {
    telephonyProvider: String(status.provider || call.provider || '').toLowerCase(),
    aiVoiceEngine: String(status.tts_provider || '').toLowerCase(),
    cartesiaProfile: status.cartesia_tts_profile && typeof status.cartesia_tts_profile === 'object' ? status.cartesia_tts_profile : null,
    supportedProviders,
    readiness: call.readiness || {},
    providerReady: call.readiness?.[String(status.provider || call.provider || '').toLowerCase()] ?? null,
    providerHealth: status.provider_health?.[String(status.provider || call.provider || '').toLowerCase()] || null,
  };
}

async function collectPlaceholderValues(conversation, ctx, placeholders, ensureActive) {
  const values = {};
  for (const placeholder of placeholders) {
    await ctx.reply(`✏️ Enter value for *${placeholder}* (type skip to leave unchanged):`, { parse_mode: 'Markdown' });
    const update = await conversation.wait();
    ensureActive();
    const text = update?.message?.text?.trim();
    if (text) {
      await guardAgainstCommandInterrupt(ctx, text);
    }
    if (!text || text.toLowerCase() === 'skip') {
      continue;
    }
    values[placeholder] = text;
  }
  return values;
}

async function fetchCallScripts() {
  const data = await getCallScripts();
  return data.scripts || [];
}

async function fetchCallScriptById(id) {
  const data = await getCallScriptById(id);
  return data.script;
}

async function selectCallScript(conversation, ctx, ensureActive, activeProvider) {
  let scripts;
  try {
    scripts = await fetchCallScripts();
    ensureActive();
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load call scripts.'));
    return { status: 'error' };
  }

  if (!scripts.length) {
    await ctx.reply('ℹ️ No call scripts found. Use /scripts to create one.');
    return { status: 'empty' };
  }

  const options = scripts.map((script) => ({
    id: script.id.toString(),
    label: `${getCallScriptFlowBadge(script)} ${script.name}`
  }));
  options.push({ id: 'back', label: '⬅️ Back' });
  options.push({ id: 'cancel', label: '❌ Cancel' });

  const selection = await askOptionWithButtons(
    conversation,
    ctx,
    '📚 *Call Scripts*\nChoose a script to use for this call.',
    options,
    { prefix: 'call-script', columns: 1 }
  );
  ensureActive();
  if (!selection || !selection.id) {
    await ctx.reply('❌ No script selected.');
    return { status: 'back' };
  }

  if (selection.id === 'back') {
    return { status: 'back' };
  }
  if (selection.id === 'cancel') {
    return { status: 'cancel' };
  }

  const scriptId = Number(selection.id);
  if (Number.isNaN(scriptId)) {
    await ctx.reply('❌ Invalid script selection.');
    return null;
  }

  let script;
  try {
    script = await fetchCallScriptById(scriptId);
    ensureActive();
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load the selected script.'));
    return { status: 'error' };
  }

  if (!script) {
    await ctx.reply('❌ Script not found.');
    return { status: 'error' };
  }

  if (!script.first_message) {
    await ctx.reply('⚠️ This script does not define a first message. Please edit it before using.');
    return { status: 'error' };
  }

  const scriptFlowTypes = getCallScriptFlowTypes(script);
  const scriptProfileRouting = resolveScriptProfileRouting(script);
  const scriptObjectiveTags = scriptProfileRouting.objectiveTags;
  if (scriptFlowTypes.includes('payment_collection')) {
    if (activeProvider && activeProvider !== 'twilio') {
      const providerGuard = await askOptionWithButtons(
        conversation,
        ctx,
        `⚠️ *Payment flow selected*\nActive provider is *${activeProvider}*.\nPayment capture is most reliable on *twilio*.`,
        [
          { id: 'continue', label: '✅ Continue anyway' },
          { id: 'reselect', label: '↩️ Choose another script' },
          { id: 'cancel', label: '❌ Cancel' }
        ],
        { prefix: 'call-script-provider-guard', columns: 1 }
      );
      ensureActive();
      if (!providerGuard || providerGuard.id === 'cancel') {
        return { status: 'cancel' };
      }
      if (providerGuard.id === 'reselect') {
        return { status: 'back' };
      }
    }
  }

  const placeholderSet = new Set();
  extractScriptVariables(script.prompt || '').forEach((token) => placeholderSet.add(token));
  extractScriptVariables(script.first_message || '').forEach((token) => placeholderSet.add(token));

  const placeholderValues = {};
  if (placeholderSet.size > 0) {
    await ctx.reply('🧩 This script contains placeholders. Provide values where applicable (type skip to leave as-is).');
    Object.assign(placeholderValues, await collectPlaceholderValues(conversation, ctx, Array.from(placeholderSet), ensureActive));
  }

  const filledPrompt = script.prompt ? replacePlaceholders(script.prompt, placeholderValues) : undefined;
  const filledFirstMessage = replacePlaceholders(script.first_message, placeholderValues);

  const payloadUpdates = {
    channel: 'voice',
    business_id: script.business_id || config.defaultBusinessId,
    prompt: filledPrompt,
    first_message: filledFirstMessage,
    voice_model: script.voice_model || null,
    script: script.name,
    script_id: script.id
  };
  if (scriptProfileRouting.callProfile) {
    payloadUpdates.call_profile = scriptProfileRouting.callProfile;
  }
  if (scriptProfileRouting.conversationProfile) {
    payloadUpdates.conversation_profile = scriptProfileRouting.conversationProfile;
  }
  if (scriptProfileRouting.attachedProfile) {
    payloadUpdates.attached_profile = scriptProfileRouting.attachedProfile;
  }
  if (scriptProfileRouting.autoAttachProfile !== null && scriptProfileRouting.autoAttachProfile !== undefined) {
    payloadUpdates.auto_attach_profile = scriptProfileRouting.autoAttachProfile;
  }
  if (scriptProfileRouting.profileLockMode) {
    payloadUpdates.profile_lock_mode = scriptProfileRouting.profileLockMode;
  }
  if (scriptProfileRouting.conversationProfileLock !== null && scriptProfileRouting.conversationProfileLock !== undefined) {
    payloadUpdates.conversation_profile_lock = scriptProfileRouting.conversationProfileLock;
  }
  if (scriptProfileRouting.purpose) {
    payloadUpdates.purpose = scriptProfileRouting.purpose;
  }

  const summary = [
    `Script: ${script.name}`,
    `Flow: ${getCallScriptFlowLabel(script)}`,
    `Objective tags: ${scriptObjectiveTags.length ? scriptObjectiveTags.join(', ') : 'none'}`
  ];
  if (script.description) {
    summary.push(`Description: ${script.description}`);
  }

  const businessOption = script.business_id ? findBusinessOption(script.business_id) : null;
  if (businessOption) {
    summary.push(`Persona: ${businessOption.label}`);
  } else if (script.business_id) {
    summary.push(`Persona: ${script.business_id}`);
  }

  if (!payloadUpdates.purpose && businessOption?.defaultPurpose) {
    payloadUpdates.purpose = businessOption.defaultPurpose;
  }

  const personaConfig = script.persona_config || {};
  if (personaConfig.purpose) {
    summary.push(`Purpose: ${personaConfig.purpose}`);
    payloadUpdates.purpose = personaConfig.purpose;
  }
  if (personaConfig.emotion) {
    summary.push(`Tone: ${personaConfig.emotion}`);
    payloadUpdates.emotion = personaConfig.emotion;
  }
  if (personaConfig.urgency) {
    summary.push(`Urgency: ${personaConfig.urgency}`);
    payloadUpdates.urgency = personaConfig.urgency;
  }
  if (personaConfig.technical_level) {
    summary.push(`Technical level: ${personaConfig.technical_level}`);
    payloadUpdates.technical_level = personaConfig.technical_level;
  }

  if (Object.keys(placeholderValues).length > 0) {
    summary.push(`Variables: ${Object.entries(placeholderValues).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  if (!payloadUpdates.purpose) {
    payloadUpdates.purpose = config.defaultPurpose;
  }

  return {
    status: 'ok',
    payloadUpdates,
    summary,
    meta: {
      scriptName: script.name,
      scriptId: script.id,
      scriptVersion: Number(script.version) || 1,
      scriptDescription: script.description || 'No description provided',
      personaLabel: businessOption?.label || script.business_id || 'Custom',
      scriptVoiceModel: script.voice_model || null,
      scriptFlowLabel: getCallScriptFlowLabel(script),
      scriptObjectiveTags,
      placeholderValues
    }
  };
}

async function promptScriptFallback(conversation, ctx, reason = 'empty') {
  const message = reason === 'empty'
    ? '⚠️ No call scripts found. You can create one with /scripts or build a custom persona now.'
    : 'No script selected. You can build a custom persona or cancel.';
  const selection = await askOptionWithButtons(
    conversation,
    ctx,
    message,
    [
      { id: 'custom', label: '🛠️ Build custom persona' },
      { id: 'cancel', label: '❌ Cancel' }
    ],
    { prefix: 'call-script-fallback', columns: 1 }
  );
  return selection?.id || null;
}

async function buildCustomCallConfig(conversation, ctx, ensureActive, businessOptions) {
  const personaOptions = Array.isArray(businessOptions) && businessOptions.length ? businessOptions : await getBusinessOptions();
  const selectedBusiness = await askOptionWithButtons(
    conversation,
    ctx,
    '🎭 *Select service type / persona:*\nTap the option that best matches this call.',
    personaOptions,
    {
      prefix: 'persona',
      columns: 2,
      formatLabel: (option) => (option.custom ? '✍️ Custom Prompt' : option.label)
    }
  );
  ensureActive();

  if (!selectedBusiness) {
    await ctx.reply('❌ Invalid persona selection. Please try again.');
    return null;
  }

  const resolvedBusinessId = selectedBusiness.id || config.defaultBusinessId;
  const payloadUpdates = {
    channel: 'voice',
    business_id: resolvedBusinessId,
    voice_model: null,
    script: selectedBusiness.custom ? 'custom' : resolvedBusinessId,
    purpose: selectedBusiness.defaultPurpose || config.defaultPurpose
  };
  const summary = [];

  if (selectedBusiness.custom) {
    await ctx.reply('✍️ Enter the agent prompt (describe how the AI should behave):');
    const promptMsg = await conversation.wait();
    ensureActive();
    const prompt = promptMsg?.message?.text?.trim();
    if (prompt) {
      await guardAgainstCommandInterrupt(ctx, prompt);
    }
    if (!prompt) {
      await ctx.reply('❌ Please provide a valid prompt.');
      return null;
    }

    await ctx.reply('💬 Enter the first message the agent will say:');
    const firstMsg = await conversation.wait();
    ensureActive();
    const firstMessage = firstMsg?.message?.text?.trim();
    if (firstMessage) {
      await guardAgainstCommandInterrupt(ctx, firstMessage);
    }
    if (!firstMessage) {
      await ctx.reply('❌ Please provide a valid first message.');
      return null;
    }

    payloadUpdates.prompt = prompt;
    payloadUpdates.first_message = firstMessage;
    summary.push('Persona: Custom prompt');
    summary.push(`Prompt: ${prompt.substring(0, 120)}${prompt.length > 120 ? '...' : ''}`);
    summary.push(`First message: ${firstMessage.substring(0, 120)}${firstMessage.length > 120 ? '...' : ''}`);
    const inferredProfile = deriveConversationProfile({
      purpose: null,
      prompt,
      firstMessage,
      fallback: 'general',
    });

    const customFlowOptions = [
      { id: 'general', label: `🧩 ${CALL_SCRIPT_FLOW_LABELS.general || 'General'}` },
      ...PROFILE_FLOW_TYPES.map((flowType) => ({
        id: flowType,
        label: CALL_SCRIPT_FLOW_BADGES[flowType]
          ? `${CALL_SCRIPT_FLOW_BADGES[flowType]} ${CALL_SCRIPT_FLOW_LABELS[flowType] || flowType}`
          : CALL_SCRIPT_FLOW_LABELS[flowType] || flowType
      }))
    ];

    const recommendedLabel = CALL_SCRIPT_FLOW_LABELS[inferredProfile] || inferredProfile || 'General';
    const selectedFlow = await askOptionWithButtons(
      conversation,
      ctx,
      `🧭 *Select call flow for this custom prompt*\nRecommended from prompt text: *${recommendedLabel}*.\nThis will be applied explicitly during call setup.`,
      customFlowOptions,
      {
        prefix: 'custom-flow',
        columns: 1
      }
    );
    ensureActive();

    if (!selectedFlow?.id) {
      await ctx.reply('❌ Flow selection is required for custom prompt mode.');
      return null;
    }

    if (isProfileFlowType(selectedFlow.id)) {
      payloadUpdates.call_profile = selectedFlow.id;
      payloadUpdates.conversation_profile = selectedFlow.id;
      payloadUpdates.conversation_profile_lock = true;
      payloadUpdates.purpose = selectedFlow.id;
      summary.push(`Flow: ${CALL_SCRIPT_FLOW_LABELS[selectedFlow.id] || selectedFlow.id}`);
    } else {
      payloadUpdates.purpose = 'general';
      summary.push(`Flow: ${CALL_SCRIPT_FLOW_LABELS.general || 'General'}`);
    }
  } else {
    const availablePurposes = selectedBusiness.purposes || [];
    let selectedPurpose = availablePurposes.find((p) => p.id === selectedBusiness.defaultPurpose) || availablePurposes[0];

    if (availablePurposes.length > 1) {
      selectedPurpose = await askOptionWithButtons(
        conversation,
        ctx,
        '🎯 *Select call purpose:*\nChoose the specific workflow for this call.',
        availablePurposes,
        {
          prefix: 'purpose',
          columns: 1,
          formatLabel: (option) => `${option.emoji || '•'} ${option.label}`
        }
      );
      ensureActive();
    }

    selectedPurpose = selectedPurpose || availablePurposes[0];
    if (selectedPurpose?.id && selectedPurpose.id !== 'general') {
      payloadUpdates.purpose = selectedPurpose.id;
    }

    const recommendedEmotion = selectedPurpose?.defaultEmotion || 'neutral';
    const moodSelection = await askOptionWithButtons(
      conversation,
      ctx,
      `🎙️ *Tone preference*\nRecommended: *${recommendedEmotion}*.`,
      MOOD_OPTIONS,
      { prefix: 'tone', columns: 2 }
    );
    ensureActive();
    if (moodSelection.id !== 'auto') {
      payloadUpdates.emotion = moodSelection.id;
    }

    const recommendedUrgency = selectedPurpose?.defaultUrgency || 'normal';
    const urgencySelection = await askOptionWithButtons(
      conversation,
      ctx,
      `⏱️ *Urgency level*\nRecommended: *${recommendedUrgency}*.`,
      URGENCY_OPTIONS,
      { prefix: 'urgency', columns: 2 }
    );
    ensureActive();
    if (urgencySelection.id !== 'auto') {
      payloadUpdates.urgency = urgencySelection.id;
    }

    const techSelection = await askOptionWithButtons(
      conversation,
      ctx,
      '🧠 *Caller technical level*\nHow comfortable is the caller with technical details?',
      TECH_LEVEL_OPTIONS,
      { prefix: 'tech', columns: 2 }
    );
    ensureActive();
    if (techSelection.id !== 'auto') {
      payloadUpdates.technical_level = techSelection.id;
    }

    summary.push(`Persona: ${selectedBusiness.label}`);
    if (selectedPurpose?.label) {
      summary.push(`Purpose: ${selectedPurpose.label}`);
    }

    const toneSummary = moodSelection.id === 'auto'
      ? `${moodSelection.label} (${getOptionLabel(MOOD_OPTIONS, recommendedEmotion)})`
      : moodSelection.label;
    const urgencySummary = urgencySelection.id === 'auto'
      ? `${urgencySelection.label} (${getOptionLabel(URGENCY_OPTIONS, recommendedUrgency)})`
      : urgencySelection.label;
    const techSummary = techSelection.id === 'auto'
      ? getOptionLabel(TECH_LEVEL_OPTIONS, 'general')
      : techSelection.label;

    summary.push(`Tone: ${toneSummary}`);
    summary.push(`Urgency: ${urgencySummary}`);
    summary.push(`Technical level: ${techSummary}`);
  }

  return {
    payloadUpdates,
    summary,
    meta: {
      scriptName: personaOptions?.label || 'Custom',
      scriptDescription: 'Custom persona configuration',
      personaLabel: personaOptions?.label || 'Custom',
      scriptVoiceModel: null
    }
  };
}

async function callFlow(conversation, ctx) {
  const opId = startOperation(ctx, 'call');
  let callSubmissionKey = null;
  let callRequestStarted = false;
  const forceFreshCallSubmission = ctx.session?.callForceNewSubmission === true;
  if (ctx.session) delete ctx.session.callForceNewSubmission;
  const flow = ensureFlow(ctx, 'call', { step: 'start' });
  const advancedVoiceOptions = ctx.session?.callAdvancedVoiceOptions === true;
  if (ctx.session) delete ctx.session.callAdvancedVoiceOptions;
  const ensureActive = () => ensureOperationActive(ctx, opId);

  const waitForMessage = async () => {
    const update = await conversation.wait();
    ensureActive();
    const text = update?.message?.text?.trim();
    if (text) {
      await guardAgainstCommandInterrupt(ctx, text);
    }
    return update;
  };

  try {
    await sendEphemeral(ctx, 'Starting call process…');
    const access = await getAccessProfile(ctx);
    ensureActive();
    if (!access.isAuthorized) {
      await ctx.reply('❌ Access denied. Your account is not authorized for this action.');
      return;
    }
    flow.touch('authorized');

    const providerStatus = await getCallProviderStatus();
    ensureActive();
    const selectionState = getCallProviderSelectionState(providerStatus);
    const selectedProvider = await selectCallProvider(conversation, ctx, ensureActive, selectionState);
    if (!selectedProvider || selectedProvider === 'cancel') {
      await ctx.reply(cancelledMessage('Call setup', 'Use /call to start again.'), { parse_mode: 'Markdown' });
      return;
    }
    const activeProvider = selectedProvider;
    const managedAgentMode = activeProvider === 'cartesia';
    const vapiMode = activeProvider === 'vapi';
    const directProviderMode = !managedAgentMode && !vapiMode;
    const callDefaults = directProviderMode
      ? resolveCallProviderDefaults({
        ...providerStatus,
        provider: activeProvider,
        providers: {
          ...(providerStatus.providers || {}),
          call: { ...(providerStatus.providers?.call || {}), provider: activeProvider },
        },
      })
      : selectionState;
    flow.touch('provider-resolved');

    const businessOptions = await getBusinessOptions();
    ensureActive();
    flow.touch('business-options');

    const prefill = ctx.session.meta?.prefill || {};
    let number = prefill.phoneNumber || null;
    let victimName = prefill.victimName || null;

    if (number) {
      await ctx.reply(`📞 Using follow-up number: ${number}`);
      if (ctx.session.meta) {
        delete ctx.session.meta.prefill;
      }
      flow.touch('number-prefilled');
    } else {
      await ctx.reply(setupStepMessage('Call setup', [
        'Enter phone number in E.164 format.',
        'Example: +16125151442'
      ]), { parse_mode: 'Markdown' });
      const numMsg = await waitForMessage();
      number = numMsg?.message?.text?.trim();

      if (!number) {
        await ctx.reply('❌ Please provide a phone number.');
        return;
      }

      if (!isValidPhoneNumber(number)) {
        await ctx.reply('❌ Invalid phone number format. Use E.164 format: +16125151442');
        return;
      }
      flow.touch('number-captured');
    }

    if (victimName) {
      await ctx.reply(`👤 Using victim name: ${victimName}`);
    } else {
      await ctx.reply(setupStepMessage('Caller details', [
        'Enter the victim name as it should be spoken on the call.',
        'Type `skip` to leave blank.'
      ]), { parse_mode: 'Markdown' });
      const nameMsg = await waitForMessage();
      const providedName = nameMsg?.message?.text?.trim();
      if (providedName && providedName.toLowerCase() !== 'skip') {
        const sanitized = sanitizeVictimName(providedName);
        if (sanitized) {
          victimName = sanitized;
          flow.touch('victim-name');
        }
      }
    }

    let configuration = null;
    let cartesiaProfile = null;
    let vapiCallSetup = null;
    if (managedAgentMode) {
      const businessId = String(config.defaultBusinessId || '').trim();
      if (!businessId) throw Object.assign(new Error('Set DEFAULT_BUSINESS_ID and authorize this Telegram account as a business call operator before using Cartesia Managed Agents.'), { code: 'call_cartesia_business_missing' });
      const profileResponse = await httpClient.get(ctx, `${config.apiUrl.replace(/\/+$/, '')}/api/cartesia/provider-defaults`, {
        params: { business_id: businessId }, timeout: 10000, retry: { retries: 0 }
      });
      ensureActive();
      cartesiaProfile = profileResponse?.data?.profile || {};
      if (!cartesiaProfile.agent_id || !cartesiaProfile.from_number_id) throw Object.assign(new Error('Cartesia Managed Agent defaults are incomplete. Ask a Cartesia administrator to set the business agent and source number in /cartesia.'), { code: 'call_cartesia_defaults_missing' });
      configuration = {
        payloadUpdates: { business_id: businessId, provider: 'cartesia', agent_id: cartesiaProfile.agent_id, from_number_id: cartesiaProfile.from_number_id },
        summary: [`Cartesia agent: ${cartesiaProfile.agent_id}`, `Source number ID: ${cartesiaProfile.from_number_id}`],
        meta: { scriptName: 'Cartesia Managed Agent', personaLabel: 'Cartesia Managed Agent' },
      };
    } else {
      const configurationMode = await askOptionWithButtons(
        conversation,
        ctx,
        vapiMode ? '⚙️ Vapi uses a synced call script. Select a script to continue.' : '⚙️ How would you like to configure this call?',
        [
          { id: 'script', label: '📁 Use call script' },
          ...(!vapiMode ? [{ id: 'custom', label: '🛠️ Build custom persona' }] : []),
          { id: 'cancel', label: '❌ Cancel' }
        ],
        { prefix: 'call-config', columns: 1 }
      );
      ensureActive();
      if (!configurationMode || configurationMode.id === 'cancel') {
        await ctx.reply(cancelledMessage('Call setup', 'Use /call to start again.'), {
          parse_mode: 'Markdown',
          reply_markup: buildBackToMenuReplyMarkup(ctx, { backAction: 'CALL', backLabel: '⬅️ Back to Call' })
        });
        return;
      }

      if (configurationMode.id === 'script') {
      const selection = await selectCallScript(conversation, ctx, ensureActive, activeProvider);
      if (selection?.status === 'ok') {
        configuration = selection;
      } else if (selection?.status === 'cancel') {
        await ctx.reply(cancelledMessage('Call setup', 'Use /call to start again.'), {
          parse_mode: 'Markdown',
          reply_markup: buildBackToMenuReplyMarkup(ctx, {
            backAction: 'CALL',
            backLabel: '⬅️ Back to Call'
          })
        });
        return;
      } else if (!vapiMode && (selection?.status === 'empty' || selection?.status === 'back')) {
        const fallbackChoice = await promptScriptFallback(
          conversation,
          ctx,
          selection?.status === 'empty' ? 'empty' : 'back'
        );
        ensureActive();
        if (fallbackChoice !== 'custom') {
          await ctx.reply(cancelledMessage('Call setup', 'Use /call to start again.'), {
            parse_mode: 'Markdown',
            reply_markup: buildBackToMenuReplyMarkup(ctx, {
              backAction: 'CALL',
              backLabel: '⬅️ Back to Call'
            })
          });
          return;
        }
      } else if (selection?.status === 'error' || (vapiMode && (selection?.status === 'empty' || selection?.status === 'back'))) {
        await safeReset(ctx, 'call_script_error', {
          message: vapiMode ? '⚠️ Vapi requires an existing call script.' : '⚠️ Unable to load call scripts.',
          menuHint: vapiMode ? '📋 Create a call script, sync its Vapi mapping, then use /call again.' : '📋 Check API credentials or use /call to try again.'
        });
        return;
      }
      }
    }
    flow.touch('mode-selected');

    if (!configuration) {
      if (vapiMode) throw Object.assign(new Error('Vapi calls require a call script with a current, compatible mapping.'), { code: 'call_vapi_mapping_unavailable' });
      configuration = await buildCustomCallConfig(conversation, ctx, ensureActive, businessOptions);
    }

    if (!configuration) {
      await ctx.reply(cancelledMessage('Call setup', 'Use /call to start again.'), {
        parse_mode: 'Markdown',
        reply_markup: buildBackToMenuReplyMarkup(ctx, {
          backAction: 'CALL',
          backLabel: '⬅️ Back to Call'
        })
      });
      return;
    }
    flow.touch('configuration-ready');

    const payload = {
      number,
      user_chat_id: ctx.from.id.toString(),
      customer_name: victimName || null,
      ...configuration.payloadUpdates,
      preferred_provider: activeProvider
    };

    const scriptVariables = configuration.meta?.placeholderValues && typeof configuration.meta.placeholderValues === 'object'
      ? configuration.meta.placeholderValues
      : {};
    if (activeProvider === 'cartesia' && Object.keys(scriptVariables).length) {
      payload.dynamic_variables = scriptVariables;
    }

    if (vapiMode) {
      const scriptId = Number(configuration.meta?.scriptId || configuration.payloadUpdates?.script_id);
      const scriptVersion = Number(configuration.meta?.scriptVersion || 1);
      const vapiSetup = await selectVapiCallSetup(conversation, ctx, ensureActive, { id: scriptId, version: scriptVersion });
      if (!vapiSetup) {
        await ctx.reply(cancelledMessage('Vapi call setup', 'Use /call to start again.'), { parse_mode: 'Markdown' });
        return;
      }
      vapiCallSetup = vapiSetup;
      Object.assign(payload, vapiSetup, {
        provider: 'vapi',
        script_version: vapiSetup.script_version,
        first_message_override: configuration.payloadUpdates?.first_message || undefined,
        variable_values: scriptVariables,
      });
    }

    payload.business_id = payload.business_id || config.defaultBusinessId;
    payload.purpose = payload.purpose || config.defaultPurpose;
    payload.voice_model = payload.voice_model || null;
    payload.script = payload.script || 'custom';
    payload.technical_level = payload.technical_level || 'auto';

    const scriptName =
      configuration.meta?.scriptName ||
      configuration.payloadUpdates?.script ||
      'Custom';
    const personaLabel =
      configuration.meta?.personaLabel ||
      configuration.payloadUpdates?.persona_label ||
      'Custom';
    const scriptVoiceModel = configuration.meta?.scriptVoiceModel || null;
    const scriptFlowLabel = configuration.meta?.scriptFlowLabel || null;
    const scriptObjectiveTags = Array.isArray(configuration.meta?.scriptObjectiveTags)
      ? configuration.meta.scriptObjectiveTags.filter(Boolean)
      : [];

    const defaultVoice = config.defaultVoiceModel;
    if (managedAgentMode || vapiMode) {
      payload.voice_model = null;
    } else if (callDefaults.aiVoiceEngine === 'cartesia') {
      payload.voice_model = resolveCallVoiceModel({
        aiVoiceEngine: callDefaults.aiVoiceEngine,
        scriptVoiceModel,
      });
    } else {
      const voiceCatalog = await fetchVoiceModelCatalog(ctx);
      const availableVoiceModels = Array.isArray(voiceCatalog.models) ? voiceCatalog.models : [];
      const configuredVoice = voiceCatalog.source === 'bot_fallback'
        ? null
        : voiceCatalog.defaults?.runtime_voice_model || null;
      if (!advancedVoiceOptions) {
        payload.voice_model = resolveCallVoiceModel({
          aiVoiceEngine: callDefaults.aiVoiceEngine,
          scriptVoiceModel,
          configuredVoice,
        });
      } else {
        if (availableVoiceModels.length > 8) {
          await ctx.reply('🔎 Tip: use Search in the voice picker to filter by model id quickly.');
        }
        const advancedDefaultVoice = configuredVoice || defaultVoice;

        const voiceSelection = await askVoiceModelWithPagination(
          conversation,
          ctx,
          {
            prompt: '🎙️ *Voice selection*\nChoose which voice to use for this call.',
            models: availableVoiceModels,
            topOptions: [
              { id: 'auto', label: '⚙️ Auto (best for flow)' },
              ...(scriptVoiceModel
                ? [{ id: 'script', label: `🎤 Script voice (${scriptVoiceModel})` }]
                : []),
              ...(advancedDefaultVoice && advancedDefaultVoice !== scriptVoiceModel
                ? [{ id: 'default', label: `🎧 Default voice (${advancedDefaultVoice})` }]
                : []),
            ],
            bottomOptions: [
              { id: 'custom', label: '✍️ Custom voice id' },
              { id: 'cancel', label: '❌ Cancel' },
            ],
            prefix: 'call-voice',
            pageSize: 8,
            ensureActive,
          }
        );
        ensureActive();
        if (!voiceSelection || voiceSelection.id === 'cancel') {
          await ctx.reply(cancelledMessage('Call setup', 'Use /call to start again.'), {
            parse_mode: 'Markdown',
            reply_markup: buildBackToMenuReplyMarkup(ctx, {
              backAction: 'CALL',
              backLabel: '⬅️ Back to Call'
            })
          });
          return;
        }

        if (voiceSelection?.id === 'auto') {
          payload.voice_model = null;
        } else if (voiceSelection?.id === 'script' && scriptVoiceModel) {
          payload.voice_model = scriptVoiceModel;
        } else if (voiceSelection?.id === 'default') {
          payload.voice_model = advancedDefaultVoice;
        } else if (voiceSelection?.id?.startsWith('model:')) {
          payload.voice_model = voiceSelection.id.slice('model:'.length).trim() || null;
        } else if (voiceSelection?.id === 'custom') {
          await ctx.reply(setupStepMessage('Voice override', [
            'Enter the voice model id to use.',
            'Type `skip` for Auto voice selection.'
          ]), { parse_mode: 'Markdown' });
          const voiceMsg = await waitForMessage();
          let customVoice = voiceMsg?.message?.text?.trim();
          if (customVoice && customVoice.toLowerCase() === 'skip') {
            customVoice = null;
          }
          payload.voice_model = customVoice || null;
        }
      }
    }

    if (!payload.first_message) {
      payload.first_message = DEFAULT_FIRST_MESSAGE;
    }
    payload.first_message = buildPersonalizedFirstMessage(
      payload.first_message,
      victimName,
      personaLabel
    );

    const toneValue = payload.emotion || 'auto';
    const urgencyValue = payload.urgency || 'auto';
    const techValue = payload.technical_level || 'auto';
    const hasAutoFields = [toneValue, urgencyValue, techValue].some((value) => value === 'auto');
    const attachedProfile = payload.call_profile || payload.conversation_profile || null;
    const placeholderSummary = formatPlaceholderSummary(configuration?.meta?.placeholderValues);
    const providerLabel = activeProvider ? toTitleCase(activeProvider) : 'Unknown';
    const expectedFollowUpMode = getExpectedFollowUpMode(attachedProfile || payload.purpose);
    const selectedProviderReady = managedAgentMode || vapiMode
      ? true
      : callDefaults.readiness?.[activeProvider] ?? callDefaults.providerReady;

    const detailLines = [
      buildLine('📋', 'To', number),
      victimName ? buildLine('👤', 'Victim', escapeMarkdown(victimName)) : null,
      buildLine('🧩', 'Script', escapeMarkdown(scriptName)),
      scriptFlowLabel ? buildLine('🧭', 'Flow', escapeMarkdown(scriptFlowLabel)) : null,
      buildLine('🪪', 'Attached profile', escapeMarkdown(attachedProfile || 'None')),
      scriptObjectiveTags.length
        ? buildLine('🏷️', 'Objective tags', escapeMarkdown(scriptObjectiveTags.join(', ')))
        : null,
      buildLine(
        '🎤',
        managedAgentMode ? 'Managed agent' : vapiMode ? 'Vapi assistant' : callDefaults.aiVoiceEngine === 'cartesia' ? 'Cartesia voice' : 'Voice',
        escapeMarkdown(managedAgentMode
          ? cartesiaProfile.agent_id
          : vapiMode
            ? `Mapping ${vapiCallSetup.mapping_id}`
            : callDefaults.aiVoiceEngine === 'cartesia'
          ? callDefaults.cartesiaProfile.voice_id
          : payload.voice_model || (advancedVoiceOptions ? 'Auto (best for flow)' : 'Configured default'))
      ),
      !managedAgentMode && !vapiMode && callDefaults.aiVoiceEngine === 'cartesia'
        ? buildLine('🧠', 'TTS model', escapeMarkdown(callDefaults.cartesiaProfile.model_id))
        : null,
      buildLine('🧠', 'AI voice engine', managedAgentMode ? 'Cartesia Managed Agent' : vapiMode ? 'Vapi' : toTitleCase(callDefaults.aiVoiceEngine)),
      payload.purpose ? buildLine('🎯', 'Purpose', escapeMarkdown(payload.purpose)) : null,
      buildLine('📡', 'Provider', escapeMarkdown(providerLabel)),
      buildLine(
        '✅',
        'Telephony configuration',
        selectedProviderReady === true
          ? 'Ready'
          : selectedProviderReady === false
            ? 'Not ready'
            : 'Not verified'
      ),
      buildLine(
        '🛡️',
        'Consent and contact policy',
        'Checked by the API before dispatch; no call is placed if blocked'
      ),
      !managedAgentMode && !vapiMode && (callDefaults.providerHealth?.degraded === true ||
      callDefaults.providerHealth?.circuit_state === 'open')
        ? buildLine('⚠️', 'Provider health', 'Recent API errors detected; provider routing may fail over')
        : null,
      buildLine('🔒', 'Profile lock', escapeMarkdown(formatCallProfileLockState(payload.conversation_profile_lock))),
      buildLine('🧩', 'Placeholder values', escapeMarkdown(placeholderSummary)),
      buildLine('🪜', 'Follow-up mode', escapeMarkdown(expectedFollowUpMode))
    ].filter(Boolean);

    if (toneValue !== 'auto') {
      detailLines.push(buildLine('🎙️', 'Tone', toneValue));
    }
    if (urgencyValue !== 'auto') {
      detailLines.push(buildLine('⏱️', 'Urgency', urgencyValue));
    }
    if (techValue !== 'auto') {
      detailLines.push(buildLine('🧠', 'Technical level', techValue));
    }
    if (hasAutoFields) {
      detailLines.push(tipLine('⚙️', 'Mode: Auto'));
    }

    let callBriefKeyboard = null;
    if (hasAutoFields) {
      const detailsKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      if (!ctx.session.callDetailsCache) {
        ctx.session.callDetailsCache = {};
      }
      if (!ctx.session.callDetailsKeys) {
        ctx.session.callDetailsKeys = [];
      }
      ctx.session.callDetailsCache[detailsKey] = [
        'ℹ️ Call Details:',
        `• Tone: ${toneValue}`,
        `• Urgency: ${urgencyValue}`,
        `• Technical level: ${techValue}`
      ].join('\n');
      ctx.session.callDetailsKeys.push(detailsKey);
      if (ctx.session.callDetailsKeys.length > 10) {
        const oldestKey = ctx.session.callDetailsKeys.shift();
        if (oldestKey) {
          delete ctx.session.callDetailsCache[oldestKey];
        }
      }
      callBriefKeyboard = {
        inline_keyboard: [[{ text: 'ℹ️ Details', callback_data: buildCallbackData(ctx, `CALL_DETAILS:${detailsKey}`) }]]
      };
    }

    const callBriefMessage = await renderMenu(ctx, section('🔍 Call Launch Summary', detailLines), callBriefKeyboard, {
      payload: { parse_mode: 'Markdown' }
    });
    const launchConfirmation = await askOptionWithButtons(
      conversation,
      ctx,
      section('✅ Confirm Call Launch', [
        'Review the summary above, then confirm the call.',
        'The summary will be cleared once you confirm or cancel.'
      ]),
      [
        { id: 'confirm', label: '✅ Confirm and call' },
        { id: 'cancel', label: '❌ Cancel' }
      ],
      {
        prefix: 'call-launch-confirm',
        columns: 1,
        ensureActive,
        keepMessage: callBriefMessage
      }
    );
    ensureActive();
    await dismissMenuMessage(ctx, callBriefMessage);
    if (!launchConfirmation || launchConfirmation.id !== 'confirm') {
      await ctx.reply(cancelledMessage('Call setup', 'Use /call to start again.'), {
        parse_mode: 'Markdown',
        reply_markup: buildBackToMenuReplyMarkup(ctx, {
          backAction: 'CALL',
          backLabel: '⬅️ Back to Call'
        })
      });
      return;
    }
    await sendEphemeral(ctx, '⏳ Making the call…');

    const persistedSubmission = await botDb.getOutboundCallSubmission(ctx.from?.id);
    if (persistedSubmission) ctx.session.outboundCallSubmission = persistedSubmission;
    if (forceFreshCallSubmission) {
      if (ctx.session.outboundCallSubmission?.outcomeUncertain === true) {
        await notifyCallError(ctx, 'A previous call may still have been accepted. Check /calllog or /callmonitor before starting a fresh call.');
        await safeReset(ctx, 'call_fresh_retry_blocked', {
          message: '⚠️ No new call was started.',
          menuHint: '📋 Review call history before another attempt.'
        });
        return;
      }
      const priorKey = ctx.session.outboundCallSubmission?.idempotencyKey;
      if (priorKey) await botDb.clearOutboundCallSubmission(ctx.from?.id, priorKey);
      delete ctx.session.outboundCallSubmission;
    }
    const submission = prepareCallSubmission(ctx.session, payload);
    if (submission.blocked) {
      await notifyCallError(ctx, [
        'A previous call with different details may still have been accepted.',
        'Check /calllog or /callmonitor before starting another call. To safely replay the same request, use the same call details so VOICEDNUT can reuse its submission key.'
      ]);
      await safeReset(ctx, 'call_submission_uncertain', {
        message: '⚠️ No new call was started.',
        menuHint: '📋 Review call history, then retry with the same details if appropriate.'
      });
      return;
    }
    callSubmissionKey = submission.idempotencyKey;
    payload.idempotency_key = callSubmissionKey;
    await persistCallSubmission(ctx, callSubmissionKey);

    const payloadForLog = { ...payload };
    if (payloadForLog.prompt) {
      payloadForLog.prompt = `${payloadForLog.prompt.substring(0, 50)}${payloadForLog.prompt.length > 50 ? '...' : ''}`;
    }

    console.log('Sending call request to API');

    if (managedAgentMode) {
      const approvalPayload = {
        business_id: payload.business_id,
        destination: payload.number,
        agent_id: payload.agent_id,
        from_number_id: payload.from_number_id,
        idempotency_key: payload.idempotency_key,
        dynamic_variables: payload.dynamic_variables || {},
        confirmation_phrase: buildCartesiaConfirmationPhrase(payload),
      };
      const approvalResponse = await httpClient.post(ctx, `${config.apiUrl.replace(/\/+$/, '')}/api/cartesia/call-approval`, approvalPayload, {
        timeout: 12000,
        retry: { retries: 0 },
      });
      const approvalToken = String(approvalResponse?.data?.approval_token || '').trim();
      if (!approvalToken) throw Object.assign(new Error('Cartesia did not return call approval. No call was submitted.'), { code: 'cartesia_approval_unavailable' });
      payload.approval_token = approvalToken;
    }

    const controller = new AbortController();
    const release = registerAbortController(ctx, controller);
    let data;
    try {
      callRequestStarted = true;
      const response = await httpClient.post(ctx, `${config.apiUrl}/outbound-call`, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000,
        signal: controller.signal
      });
      data = response?.data;
      ensureActive();
    } finally {
      release();
    }
    if (data?.success && data.call_sid) {
      resolveCallSubmissionOutcome(ctx.session, callSubmissionKey, false, {
        call_sid: data.call_sid,
        status: data.status,
        provider: data.provider,
      });
      await persistCallSubmission(ctx, callSubmissionKey).catch((error) => {
        console.error('call_submission_confirmation_state_persist_failed', {
          code: String(error?.code || 'storage_error').slice(0, 80),
        });
      });
      try {
        await ctx.reply(formatCallAcceptedMessage(data), {
          reply_markup: buildBackToMenuReplyMarkup(ctx, {
            backAction: 'CALL',
            backLabel: '⬅️ Back to Call'
          })
        });
      } catch (error) {
        console.error('call_acceptance_confirmation_delivery_failed', {
          call_reference: String(data.call_sid).replace(/[^A-Za-z0-9]/g, '').slice(-8) || null,
          code: String(error?.code || 'telegram_delivery_failed').slice(0, 80)
        });
      }
      flow.touch('completed');
    } else {
      resolveCallSubmissionOutcome(ctx.session, callSubmissionKey, true);
      await persistCallSubmission(ctx, callSubmissionKey).catch(() => {});
      await ctx.reply(`⚠️ The call response was incomplete, so VOICEDNUT could not confirm whether a call was created. Do not retry yet. ${getReconciliationInstruction(activeProvider)}`, {
        reply_markup: buildBackToMenuReplyMarkup(ctx, {
          backAction: 'CALL',
          backLabel: '⬅️ Back to Call'
        })
      });
    }
  } catch (error) {
    if (callSubmissionKey) {
      resolveCallSubmissionOutcome(ctx.session, callSubmissionKey,
        callRequestStarted && isUncertainCallSubmissionError(error));
      await persistCallSubmission(ctx, callSubmissionKey).catch((persistError) => {
        console.error('call_submission_recovery_state_persist_failed', {
          code: String(persistError?.code || 'storage_error').slice(0, 80),
        });
      });
    }
    if (error instanceof OperationCancelledError || error?.name === 'AbortError' || error?.name === 'CanceledError') {
      console.log('Call flow cancelled');
      return;
    }

    if ([
      'call_provider_config_invalid',
      'call_provider_operation_unsupported',
      'call_provider_not_ready',
      'call_voice_engine_config_invalid',
      'call_cartesia_profile_incomplete',
      'call_cartesia_business_missing',
      'call_cartesia_defaults_missing',
      'call_vapi_mapping_unavailable', 'call_vapi_number_unavailable'
    ].includes(error?.code)) {
      await notifyCallError(ctx, error.message);
      await safeReset(ctx, 'call_provider_config_error', {
        message: '⚠️ Provider setup needs attention.',
        menuHint: '📋 Review /provider or /cartesia settings, then use /call again.'
      });
      return;
    }

    console.error('Call error:', {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText
    });

    let handled = false;
    if (error.response) {
      const status = error.response.status;
      const apiError = (error.response.data?.error || '').toString();
      const apiCode = String(error.response.data?.code || '').toLowerCase();
      const unknownBusinessMatch = apiError.match(/Unknown business_id "([^"]+)"/i);
      if (apiCode === 'outbound_persistence_failed') {
        await notifyCallError(ctx, `The provider may have accepted this call, but VOICEDNUT could not confirm it was saved. Do not retry yet. ${getReconciliationInstruction(activeProvider)}`);
        handled = true;
      } else if (apiCode.startsWith('outbound_') &&
          /(consent|opted_out|cooldown|quiet_hours|emergency_stop|contact_policy)/.test(apiCode)) {
        await notifyCallError(ctx, 'The business contact or safety policy blocked this call before provider dispatch. No call was placed; ask a policy manager to review consent and settings.');
        handled = true;
      } else if (unknownBusinessMatch) {
        const invalidId = unknownBusinessMatch[1];
        await notifyCallError(ctx, `${tipLine('🧩', `Unrecognized service “${escapeMarkdown(invalidId)}”. Choose a valid profile.`)}`);
        handled = true;
      } else if (apiCode === 'provider_operation_unsupported') {
        await notifyCallError(ctx, apiError || 'The selected telephony provider cannot place this call. Review /provider and choose a direct-call provider.');
        handled = true;
      } else if (status === 400) {
        const detail = apiError.trim().slice(0, 300);
        await notifyCallError(ctx, detail
          ? `Call setup needs attention: ${escapeMarkdown(detail)}`
          : 'Invalid call setup. Review the selected script and required details, then try again.');
        handled = true;
      } else if (status === 401 || status === 403) {
        await notifyCallError(ctx, 'Your account or selected business is not authorized to place this call. Ask an administrator to review your access.');
        handled = true;
      } else if (status === 503) {
        await notifyCallError(ctx, 'Service unavailable. Please try again shortly.');
        handled = true;
      }

      if (!handled) {
        const errorData = error.response.data;
        await notifyCallError(ctx, `${tipLine('🔍', `Call failed with status ${status}: ${escapeMarkdown(errorData?.error || error.response.statusText)}`)}`);
        handled = true;
      }
    } else if (error.request) {
      await notifyCallError(ctx, `VOICEDNUT did not receive confirmation from the API. Do not retry yet. ${getReconciliationInstruction(activeProvider)}`);
      handled = true;
    } else {
      await notifyCallError(ctx, httpClient.getUserMessage(error, `Unexpected error: ${escapeMarkdown(error.message)}`));
      handled = true;
    }

    await safeReset(ctx, 'call_flow_error', {
      message: '⚠️ Setup interrupted — restarting call setup...',
      menuHint: '📋 Use /call to try again or /menu for other actions.'
    });
  }
}

function registerCallCommand(bot) {
  bot.command('call', async (ctx) => {
    try {
      console.log(`Call command started by user ${ctx.from?.id || 'unknown'}`);
      const requestedMode = String(ctx.message?.text || '').trim().split(/\s+/).slice(1)[0]?.toLowerCase() || '';
      if (requestedMode && !['advanced', 'new'].includes(requestedMode)) {
        return ctx.reply('Usage: /call, /call advanced, or /call new');
      }
      const access = await getAccessProfile(ctx);
      if (!access.isAuthorized) {
        return ctx.reply('❌ Access denied. Your account is not authorized for this action.');
      }
      ctx.session.callAdvancedVoiceOptions = requestedMode === 'advanced';
      ctx.session.callForceNewSubmission = requestedMode === 'new';
      await ctx.conversation.enter('call-conversation');
    } catch (error) {
      console.error('Error starting call conversation:', error);
      await ctx.reply('❌ Could not start call process. Please try again.');
    }
  });
}

module.exports = {
  callFlow,
  formatCallAcceptedMessage,
  getReconciliationInstruction,
  buildCartesiaConfirmationPhrase,
  resolveCallProviderDefaults,
  getCallProviderSelectionState,
  resolveCallVoiceModel,
  prepareCallSubmission,
  resolveCallSubmissionOutcome,
  persistCallSubmission,
  isUncertainCallSubmissionError,
  registerCallCommand
};
