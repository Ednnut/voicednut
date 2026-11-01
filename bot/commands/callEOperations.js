'use strict';

const crypto = require('node:crypto');
const { getAccessProfile } = require('../utils/capabilities');
const { startOperation, ensureOperationActive } = require('../utils/sessionState');
const { buildCallbackData } = require('../utils/actions');
const { renderMenu } = require('../utils/ui');
const config = require('../config');
const httpClient = require('../utils/httpClient');
const { escapeHtml } = require('../utils/ui');
const { callPlanFlow } = require('./callPlan');
const { handleCallCampaigns, handleCallCampaignInfo, handleCallCampaignReview, callCampaignCreateFlow } = require('./callCampaigns');
const { handleCallResults, handleCallResult, handleCallReconcile } = require('./callResults');
const { handleCallQuality } = require('./callQuality');
const { handleCallMissions, callMissionCreateFlow, handleCallMissionReview, handleCallMissionAdvance, handleCallMissionResolve, handleCallMissionInfo } = require('./callMissions');

const ACTIONS = {
  CALL_E_GOALS: { workflow: 'goals' },
  CALL_E_GOAL_RUN_CREATE: { workflow: 'goalRunCreate', privateOnly: true },
  CALL_E_GOAL_RUNS: { workflow: 'goalRuns' },
  CALL_E_GOAL_RUN_REVIEW: { workflow: 'goalRunReview' },
  CALL_E_GOAL_RUN_ADVANCE: { workflow: 'goalRunAdvance' },
  CALL_E_GOAL_RUN_RECONCILE: { workflow: 'goalRunReconcile' },
  CALL_E_GOAL_RUN_STATUS: { workflow: 'goalRunStatus', privateOnly: true },
  CALL_E_MISSION_SAFETY: { workflow: 'missionSafety' },
  CALL_E_RETENTION: { workflow: 'retention' },
  CALL_E_OPERATIONS_AUDIT: { workflow: 'operationsAudit' },
  CALL_E_REVIEW_INBOX: { workflow: 'reviewInbox' },
  CALL_E_MISSION_ALERTS: { workflow: 'missionAlerts' },
  CALL_E_MISSION_APPROVAL_POLICY: { workflow: 'missionApprovalPolicy' },
  CALL_E_PROVIDER_ROUTING: { workflow: 'providerRouting' },
  CALL_E_MISSION_REPORT: { workflow: 'missionReport' },
  CALL_E_ALERT_SUBSCRIPTION: { workflow: 'alertSubscription', privateOnly: true },
  CALL_E_REPORT_DIGEST: { workflow: 'reportDigest', privateOnly: true },
  CALL_E_CONTACT_POLICY: { workflow: 'contactPolicy', privateOnly: true },
  CALL_E_REVIEW_ASSIGNMENTS: { workflow: 'reviewAssignments', privateOnly: true },
  CALL_E_MISSION_USAGE: { workflow: 'missionUsage', privateOnly: true },
  CALL_E_RESULT_FOLLOWUP: { workflow: 'resultFollowup', privateOnly: true },
  CALL_E_MISSION_RECOVERY: { workflow: 'missionRecovery', privateOnly: true },
  CALL_E_CDR_IMPORT: { workflow: 'cdrImport', privateOnly: true },
  CALL_E_PROVIDER_DIAGNOSTICS: { workflow: 'providerDiagnostics', privateOnly: true },
  CALL_E_MISSION_READINESS: { workflow: 'missionReadiness', privateOnly: true },
  CALL_E_MISSION_RETRY: { workflow: 'missionRetry', privateOnly: true },
  CALL_E_CAMPAIGNS: { prompts: ['Business ID'], run: handleCallCampaigns },
  CALL_E_CAMPAIGN_CREATE: { create: callCampaignCreateFlow },
  CALL_E_CAMPAIGN_INFO: { prompts: ['Business ID', 'Campaign ID'], run: handleCallCampaignInfo, privateOnly: true },
  CALL_E_CAMPAIGN_REVIEW: { prompts: ['Business ID', 'Campaign ID', 'Decision: approve or reject'], run: handleCallCampaignReview, choices: { 2: ['approve', 'reject'] } },
  CALL_E_CALL_RESULT: { prompts: ['Local CALL-E call ID (call_e_…)'], run: handleCallResult, privateOnly: true },
  CALL_E_RECONCILE: { prompts: ['Local CALL-E call ID (call_e_…)'], run: handleCallReconcile },
  CALL_E_QUALITY: { prompts: ['Local CALL-E call ID (call_e_…)'], run: handleCallQuality },
  CALL_E_MISSIONS: { prompts: ['Business ID'], run: handleCallMissions },
  CALL_E_MISSION_CREATE: { create: callMissionCreateFlow },
  CALL_E_MISSION_REVIEW: { prompts: ['Business ID', 'Mission ID', 'Decision: approve or reject'], run: handleCallMissionReview, choices: { 2: ['approve', 'reject'] } },
  CALL_E_MISSION_ADVANCE: { prompts: ['Business ID', 'Mission ID', 'Type ADVANCE to authorize one approved mission step. It may place one call if all server-side approval gates pass.'], run: handleCallMissionAdvance, choices: { 2: ['advance'] }, handlerArgumentCount: 2 },
  CALL_E_MISSION_RESOLVE: { prompts: ['Business ID', 'Mission ID', 'Decision: continue or cancel'], run: handleCallMissionResolve, choices: { 2: ['continue', 'cancel'] } },
  CALL_E_MISSION_INFO: { prompts: ['Business ID', 'Mission ID'], run: handleCallMissionInfo, privateOnly: true },
};

function selectPendingReviews(campaigns, missions, actorId, goalRuns = []) {
  const actor = String(actorId || '');
  const campaignItems = (Array.isArray(campaigns) ? campaigns : [])
    .filter((row) => row?.status === 'draft' && row?.can_review === true && /^campaign_[a-f0-9]{64}$/.test(String(row.campaign_id || '')))
    .map((row) => ({ type: 'campaign', id: String(row.campaign_id), status: String(row.status), recipientCount: Number(row.recipient_count) || 0 }));
  const missionItems = (Array.isArray(missions) ? missions : [])
    .filter((row) => row?.status === 'pending_approval' && String(row.created_by || '') !== actor && String(row.reviewed_by || '') !== actor && /^mission_[a-f0-9]{64}$/.test(String(row.mission_id || '')))
    .map((row) => ({ type: 'mission', id: String(row.mission_id), status: String(row.status), recipientCount: Number(row.recipient_count) || 0 }));
  const goalRunItems = (Array.isArray(goalRuns) ? goalRuns : [])
    .filter((row) => row?.status === 'pending_approval' && String(row.created_by || row.actor_id || row.submitted_by || '') !== actor)
    .map((row) => goalRunRequestIdOf(row))
    .filter((id) => isSafeOpaqueId(id))
    .map((id) => ({ type: 'goal_run', id, status: 'pending_approval', recipientCount: 1 }));
  return [...campaignItems, ...missionItems, ...goalRunItems].slice(0, 50);
}

function isSafeOpaqueId(value) {
  const text = String(value || '').trim();
  return Boolean(text && text.length <= 255 && !/[\u0000-\u001f\u007f]/.test(text));
}

function goalRunRequestIdOf(run) {
  return String(run?.goal_run_request_id || run?.request_id || run?.requestId || run?.id || '').trim();
}

function selectMissionAttention(missions) {
  return (Array.isArray(missions) ? missions : [])
    .filter((row) => ['needs_review', 'paused', 'failed', 'blocked'].includes(String(row?.status || '')) || Number(row?.attention_count) > 0)
    .filter((row) => /^mission_[a-f0-9]{64}$/.test(String(row?.mission_id || '')))
    .map((row) => ({
      missionId: String(row.mission_id),
      status: String(row.status || 'unknown'),
      attentionCount: Math.max(0, Number(row.attention_count) || 0),
      activeCount: Math.max(0, Number(row.active_count) || 0),
      queuedCount: Math.max(0, Number(row.queued_count) || 0),
    }));
}

function buildCallEKeyboard(ctx) {
  const { InlineKeyboard } = require('grammy');
  return new InlineKeyboard()
    .text('🧭 Plan a call (no call placed)', buildCallbackData(ctx, 'CALL_E_PLAN'))
    .text('📊 Recent results', buildCallbackData(ctx, 'CALL_E_RESULTS')).row()
    .text('📥 Pending reviews', buildCallbackData(ctx, 'CALL_E_REVIEW_INBOX'))
    .text('🚨 Mission alerts', buildCallbackData(ctx, 'CALL_E_MISSION_ALERTS')).row()
    .text('📚 Published goals', buildCallbackData(ctx, 'CALL_E_GOALS'))
    .text('📝 Draft Goal Run', buildCallbackData(ctx, 'CALL_E_GOAL_RUN_CREATE')).row()
    .text('📃 Goal Runs', buildCallbackData(ctx, 'CALL_E_GOAL_RUNS'))
    .text('✅ Review Goal Run', buildCallbackData(ctx, 'CALL_E_GOAL_RUN_REVIEW')).row()
    .text('▶️ Advance Goal Run', buildCallbackData(ctx, 'CALL_E_GOAL_RUN_ADVANCE'))
    .text('🔄 Reconcile Goal Run', buildCallbackData(ctx, 'CALL_E_GOAL_RUN_RECONCILE')).row()
    .text('🔎 Goal Run status/result', buildCallbackData(ctx, 'CALL_E_GOAL_RUN_STATUS')).row()
    .text('🛡 Mission safety / worker', buildCallbackData(ctx, 'CALL_E_MISSION_SAFETY')).row()
    .text('☎️ Outbound consent', buildCallbackData(ctx, 'CALL_E_CONTACT_POLICY'))
    .text('🧾 Mission usage', buildCallbackData(ctx, 'CALL_E_MISSION_USAGE')).row()
    .text('🩺 Recovery inbox', buildCallbackData(ctx, 'CALL_E_MISSION_RECOVERY'))
    .text('✅ Mission readiness', buildCallbackData(ctx, 'CALL_E_MISSION_READINESS')).row()
    .text('📥 Import CDR batch', buildCallbackData(ctx, 'CALL_E_CDR_IMPORT'))
    .text('📡 Provider diagnostics', buildCallbackData(ctx, 'CALL_E_PROVIDER_DIAGNOSTICS')).row()
    .text('🧑‍⚖️ Assign / acknowledge review', buildCallbackData(ctx, 'CALL_E_REVIEW_ASSIGNMENTS')).row()
    .text('⚙️ Result follow-up rules', buildCallbackData(ctx, 'CALL_E_RESULT_FOLLOWUP')).row()
    .text('⚖️ Approval policy', buildCallbackData(ctx, 'CALL_E_MISSION_APPROVAL_POLICY'))
    .text('🛣 Business provider order', buildCallbackData(ctx, 'CALL_E_PROVIDER_ROUTING')).row()
    .text('📈 Mission outcome report', buildCallbackData(ctx, 'CALL_E_MISSION_REPORT'))
    .text('🔔 Alert notifications', buildCallbackData(ctx, 'CALL_E_ALERT_SUBSCRIPTION')).row()
    .text('📬 Report digest', buildCallbackData(ctx, 'CALL_E_REPORT_DIGEST')).row()
    .text('🧹 Sensitive-data retention', buildCallbackData(ctx, 'CALL_E_RETENTION'))
    .text('📚 Operations audit', buildCallbackData(ctx, 'CALL_E_OPERATIONS_AUDIT')).row()
    .text('📋 Campaigns', buildCallbackData(ctx, 'CALL_E_CAMPAIGNS'))
    .text('➕ Draft campaign', buildCallbackData(ctx, 'CALL_E_CAMPAIGN_CREATE')).row()
    .text('✅ Review campaign', buildCallbackData(ctx, 'CALL_E_CAMPAIGN_REVIEW'))
    .text('🔎 Campaign audit', buildCallbackData(ctx, 'CALL_E_CAMPAIGN_INFO')).row()
    .text('🗂 Missions', buildCallbackData(ctx, 'CALL_E_MISSIONS'))
    .text('➕ Draft mission', buildCallbackData(ctx, 'CALL_E_MISSION_CREATE')).row()
    .text('✅ Review mission', buildCallbackData(ctx, 'CALL_E_MISSION_REVIEW'))
    .text('▶️ Advance mission', buildCallbackData(ctx, 'CALL_E_MISSION_ADVANCE')).row()
    .text('🧑‍⚖️ Resolve pause', buildCallbackData(ctx, 'CALL_E_MISSION_RESOLVE'))
    .text('🔎 Mission audit', buildCallbackData(ctx, 'CALL_E_MISSION_INFO')).row()
    .text('↩️ Retry rejected recipient', buildCallbackData(ctx, 'CALL_E_MISSION_RETRY')).row()
    .text('📄 Call result', buildCallbackData(ctx, 'CALL_E_CALL_RESULT'))
    .text('🔄 Reconcile', buildCallbackData(ctx, 'CALL_E_RECONCILE'))
    .text('🧪 Quality signals', buildCallbackData(ctx, 'CALL_E_QUALITY')).row()
    .text('⬅️ Main menu', buildCallbackData(ctx, 'MENU'));
}

