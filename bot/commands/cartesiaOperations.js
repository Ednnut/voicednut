'use strict';

const crypto = require('node:crypto');
const { InlineKeyboard, InputFile } = require('grammy');
const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { buildCallbackData } = require('../utils/actions');
const { escapeHtml, escapeMarkdown, renderMenu } = require('../utils/ui');
const { askOptionWithButtons } = require('../utils/persona');
const { startOperation, ensureOperationActive } = require('../utils/sessionState');

const ACTIONS = new Set(['CARTESIA_CALL', 'CARTESIA_RECONCILE', 'CARTESIA_CALLS', 'CARTESIA_REVIEW_QUEUE', 'CARTESIA_REVIEW_RULES', 'CARTESIA_CAMPAIGN', 'CARTESIA_CAMPAIGN_STATUS', 'CARTESIA_CAMPAIGN_RECONCILE', 'CARTESIA_BATCH_RECONCILE', 'CARTESIA_BATCH_CANCEL', 'CARTESIA_BATCH_RETRY', 'CARTESIA_AGENT_HEALTH', 'CARTESIA_AGENT_RUNTIME', 'CARTESIA_BUSINESS_SCOPE']);
const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const DESTINATION_PATTERN = /^\+[1-9]\d{7,14}$/;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,180}$/;
const MAX_CARTESIA_CAMPAIGN_RECIPIENTS = 1000;
const MAX_CARTESIA_CAMPAIGN_RECIPIENTS_PER_MESSAGE = 100;
const CANCEL_WORDS = new Set(['cancel', 'exit', 'quit']);
const SCHEDULE_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

function apiRoot() {
  return String(config.apiUrl || '').replace(/\/+$/, '');
}

function buildCartesiaKeyboard(ctx) {
  return new InlineKeyboard()
    .text('📞 Place a single call', buildCallbackData(ctx, 'CARTESIA_CALL')).row()
    .text('👥 Plan a batch campaign', buildCallbackData(ctx, 'CARTESIA_CAMPAIGN')).row()
    .text('🔎 Check campaign status', buildCallbackData(ctx, 'CARTESIA_CAMPAIGN_STATUS')).row()
    .text('🔄 Refresh provider progress', buildCallbackData(ctx, 'CARTESIA_CAMPAIGN_RECONCILE')).row()
    .text('🔄 Reconcile batch progress', buildCallbackData(ctx, 'CARTESIA_BATCH_RECONCILE')).row()
    .text('🎛 Cartesia Studio', buildCallbackData(ctx, 'CARTESIA_STUDIO_CENTER')).row()
    .text('⛔ Cancel queued batch calls', buildCallbackData(ctx, 'CARTESIA_BATCH_CANCEL')).row()
    .text('↻ Retry failed recipients', buildCallbackData(ctx, 'CARTESIA_BATCH_RETRY')).row()
    .text('📋 Recent calls', buildCallbackData(ctx, 'CARTESIA_CALLS')).row()
    .text('🧭 Post-call review queue', buildCallbackData(ctx, 'CARTESIA_REVIEW_QUEUE')).row()
    .text('🧭 Post-call review rules', buildCallbackData(ctx, 'CARTESIA_REVIEW_RULES')).row()
    .text('🩺 Agent & deployment health', buildCallbackData(ctx, 'CARTESIA_AGENT_HEALTH')).row()
    .text('🔌 Managed Agent runtime', buildCallbackData(ctx, 'CARTESIA_AGENT_RUNTIME')).row()
    .text('🏢 Assign number to a business', buildCallbackData(ctx, 'CARTESIA_BUSINESS_SCOPE')).row()
    .text('🔎 Reconcile a call', buildCallbackData(ctx, 'CARTESIA_RECONCILE')).row()
    .text('⬅️ Main menu', buildCallbackData(ctx, 'MENU'));
}

async function renderCartesiaCenter(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('Cartesia operations are available to administrators only.');
    return;
  }
  await renderMenu(ctx,
    '<b>Cartesia Operations</b>\nPlace one explicitly approved call through a Cartesia Managed Agent. The API checks business operator access, consent, suppression, quiet hours, emergency stop, and idempotency. Do not enter a destination unless you are authorized to call it.',
    buildCartesiaKeyboard(ctx), { parseMode: 'HTML' });
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

