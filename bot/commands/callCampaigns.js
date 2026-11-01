'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { escapeHtml } = require('../utils/ui');
const { startOperation, ensureOperationActive } = require('../utils/sessionState');
const { isValidBusinessId, isValidRequestKey, parseDestinationList } = require('../utils/callMissionInputs');
const { parseResultSchema } = require('../utils/callPlanInputs');

const CANCEL_WORDS = new Set(['cancel', 'exit', 'quit']);

async function askCampaignInput(conversation, ctx, prompt, ensureActive) {
  await ctx.reply(prompt);
  const update = await conversation.wait();
  ensureActive();
  const value = String(update?.message?.text || '').trim();
  return CANCEL_WORDS.has(value.toLowerCase()) ? null : value;
}

async function handleCallCampaigns(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. Campaign summaries are available to administrators.');
    return;
  }
  const businessId = String(ctx.match || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) {
    await ctx.reply('Usage: /callcampaigns <business_id>');
    return;
  }
  const actorId = String(ctx.from?.id || '').trim();
  try {
    const apiBase = `${config.apiUrl.replace(/\/+$/, '')}/api/call-e`;
    const [campaignResponse, rehearsalResponse] = await Promise.all([
      httpClient.get(ctx, `${apiBase}/campaigns`, { params: { business_id: businessId, actor_id: actorId, limit: 20 }, timeout: 12000 }),
      httpClient.get(ctx, `${apiBase}/campaign-rehearsals`, { params: { business_id: businessId, actor_id: actorId, limit: 20 }, timeout: 12000 }),
    ]);
    const campaigns = Array.isArray(campaignResponse?.data?.campaigns) ? campaignResponse.data.campaigns : [];
    const rehearsals = Array.isArray(rehearsalResponse?.data?.campaigns) ? rehearsalResponse.data.campaigns : [];
    if (!campaigns.length) {
      await ctx.reply(`No CALL-E campaign drafts found for <code>${escapeHtml(businessId)}</code>.`, { parse_mode: 'HTML' });
      return;
    }
    const rehearsalById = new Map(rehearsals.map((campaign) => [campaign.campaign_id, campaign.latest_rehearsal]));
    const lines = campaigns.map((campaign) => {
      const id = escapeHtml(String(campaign.campaign_id || 'unknown'));
      const count = Number(campaign.recipient_count) || 0;
      const status = escapeHtml(String(campaign.status || 'unknown'));
      const readiness = `${Number(campaign.ready_count) || 0}/${count} ready`;
      const rehearsal = rehearsalById.get(campaign.campaign_id);
      const rehearsalLabel = rehearsal
        ? ` · rehearsal ${Number(rehearsal.ready_count) || 0}/${Number(rehearsal.recipient_count) || 0} simulated ready`
        : '';
      return `• <code>${id}</code> · ${status} · ${readiness}${rehearsalLabel}`;
    });
    await ctx.reply(`<b>CALL-E campaigns</b> · <code>${escapeHtml(businessId)}</code>\n\n${lines.join('\n')}\n\nUse /callcampaignreview with a campaign ID to record a separate decision. No calls were placed.`, { parse_mode: 'HTML' });
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ You do not have current CALL-E operator membership for that business.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load campaign rehearsal summaries.'));
  }
}