async function renderCallECenter(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    const { InlineKeyboard } = require('grammy');
    await renderMenu(ctx, '<b>CALL-E Planner</b>\nPlan and preview a template. This workflow does not place a call.',
      new InlineKeyboard().text('🧭 Start planning', buildCallbackData(ctx, 'CALL_E_PLAN')).row().text('⬅️ Main menu', buildCallbackData(ctx, 'MENU')), { parseMode: 'HTML' });
    return;
  }
  await renderMenu(ctx,
    '<b>CALL-E Operations</b>\nChoose a guided workflow. Drafts and reviews do not place calls. Mission advance asks for a separate explicit confirmation and remains subject to server-side approval.',
    buildCallEKeyboard(ctx), { parseMode: 'HTML' });
}

async function ask(conversation, ctx, prompt, ensureActive, choices = []) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ctx.reply(`${prompt}${attempt ? ` (attempt ${attempt + 1}/3)` : ''}\nType cancel to stop.`);
    const update = await conversation.wait();
    ensureActive();
    const value = String(update?.message?.text || '').trim();
    if (['cancel', 'exit', 'quit'].includes(value.toLowerCase())) return null;
    if (choices.length && !choices.includes(value.toLowerCase())) {
      await ctx.reply(`Choose one of: ${choices.join(', ')}.`);
      continue;
    }
    if (prompt.includes('Local CALL-E call ID') && !/^call_e_[0-9a-f-]{36}$/i.test(value)) {
      await ctx.reply('Enter a valid local CALL-E call ID.');
      continue;
    }
    if (prompt.includes('Business ID') && !/^[A-Za-z0-9._:-]{1,120}$/.test(value)) {
      await ctx.reply('Business ID format is invalid.');
      continue;
    }
    if (prompt.includes('Campaign ID') && !/^campaign_[a-f0-9]{64}$/.test(value)) {
      await ctx.reply('Enter a valid campaign ID.');
      continue;
    }
    if (prompt.includes('Mission ID') && !/^mission_[a-f0-9]{64}$/.test(value)) {
      await ctx.reply('Enter a valid mission ID.');
      continue;
    }
    return value;
  }
  return null;
}

function callEApiBase() {
  return `${config.apiUrl.replace(/\/+$/, '')}/api/call-e`;
}

async function loadBusinessSummaries(ctx, businessId) {
  const params = { business_id: businessId, actor_id: String(ctx.from?.id || ''), limit: 50 };
  const [campaignResponse, missionResponse] = await Promise.all([
    httpClient.get(ctx, `${callEApiBase()}/campaigns`, { params, timeout: 12000 }),
    httpClient.get(ctx, `${callEApiBase()}/missions`, { params, timeout: 12000 }),
  ]);
  const goalRunResponse = await httpClient.get(ctx, `${callEApiBase()}/goal-runs`, {
    params: { business_id: businessId, actor_id: String(ctx.from?.id || ''), status: 'pending_approval' },
    timeout: 12000,
  });
  return {
    campaigns: Array.isArray(campaignResponse?.data?.campaigns) ? campaignResponse.data.campaigns : [],
    missions: Array.isArray(missionResponse?.data?.missions) ? missionResponse.data.missions : [],
    goalRuns: Array.isArray(goalRunResponse?.data?.goal_runs) ? goalRunResponse.data.goal_runs
      : Array.isArray(goalRunResponse?.data?.runs) ? goalRunResponse.data.runs
        : Array.isArray(goalRunResponse?.data?.rows) ? goalRunResponse.data.rows : [],
  };
}

async function runReviewInbox(conversation, ctx, ensureActive) {
  const businessId = await ask(conversation, ctx, 'Choose the business ID to review. Scope is explicit and checked by the API.', ensureActive);
  if (businessId === null) return;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) {
    await ctx.reply('Business ID format is invalid. Open Pending reviews and try again.');
    return;
  }
  try {
    const { campaigns, missions, goalRuns } = await loadBusinessSummaries(ctx, businessId);
    ensureActive();
    const items = selectPendingReviews(campaigns, missions, ctx.from?.id, goalRuns);
    if (!items.length) {
      await ctx.reply(`No pending campaign or mission reviews are available for <code>${escapeHtml(businessId)}</code>.`, { parse_mode: 'HTML' });
      return;
    }
    const lines = items.map((item, index) =>
      `${index + 1}. ${item.type === 'goal_run' ? 'Goal Run' : item.type} · <code>${escapeHtml(item.id)}</code> · ${item.recipientCount} recipient${item.recipientCount === 1 ? '' : 's'}`,
    );
    await ctx.reply(`<b>Pending CALL-E reviews</b> · <code>${escapeHtml(businessId)}</code>\n\n${lines.join('\n')}\n\nChoose a number to review one item. The API will enforce policy-manager role and four-eyes rules.`, { parse_mode: 'HTML' });
    const choices = items.map((_, index) => String(index + 1));
    const selection = await ask(conversation, ctx, 'Select the review item number.', ensureActive, choices);
    if (selection === null) return;
    const item = items[Number(selection) - 1];
    const decision = await ask(conversation, ctx, `Choose approve or reject for this ${item.type}.`, ensureActive, ['approve', 'reject']);
    if (decision === null) return;
    if (item.type === 'goal_run') {
      const response = await httpClient.post(ctx, `${callEApiBase()}/goal-runs/${encodeURIComponent(item.id)}/review`, {
        business_id: businessId, actor_id: String(ctx.from?.id || ''), decision,
      }, { timeout: 12000 });
      const status = response?.data?.goal_run?.status || response?.data?.run?.status || decision;
      await ctx.reply(`CALL-E Goal Run <code>${escapeHtml(item.id)}</code> is <b>${escapeHtml(String(status))}</b>. No call was placed.`, { parse_mode: 'HTML' });
    } else {
      ctx.match = `${businessId} ${item.id} ${decision}`;
      await (item.type === 'campaign' ? handleCallCampaignReview : handleCallMissionReview)(ctx);
    }
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('You do not have current CALL-E operator membership for that business.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Pending CALL-E reviews could not be loaded.'));
  }
}

function scopedGoalParams(ctx, businessId, extra = {}) {
  return { business_id: businessId, actor_id: String(ctx.from?.id || ''), ...extra };
}

async function askBusinessId(conversation, ctx, ensureActive) {
  return ask(conversation, ctx, 'Enter the business ID. The API checks your current operator scope.', ensureActive);
}

async function readGoalList(ctx, businessId, after = '') {
  const response = await httpClient.get(ctx, `${callEApiBase()}/goals`, {
    params: scopedGoalParams(ctx, businessId, { limit: 50, ...(after ? { after } : {}) }), timeout: 15000,
  });
  const rows = Array.isArray(response?.data?.goals) ? response.data.goals
    : Array.isArray(response?.data?.items) ? response.data.items : [];
  return rows.filter((goal) => isSafeOpaqueId(goal?.goal_id || goal?.id));
}

function goalIdOf(goal) {
  return String(goal?.goal_id || goal?.id || '').trim();
}

function goalNameOf(goal) {
  return String(goal?.name || goal?.title || goal?.display_name || 'Published goal').slice(0, 120);
}

async function fetchGoalDetail(ctx, businessId, goalId) {
  const response = await httpClient.get(ctx, `${callEApiBase()}/goals/${encodeURIComponent(goalId)}`, {
    params: scopedGoalParams(ctx, businessId), timeout: 15000,
  });
  return response?.data?.goal || response?.data || {};
}

