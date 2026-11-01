'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { escapeHtml } = require('../utils/ui');
const { formatCallMissionAdvanceError } = require('../utils/callMissionErrors');
const { startOperation, ensureOperationActive } = require('../utils/sessionState');
const { isValidBusinessId, isValidRequestKey, parseDestinationList } = require('../utils/callMissionInputs');
const { parseResultSchema } = require('../utils/callPlanInputs');

const CANCEL_WORDS = new Set(['cancel', 'exit', 'quit']);

async function askMissionInput(conversation, ctx, prompt, ensureActive) {
  await ctx.reply(prompt);
  const update = await conversation.wait();
  ensureActive();
  const value = String(update?.message?.text || '').trim();
  return CANCEL_WORDS.has(value.toLowerCase()) ? null : value;
}

async function handleCallMissions(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E missions are available to administrators.');
    return;
  }
  const businessId = String(ctx.match || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) {
    await ctx.reply('Usage: /callmissions <business_id>');
    return;
  }
  try {
    const response = await httpClient.get(ctx, `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/missions`, {
      params: { business_id: businessId, actor_id: String(ctx.from?.id || ''), limit: 20 },
      timeout: 12000,
    });
    const missions = Array.isArray(response?.data?.missions) ? response.data.missions : [];
    if (!missions.length) {
      await ctx.reply(`No CALL-E missions found for <code>${escapeHtml(businessId)}</code>.`, { parse_mode: 'HTML' });
      return;
    }
    const lines = missions.map((mission) =>
      `• <code>${escapeHtml(String(mission.mission_id || 'unknown'))}</code> · ${escapeHtml(String(mission.status || 'unknown'))} · ${Number(mission.active_count) || 0} active · ${Number(mission.queued_count) || 0} queued · ${Number(mission.completed_count) || 0} complete · ${Number(mission.attention_count) || 0} need attention`,
    );
    await ctx.reply(`<b>CALL-E missions</b> · <code>${escapeHtml(businessId)}</code>\n\n${lines.join('\n')}\n\nDestinations are encrypted at rest.`, { parse_mode: 'HTML' });
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ You do not have current CALL-E operator membership for that business.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load CALL-E missions.'));
  }
}