function buildConfirmationPhrase({ destination, fromNumberId, agentId }) {
  return `PLACE CARTESIA CALL TO ${destination} FROM ${fromNumberId} WITH AGENT ${agentId}`;
}

function normalizeDynamicVariables(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, typeof entry === 'string' ? entry.trim() : entry]));
}

function normalizeCampaignSchedule(value, nowMs = Date.now()) {
  if (String(value || '').trim().toLowerCase() === 'now') return null;
  const text = String(value || '').trim();
  if (!SCHEDULE_PATTERN.test(text)) return undefined;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || timestamp <= nowMs || timestamp - nowMs > 24 * 60 * 60 * 1000) return undefined;
  return new Date(timestamp).toISOString();
}

function campaignSubmitPhrase(campaign) {
  return `SUBMIT CARTESIA CAMPAIGN ${campaign.campaign_id} WITH ${Number(campaign.ready_count)} RECIPIENTS${campaign.scheduled_at ? ` AT ${campaign.scheduled_at}` : ''}`;
}

function buildCallConfirmationPhrase({ destination, fromNumberId, agentId, dynamicVariables = {} }) {
  const phrase = buildConfirmationPhrase({ destination, fromNumberId, agentId });
  const variables = normalizeDynamicVariables(dynamicVariables);
  if (!Object.keys(variables).length) return phrase;
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(variables)).digest('hex').slice(0, 12);
  return `${phrase} WITH VARIABLES ${fingerprint}`;
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
    if (action === 'CARTESIA_BATCH_RETRY') {
      const retryStatuses = new Set(['failed', 'unanswered']);
      const blockedStatuses = new Set(['completed', ...retryStatuses]);
      const rows = campaign?.recipients || [];
      const count = rows.filter((row) => retryStatuses.has(String(row.provider_status || '').toLowerCase())).length;
      if (!campaign?.provider_batch_id || !['completed', 'failed'].includes(String(campaign.provider_status)) || !count || rows.some((row) => !blockedStatuses.has(String(row.provider_status || '').toLowerCase()))) {
        await ctx.reply('Retry is unavailable: batch must be completed or failed and every recipient status must be recognized. Reconcile progress and review consent before retrying.'); return;
      }
      const retryNumber = Number(campaign.provider_retry_count) || 0;
      const phrase = `RETRY CARTESIA CAMPAIGN ${campaign.campaign_id} BATCH ${campaign.provider_batch_id} RETRY ${retryNumber + 1} FOR ${count} RECIPIENTS`;
      const confirmation = await askInput(conversation, ctx,
        `This retries all failed or unanswered recipients. The API rechecks consent, suppression, quiet hours, cooldown, emergency stop, and daily limits. Type this exact phrase to confirm: ${phrase}`, ensureActive);
      if (confirmation !== phrase) { await ctx.reply('Retry not confirmed. No batch operation was sent.'); return; }
      const result = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/campaigns/${encodeURIComponent(pending.campaignId)}/retry`,
        { business_id: pending.businessId, confirmation_phrase: confirmation }, { timeout: 30000 });
      ensureActive();
      await ctx.reply(`Cartesia accepted a retry for ${Number(result?.data?.retried_recipient_count) || count} eligible recipient(s). Reconcile batch progress to confirm completion.`, { parse_mode: 'HTML' });
      return;
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

async function runCartesiaCampaign(conversation, ctx, ensureActive) {
  const businessId = await askInput(conversation, ctx, 'Enter the business ID with current call-operator membership.', ensureActive);
  if (businessId === null) return;
  if (!BUSINESS_ID_PATTERN.test(businessId)) { await ctx.reply('Campaign canceled. The business ID format is invalid.'); return; }
  const inventory = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/agents`, { timeout: 15000 });
  const agents = buildAgentChoices(inventory?.data?.agents);
  if (!agents.length) { await ctx.reply('No active Cartesia agent with an attached source number is available. No batch was submitted.'); return; }
  const agentChoice = await askChoice(conversation, ctx, 'Choose the Cartesia Managed Agent:', formatAgentChoices(agents), ensureActive);
  if (agentChoice === null) return;
  if (agentChoice < 0 || agentChoice >= agents.length) { await ctx.reply('Campaign canceled. Choose one of the listed agents.'); return; }
  const agent = agents[agentChoice];
  const numbers = agent.phoneNumbers.filter((phone) => IDENTIFIER_PATTERN.test(String(phone?.id || '')));
  const phoneChoice = await askChoice(conversation, ctx, 'Choose a source number attached to this agent:', formatPhoneNumberChoices(numbers), ensureActive);
  if (phoneChoice === null) return;
  if (phoneChoice < 0 || phoneChoice >= numbers.length) { await ctx.reply('Campaign canceled. Choose one of the listed source numbers.'); return; }
  const name = await askInput(conversation, ctx, 'Enter a campaign name (up to 120 characters).', ensureActive);
  if (name === null) return;
  const rawDestinations = await askInput(conversation, ctx, 'Paste up to 100 authorized E.164 destinations, one per line. Recorded consent is required for every recipient.', ensureActive);
  if (rawDestinations === null) return;
  let destinationChunk = rawDestinations.split(/[\s,;]+/).filter(Boolean);
  const destinations = [];
  if (destinationChunk.length < 1 || destinationChunk.length > MAX_CARTESIA_CAMPAIGN_RECIPIENTS_PER_MESSAGE ||
      destinationChunk.some((value) => !DESTINATION_PATTERN.test(value))) {
    await ctx.reply('Campaign canceled. Provide 1–100 valid E.164 numbers, with no extra text.'); return;
  }
  destinations.push(...destinationChunk);
  while (destinationChunk.length === MAX_CARTESIA_CAMPAIGN_RECIPIENTS_PER_MESSAGE && destinations.length < MAX_CARTESIA_CAMPAIGN_RECIPIENTS) {
    const rawNextChunk = await askInput(conversation, ctx,
      `Campaign currently has ${destinations.length} recipients. Paste another chunk of up to 100 authorized E.164 destinations, or type DONE. The total limit is 1,000.`, ensureActive);
    if (rawNextChunk === null) return;
    if (rawNextChunk.trim().toUpperCase() === 'DONE') break;
    destinationChunk = rawNextChunk.split(/[\s,;]+/).filter(Boolean);
    if (destinationChunk.length < 1 || destinationChunk.length > MAX_CARTESIA_CAMPAIGN_RECIPIENTS_PER_MESSAGE ||
        destinations.length + destinationChunk.length > MAX_CARTESIA_CAMPAIGN_RECIPIENTS ||
        destinationChunk.some((value) => !DESTINATION_PATTERN.test(value))) {
      await ctx.reply('Campaign canceled. Each chunk must contain 1–100 valid E.164 numbers, with no more than 1,000 total.'); return;
    }
    destinations.push(...destinationChunk);
  }
  const concurrencyText = await askInput(conversation, ctx, 'Target concurrent calls (1–10). Enter 1 for the safest default.', ensureActive);
  if (concurrencyText === null) return;
  const concurrency = Number(concurrencyText);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) { await ctx.reply('Campaign canceled. Concurrency must be an integer from 1 to 10.'); return; }
  const variablesText = await askInput(conversation, ctx,
    'Optional Cartesia dynamic variables as JSON: provide one object shared by all recipients, or an array with one object per recipient in the same order. Use {} for none. Do not include secrets.', ensureActive);
  if (variablesText === null) return;
  let variablePayload = {};
  try {
    const parsed = JSON.parse(variablesText);
    if (Array.isArray(parsed)) {
      if (parsed.length !== destinations.length || parsed.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error('invalid per-recipient variables');
      variablePayload = { dynamic_variables_by_recipient: parsed.map(normalizeDynamicVariables) };
    } else if (parsed && typeof parsed === 'object') {
      variablePayload = { dynamic_variables: normalizeDynamicVariables(parsed) };
    } else throw new Error('invalid variables');
  } catch {
    await ctx.reply('Campaign canceled. Variables must be one JSON object or one object per recipient.'); return;
  }
  const scheduleText = await askInput(conversation, ctx,
    'When should Cartesia start dialing? Type now to start as soon as you approve, or enter a future RFC3339 timestamp with an explicit timezone (for example 2026-10-31T15:30:00-04:00). Scheduled starts are limited to the next 24 hours.', ensureActive);
  if (scheduleText === null) return;
  const scheduledAt = normalizeCampaignSchedule(scheduleText);
  if (scheduledAt === undefined) { await ctx.reply('Campaign canceled. Use now or a valid future timestamp with an explicit timezone, no more than 24 hours ahead.'); return; }
  const variableKeys = [...new Set((variablePayload.dynamic_variables_by_recipient || [variablePayload.dynamic_variables || {}]).flatMap((variables) => Object.keys(variables)))];
  const requestKey = `cartesia:${crypto.randomUUID()}`;
  const response = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/campaigns`, {
    business_id: businessId, request_key: requestKey, name: name.slice(0, 120), agent_id: agent.id,
    from_number_id: numbers[phoneChoice].id, target_concurrency_limit: concurrency, destinations,
    ...(scheduledAt ? { scheduled_at: scheduledAt } : {}), ...variablePayload,
  }, { timeout: 30000 });
  ensureActive();
  const campaign = response?.data?.campaign;
  if (!campaign?.campaign_id) throw new Error('The API did not return a saved campaign reference.');
  if ((scheduledAt || null) !== (campaign.scheduled_at || null)) throw new Error('The API did not confirm the requested Cartesia campaign schedule.');
  ctx.session.cartesiaCampaignPending = { businessId, campaignId: campaign.campaign_id };
  const recipientRows = Array.isArray(campaign.recipients) ? campaign.recipients : [];
  const recipients = recipientRows.slice(0, 10).map((row) => `${row.status === 'ready' ? '✓' : '×'} ${escapeHtml(row.destination_masked)}${row.reason_code && row.reason_code !== 'ready' ? ` (${escapeHtml(row.reason_code)})` : ''}`).join('\n');
  const extraRecipients = Math.max(0, recipientRows.length - 10);
  const variableKeyPreview = variableKeys.slice(0, 10).map(escapeHtml).join(', ') || 'none';
  const extraVariableKeys = Math.max(0, variableKeys.length - 10);
  await ctx.reply(`Saved Cartesia campaign <code>${escapeHtml(campaign.campaign_id)}</code>.\nReady: ${Number(campaign.ready_count)}/${Number(campaign.recipient_count)}\nDynamic variable keys: ${variableKeyPreview}${extraVariableKeys ? ` (+${extraVariableKeys} more)` : ''}\n${recipients || 'No recipient details returned.'}${extraRecipients ? `\n… ${extraRecipients} additional recipients omitted from this preview.` : ''}`, { parse_mode: 'HTML' });
  if (Number(campaign.ready_count) !== Number(campaign.recipient_count) || Number(campaign.ready_count) < 1) {
    await ctx.reply('The campaign has blocked recipients and cannot be submitted. Review consent and policy, then create a new campaign after resolving them.'); return;
  }
  const phrase = campaignSubmitPhrase(campaign);
  const confirmation = await askInput(conversation, ctx,
    `${campaign.scheduled_at ? `This saves the approved campaign locally for ${campaign.scheduled_at} UTC. VOICEDNUT will recheck current consent, quiet hours, emergency stop, and daily capacity immediately before releasing it to Cartesia. ` : Number(campaign.recipient_count) > 100 ? 'This queues the approved campaign for background dispatch; when processed it can initiate calls to every listed recipient. VOICEDNUT will recheck consent and business safety limits before release. ' : 'This submits one real Cartesia batch now and can initiate calls to every listed recipient. '}Confirm that you are authorized to contact all of them, then type this exact phrase: ${phrase}`,
    ensureActive);
  if (confirmation !== phrase) { await ctx.reply('Campaign approval canceled. No batch was submitted.'); return; }
  try {
    const submitted = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/campaigns/${encodeURIComponent(campaign.campaign_id)}/submit`, {
      business_id: businessId, confirmation_phrase: confirmation,
    }, { timeout: 30000 });
    ensureActive();
    const saved = submitted?.data?.campaign;
    await ctx.reply(`Cartesia campaign status: <b>${escapeHtml(saved?.status || 'unknown')}</b>\n${saved?.dispatch_queued || submitted?.data?.queued_for_async_dispatch ? 'Queued for asynchronous dispatch; consent and business safety limits will be checked before release.\n' : ''}${saved?.held_for_local_dispatch ? `Scheduled locally for <code>${escapeHtml(saved?.scheduled_at || '')}</code>; dispatch-time checks will run before Cartesia receives it.\n` : ''}Batch: <code>${escapeHtml(saved?.provider_batch_id || (saved?.held_for_local_dispatch || saved?.dispatch_queued || submitted?.data?.queued_for_async_dispatch ? 'not sent yet' : 'not confirmed'))}</code>\nUse “Check campaign status” to inspect the same saved campaign. Do not create another campaign if the result is unclear.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, `Campaign submission result may be unresolved. Check status for ${campaign.campaign_id}; do not create a second campaign or submit with a new request key.`));
  }
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
  if (!access?.isAdmin) {
    await ctx.reply('Cartesia operations are available to administrators only.');
    return;
  }
  const action = String(ctx.session?.cartesiaOperationAction || '');
  if (!ACTIONS.has(action)) {
    await ctx.reply('That Cartesia action expired. Reopen /cartesia and choose the action again.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the bot before entering a destination or approving a call.');
    return;
  }

  const operationId = `cartesia:${action.toLowerCase()}`;
  const token = startOperation(ctx, operationId);
  const ensureActive = () => ensureOperationActive(ctx, token);

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
  if (action === 'CARTESIA_BATCH_RECONCILE' || action === 'CARTESIA_BATCH_CANCEL' || action === 'CARTESIA_BATCH_RETRY') {
    await runCartesiaBatchControl(conversation, ctx, ensureActive, action);
    return;
  }
  if (action === 'CARTESIA_CAMPAIGN') {
    try { await runCartesiaCampaign(conversation, ctx, ensureActive); }
    catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Cartesia campaign planning failed. Check the saved campaign status before retrying any submission.')); }
    return;
  }

  try {
    const businessInput = String(config.defaultBusinessId || '').trim();
    if (!BUSINESS_ID_PATTERN.test(businessInput)) {
      await ctx.reply('Cartesia calls are not configured. Set DEFAULT_BUSINESS_ID to the business used for Cartesia calls, then try again.');
      return;
    }
    if (ctx.session?.cartesiaCallPending) {
      await ctx.reply('A previous Cartesia request has an unresolved result. Choose “Reconcile a call” and resolve that exact request before starting another call.');
      return;
    }
    let agents;
    try {
      const inventory = await httpClient.get(ctx, `${apiRoot()}/api/cartesia/agents`, {
        params: { actor_id: String(ctx.from?.id || '') },
        timeout: 15000,
      });
      agents = buildAgentChoices(inventory?.data?.agents);
    } catch (error) {
      await ctx.reply(httpClient.getUserMessage(error, 'Cartesia agent inventory is unavailable. No call was submitted.'));
      return;
    }
    if (!agents.length) {
      await ctx.reply('No active Cartesia agent with an attached source number is ready. Check the Cartesia account setup. No call was submitted.');
      return;
    }
    const agentOptions = agents.map((agent, index) => ({
      id: String(index),
      label: `${agent.name || 'Cartesia agent'}${agent.deploymentCount ? ` · ${agent.deploymentCount} deployments` : ''}`,
    }));
    const agentSelection = await askOptionWithButtons(
      conversation,
      ctx,
      '📞 Choose the Cartesia agent for this call:',
      [...agentOptions, { id: 'cancel', label: '❌ Cancel' }],
      { prefix: 'cartesia-call-agent', columns: 1, ensureActive },
    );
    if (!agentSelection || agentSelection.id === 'cancel') {
      await ctx.reply('Cartesia call canceled. No call was submitted.');
      return;
    }
    const agentIndex = Number(agentSelection.id);
    if (!Number.isInteger(agentIndex) || agentIndex < 0 || agentIndex >= agents.length) {
      await ctx.reply('Cartesia call canceled. Choose one of the listed agents.');
      return;
    }
    const selectedAgent = agents[agentIndex];
    const attachedNumbers = selectedAgent.phoneNumbers.filter((phone) => IDENTIFIER_PATTERN.test(String(phone?.id || '')));
    if (!attachedNumbers.length) {
      await ctx.reply('The selected Cartesia agent has no usable source number. No call was submitted.');
      return;
    }
    const phoneOptions = attachedNumbers.map((phone, index) => ({
      id: String(index),
      label: phone.displayNumber || `Cartesia source number ${index + 1}`,
    }));
    const phoneSelection = await askOptionWithButtons(
      conversation,
      ctx,
      '📲 Choose the outgoing Cartesia number:',
      [...phoneOptions, { id: 'cancel', label: '❌ Cancel' }],
      { prefix: 'cartesia-call-number', columns: 1, ensureActive },
    );
    if (!phoneSelection || phoneSelection.id === 'cancel') {
      await ctx.reply('Cartesia call canceled. No call was submitted.');
      return;
    }
    const phoneIndex = Number(phoneSelection.id);
    if (!Number.isInteger(phoneIndex) || phoneIndex < 0 || phoneIndex >= attachedNumbers.length) {
      await ctx.reply('Cartesia call canceled. Choose one of the listed source numbers.');
      return;
    }
    const selectedPhone = attachedNumbers[phoneIndex];
    const agentId = String(selectedAgent.id);
    const fromNumberId = String(selectedPhone.id);

    const destination = await askInput(conversation, ctx, 'Enter the authorized destination in E.164 format (for example +14155550123). Current recorded consent is required.', ensureActive);
    if (destination === null) return;
    if (!DESTINATION_PATTERN.test(destination)) {
      await ctx.reply('Cartesia call canceled. Enter a valid E.164 destination.');
      return;
    }
    const input = { businessId: businessInput, destination, agentId, fromNumberId };
    const dynamicVariables = {};
    const requestKey = `cartesia:${crypto.randomUUID()}`;
    if (!REQUEST_KEY_PATTERN.test(requestKey)) {
      await ctx.reply('Cartesia call canceled. The generated request key is invalid.');
      return;
    }

    const phrase = buildCallConfirmationPhrase({ destination, fromNumberId, agentId, dynamicVariables });
    const confirmation = await askOptionWithButtons(
      conversation,
      ctx,
      `Review this call before submitting:\nBusiness: ${escapeMarkdown(businessInput)}\nAgent: ${escapeMarkdown(selectedAgent.name || agentId)}\nFrom: ${escapeMarkdown(selectedPhone.displayNumber || fromNumberId)}\nTo: ${escapeMarkdown(destination)}\n\nThis places a real outbound call and may incur charges. The API checks operator access and recorded consent.`,
      [
        { id: 'confirm', label: '✅ Confirm and call' },
        { id: 'cancel', label: '❌ Cancel' },
      ],
      { prefix: 'cartesia-call-confirm', columns: 1, ensureActive },
    );
    if (!confirmation || confirmation.id !== 'confirm') {
      await ctx.reply('Cartesia call canceled. No call was submitted.');
      return;
    }

    const pending = {
      ...input,
      idempotencyKey: requestKey,
      createdAt: Date.now(),
    };
    const actorId = String(ctx.from?.id || '');
    if (!/^\d{1,20}$/.test(actorId)) {
      await ctx.reply('Cartesia call canceled. A verified Telegram actor is required.');
      return;
    }

    const approvalResponse = await httpClient.post(ctx, `${apiRoot()}/api/cartesia/call-approval`, {
      business_id: businessInput,
      actor_id: actorId,
      destination,
      agent_id: agentId,
      from_number_id: fromNumberId,
      idempotency_key: requestKey,
      confirmation_phrase: phrase,
      dynamic_variables: dynamicVariables,
    }, { timeout: 15000 });
    const approvalToken = String(approvalResponse?.data?.approval_token || '').trim();
    const requestFingerprint = String(approvalResponse?.data?.request_fingerprint || '').trim();
    if (!approvalToken || approvalToken.length > 4096 || !/^[a-f0-9]{64}$/.test(requestFingerprint)) {
      await ctx.reply('Cartesia approval was not issued. No call was submitted. Reopen /cartesia and reuse the same request if its outcome is unclear.');
      return;
    }
    pending.requestFingerprint = requestFingerprint;
    ctx.session.cartesiaCallPending = pending;

    const result = await httpClient.post(ctx, `${apiRoot()}/outbound-call`, {
      provider: 'cartesia',
      business_id: businessInput,
      actor_id: actorId,
      user_chat_id: actorId,
      number: destination,
      agent_id: agentId,
      from_number_id: fromNumberId,
      dynamic_variables: dynamicVariables,
      idempotency_key: requestKey,
      approval_token: approvalToken,
    }, { timeout: 30000, headers: { 'Idempotency-Key': requestKey } });
    ensureActive();
    const callId = String(result?.data?.provider_call_id || result?.data?.call_sid || '').trim();
    const status = String(result?.data?.status || 'queued').trim().toLowerCase();
    if (!callId || !/^[a-z0-9_-]{1,200}$/i.test(callId)) {
      await ctx.reply(`Cartesia accepted the request, but did not return a usable call ID. Request key: <code>${escapeHtml(requestKey)}</code>. Do not submit a new request key until this request is reconciled.`, { parse_mode: 'HTML' });
      return;
    }
    ctx.session.cartesiaCallPending = null;
    await ctx.reply(
      `Cartesia call submitted.\nCall: <code>${escapeHtml(callId)}</code>\nStatus: <b>${escapeHtml(status)}</b>\nDestination: ${escapeHtml(maskDestination(destination))}\nRequest key: <code>${escapeHtml(requestKey)}</code>\nThe provider accepted the request; this does not mean the call completed.`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    if (status === 400 || status === 403 || status === 409) {
      await ctx.reply(httpClient.getUserMessage(error, 'Cartesia rejected the call request. No new call was submitted.'));
      return;
    }
    const pending = ctx.session?.cartesiaCallPending;
    await ctx.reply(
      `Cartesia call outcome is unclear. Do not use a new request key or submit a different call until an administrator reconciles it.${pending?.idempotencyKey ? `\nReuse this request key for reconciliation: <code>${escapeHtml(pending.idempotencyKey)}</code>` : ''}${pending?.requestFingerprint ? `\nSaved request fingerprint: <code>${escapeHtml(pending.requestFingerprint)}</code>` : ''}`,
      { parse_mode: 'HTML' },
    );
  }
}

function registerCartesiaCommand(bot) {
  bot.command('cartesia', async (ctx) => {
    const access = await getAccessProfile(ctx);
    if (!access?.isAdmin) {
      await ctx.reply('Cartesia operations are available to administrators only.');
      return;
    }
    await renderCartesiaCenter(ctx);
  });
}

module.exports = {
  ACTIONS,
  buildCartesiaKeyboard,
  buildCallConfirmationPhrase,
  normalizeDynamicVariables,
  renderCartesiaCenter,
  registerCartesiaCommand,
  cartesiaOperationFlow,
  __testables: {
    buildConfirmationPhrase,
    buildReconciliationPayload,
    buildAgentChoices,
    formatAgentChoices,
    buildHealthAgentChoices,
    formatAgentHealth,
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
    formatCallDetails,
    formatCallTranscript,
    formatCampaignOutcomes,
    formatCampaignStatus,
    runCartesiaCampaignStatus,
    runCartesiaCampaignReconciliation,
    normalizeCampaignSchedule,
    campaignSubmitPhrase,
    runCartesiaBatchControl,
    runCartesiaCampaign,
  },
};