async function runGoalBrowser(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const afterInput = await ask(conversation, ctx, 'Optional continuation cursor, or type skip to start at the first published goal.', ensureActive);
  if (afterInput === null) return;
  const after = afterInput.toLowerCase() === 'skip' ? '' : afterInput;
  try {
    const goals = await readGoalList(ctx, businessId, after);
    ensureActive();
    if (!goals.length) {
      await ctx.reply('No published CALL-E goals were returned for this business and page.');
      return;
    }
    const items = goals.slice(0, 30);
    const lines = items.map((goal, index) => `${index + 1}. ${escapeHtml(goalNameOf(goal))} · <code>${escapeHtml(goalIdOf(goal))}</code>`);
    await ctx.reply(`<b>Published CALL-E goals</b> · <code>${escapeHtml(businessId)}</code>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    const selection = await ask(conversation, ctx, 'Choose a goal number to inspect, or type skip to finish.', ensureActive, [...items.map((_, index) => String(index + 1)), 'skip']);
    if (selection === null || selection.toLowerCase() === 'skip') return;
    const selected = items[Number(selection) - 1];
    const goal = await fetchGoalDetail(ctx, businessId, goalIdOf(selected));
    ensureActive();
    const name = escapeHtml(goalNameOf(goal));
    const goalId = escapeHtml(goalIdOf(goal) || goalIdOf(selected));
    const schema = goal.published_run_spec?.input_schema || goal.input_schema || goal.inputSchema || goal.variables_schema || goal.variablesSchema;
    const schemaText = schema ? JSON.stringify(schema, null, 2).slice(0, 1800) : 'Input schema details were not included.';
    await ctx.reply(`<b>${name}</b> · <code>${goalId}</code>\nInput schema:\n<pre>${escapeHtml(schemaText)}</pre>`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Published CALL-E goals could not be loaded.'));
  }
}

async function runGoalRunCreate(conversation, ctx, ensureActive) {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the BOT to enter a destination or Goal Run variables.');
    return;
  }
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  try {
    const goals = await readGoalList(ctx, businessId);
    ensureActive();
    if (!goals.length) {
      await ctx.reply('No published CALL-E goals are available for this business.');
      return;
    }
    const items = goals.slice(0, 30);
    const lines = items.map((goal, index) => `${index + 1}. ${escapeHtml(goalNameOf(goal))} · <code>${escapeHtml(goalIdOf(goal))}</code>`);
    await ctx.reply(`<b>Choose a published goal</b>\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    const selection = await ask(conversation, ctx, 'Choose a goal number.', ensureActive, items.map((_, index) => String(index + 1)));
    if (selection === null) return;
    const selected = items[Number(selection) - 1];
    const goalId = goalIdOf(selected);
    const goal = await fetchGoalDetail(ctx, businessId, goalId);
    ensureActive();
    await ctx.reply(`Selected ${escapeHtml(goalNameOf(goal))}. The API will validate variables against this published goal schema.`);
    const phone = await ask(conversation, ctx, 'Enter the authorized destination in E.164 format.', ensureActive);
    if (phone === null) return;
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      await ctx.reply('Enter a valid E.164 destination. No Goal Run was staged.');
      return;
    }
    const variablesText = await ask(conversation, ctx, 'Enter Goal Run variables as a JSON object containing scalar values. No phone or variables are logged.', ensureActive);
    if (variablesText === null) return;
    if (variablesText.length > 12000) {
      await ctx.reply('Variables JSON is too large. No Goal Run was staged.');
      return;
    }
    let variables;
    try {
      variables = JSON.parse(variablesText);
    } catch {
      await ctx.reply('Variables must be valid JSON. No Goal Run was staged.');
      return;
    }
    if (!variables || typeof variables !== 'object' || Array.isArray(variables) || Object.values(variables).some((value) => !['string', 'number', 'boolean'].includes(typeof value))) {
      await ctx.reply('Variables must be a JSON object with scalar values. No Goal Run was staged.');
      return;
    }
    const suppliedKey = await ask(conversation, ctx, 'Optional idempotency key for a retry, or type skip to generate one.', ensureActive);
    if (suppliedKey === null) return;
    if (suppliedKey.toLowerCase() !== 'skip' && !/^[A-Za-z0-9._:-]{8,180}$/.test(suppliedKey)) {
      await ctx.reply('Idempotency key must be 8–180 letters, digits, dots, underscores, colons, or hyphens. No Goal Run was staged.');
      return;
    }
    const confirmation = await ask(conversation, ctx, 'Reply exactly YES I HAVE AUTHORIZATION to confirm you may contact this destination. This only stages a pending review; it does not place a call.', ensureActive);
    if (confirmation !== 'YES I HAVE AUTHORIZATION') {
      await ctx.reply('Goal Run draft canceled. No call was placed.');
      return;
    }
    const idempotencyKey = suppliedKey.toLowerCase() === 'skip' ? `bot-goal-run:${crypto.randomUUID()}` : suppliedKey;
    await ctx.reply(`Goal Run request key: <code>${escapeHtml(idempotencyKey)}</code>. Reuse it with identical inputs if the response is unclear.`, { parse_mode: 'HTML' });
    const response = await httpClient.post(ctx, `${callEApiBase()}/goal-runs`, {
      business_id: businessId,
      actor_id: String(ctx.from?.id || ''),
      goal_id: goalId,
      phone,
      variables,
      authorized: true,
    }, { timeout: 20000, headers: { 'Idempotency-Key': idempotencyKey } });
    ensureActive();
    const run = response?.data?.goal_run || response?.data?.run || {};
    const requestId = goalRunRequestIdOf(run) || String(response?.data?.goal_run_request_id || response?.data?.request_id || 'pending');
    await ctx.reply(`CALL-E Goal Run <code>${escapeHtml(requestId)}</code> is <b>pending approval</b>. Request key: <code>${escapeHtml(idempotencyKey)}</code>. No call was placed.`, { parse_mode: 'HTML' });
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('Current CALL-E business operator membership is required. No call was placed.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Goal Run draft could not be staged. No call was placed.'));
  }
}

async function runGoalRuns(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const statusInput = await ask(conversation, ctx, 'Optional Goal Run status filter, or type skip for all statuses.', ensureActive);
  if (statusInput === null) return;
  if (statusInput.toLowerCase() !== 'skip' && !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(statusInput)) {
    await ctx.reply('Status filter format is invalid.');
    return;
  }
  try {
    const params = scopedGoalParams(ctx, businessId, statusInput.toLowerCase() === 'skip' ? {} : { status: statusInput });
    const response = await httpClient.get(ctx, `${callEApiBase()}/goal-runs`, { params, timeout: 12000 });
    ensureActive();
    const runs = Array.isArray(response?.data?.goal_runs) ? response.data.goal_runs
      : Array.isArray(response?.data?.runs) ? response.data.runs : Array.isArray(response?.data?.rows) ? response.data.rows : [];
    if (!runs.length) {
      await ctx.reply('No CALL-E Goal Runs matched that business and status filter.');
      return;
    }
    const lines = runs.slice(0, 30).map((run) => {
      const id = goalRunRequestIdOf(run) || 'unknown';
      return `• <code>${escapeHtml(id)}</code> · ${escapeHtml(String(run.status || 'unknown'))} · goal ${escapeHtml(String(run.goal_id || run.goalId || 'unknown'))}`;
    });
    await ctx.reply(`<b>CALL-E Goal Runs</b> · <code>${escapeHtml(businessId)}</code>\n\n${lines.join('\n')}\n\nPhone and variables are not displayed.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'CALL-E Goal Runs could not be loaded.'));
  }
}

async function askGoalRunIdentity(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return null;
  const requestId = await ask(conversation, ctx, 'Enter the Goal Run request ID.', ensureActive);
  if (requestId === null) return null;
  if (!isSafeOpaqueId(requestId)) {
    await ctx.reply('Goal Run request ID is invalid.');
    return null;
  }
  return { businessId, requestId };
}

async function runGoalRunReview(conversation, ctx, ensureActive) {
  const identity = await askGoalRunIdentity(conversation, ctx, ensureActive);
  if (!identity) return;
  const decision = await ask(conversation, ctx, 'Choose approve or reject. The API enforces reviewer separation.', ensureActive, ['approve', 'reject']);
  if (decision === null) return;
  try {
    const response = await httpClient.post(ctx, `${callEApiBase()}/goal-runs/${encodeURIComponent(identity.requestId)}/review`, {
      business_id: identity.businessId, actor_id: String(ctx.from?.id || ''), decision,
    }, { timeout: 12000 });
    const run = response?.data?.goal_run || response?.data?.run || {};
    await ctx.reply(`CALL-E Goal Run <code>${escapeHtml(identity.requestId)}</code> is <b>${escapeHtml(String(run.status || decision))}</b>. No call was placed.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'CALL-E Goal Run review could not be recorded.'));
  }
}

async function runGoalRunAdvance(conversation, ctx, ensureActive) {
  const identity = await askGoalRunIdentity(conversation, ctx, ensureActive);
  if (!identity) return;
  const confirmation = await ask(conversation, ctx, 'Type ADVANCE to authorize this approved Goal Run to execute. If all server approval and consent gates pass, this may place a live call.', ensureActive, ['advance']);
  if (confirmation === null) return;
  try {
    const response = await httpClient.post(ctx, `${callEApiBase()}/goal-runs/${encodeURIComponent(identity.requestId)}/advance`, {
      business_id: identity.businessId, actor_id: String(ctx.from?.id || ''),
    }, { timeout: 20000 });
    ensureActive();
    const run = response?.data?.goal_run || response?.data?.run || {};
    await ctx.reply(`CALL-E Goal Run <code>${escapeHtml(identity.requestId)}</code> · ${escapeHtml(String(run.status || response?.data?.status || 'updated'))}. Provider execution remains subject to server-side approval gates.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'CALL-E Goal Run could not advance.'));
  }
}

async function runGoalRunReconcile(conversation, ctx, ensureActive) {
  const identity = await askGoalRunIdentity(conversation, ctx, ensureActive);
  if (!identity) return;
  try {
    const response = await httpClient.post(ctx, `${callEApiBase()}/goal-runs/${encodeURIComponent(identity.requestId)}/reconcile`, {
      business_id: identity.businessId, actor_id: String(ctx.from?.id || ''),
    }, { timeout: 20000 });
    ensureActive();
    const run = response?.data?.goal_run || response?.data?.run || {};
    await ctx.reply(`CALL-E Goal Run <code>${escapeHtml(identity.requestId)}</code> · ${escapeHtml(String(run.status || response?.data?.status || 'reconciled'))}. This refreshed status; it did not place a new call.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'CALL-E Goal Run reconciliation failed.'));
  }
}