async function callMissionCreateFlow(conversation, ctx) {
  const operationId = startOperation(ctx, 'call-mission-create');
  const ensureActive = () => ensureOperationActive(ctx, operationId);
  const access = await getAccessProfile(ctx);
  ensureActive();
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E mission drafting requires an administrator BOT account and current business operator membership.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the BOT to stage a CALL-E mission. Destination numbers are not collected in group chats.');
    return;
  }

  const args = String(ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (args.length < 2) {
    const businessInput = await askMissionInput(conversation, ctx, 'Enter the business ID for the approved campaign.', ensureActive);
    if (businessInput === null) return;
    const campaignInput = await askMissionInput(conversation, ctx, 'Enter the approved campaign ID.', ensureActive);
    if (campaignInput === null) return;
    args.push(businessInput, campaignInput);
    const requestInput = await askMissionInput(conversation, ctx, 'Optional idempotency request key, or type skip to generate one.', ensureActive);
    if (requestInput === null) return;
    if (requestInput.toLowerCase() !== 'skip') args.push(requestInput);
  }
  const [businessId, campaignId, suppliedRequestKey] = args;
  if (args.length < 2 || args.length > 3 || !isValidBusinessId(businessId) || !/^campaign_[a-f0-9]{64}$/.test(campaignId || '') ||
      (suppliedRequestKey !== undefined && !isValidRequestKey(suppliedRequestKey))) {
    await ctx.reply('Usage: /callmissioncreate <business_id> <approved_campaign_id> [request_key]');
    return;
  }

  try {
    const reportResponse = await httpClient.get(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/campaigns/${encodeURIComponent(campaignId)}`,
      { params: { business_id: businessId, actor_id: String(ctx.from?.id || '') }, timeout: 12000 });
    ensureActive();
    const campaign = reportResponse?.data?.campaign || {};
    const campaignRecipients = Array.isArray(reportResponse?.data?.recipients) ? reportResponse.data.recipients : [];
    if (campaign.status !== 'approved' || campaignRecipients.length < 1 || campaignRecipients.length > 25) {
      await ctx.reply('That campaign is not approved or has an invalid recipient count. No mission was created and no calls were placed.');
      return;
    }
    await ctx.reply(`Campaign is approved for template ${Number(campaign.template_id) || 'unknown'} with ${campaignRecipients.length} masked destinations. Re-enter the exact original destinations and result schema; the server will reject any mismatch.`);
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ Current CALL-E business operator membership is required.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to verify the approved campaign. No mission was created.'));
    return;
  }

  const destinationText = await askMissionInput(conversation, ctx,
    'Re-enter the exact approved destinations, one per line (commas also work). Type cancel to stop.', ensureActive);
  if (destinationText === null) return;
  const destinations = parseDestinationList(destinationText);
  if (!destinations) {
    await ctx.reply('Destinations are invalid. Use 1–25 unique E.164 numbers. No mission was created.');
    return;
  }

  const schemaText = await askMissionInput(conversation, ctx,
    'Re-enter the exact result schema JSON used for campaign approval. Type cancel to stop.', ensureActive);
  if (schemaText === null) return;
  const resultSchema = parseResultSchema(schemaText);
  if (!resultSchema) {
    await ctx.reply('The result schema must be a JSON object. No mission was created.');
    return;
  }

  const scheduleText = await askMissionInput(conversation, ctx,
    'Optional launch time in ISO 8601 with timezone (for example 2027-01-15T09:00:00Z), or type skip for manual advance.', ensureActive);
  if (scheduleText === null) return;
  let scheduledAt = null;
  if (scheduleText.toLowerCase() !== 'skip') {
    const scheduledMs = Date.parse(scheduleText);
    if (!Number.isFinite(scheduledMs) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(scheduleText) || scheduledMs < Date.now() + 60000 || scheduledMs > Date.now() + 365 * 86400000) {
      await ctx.reply('Launch time must be between 1 minute and 1 year from now and include a timezone. No mission was created.');
      return;
    }
    scheduledAt = new Date(scheduledMs).toISOString();
  }
  const budgetText = await askMissionInput(conversation, ctx,
    'Optional total budget in minor currency units (for example cents), or type skip. The policy manager reviews this cap.', ensureActive);
  if (budgetText === null) return;
  let budgetLimitMinor = null;
  let perCallCostCeilingMinor = null;
  let budgetCurrency = null;
  if (budgetText.toLowerCase() !== 'skip') {
    budgetLimitMinor = Number(budgetText);
    if (!Number.isSafeInteger(budgetLimitMinor) || budgetLimitMinor < 1 || budgetLimitMinor > 1000000000) {
      await ctx.reply('Budget must be an integer from 1 to 1,000,000,000 minor units. No mission was created.');
      return;
    }
    budgetCurrency = await askMissionInput(conversation, ctx,
      'Enter the three-letter ISO currency for this budget (for example USD, EUR, or GBP).', ensureActive);
    if (budgetCurrency === null) return;
    budgetCurrency = budgetCurrency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(budgetCurrency)) { await ctx.reply('Currency must be a three-letter ISO code. No mission was created.'); return; }
    const perCallText = await askMissionInput(conversation, ctx,
      'Enter the maximum reserved cost per recipient in the same minor units. This is an operator estimate; actual provider billing can differ.', ensureActive);
    if (perCallText === null) return;
    perCallCostCeilingMinor = Number(perCallText);
    if (!Number.isSafeInteger(perCallCostCeilingMinor) || perCallCostCeilingMinor < 1 || perCallCostCeilingMinor > budgetLimitMinor) {
      await ctx.reply('Per-recipient cost ceiling must be between 1 and the mission budget. No mission was created.');
      return;
    }
  }

  const confirmation = await askMissionInput(conversation, ctx,
    `Review plan: ${scheduledAt ? `launch no earlier than ${scheduledAt}` : 'manual launch'}; ${budgetLimitMinor === null ? 'no mission budget reservation' : `reserve up to ${budgetLimitMinor} ${budgetCurrency} minor units at ${perCallCostCeilingMinor} per recipient`}. Reply exactly YES CREATE MISSION to confirm the original contact authorization remains valid and stage this mission for policy-manager review. This does not place calls.`, ensureActive);
  if (confirmation !== 'YES CREATE MISSION') {
    await ctx.reply('Mission creation canceled. No calls were placed.');
    return;
  }

  const requestKey = suppliedRequestKey || `bot-mission:${crypto.randomUUID()}`;
  await ctx.reply(`Mission request key: <code>${escapeHtml(requestKey)}</code>. Reuse it with the same inputs if the result is unclear.`, { parse_mode: 'HTML' });
  try {
    const response = await httpClient.post(ctx, `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/missions`, {
      business_id: businessId,
      actor_id: String(ctx.from?.id || ''),
      campaign_id: campaignId,
      destinations,
      result_schema: resultSchema,
      scheduled_at: scheduledAt,
      budget_limit_minor: budgetLimitMinor,
      budget_currency: budgetCurrency,
      per_call_cost_ceiling_minor: perCallCostCeilingMinor,
    }, { timeout: 20000, headers: { 'Idempotency-Key': requestKey } });
    ensureActive();
    const mission = response?.data?.mission || {};
    await ctx.reply(
      `CALL-E mission <code>${escapeHtml(String(mission.mission_id || 'unavailable'))}</code> is <b>${escapeHtml(String(mission.status || 'pending_approval'))}</b>. ` +
      `${Number(mission.recipient_count) || destinations.length} destinations are encrypted at rest. ${mission.scheduled_at ? `It is scheduled for ${escapeHtml(String(mission.scheduled_at))}. ` : ''}${mission.budget_limit_minor ? `Budget reservation cap: ${Number(mission.budget_limit_minor)} minor units. ` : ''}A separate policy manager must review it. No calls were placed.`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ Current CALL-E operator membership is required. No calls were placed.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to create the CALL-E mission. No calls were placed.'));
  }
}

async function handleCallMissionReview(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E mission review is available to administrators.');
    return;
  }
  const parts = String(ctx.match || '').trim().split(/\s+/);
  const [businessId, missionId, decision] = parts;
  if (parts.length !== 3 || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId || '') ||
      !/^mission_[a-f0-9]{64}$/.test(missionId || '') || !['approve', 'reject'].includes(String(decision || '').toLowerCase())) {
    await ctx.reply('Usage: /callmissionreview <business_id> <mission_id> <approve|reject>');
    return;
  }
  try {
    const response = await httpClient.post(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/missions/${encodeURIComponent(missionId)}/review`,
      { business_id: businessId, actor_id: String(ctx.from?.id || ''), decision: String(decision).toLowerCase() },
      { timeout: 12000 });
    const mission = response?.data?.mission;
    const awaitingSecond = response?.data?.awaiting_secondary_approval === true;
    await ctx.reply(
      `CALL-E mission <code>${escapeHtml(String(mission?.mission_id || missionId))}</code> is <b>${escapeHtml(String(mission?.status || decision))}</b>. ${Number(mission?.recipient_count) || 0} recipients; destinations remain encrypted. ${awaitingSecond ? 'A second, different policy manager must approve before dispatch.' : 'No calls were placed.'}`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ Current policy-manager membership is required. A mission creator cannot approve their own mission.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to record the CALL-E mission decision.'));
  }
}

async function handleCallMissionAdvance(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E mission dispatch is available to administrators.');
    return;
  }
  const parts = String(ctx.match || '').trim().split(/\s+/);
  const [businessId, missionId] = parts;
  if (parts.length !== 2 || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId || '') ||
      !/^mission_[a-f0-9]{64}$/.test(missionId || '')) {
    await ctx.reply('Usage: /callmissionadvance <business_id> <mission_id>');
    return;
  }
  try {
    const response = await httpClient.post(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/missions/${encodeURIComponent(missionId)}/advance`,
      { business_id: businessId, actor_id: String(ctx.from?.id || '') },
      { timeout: 20000 });
    const data = response?.data || {};
    const mission = data.mission || {};
    const state = String(data.state || 'unknown');
    const summary = state === 'call_accepted'
      ? `One call was accepted for recipient ${Number(data.recipient_position) + 1}. Call ID: <code>${escapeHtml(String(data.local_call_id || 'unknown'))}</code>. Advance again only after it reaches a terminal state.`
      : state === 'waiting_for_call'
        ? 'A prior call is still active. No new call was placed.'
        : state === 'waiting_for_result'
          ? 'The call ended, but its structured result is still pending. No new call was placed.'
        : state === 'recovery_required'
          ? 'The prior call state could not be confirmed. No new call was placed; reconcile before retrying.'
        : ['complete', 'completed'].includes(state)
            ? 'No queued recipient remains.'
            : state === 'needs_review'
              ? 'The mission has recipients requiring operator review. No new call was placed.'
              : ['rejected', 'canceled'].includes(state)
                ? 'The mission is not active and no call was placed.'
            : `Mission state: ${escapeHtml(state)}. No new call was placed.`;
    await ctx.reply(`CALL-E mission <code>${escapeHtml(String(mission.mission_id || missionId))}</code> · ${escapeHtml(String(mission.status || 'unknown'))}\n${summary}`, { parse_mode: 'HTML' });
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ Current CALL-E operator membership and exact mission approval are required.');
      return;
    }
    const fallback = httpClient.getUserMessage(error, 'Unable to advance the CALL-E mission.');
    await ctx.reply(formatCallMissionAdvanceError(error, fallback));
  }
}

async function handleCallMissionResolve(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E mission resolution is available to administrators.');
    return;
  }
  const parts = String(ctx.match || '').trim().split(/\s+/);
  const [businessId, missionId, decision, suppliedRequestKey] = parts;
  const normalizedDecision = String(decision || '').toLowerCase();
  if (parts.length < 3 || parts.length > 4 || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId || '') ||
      !/^mission_[a-f0-9]{64}$/.test(missionId || '') || !['continue', 'cancel'].includes(normalizedDecision) ||
      (suppliedRequestKey !== undefined && !/^[A-Za-z0-9._:-]{8,180}$/.test(suppliedRequestKey))) {
    await ctx.reply('Usage: /callmissionresolve <business_id> <mission_id> <continue|cancel> [request_key]');
    return;
  }
  const idempotencyKey = suppliedRequestKey || `bot-mission-resolution:${crypto.randomUUID()}`;
  if (!suppliedRequestKey) {
    await ctx.reply(`Resolution request key: <code>${escapeHtml(idempotencyKey)}</code>\nIf the result is unclear, retry the same command with this key as the final argument.`, { parse_mode: 'HTML' });
  }
  try {
    const response = await httpClient.post(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/missions/${encodeURIComponent(missionId)}/resolve`,
      { business_id: businessId, actor_id: String(ctx.from?.id || ''), decision: normalizedDecision, idempotency_key: idempotencyKey },
      { timeout: 12000 });
    const mission = response?.data?.mission || {};
    await ctx.reply(
      `CALL-E mission <code>${escapeHtml(String(mission.mission_id || missionId))}</code> is <b>${escapeHtml(String(mission.status || 'needs_review'))}</b>. ` +
      (normalizedDecision === 'continue'
        ? 'The human resolution is recorded; no call was placed. Use /callmissionadvance when ready to process one step.'
        : 'The mission was canceled; no queued recipient was called.'),
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ Current policy-manager membership is required. The creator and original approver cannot resolve this pause.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to resolve the CALL-E mission pause.'));
  }
}