async function callCampaignCreateFlow(conversation, ctx) {
  const operationId = startOperation(ctx, 'call-campaign-create');
  const ensureActive = () => ensureOperationActive(ctx, operationId);
  const access = await getAccessProfile(ctx);
  ensureActive();
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E campaign drafting requires an administrator BOT account and current business operator membership.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the BOT to draft a CALL-E campaign. Destination numbers are not collected in group chats.');
    return;
  }

  const args = String(ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (args.length < 2) {
    const businessInput = await askCampaignInput(conversation, ctx, 'Enter the business ID for the campaign draft.', ensureActive);
    if (businessInput === null) return;
    const templateInput = await askCampaignInput(conversation, ctx, 'Enter the live template ID to use.', ensureActive);
    if (templateInput === null) return;
    args.push(businessInput, templateInput);
    const requestInput = await askCampaignInput(conversation, ctx, 'Optional idempotency request key, or type skip to generate one.', ensureActive);
    if (requestInput === null) return;
    if (requestInput.toLowerCase() !== 'skip') args.push(requestInput);
  }
  const [businessId, templateIdInput, suppliedRequestKey] = args;
  const templateId = Number(templateIdInput);
  if (args.length < 2 || args.length > 3 || !isValidBusinessId(businessId) || !Number.isSafeInteger(templateId) || templateId < 1 ||
      (suppliedRequestKey !== undefined && !isValidRequestKey(suppliedRequestKey))) {
    await ctx.reply('Usage: /callcampaigncreate <business_id> <live_template_id> [request_key]');
    return;
  }

  const destinationText = await askCampaignInput(conversation, ctx,
    'Enter 1–25 authorized E.164 destinations, one per line (commas also work). This input is used only for this request. Type cancel to stop.', ensureActive);
  if (destinationText === null) return;
  const destinations = parseDestinationList(destinationText);
  if (!destinations) {
    await ctx.reply('Destinations are invalid. Use 1–25 unique E.164 numbers such as +14155550123. No call was placed.');
    return;
  }

  const schemaText = await askCampaignInput(conversation, ctx,
    'Enter the closed result schema as a JSON object. Type cancel to stop.', ensureActive);
  if (schemaText === null) return;
  const resultSchema = parseResultSchema(schemaText);
  if (!resultSchema) {
    await ctx.reply('The result schema must be a JSON object. No campaign was created and no call was placed.');
    return;
  }

  const confirmation = await askCampaignInput(conversation, ctx,
    'Consent check: reply exactly YES I HAVE AUTHORIZATION to confirm you are authorized to contact everyone listed and want to create a review draft. The server will check recorded consent. This does not place calls.', ensureActive);
  if (confirmation !== 'YES I HAVE AUTHORIZATION') {
    await ctx.reply('Campaign drafting canceled. No calls were placed.');
    return;
  }

  const requestKey = suppliedRequestKey || `bot-campaign:${crypto.randomUUID()}`;
  await ctx.reply(`Campaign request key: <code>${escapeHtml(requestKey)}</code>. Reuse it with the same inputs if the result is unclear.`, { parse_mode: 'HTML' });
  try {
    const response = await httpClient.post(ctx, `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/campaigns`, {
      business_id: businessId,
      actor_id: String(ctx.from?.id || ''),
      template_id: templateId,
      destinations,
      result_schema: resultSchema,
      authorized: true,
    }, { timeout: 20000, headers: { 'Idempotency-Key': requestKey } });
    ensureActive();
    const campaign = response?.data?.campaign || {};
    const rows = Array.isArray(response?.data?.recipients) ? response.data.recipients : [];
    const ready = rows.filter((row) => row.status === 'ready').length;
    const blocked = rows.length - ready;
    await ctx.reply(
      `CALL-E campaign <code>${escapeHtml(String(campaign.campaign_id || 'unavailable'))}</code> · ${escapeHtml(String(campaign.status || 'draft'))}\n` +
      `${ready}/${rows.length} destinations passed current consent and template checks; ${blocked} blocked. Destinations remain masked. No calls were placed. ` +
      'A separate policy manager must review this draft.',
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ Current CALL-E business operator membership is required. No calls were placed.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to create the CALL-E campaign draft. No calls were placed.'));
  }
}

async function handleCallCampaignReview(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. Campaign review is available to administrators.');
    return;
  }
  const [businessId, campaignId, decision, ...extra] = String(ctx.match || '').trim().split(/\s+/);
  const normalizedDecision = String(decision || '').toLowerCase();
  if (extra.length || !isValidBusinessId(businessId) || !/^campaign_[a-f0-9]{64}$/.test(campaignId || '') ||
      !['approve', 'reject'].includes(normalizedDecision)) {
    await ctx.reply('Usage: /callcampaignreview <business_id> <campaign_id> <approve|reject>');
    return;
  }
  try {
    const response = await httpClient.post(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/campaigns/${encodeURIComponent(campaignId)}/review`,
      { business_id: businessId, actor_id: String(ctx.from?.id || ''), decision: normalizedDecision },
      { timeout: 12000 });
    const campaign = response?.data?.campaign || {};
    await ctx.reply(
      `CALL-E campaign <code>${escapeHtml(String(campaign.campaign_id || campaignId))}</code> is <b>${escapeHtml(String(campaign.status || normalizedDecision))}</b>. No calls were placed.`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ Current policy-manager membership is required. A creator cannot approve their own campaign.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to record the CALL-E campaign decision.'));
  }
}

async function handleCallCampaignInfo(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E campaign details are available to administrators.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the BOT to view the CALL-E campaign approval audit.');
    return;
  }
  const [businessId, campaignId, ...extra] = String(ctx.match || '').trim().split(/\s+/);
  if (extra.length || !isValidBusinessId(businessId) || !/^campaign_[a-f0-9]{64}$/.test(campaignId || '')) {
    await ctx.reply('Usage: /callcampaigninfo <business_id> <campaign_id>');
    return;
  }
  try {
    const response = await httpClient.get(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/campaigns/${encodeURIComponent(campaignId)}`,
      { params: { business_id: businessId, actor_id: String(ctx.from?.id || '') }, timeout: 12000 });
    const campaign = response?.data?.campaign || {};
    const recipients = Array.isArray(response?.data?.recipients) ? response.data.recipients : [];
    const reviews = Array.isArray(response?.data?.review_history) ? response.data.review_history : [];
    const auditLines = reviews.map((review) =>
      `• ${escapeHtml(String(review.decision || 'unknown'))} by <code>${escapeHtml(String(review.reviewed_by || 'unknown'))}</code> at ${escapeHtml(String(review.created_at || 'time unavailable'))}`,
    );
    const requestHash = /^[a-f0-9]{64}$/i.test(String(reviews[0]?.request_hash || ''))
      ? String(reviews[0].request_hash).toLowerCase() : 'unavailable';
    await ctx.reply(
      `<b>CALL-E campaign</b> · <code>${escapeHtml(String(campaign.campaign_id || campaignId))}</code> · ${escapeHtml(String(campaign.status || 'unknown'))}\n` +
      `Template ${Number(campaign.template_id) || 'unknown'} v${Number(campaign.template_version) || 'unknown'} · ${recipients.filter((row) => row.status === 'ready').length}/${recipients.length} destinations ready\n` +
      `Approval fingerprint: <code>${escapeHtml(requestHash)}</code>\n` +
      `Review audit:\n${auditLines.length ? auditLines.join('\n') : '• No review record available'}\nNo calls were placed.`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403 || error?.response?.status === 404) {
      await ctx.reply('CALL-E campaign not found in your current business-operator scope.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load the CALL-E campaign approval audit.'));
  }
}

function registerCallCampaignsCommand(bot) {
  bot.command('callcampaigns', handleCallCampaigns);
  bot.command('callcampaigninfo', handleCallCampaignInfo);
  bot.command('callcampaignreview', handleCallCampaignReview);
  bot.command('callcampaigncreate', async (ctx) => {
    await ctx.conversation.enter('call-campaign-create-conversation');
  });
}

module.exports = { handleCallCampaigns, handleCallCampaignInfo, handleCallCampaignReview, callCampaignCreateFlow, registerCallCampaignsCommand };