async function runGoalRunStatus(conversation, ctx, ensureActive) {
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the BOT to view Goal Run status or results.');
    return;
  }
  const identity = await askGoalRunIdentity(conversation, ctx, ensureActive);
  if (!identity) return;
  try {
    const response = await httpClient.get(ctx, `${callEApiBase()}/goal-runs/${encodeURIComponent(identity.requestId)}`, {
      params: scopedGoalParams(ctx, identity.businessId), timeout: 15000,
    });
    ensureActive();
    const run = response?.data?.goal_run || response?.data?.run || response?.data || {};
    const result = run.result ?? run.output ?? response?.data?.result;
    const resultText = result === undefined || result === null ? 'No result is available.' : JSON.stringify(result, null, 2).slice(0, 2800);
    await ctx.reply(`<b>CALL-E Goal Run</b> · <code>${escapeHtml(identity.requestId)}</code>\nStatus: ${escapeHtml(String(run.status || 'unknown'))}\nGoal: ${escapeHtml(String(run.goal_id || run.goalId || 'unknown'))}\nResult:\n<pre>${escapeHtml(resultText)}</pre>\nPhone and input variables are not displayed.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'CALL-E Goal Run status could not be loaded.'));
  }
}

async function updateSafetyPolicy(ctx, businessId, actorId, policy, emergencyStop = policy.emergency_stop) {
  return httpClient.put(ctx, `${callEApiBase()}/mission-safety`, {
    business_id: businessId, actor_id: actorId,
    max_calls_per_day: policy.max_calls_per_day,
    quiet_hours_start: policy.quiet_hours_start,
    quiet_hours_end: policy.quiet_hours_end,
    timezone: policy.timezone,
    emergency_stop: emergencyStop,
    contact_cooldown_hours: Number(policy.contact_cooldown_hours) || 0,
  }, { timeout: 15000 });
}

async function runMissionSafety(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const actorId = String(ctx.from?.id || '');
  const base = `${callEApiBase()}/mission-safety`;
  try {
    let response = await httpClient.get(ctx, base, { params: { business_id: businessId, actor_id: actorId }, timeout: 12000 });
    ensureActive();
    let policy = response?.data?.safety_policy || {};
    const quiet = policy.quiet_hours_start ? `${policy.quiet_hours_start}-${policy.quiet_hours_end}` : 'off';
    await ctx.reply(`<b>Mission safety</b> · <code>${escapeHtml(businessId)}</code>\nConfigured: ${policy.configured === true ? 'yes' : 'no'}\nDaily cap: ${Number(policy.max_calls_per_day) || 0}\nUsed today: ${Number(policy.calls_used_today) || 0}\nQuiet hours: ${escapeHtml(quiet)} (${escapeHtml(String(policy.timezone || 'UTC'))})\nContact cooldown: ${Number(policy.contact_cooldown_hours) || 0} hours\nEmergency stop: ${policy.emergency_stop === true ? '<b>ON</b>' : 'off'}\n\nOnly a policy manager can change these controls.`, { parse_mode: 'HTML' });
    const action = await ask(conversation, ctx, 'Choose view, configure, stop, resume, worker status, pause worker, resume worker, or skip.', ensureActive,
      ['view', 'configure', 'stop', 'resume', 'worker status', 'pause worker', 'resume worker', 'skip']);
    if (action === null || action === 'view' || action === 'skip') return;
    if (action === 'configure') {
      const capText = await ask(conversation, ctx, 'Set the per-business daily call cap (1–1000).', ensureActive);
      if (capText === null) return;
      const cap = Number(capText);
      if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1000) { await ctx.reply('Daily cap is invalid; no policy was changed.'); return; }
      const timezone = await ask(conversation, ctx, 'Enter an IANA timezone, for example America/Los_Angeles.', ensureActive);
      if (timezone === null) return;
      const quietText = await ask(conversation, ctx, 'Quiet hours as HH:MM-HH:MM (overnight is supported), or none.', ensureActive);
      if (quietText === null) return;
      const quietMatch = quietText.toLowerCase() === 'none' ? null : quietText.match(/^((?:[01]\d|2[0-3]):[0-5]\d)-((?:[01]\d|2[0-3]):[0-5]\d)$/);
      if (quietText.toLowerCase() !== 'none' && !quietMatch) { await ctx.reply('Quiet hours format is invalid; no policy was changed.'); return; }
      const stopChoice = await ask(conversation, ctx, 'Emergency stop state: on or off. Keep it on until dispatch is explicitly authorized.', ensureActive, ['on', 'off']);
      if (stopChoice === null) return;
      const cooldownText = await ask(conversation, ctx, 'Contact cooldown in hours (0 disables; maximum 8760). Recent accepted or uncertain calls are suppressed across mission preflights.', ensureActive);
      if (cooldownText === null) return;
      const cooldown = Number(cooldownText);
      if (!Number.isSafeInteger(cooldown) || cooldown < 0 || cooldown > 8760) { await ctx.reply('Cooldown must be an integer from 0 to 8760 hours; no policy was changed.'); return; }
      response = await updateSafetyPolicy(ctx, businessId, actorId, {
        max_calls_per_day: cap, timezone,
        quiet_hours_start: quietMatch?.[1] || null, quiet_hours_end: quietMatch?.[2] || null,
        contact_cooldown_hours: cooldown,
      }, stopChoice === 'on');
      await ctx.reply(`Safety policy saved. Emergency stop is ${response?.data?.safety_policy?.emergency_stop ? 'ON' : 'off'}; contact cooldown is ${Number(response?.data?.safety_policy?.contact_cooldown_hours) || 0} hours.`, { parse_mode: 'HTML' });
      return;
    }
    if (['stop', 'resume'].includes(action)) {
      if (policy.configured !== true) { await ctx.reply('Configure a daily cap and timezone before changing the emergency stop.'); return; }
      const confirmation = action === 'resume'
        ? await ask(conversation, ctx, 'Type RESUME CALLS to turn off the emergency stop.', ensureActive, ['resume calls'])
        : 'stop';
      if (confirmation === null) return;
      if (action === 'resume' && confirmation !== 'resume calls') { await ctx.reply('Resume canceled.'); return; }
      response = await updateSafetyPolicy(ctx, businessId, actorId, policy, action === 'stop');
      await ctx.reply(`Emergency stop is now ${response?.data?.safety_policy?.emergency_stop ? 'ON' : 'off'}.`, { parse_mode: 'HTML' });
      return;
    }
    const missionId = await ask(conversation, ctx, 'Enter the mission ID (mission_ followed by 64 lowercase hex characters).', ensureActive);
    if (missionId === null) return;
    if (!/^mission_[a-f0-9]{64}$/.test(missionId)) { await ctx.reply('Mission ID format is invalid.'); return; }
    if (action === 'worker status') {
      const result = await httpClient.get(ctx, `${callEApiBase()}/missions/${encodeURIComponent(missionId)}/worker`, {
        params: { business_id: businessId, actor_id: actorId }, timeout: 12000,
      });
      const worker = result?.data?.worker || {};
      await ctx.reply(`<b>Mission worker</b> · <code>${escapeHtml(missionId)}</code>\nConfigured: ${worker.configured ? 'yes' : 'no'}\nPaused: ${worker.paused ? 'yes' : 'no'}\nLease active: ${worker.active ? 'yes' : 'no'} · stale: ${worker.stale ? 'yes' : 'no'}\nLast state: ${escapeHtml(String(worker.last_state || 'idle'))}\nLast error: ${escapeHtml(String(worker.last_error_code || 'none'))}\nHeartbeat: ${escapeHtml(String(worker.heartbeat_at || 'never'))}`, { parse_mode: 'HTML' });
      return;
    }
    const paused = action === 'pause worker';
    const confirmation = await ask(conversation, ctx, `Type ${paused ? 'PAUSE' : 'RESUME'} WORKER to confirm this control.`, ensureActive, [paused ? 'pause worker' : 'resume worker']);
    if (confirmation === null) return;
    const result = await httpClient.put(ctx, `${callEApiBase()}/missions/${encodeURIComponent(missionId)}/worker`, {
      business_id: businessId, actor_id: actorId, paused,
    }, { timeout: 12000 });
    await ctx.reply(`Mission worker is ${result?.data?.worker_control?.paused ? 'paused' : 'resumed'}.`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Mission safety controls could not be loaded or changed.'));
  }
}

async function runRetention(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  try {
    const response = await httpClient.get(ctx, `${callEApiBase()}/retention`, {
      params: { business_id: businessId, actor_id: String(ctx.from?.id || '') }, timeout: 12000,
    });
    ensureActive();
    const retention = response?.data?.retention || {};
    if (!(Number(retention.expired_goal_runs) + Number(retention.expired_missions))) return;
    const confirmation = await ask(conversation, ctx, 'Type PURGE EXPIRED SENSITIVE DATA to continue.', ensureActive, ['purge expired sensitive data']);
    if (confirmation === null) return;
    const result = await httpClient.post(ctx, `${callEApiBase()}/retention/purge`, {
      business_id: businessId, actor_id: String(ctx.from?.id || ''), confirmation: 'PURGE EXPIRED SENSITIVE DATA',
    }, { timeout: 20000 });
    const summary = result?.data?.retention || {};
    await ctx.reply(`Purged expired sensitive data. Goal Runs: ${Number(summary.expired_goal_runs) || 0}; missions: ${Number(summary.expired_missions) || 0}. Aggregate action was audited.`);
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Retention preview or purge failed.'));
  }
}

async function runOperationsAudit(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  try {
    const response = await httpClient.get(ctx, `${callEApiBase()}/operations-audit`, {
      params: { business_id: businessId, actor_id: String(ctx.from?.id || ''), limit: 50 }, timeout: 15000,
    });
    ensureActive();
    const rows = Array.isArray(response?.data?.audit) ? response.data.audit : [];
    if (!rows.length) { await ctx.reply('No CALL-E operations audit events are recorded for this business.'); return; }
    const lines = rows.slice(0, 30).map((row) => `• ${escapeHtml(String(row.created_at || 'unknown'))} · ${escapeHtml(String(row.action || 'unknown'))} · actor <code>${escapeHtml(String(row.actor_id || 'unknown'))}</code>${row.mission_id ? ` · <code>${escapeHtml(String(row.mission_id))}</code>` : ''}`);
    await ctx.reply(`<b>CALL-E operations audit</b> · <code>${escapeHtml(businessId)}</code>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'CALL-E operations audit could not be loaded.'));
  }
}

async function runMissionAlerts(conversation, ctx, ensureActive) {
  const businessId = await ask(conversation, ctx, 'Choose the business ID for mission alerts. Scope is explicit and checked by the API.', ensureActive);
  if (businessId === null) return;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) {
    await ctx.reply('Business ID format is invalid. Open Mission alerts and try again.');
    return;
  }
  try {
    const response = await httpClient.get(ctx, `${callEApiBase()}/missions`, {
      params: { business_id: businessId, actor_id: String(ctx.from?.id || ''), limit: 50 }, timeout: 12000,
    });
    ensureActive();
    const alerts = selectMissionAttention(response?.data?.missions);
    if (!alerts.length) {
      await ctx.reply(`No persisted mission attention states for <code>${escapeHtml(businessId)}</code>.`, { parse_mode: 'HTML' });
      return;
    }
    const lines = alerts.map((item) => {
      const attention = item.attentionCount
        ? ` · ${item.attentionCount} recipient(s) failed, blocked, or need review/recovery`
        : '';
      const state = item.status === 'needs_review' ? 'needs review / recovery' : item.status;
      return `• <code>${escapeHtml(item.missionId)}</code> · ${escapeHtml(state)}${attention} · ${item.activeCount} active · ${item.queuedCount} queued`;
    });
    await ctx.reply(`<b>CALL-E mission attention</b> · <code>${escapeHtml(businessId)}</code>\n\n${lines.join('\n')}\n\nThese alerts reflect persisted mission and recipient states. Use Mission info, Reconcile, or Resolve pause for the next step.`, { parse_mode: 'HTML' });
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('You do not have current CALL-E operator membership for that business.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'CALL-E mission alerts could not be loaded.'));
  }
}