async function handleCallMissionInfo(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E mission details are available to administrators.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the BOT to view the CALL-E mission approval audit.');
    return;
  }
  const parts = String(ctx.match || '').trim().split(/\s+/);
  const [businessId, missionId] = parts;
  if (parts.length !== 2 || !/^[A-Za-z0-9._:-]{1,120}$/.test(businessId || '') ||
      !/^mission_[a-f0-9]{64}$/.test(missionId || '')) {
    await ctx.reply('Usage: /callmissioninfo <business_id> <mission_id>');
    return;
  }
  try {
    const response = await httpClient.get(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/missions/${encodeURIComponent(missionId)}`,
      { params: { business_id: businessId, actor_id: String(ctx.from?.id || '') }, timeout: 12000 });
    const mission = response?.data?.mission || {};
    const fingerprint = /^[a-f0-9]{64}$/.test(String(mission.approval_fingerprint || ''))
      ? String(mission.approval_fingerprint) : 'unavailable';
    const reviewHistory = Array.isArray(response?.data?.review_history) ? response.data.review_history : [];
    const timeline = Array.isArray(response?.data?.timeline) ? response.data.timeline.slice(0, 20) : [];
    const reviewLines = reviewHistory.map((review) =>
      `• ${escapeHtml(String(review.decision || 'unknown'))} by <code>${escapeHtml(String(review.reviewed_by || 'unknown'))}</code> at ${escapeHtml(String(review.created_at || 'time unavailable'))}`,
    );
    const timelineLines = timeline.map((event) => {
      const recipient = Number.isSafeInteger(Number(event.recipient_position)) ? ` · recipient ${Number(event.recipient_position) + 1}` : '';
      const error = /^[a-z][a-z0-9_]{0,79}$/.test(String(event.error_code || '')) ? ` · ${event.error_code}` : '';
      return `• ${escapeHtml(String(event.event_type || 'event'))}${recipient} · ${escapeHtml(String(event.state || 'unknown'))}${error} · ${escapeHtml(String(event.created_at || 'time unavailable'))}`;
    });
    const recipientLines = (Array.isArray(response?.data?.recipients) ? response.data.recipients : []).map((recipient) =>
      `• #${Number(recipient.position) + 1} ${escapeHtml(String(recipient.destination_masked || '••••0000'))} · ${escapeHtml(String(recipient.status || 'unknown'))}`,
    );
    await ctx.reply(
      `CALL-E mission <code>${escapeHtml(String(mission.mission_id || missionId))}</code> · ${escapeHtml(String(mission.status || 'unknown'))}\n` +
      `Approval fingerprint: <code>${escapeHtml(fingerprint)}</code>\n` +
      `Review audit:\n${reviewLines.length ? reviewLines.join('\n') : '• No review record available'}\n` +
      `Recipient states:\n${recipientLines.length ? recipientLines.join('\n') : '• No recipient summary available'}\n` +
      `Recent timeline:\n${timelineLines.length ? timelineLines.join('\n') : '• No activity events available'}\n` +
      `Set this together with the mission ID, an approval reference and expiry, and a recipient cap. Dispatch remains disabled unless the server gate is configured.`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load CALL-E mission details.'));
  }
}

function registerCallMissionsCommands(bot) {
  bot.command('callmissions', handleCallMissions);
  bot.command('callmissioncreate', async (ctx) => {
    await ctx.conversation.enter('call-mission-create-conversation');
  });
  bot.command('callmissionreview', handleCallMissionReview);
  bot.command('callmissionadvance', handleCallMissionAdvance);
  bot.command('callmissionresolve', handleCallMissionResolve);
  bot.command('callmissioninfo', handleCallMissionInfo);
}

module.exports = { handleCallMissions, callMissionCreateFlow, handleCallMissionReview, handleCallMissionAdvance, handleCallMissionResolve, handleCallMissionInfo, registerCallMissionsCommands };