async function runMissionApprovalPolicy(conversation, ctx, ensureActive) {
  const businessId = await ask(conversation, ctx, 'Enter the business ID for its mission approval policy.', ensureActive);
  if (businessId === null) return;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) { await ctx.reply('Business ID format is invalid.'); return; }
  try {
    const current = await httpClient.get(ctx, `${callEApiBase()}/mission-approval-policy`, {
      params: { business_id: businessId, actor_id: String(ctx.from?.id || '') }, timeout: 12000,
    });
    const policy = current?.data?.policy || {};
    await ctx.reply(`Current policy: missions with ${Number(policy.secondary_approval_threshold) >= 26 ? 'no eligible recipient count' : `${Number(policy.secondary_approval_threshold)} or more recipients`} require two different policy managers; approval expires after ${Number(policy.approval_ttl_hours) || 24} hours; review SLA is ${Number(policy.review_sla_minutes) || 0} minutes; repeat escalation interval is ${Number(policy.review_repeat_minutes) || 0} minutes (0 disables repeats). Enter a secondary-approval threshold from 2 to 26 (26 disables it).`);
    const thresholdText = await ask(conversation, ctx, 'Secondary approval threshold (2–26).', ensureActive);
    if (thresholdText === null) return;
    const threshold = Number(thresholdText);
    if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > 26) { await ctx.reply('Threshold must be an integer from 2 through 26.'); return; }
    const ttlText = await ask(conversation, ctx, 'Approval expiry in hours (1–720).', ensureActive);
    if (ttlText === null) return;
    const ttl = Number(ttlText);
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 720) { await ctx.reply('Expiry must be an integer from 1 through 720 hours.'); return; }
    const slaText = await ask(conversation, ctx, 'Review escalation deadline in minutes (0 disables; maximum 10080). Opted-in operators receive a one-time alert for overdue pending reviews.', ensureActive);
    if (slaText === null) return;
    const reviewSla = Number(slaText);
    if (!Number.isSafeInteger(reviewSla) || reviewSla < 0 || reviewSla > 10080) { await ctx.reply('Review SLA must be an integer from 0 through 10080 minutes.'); return; }
    const repeatText = await ask(conversation, ctx, 'Repeat escalation interval in minutes (0 disables repeat notifications; 5–10080 otherwise).', ensureActive);
    if (repeatText === null) return;
    const repeatMinutes = Number(repeatText);
    if (!Number.isSafeInteger(repeatMinutes) || repeatMinutes < 0 || repeatMinutes > 10080 || (repeatMinutes > 0 && repeatMinutes < 5) || (repeatMinutes > 0 && reviewSla === 0)) {
      await ctx.reply('Repeat escalation must be 0 or from 5 through 10080 minutes, and requires a nonzero review SLA.'); return;
    }
    const confirmation = await ask(conversation, ctx, 'Type SAVE POLICY to confirm this business-level policy change.', ensureActive);
    if (confirmation !== 'SAVE POLICY') { await ctx.reply('Approval policy update canceled.'); return; }
    const saved = await httpClient.put(ctx, `${callEApiBase()}/mission-approval-policy`, {
      business_id: businessId, actor_id: String(ctx.from?.id || ''), secondary_approval_threshold: threshold, approval_ttl_hours: ttl,
      review_sla_minutes: reviewSla, review_repeat_minutes: repeatMinutes,
    }, { timeout: 12000 });
    await ctx.reply(`Approval policy saved for <code>${escapeHtml(businessId)}</code>.`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Mission approval policy could not be updated.')); }
}

async function runProviderRouting(conversation, ctx, ensureActive) {
  const businessId = await ask(conversation, ctx, 'Enter the business ID for provider routing.', ensureActive);
  if (businessId === null) return;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) { await ctx.reply('Business ID format is invalid.'); return; }
  try {
    const current = await httpClient.get(ctx, `${callEApiBase()}/provider-routing`, {
      params: { business_id: businessId, actor_id: String(ctx.from?.id || '') }, timeout: 12000,
    });
    const order = current?.data?.policy?.provider_order || [];
    await ctx.reply(`Current business priority: ${order.length ? order.join(' → ') : 'global default'}. Enter a comma-separated order using twilio, plivo, and vonage. Global readiness, circuit guards, and safe submission uncertainty rules still apply.`);
    const orderText = await ask(conversation, ctx, 'Provider order, for example: twilio,plivo,vonage', ensureActive);
    if (orderText === null) return;
    const providers = orderText.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (!providers.length || providers.length > 3 || new Set(providers).size !== providers.length || providers.some((provider) => !['twilio', 'plivo', 'vonage'].includes(provider))) {
      await ctx.reply('List one to three unique providers from twilio, plivo, vonage.'); return;
    }
    const preview = await httpClient.post(ctx, `${callEApiBase()}/provider-routing/preview`, {
      business_id: businessId, actor_id: String(ctx.from?.id || ''), preferred_provider: providers[0], provider_order: providers,
    }, { timeout: 12000 });
    const routing = preview?.data?.preview || {};
    const healthLines = (Array.isArray(routing.provider_health) ? routing.provider_health : [])
      .map((item) => `${item.provider}: ${item.ready ? 'ready' : 'not ready'}, circuit ${item.state}, score ${Number(item.score) || 0}`);
    await ctx.reply(`<b>No-call routing preview</b>\nSelected: ${escapeHtml(String(routing.selected_provider || 'none'))}\nEligible order: ${escapeHtml((routing.eligible_order || []).join(' → ') || 'none')}\nBlocked: ${escapeHtml((routing.blocked_providers || []).join(', ') || 'none')}\n${healthLines.map(escapeHtml).join('\n') || 'No provider health data is available.'}\n\nThis preview does not dispatch a call. Automatic failover remains disabled after an uncertain provider submission.`, { parse_mode: 'HTML' });
    const confirmation = await ask(conversation, ctx, 'Type SAVE ROUTING to confirm the provider priority.', ensureActive);
    if (confirmation !== 'SAVE ROUTING') { await ctx.reply('Provider routing update canceled.'); return; }
    await httpClient.put(ctx, `${callEApiBase()}/provider-routing`, {
      business_id: businessId, actor_id: String(ctx.from?.id || ''), provider_order: providers,
    }, { timeout: 12000 });
    await ctx.reply(`Business provider order saved: ${providers.join(' → ')}. This changes priority only for calls using a business-owned script.`);
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Business provider routing could not be updated.')); }
}

async function runMissionReport(conversation, ctx, ensureActive) {
  const businessId = await ask(conversation, ctx, 'Enter the business ID for a mission outcome report.', ensureActive);
  if (businessId === null) return;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) { await ctx.reply('Business ID format is invalid.'); return; }
  const from = await ask(conversation, ctx, 'Start date YYYY-MM-DD, or type default for the last 30 days.', ensureActive);
  if (from === null) return;
  const to = await ask(conversation, ctx, 'End date YYYY-MM-DD, or type default for today.', ensureActive);
  if (to === null) return;
  const params = { business_id: businessId, actor_id: String(ctx.from?.id || '') };
  if (from.toLowerCase() !== 'default') params.from = from;
  if (to.toLowerCase() !== 'default') params.to = to;
  try {
    const response = await httpClient.get(ctx, `${callEApiBase()}/mission-report`, { params, timeout: 12000 });
    ensureActive();
    const report = response?.data?.report || {};
    await ctx.reply(`<b>Mission outcome report</b> · <code>${escapeHtml(businessId)}</code> · ${escapeHtml(String(report.from || ''))} to ${escapeHtml(String(report.to || ''))}\nMissions: ${Number(report.mission_count) || 0} · completed: ${Number(report.completed_missions) || 0} · attention: ${Number(report.attention_missions) || 0}\nRecipients: ${Number(report.recipient_count) || 0} · completion rate: ${Number(report.completion_rate) || 0}%\nCompleted: ${Number(report.completed_recipients) || 0} · failed: ${Number(report.failed_recipients) || 0} · review: ${Number(report.review_recipients) || 0} · canceled: ${Number(report.canceled_recipients) || 0} · open: ${Number(report.open_recipients) || 0}`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Mission report could not be loaded.')); }
}

async function runAlertSubscription(conversation, ctx, ensureActive) {
  const businessId = await ask(conversation, ctx, 'Enter the business ID for private CALL-E mission alerts.', ensureActive);
  if (businessId === null) return;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) { await ctx.reply('Business ID format is invalid.'); return; }
  try {
    const current = await httpClient.get(ctx, `${callEApiBase()}/mission-alert-subscription`, {
      params: { business_id: businessId, actor_id: String(ctx.from?.id || '') }, timeout: 12000,
    });
    const enabled = current?.data?.subscription?.enabled === true;
    await ctx.reply(`Private mission notifications are currently ${enabled ? 'on' : 'off'} for this business. Choose on or off.`);
    const choice = await ask(conversation, ctx, 'Enter on or off.', ensureActive, ['on', 'off']);
    if (choice === null) return;
    const saved = await httpClient.put(ctx, `${callEApiBase()}/mission-alert-subscription`, {
      business_id: businessId, actor_id: String(ctx.from?.id || ''), enabled: choice === 'on',
    }, { timeout: 12000 });
    const workerEnabled = saved?.data?.worker_enabled === true;
    await ctx.reply(choice === 'on'
      ? `Subscription saved. ${workerEnabled ? 'Attention alerts will be sent privately.' : 'The server-side notification worker is currently disabled; alerts remain visible in the Operations menu.'}`
      : 'Private mission notifications are off.');
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Mission alert subscription could not be updated.')); }
}

async function runMissionRetry(conversation, ctx, ensureActive) {
  const businessId = await ask(conversation, ctx, 'Enter the business ID for the rejected mission recipient.', ensureActive);
  if (businessId === null) return;
  const missionId = await ask(conversation, ctx, 'Enter the mission ID.', ensureActive);
  if (missionId === null) return;
  const positionText = await ask(conversation, ctx, 'Enter the recipient number shown in the mission timeline (starting at 1).', ensureActive);
  if (positionText === null) return;
  const position = Number(positionText) - 1;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^mission_[a-f0-9]{64}$/.test(missionId) || !Number.isSafeInteger(position) || position < 0 || position > 24) {
    await ctx.reply('Business ID, mission ID, or recipient number is invalid.'); return;
  }
  const confirmation = await ask(conversation, ctx, 'Only provider-confirmed rejected submissions can be retried. Type RETRY REJECTED RECIPIENT to requeue it; no call is placed by this action.', ensureActive);
  if (confirmation !== 'RETRY REJECTED RECIPIENT') { await ctx.reply('Retry canceled.'); return; }
  const idempotencyKey = `bot-mission-retry:${crypto.randomUUID()}`;
  try {
    const response = await httpClient.post(ctx, `${callEApiBase()}/missions/${encodeURIComponent(missionId)}/recipients/${position}/retry`, {
      business_id: businessId, actor_id: String(ctx.from?.id || ''), idempotency_key: idempotencyKey,
    }, { timeout: 12000 });
    const mission = response?.data?.mission || {};
    await ctx.reply(`Recipient ${position + 1} is queued again in mission <code>${escapeHtml(String(mission.mission_id || missionId))}</code>. The operator must separately advance the mission after current consent, safety, and approval checks.`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Recipient was not queued for retry.')); }
}

async function runReportDigestSubscription(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const actorId = String(ctx.from?.id || '');
  const base = `${callEApiBase()}/mission-report-digest-subscription`;
  try {
    const current = await httpClient.get(ctx, base, { params: { business_id: businessId, actor_id: actorId }, timeout: 12000 });
    const subscription = current?.data?.subscription || {};
    await ctx.reply(`Scheduled mission report digest is ${subscription.enabled ? 'on' : 'off'} (${Number(subscription.interval_hours) === 168 ? 'weekly' : 'daily'}). Choose on or off.`);
    const enabledChoice = await ask(conversation, ctx, 'Enter on or off.', ensureActive, ['on', 'off']);
    if (enabledChoice === null) return;
    let intervalHours = Number(subscription.interval_hours) === 168 ? 168 : 24;
    if (enabledChoice === 'on') {
      const interval = await ask(conversation, ctx, 'Choose daily or weekly delivery.', ensureActive, ['daily', 'weekly']);
      if (interval === null) return;
      intervalHours = interval === 'weekly' ? 168 : 24;
    }
    const saved = await httpClient.put(ctx, base, {
      business_id: businessId, actor_id: actorId, enabled: enabledChoice === 'on', interval_hours: intervalHours,
    }, { timeout: 12000 });
    const workerEnabled = saved?.data?.worker_enabled === true;
    await ctx.reply(enabledChoice === 'on'
      ? `Report digest saved (${intervalHours === 24 ? 'daily' : 'weekly'}). ${workerEnabled ? 'The server worker will send the first digest after this interval.' : 'The automation worker is disabled, so no digest will be sent until server-side enablement.'}`
      : 'Scheduled report digests are off.');
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Report digest subscription could not be updated.')); }
}

async function runContactPolicy(conversation, ctx, ensureActive) {
  await ctx.reply('This consent and opt-out policy applies to outbound calls across Twilio, Plivo, Vonage, Vapi, and CALL-E. Fresh calls are blocked unless current consent is recorded; opt-outs and business safety controls take precedence.');
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const destination = await ask(conversation, ctx, 'Enter the contact E.164 number. It is sent only to the API and displayed masked.', ensureActive);
  if (destination === null) return;
  if (!/^\+[1-9]\d{7,14}$/.test(destination)) { await ctx.reply('Enter a valid E.164 number.'); return; }
  const choice = await ask(conversation, ctx, 'Choose status, consent, or optout for this business contact.', ensureActive, ['status', 'consent', 'optout']);
  if (choice === null) return;
  const actorId = String(ctx.from?.id || '');
  try {
    if (choice === 'status') {
      const response = await httpClient.get(ctx, `${callEApiBase()}/contact-policy`, {
        params: { business_id: businessId, actor_id: actorId, destination }, timeout: 12000,
      });
      const status = response?.data || {};
      const events = Array.isArray(status.events) ? status.events : [];
      await ctx.reply(`<b>Outbound contact policy</b> · ${escapeHtml(String(status.destination_masked || '••••'))}\nEligible for a fresh outbound call: <b>${status.eligible === true ? 'yes' : 'no'}</b>${status.reason ? ` · ${escapeHtml(status.reason)}` : ''}\n${events.length ? `Recent evidence events:\n${events.map((event) => `• ${escapeHtml(String(event.event_type))} · ${escapeHtml(String(event.source))} · ${escapeHtml(String(event.occurred_at))}`).join('\n')}` : 'No consent or opt-out events are recorded.'}`, { parse_mode: 'HTML' });
      return;
    }
    const sources = choice === 'consent' ? ['web_form', 'written', 'verbal', 'other'] : ['recipient_request', 'operator_report', 'provider_report', 'other'];
    const source = await ask(conversation, ctx, `Select evidence source: ${sources.join(', ')}.`, ensureActive, sources);
    if (source === null) return;
    const evidenceReference = choice === 'consent'
      ? await ask(conversation, ctx, 'Enter the opaque evidence reference (do not paste personal documents or message content).', ensureActive)
      : null;
    if (choice === 'consent' && evidenceReference === null) return;
    if (choice === 'consent' && !/^[A-Za-z0-9._:-]{8,180}$/.test(evidenceReference)) { await ctx.reply('Evidence reference must be an opaque identifier between 8 and 180 characters.'); return; }
    let expiresAt = null;
    if (choice === 'consent') {
      const expiry = await ask(conversation, ctx, 'Optional consent expiry in ISO 8601 with timezone, or type skip.', ensureActive);
      if (expiry === null) return;
      if (expiry.toLowerCase() !== 'skip') expiresAt = expiry;
    }
    const confirmation = await ask(conversation, ctx, `Type SAVE ${choice.toUpperCase()} to record this append-only event. Contact: ${destination.slice(-4)}.`, ensureActive);
    if (confirmation !== `SAVE ${choice.toUpperCase()}`) { await ctx.reply('Contact policy change canceled.'); return; }
    const body = { business_id: businessId, actor_id: actorId, kind: choice, destination,
      event_key: `bot-contact-policy:${crypto.randomUUID()}`, source, occurred_at: new Date().toISOString(),
      ...(evidenceReference ? { evidence_reference: evidenceReference } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) };
    const saved = await httpClient.post(ctx, `${callEApiBase()}/contact-policy/events`, body, { timeout: 12000 });
    await ctx.reply(`${choice === 'consent' ? 'Consent' : 'Opt-out'} evidence ${saved?.data?.idempotentReplay ? 'was already recorded' : 'recorded'} for contact ending ${destination.slice(-4)}. Consent events do not remove opt-outs; an opt-out remains blocking.`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Contact policy operation failed.')); }
}

async function runReviewAssignments(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const actorId = String(ctx.from?.id || '');
  try {
    const response = await httpClient.get(ctx, `${callEApiBase()}/mission-review-inbox`, {
      params: { business_id: businessId, actor_id: actorId, limit: 50 }, timeout: 12000,
    });
    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    if (!items.length) { await ctx.reply('No pending mission reviews in this business.'); return; }
    await ctx.reply(`<b>Mission review queue</b>\n${items.map((item, index) => `${index + 1}. <code>${escapeHtml(String(item.mission_id))}</code> · ${item.escalated_at ? 'overdue' : 'pending'} · ${item.assigned_to ? `assigned to ${escapeHtml(String(item.assigned_to))}` : 'unassigned'}${item.acknowledged ? ' · acknowledged' : ''}`).join('\n')}`, { parse_mode: 'HTML' });
    const selected = await ask(conversation, ctx, 'Select a mission number.', ensureActive, items.map((_, index) => String(index + 1)));
    if (selected === null) return;
    const item = items[Number(selected) - 1];
    const action = await ask(conversation, ctx, 'Choose acknowledge, assign, reassign, or extend_deadline.', ensureActive, ['acknowledge', 'assign', 'reassign', 'extend_deadline']);
    if (action === null) return;
    const body = { business_id: businessId, mission_id: item.mission_id, actor_id: actorId,
      action, idempotency_key: `bot-mission-review:${crypto.randomUUID()}` };
    if (action === 'assign' || action === 'reassign') {
      const target = await ask(conversation, ctx, 'Enter the Telegram ID of a different current policy manager.', ensureActive);
      if (target === null) return;
      if (!/^\d{1,20}$/.test(target) || target === String(item.created_by || '')) { await ctx.reply('Choose a valid policy manager other than the mission creator.'); return; }
      body.assigned_to = target;
    }
    if (action === 'extend_deadline') {
      const extendText = await ask(conversation, ctx, 'Extend the next escalation deadline by minutes (5 to 10080).', ensureActive);
      if (extendText === null) return;
      body.extend_minutes = Number(extendText);
    }
    if (action === 'reassign' || action === 'extend_deadline') body.action = action;
    const confirm = await ask(conversation, ctx, `Type ${action.toUpperCase()} REVIEW to confirm.`, ensureActive);
    if (confirm !== `${action.toUpperCase()} REVIEW`) { await ctx.reply('Review action canceled.'); return; }
    await httpClient.post(ctx, `${callEApiBase()}/mission-review-actions`, body, { timeout: 12000 });
    await ctx.reply(action === 'assign' || action === 'reassign' ? `Review assigned to policy manager ${escapeHtml(String(body.assigned_to))}.`
      : action === 'extend_deadline' ? 'Escalation deadline extended. The action is recorded in the mission audit.'
        : 'Review acknowledged. Use the separate review action to approve or reject the mission.');
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Mission review queue action failed.')); }
}

async function runMissionRecovery(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const actorId = String(ctx.from?.id || '');
  try {
    const response = await httpClient.get(ctx, `${callEApiBase()}/mission-recovery-inbox`, {
      params: { business_id: businessId, actor_id: actorId, limit: 50 }, timeout: 12000,
    });
    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    if (!items.length) { await ctx.reply('No failed, blocked, or stale mission recipients need recovery.'); return; }
    await ctx.reply(`<b>Mission recovery queue</b>\n${items.map((item, index) => `${index + 1}. <code>${escapeHtml(String(item.mission_id))}</code> · recipient ${Number(item.position) + 1} · ${escapeHtml(String(item.recipient_status))} · ${escapeHtml(String(item.action))} · ${escapeHtml(String(item.error_code || 'no error code'))}`).join('\n')}\n\nUncertain submissions are never retried automatically.`, { parse_mode: 'HTML' });
    const selection = await ask(conversation, ctx, 'Select a recovery item number.', ensureActive, items.map((_, index) => String(index + 1)));
    if (selection === null) return;
    const item = items[Number(selection) - 1];
    if (item.action === 'manual_review') { await ctx.reply('This item has no safe automated action. Review its mission audit and provider record first.'); return; }
    const confirm = await ask(conversation, ctx, item.action === 'reconcile_only'
      ? 'Type RECONCILE ONLY to refresh provider state. This does not advance or dispatch.'
      : 'Type RETRY CONFIRMED REJECTION to queue only the provider-confirmed rejected submission.', ensureActive);
    const expected = item.action === 'reconcile_only' ? 'RECONCILE ONLY' : 'RETRY CONFIRMED REJECTION';
    if (confirm !== expected) { await ctx.reply('Recovery canceled.'); return; }
    const result = await httpClient.post(ctx, `${callEApiBase()}/mission-recovery-actions`, {
      business_id: businessId, actor_id: actorId, mission_id: item.mission_id, position: item.position,
      action: item.action, ...(item.action === 'retry_confirmed_rejection' ? { idempotency_key: `bot-recovery:${crypto.randomUUID()}` } : {}),
    }, { timeout: 20000 });
    await ctx.reply(`Recovery action finished. State: ${escapeHtml(String(result?.data?.state || result?.data?.mission?.status || 'updated'))}. No call was dispatched by the inbox action.`);
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Mission recovery inbox failed.')); }
}

async function runMissionReadiness(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const missionId = await ask(conversation, ctx, 'Enter the mission ID.', ensureActive);
  if (missionId === null) return;
  if (!/^mission_[a-f0-9]{64}$/.test(missionId)) { await ctx.reply('Mission ID format is invalid.'); return; }
  try {
    const response = await httpClient.get(ctx, `${callEApiBase()}/missions/${encodeURIComponent(missionId)}/readiness`, {
      params: { business_id: businessId, actor_id: String(ctx.from?.id || '') }, timeout: 20000,
    });
    const readiness = response?.data?.readiness || {};
    const checks = (readiness.checks || []).map((item) => `${item.ready ? '✅' : '⛔'} ${escapeHtml(String(item.key))}${item.reason ? ` · ${escapeHtml(String(item.reason))}` : ''}`).join('\n');
    await ctx.reply(`<b>Mission readiness</b> · ${readiness.ready ? 'ready' : 'blocked'}\n${checks}\nBudget: ${Number(readiness.budget?.actual_minor) || 0} actual + ${Number(readiness.budget?.reserved_minor) || 0} reserved / ${readiness.budget?.cap_minor == null ? 'no cap' : `${readiness.budget.cap_minor} ${escapeHtml(String(readiness.budget.currency || ''))} minor units`}\nProvider: ${escapeHtml(String(readiness.provider?.selected_provider || 'none ready'))}\n\nThis report is read-only and never dispatches.`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Mission readiness could not be checked.')); }
}

async function runProviderDiagnostics(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  try {
    const response = await httpClient.get(ctx, `${callEApiBase()}/provider-diagnostics`, {
      params: { business_id: businessId, actor_id: String(ctx.from?.id || ''), limit: 30 }, timeout: 12000,
    });
    const entries = Array.isArray(response?.data?.current) ? response.data.current : [];
    const history = Array.isArray(response?.data?.history) ? response.data.history.slice(0, 12) : [];
    const lines = entries.map((row) => `${escapeHtml(String(row.provider))}: ${row.ready ? 'ready' : 'not ready'}, circuit ${escapeHtml(String(row.circuit_state))}, score ${Number(row.score) || 0}${row.reason_code ? ` · ${escapeHtml(String(row.reason_code))}` : ''}`);
    await ctx.reply(`<b>Provider diagnostics</b>\n${lines.join('\n') || 'No current provider status'}\n\nRecent persisted observations: ${history.length}${history.length ? `\n${history.map((row) => `${escapeHtml(String(row.provider))} ${escapeHtml(String(row.status))} · ${escapeHtml(String(row.recorded_at))}`).join('\n')}` : ''}\n\nHistory contains readiness/circuit codes only; no provider account is queried here.`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Provider diagnostics could not be loaded.')); }
}

async function runCdrImport(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const missionId = await ask(conversation, ctx, 'Enter the mission ID.', ensureActive);
  if (missionId === null) return;
  if (!/^mission_[a-f0-9]{64}$/.test(missionId)) { await ctx.reply('Mission ID format is invalid.'); return; }
  const sourceReference = await ask(conversation, ctx, 'Opaque CDR source reference. Do not paste invoices or personal data.', ensureActive);
  if (sourceReference === null) return;
  const raw = await ask(conversation, ctx, 'Paste a JSON array of 1–100 normalized records: recipient_position, provider, provider_call_id, amount_minor, currency, occurred_at, optional billed_duration_seconds.', ensureActive);
  if (raw === null) return;
  let records;
  try { records = JSON.parse(raw); } catch (_) { await ctx.reply('CDR records must be valid JSON.'); return; }
  if (!Array.isArray(records) || records.length < 1 || records.length > 100) { await ctx.reply('Provide a JSON array containing 1 to 100 records.'); return; }
  try {
    const staged = await httpClient.post(ctx, `${callEApiBase()}/mission-cdr-imports`, {
      business_id: businessId, mission_id: missionId, actor_id: String(ctx.from?.id || ''),
      source_reference: sourceReference, idempotency_key: `bot-cdr-import:${crypto.randomUUID()}`, records,
    }, { timeout: 20000 });
    const data = staged?.data || {};
    const preview = data.preview || {};
    await ctx.reply(`<b>CDR import preview</b>\nRecords: ${Number(preview.record_count) || 0} · duplicates skipped: ${Number(preview.duplicate_count) || 0} · new: ${Number(preview.new_record_count) || 0}\nBudget exceeded after import: ${preview.budget_exceeded ? 'yes' : 'no'}\nProjected totals: ${escapeHtml(JSON.stringify(preview.projected_actual_by_currency || {}))}\n\nRecords are operator-supplied and provider-account data is not fetched.`, { parse_mode: 'HTML' });
    const confirm = await ask(conversation, ctx, 'Type COMMIT CDR IMPORT to save the staged non-duplicate records.', ensureActive);
    if (confirm !== 'COMMIT CDR IMPORT') { await ctx.reply(`Import remains staged as ${escapeHtml(String(data.import_id || 'unknown'))}.`); return; }
    const committed = await httpClient.post(ctx, `${callEApiBase()}/mission-cdr-imports/${encodeURIComponent(data.import_id)}/commit`, {
      business_id: businessId, actor_id: String(ctx.from?.id || ''),
    }, { timeout: 30000 });
    await ctx.reply(`CDR import committed. Records saved: ${Number(committed?.data?.records_saved) || 0}.`);
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'CDR import failed.')); }
}

async function runMissionUsage(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const missionId = await ask(conversation, ctx, 'Enter the mission ID.', ensureActive);
  if (missionId === null) return;
  if (!/^mission_[a-f0-9]{64}$/.test(missionId)) { await ctx.reply('Mission ID format is invalid.'); return; }
  const action = await ask(conversation, ctx, 'Choose report or record.', ensureActive, ['report', 'record']);
  if (action === null) return;
  const actorId = String(ctx.from?.id || '');
  try {
    if (action === 'report') {
      const response = await httpClient.get(ctx, `${callEApiBase()}/missions/${encodeURIComponent(missionId)}/usage`, {
        params: { business_id: businessId, actor_id: actorId }, timeout: 12000,
      });
      const report = response?.data?.report || {};
      const amounts = Object.entries(report.actual_by_currency || {}).map(([currency, amount]) => `${Number(amount)} ${currency} minor units`).join(', ') || 'none recorded';
      await ctx.reply(`<b>Mission usage reconciliation</b>\nReserved: ${report.budget_currency ? `${Number(report.reserved_minor) || 0} ${escapeHtml(report.budget_currency)} minor units` : 'not configured'}\nActual usage: ${escapeHtml(amounts)}\nBudget alert: ${report.budget_exceeded ? '<b>exceeded</b>' : 'not exceeded'}. Imported entries are operator-entered records; this report does not fetch or verify provider accounts.`, { parse_mode: 'HTML' });
      return;
    }
    const positionText = await ask(conversation, ctx, 'Recipient position, starting at 0.', ensureActive);
    if (positionText === null) return;
    const recipientPosition = Number(positionText);
    if (!Number.isSafeInteger(recipientPosition) || recipientPosition < 0 || recipientPosition > 24) { await ctx.reply('Recipient position must be an integer from 0 through 24.'); return; }
    const provider = await ask(conversation, ctx, 'Provider: twilio, plivo, vonage, or other.', ensureActive, ['twilio', 'plivo', 'vonage', 'other']);
    if (provider === null) return;
    const providerCallId = await ask(conversation, ctx, 'Provider call identifier from its CDR.', ensureActive);
    if (providerCallId === null) return;
    const amount = await ask(conversation, ctx, 'Actual billed amount in minor units (integer from provider record).', ensureActive);
    if (amount === null) return;
    const amountMinor = Number(amount);
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) { await ctx.reply('Billed amount must be a non-negative integer in minor units.'); return; }
    const currency = await ask(conversation, ctx, 'ISO currency code (three letters).', ensureActive);
    if (currency === null) return;
    const sourceType = await ask(conversation, ctx, 'Source: provider_cdr, invoice, or operator_estimate.', ensureActive, ['provider_cdr', 'invoice', 'operator_estimate']);
    if (sourceType === null) return;
    const sourceReference = await ask(conversation, ctx, 'Opaque source reference (do not paste invoices or personal data).', ensureActive);
    if (sourceReference === null) return;
    const durationText = await ask(conversation, ctx, 'Billed duration in seconds, or skip.', ensureActive);
    if (durationText === null) return;
    const confirmation = await ask(conversation, ctx, `Type RECORD USAGE to save ${amountMinor} ${currency.toUpperCase()} minor units. The API stores this as an operator-entered CDR/invoice value.`, ensureActive);
    if (confirmation !== 'RECORD USAGE') { await ctx.reply('Usage entry canceled.'); return; }
    const saved = await httpClient.post(ctx, `${callEApiBase()}/mission-usage`, {
      business_id: businessId, mission_id: missionId, actor_id: actorId, recipient_position: recipientPosition,
      provider, provider_call_id: providerCallId, amount_minor: amountMinor, currency: currency.toUpperCase(),
      source_type: sourceType, source_reference: sourceReference, occurred_at: new Date().toISOString(),
      billed_duration_seconds: durationText.toLowerCase() === 'skip' ? null : Number(durationText),
      idempotency_key: `bot-provider-usage:${crypto.randomUUID()}`,
    }, { timeout: 12000 });
    await ctx.reply(`Usage record saved (${escapeHtml(String(saved?.data?.confidence || 'operator-entered'))}).${saved?.data?.budget_exceeded ? ' <b>Budget exceeded:</b> opted-in mission alert subscribers will be notified.' : ''}`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Mission usage operation failed.')); }
}

async function runResultFollowup(conversation, ctx, ensureActive) {
  const businessId = await askBusinessId(conversation, ctx, ensureActive);
  if (businessId === null) return;
  const actorId = String(ctx.from?.id || '');
  const action = await ask(conversation, ctx, 'Choose list, create, approve_actions, or approve_run.', ensureActive,
    ['list', 'create', 'approve_actions', 'approve_run']);
  if (action === null) return;
  try {
    if (action === 'list' || action === 'approve_actions') {
      const response = await httpClient.get(ctx, `${callEApiBase()}/result-follow-up-workflows`, {
        params: { business_id: businessId, actor_id: actorId }, timeout: 12000,
      });
      const workflows = Array.isArray(response?.data?.workflows) ? response.data.workflows : [];
      if (action === 'list') {
        await ctx.reply(workflows.length
          ? `<b>Result follow-up rules</b>\n${workflows.map((row) => `• <code>${escapeHtml(String(row.workflow_id))}</code> v${Number(row.version)} · ${escapeHtml(String(row.status))}${row.needs_action_approval ? ' · needs a second policy manager approval' : ''}`).join('\n')}\n\nTicket actions also wait for a separate per-result approval.`
          : 'No result follow-up rules are configured for this business.', { parse_mode: 'HTML' });
        return;
      }
      const pending = workflows.filter((row) => row.needs_action_approval === true);
      if (!pending.length) { await ctx.reply('No result follow-up action definitions are waiting for policy-manager approval.'); return; }
      await ctx.reply(`<b>Action approval queue</b>\n${pending.map((row, index) => `${index + 1}. ${escapeHtml(String(row.workflow_id))} v${Number(row.version)} · ${escapeHtml(String(row.name))}`).join('\n')}`, { parse_mode: 'HTML' });
      const selection = await ask(conversation, ctx, 'Select a workflow number.', ensureActive, pending.map((_, index) => String(index + 1)));
      if (selection === null) return;
      const workflow = pending[Number(selection) - 1];
      const confirm = await ask(conversation, ctx, 'Type APPROVE TICKET ACTION to allow this ticket action definition. Each result run still requires separate human approval.', ensureActive);
      if (confirm !== 'APPROVE TICKET ACTION') { await ctx.reply('Result action approval canceled.'); return; }
      const saved = await httpClient.post(ctx, `${callEApiBase()}/result-follow-up-workflows/${encodeURIComponent(workflow.workflow_id)}/versions/${Number(workflow.version)}/approve-actions`, {
        business_id: businessId, actor_id: actorId, idempotency_key: `bot-result-action-approval:${crypto.randomUUID()}`,
      }, { timeout: 12000 });
      await ctx.reply(`Result action definition ${escapeHtml(String(workflow.workflow_id))} v${Number(workflow.version)} approved by the current policy manager. Per-result approval remains required.${saved?.data?.idempotent_replay ? ' This was an idempotent replay.' : ''}`, { parse_mode: 'HTML' });
      return;
    }
    if (action === 'approve_run') {
      const response = await httpClient.get(ctx, `${callEApiBase()}/result-follow-up-workflows/runs`, {
        params: { business_id: businessId, actor_id: actorId }, timeout: 12000,
      });
      const runs = Array.isArray(response?.data?.runs) ? response.data.runs : [];
      if (!runs.length) { await ctx.reply('No result follow-up actions are waiting for per-result approval.'); return; }
      await ctx.reply(`<b>Pending result actions</b>\n${runs.map((row, index) => `${index + 1}. <code>${escapeHtml(String(row.run_id))}</code> · ${escapeHtml(String(row.workflow_id))} v${Number(row.workflow_version)}`).join('\n')}`, { parse_mode: 'HTML' });
      const selection = await ask(conversation, ctx, 'Select a run number.', ensureActive, runs.map((_, index) => String(index + 1)));
      if (selection === null) return;
      const run = runs[Number(selection) - 1];
      const confirm = await ask(conversation, ctx, 'Type APPROVE THIS RESULT ACTION to authorize the configured ticket action for this result only.', ensureActive);
      if (confirm !== 'APPROVE THIS RESULT ACTION') { await ctx.reply('Per-result action canceled.'); return; }
      const saved = await httpClient.post(ctx, `${callEApiBase()}/result-follow-up-workflows/runs/${encodeURIComponent(run.run_id)}/approve`, {
        business_id: businessId, actor_id: actorId,
      }, { timeout: 12000 });
      await ctx.reply(`Result follow-up run approved. Current status: ${escapeHtml(String(saved?.data?.status || 'approved'))}.`);
      return;
    }
    const workflowId = await ask(conversation, ctx, 'Workflow ID (letters, numbers, dash, underscore).', ensureActive);
    if (workflowId === null) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(workflowId)) { await ctx.reply('Workflow ID is invalid.'); return; }
    const name = await ask(conversation, ctx, 'Short rule name.', ensureActive);
    if (name === null) return;
    const templateIdText = await ask(conversation, ctx, 'Pinned CALL-E template ID.', ensureActive);
    if (templateIdText === null) return;
    const templateVersionText = await ask(conversation, ctx, 'Pinned CALL-E template version.', ensureActive);
    if (templateVersionText === null) return;
    const templateId = Number(templateIdText);
    const templateVersion = Number(templateVersionText);
    if (!Number.isSafeInteger(templateId) || templateId < 1 || !Number.isSafeInteger(templateVersion) || templateVersion < 1) { await ctx.reply('Template ID and version must be positive integers.'); return; }
    const provider = await ask(conversation, ctx, 'Ticket provider: hubspot, salesforce, airtable, gohighlevel, or managed.', ensureActive,
      ['hubspot', 'salesforce', 'airtable', 'gohighlevel', 'managed']);
    if (provider === null) return;
    const contactIdText = await ask(conversation, ctx, 'External CRM contact ID, or type skip.', ensureActive);
    if (contactIdText === null) return;
    const summary = await ask(conversation, ctx, 'Ticket summary (no transcript or result values).', ensureActive);
    if (summary === null) return;
    const confirmation = await ask(conversation, ctx, 'Type SAVE RESULT RULE to stage this rule for separate policy-manager approval. It will not execute yet.', ensureActive);
    if (confirmation !== 'SAVE RESULT RULE') { await ctx.reply('Result follow-up rule canceled.'); return; }
    const definition = {
      schema_version: 1, workflow_id: workflowId, business_id: businessId,
      template_id: templateId, template_version: templateVersion, result_classifications: [],
      name, trigger_event: 'call_e_result_ready', start_step_id: 'human-review',
      steps: [
        { id: 'human-review', type: 'approval', next_step_id: 'ticket-action' },
        { id: 'ticket-action', type: 'action', action_type: 'create_ticket',
          config: { provider, ...(contactIdText.toLowerCase() === 'skip' ? {} : { contact_id: contactIdText }), summary, metadata: { source: 'call_e_result_ready' } },
          next_step_id: 'finish' },
        { id: 'finish', type: 'end' },
      ],
    };
    const saved = await httpClient.post(ctx, `${callEApiBase()}/result-follow-up-workflows`, {
      business_id: businessId, actor_id: actorId, definition,
    }, { timeout: 15000 });
    const workflow = saved?.data?.workflow || {};
    await ctx.reply(`Result follow-up <code>${escapeHtml(String(workflow.workflow_id || workflowId))}</code> v${Number(workflow.version) || 1} saved as a draft. A different policy manager must approve the action, then each result run waits for its own approval.`, { parse_mode: 'HTML' });
  } catch (error) { await ctx.reply(httpClient.getUserMessage(error, 'Result follow-up workflow operation failed.')); }
}

async function callEOperationFlow(conversation, ctx) {
  const action = String(ctx.session?.callEOperationAction || '');
  const definition = ACTIONS[action];
  if (!definition) {
    await ctx.reply('That CALL-E workflow expired. Open /menu and choose CALL-E Operations again.');
    return;
  }
  const operationId = startOperation(ctx, action.toLowerCase());
  const ensureActive = () => ensureOperationActive(ctx, operationId);
  const access = await getAccessProfile(ctx);
  ensureActive();
  if (!access?.isAdmin) {
    await ctx.reply('Access denied. CALL-E operational workflows require an administrator BOT account.');
    return;
  }
  if (definition.privateOnly && ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the BOT to view this CALL-E record.');
    return;
  }
  if (definition.workflow === 'reviewInbox') {
    await runReviewInbox(conversation, ctx, ensureActive);
    return;
  }
  if (definition.workflow === 'missionAlerts') {
    await runMissionAlerts(conversation, ctx, ensureActive);
    return;
  }
  if (definition.workflow === 'contactPolicy') { await runContactPolicy(conversation, ctx, ensureActive); return; }
  if (definition.workflow === 'reviewAssignments') { await runReviewAssignments(conversation, ctx, ensureActive); return; }
  if (definition.workflow === 'missionUsage') { await runMissionUsage(conversation, ctx, ensureActive); return; }
  if (definition.workflow === 'resultFollowup') { await runResultFollowup(conversation, ctx, ensureActive); return; }
  if (definition.workflow === 'missionRecovery') { await runMissionRecovery(conversation, ctx, ensureActive); return; }
  if (definition.workflow === 'cdrImport') { await runCdrImport(conversation, ctx, ensureActive); return; }
  if (definition.workflow === 'providerDiagnostics') { await runProviderDiagnostics(conversation, ctx, ensureActive); return; }
  if (definition.workflow === 'missionReadiness') { await runMissionReadiness(conversation, ctx, ensureActive); return; }
  const opsFlows = {
    missionSafety: runMissionSafety, retention: runRetention, operationsAudit: runOperationsAudit,
    missionApprovalPolicy: runMissionApprovalPolicy, providerRouting: runProviderRouting,
    missionReport: runMissionReport, alertSubscription: runAlertSubscription, missionRetry: runMissionRetry,
    reportDigest: runReportDigestSubscription,
  };
  if (opsFlows[definition.workflow]) {
    await opsFlows[definition.workflow](conversation, ctx, ensureActive);
    return;
  }
  const guidedGoalFlows = {
    goals: runGoalBrowser,
    goalRunCreate: runGoalRunCreate,
    goalRuns: runGoalRuns,
    goalRunReview: runGoalRunReview,
    goalRunAdvance: runGoalRunAdvance,
    goalRunReconcile: runGoalRunReconcile,
    goalRunStatus: runGoalRunStatus,
  };
  if (guidedGoalFlows[definition.workflow]) {
    await guidedGoalFlows[definition.workflow](conversation, ctx, ensureActive);
    return;
  }
  if (definition.create) {
    await definition.create(conversation, ctx);
    return;
  }
  const values = [];
  for (let index = 0; index < definition.prompts.length; index += 1) {
    const value = await ask(conversation, ctx, definition.prompts[index], ensureActive, definition.choices?.[index] || []);
    if (value === null) {
      await ctx.reply('CALL-E workflow canceled.');
      return;
    }
    values.push(value);
  }
  ctx.match = values.slice(0, definition.handlerArgumentCount || values.length).join(' ');
  await definition.run(ctx);
}

function registerCallEOperations(bot) {
  bot.command('calle', renderCallECenter);
}

module.exports = {
  ACTIONS,
  buildCallEKeyboard,
  renderCallECenter,
  callEOperationFlow,
  registerCallEOperations,
  selectPendingReviews,
  selectMissionAttention,
  runReviewInbox,
  runMissionAlerts,
  runMissionSafety,
  runRetention,
  runOperationsAudit,
  runGoalBrowser,
  runGoalRunCreate,
  runGoalRunReview,
  runGoalRunAdvance,
  runGoalRunReconcile,
  runGoalRunStatus,
  runMissionApprovalPolicy,
  runProviderRouting,
  runMissionReport,
  runAlertSubscription,
  runReportDigestSubscription,
  runMissionRetry,
  runContactPolicy,
  runReviewAssignments,
  runMissionUsage,
  runMissionRecovery,
  runMissionReadiness,
  runProviderDiagnostics,
  runCdrImport,
  runResultFollowup,
};
