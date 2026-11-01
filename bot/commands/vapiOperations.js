'use strict';

const crypto = require('node:crypto');
const { InlineKeyboard } = require('grammy');
const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { buildCallbackData } = require('../utils/actions');
const { escapeHtml, renderMenu } = require('../utils/ui');

const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const ACTIONS = new Set([
  'VAPI_STATUS', 'VAPI_NUMBERS', 'VAPI_EVENTS', 'VAPI_CAMPAIGNS',
  'VAPI_CALL_INFO', 'VAPI_RECONCILE', 'VAPI_END', 'VAPI_TRANSFER', 'VAPI_TOOLS', 'VAPI_MAPPING_HEALTH', 'VAPI_SIMULATIONS',
  'VAPI_EVALS', 'VAPI_EVAL_CREATE', 'VAPI_SQUADS',
]);
const BUSINESS_CONTEXT_TOOL_ID = 'vapi.lookup_business_context';

function apiBase() {
  return `${config.apiUrl.replace(/\/+$/, '')}/api/vapi`;
}

function requirePrivateChat(ctx) {
  return ctx.chat?.type === 'private';
}

function formatVapiStatus(status = {}) {
  return [
    '<b>Vapi readiness</b>',
    `Integration: ${status.enabled ? 'enabled' : 'disabled'}`,
    `Server credentials: ${status.configured ? 'configured' : 'not configured'}`,
    `Webhook: ${status.webhook_configured ? 'configured' : 'not configured'}`,
    'Provider selection: explicit per call',
    'This status checks local configuration only; it does not contact Vapi.',
  ].join('\n');
}

function formatVapiEvents(events = []) {
  if (!events.length) return '<b>Recent Vapi call events</b>\nNo events are recorded.';
  const rows = events.slice(0, 20).map((event) =>
    `• <code>${escapeHtml(event.provider_call_id || 'unknown')}</code> · ${escapeHtml(event.event_type || 'event')} · ${escapeHtml(event.provider_status || 'status unknown')}`,
  );
  return `<b>Recent Vapi call events</b>\n${rows.join('\n')}\n\nPhone numbers and transcripts are not shown.`;
}

function formatVapiCampaigns(campaigns = []) {
  if (!campaigns.length) return '<b>Vapi campaign drafts</b>\nNo local drafts are available.';
  return `<b>Vapi campaign drafts</b>\n${campaigns.slice(0, 20).map((campaign) =>
    `• <code>${escapeHtml(campaign.campaign_id || 'unknown')}</code> · ${escapeHtml(campaign.status || 'draft')} · template ${Number(campaign.template_id) || 'unknown'} v${Number(campaign.template_version) || '?'}`,
  ).join('\n')}\n\nThese are local drafts. No calls are placed from this view.`;
}

function formatVapiPhoneNumbers(result = {}) {
  const rows = Array.isArray(result.phoneNumbers) ? result.phoneNumbers
    : Array.isArray(result.phone_numbers) ? result.phone_numbers
      : Array.isArray(result.data) ? result.data : [];
  if (!rows.length) return '<b>Vapi phone numbers</b>\nNo numbers were returned.';
  return `<b>Vapi phone numbers</b>\n${rows.slice(0, 25).map((number) =>
    `• <code>${escapeHtml(number.id || 'unknown')}</code> · ${escapeHtml(number.status || number.provider || 'available')}`,
  ).join('\n')}\n\nNumbers are shown only in this private chat.`;
}

function formatVapiMappingHealth(health = {}) {
  const mappings = Array.isArray(health.mappings) ? health.mappings : [];
  const header = `<b>Vapi template health</b>\nTemplate ${Number(health.template_id) || '?'} · v${Number(health.template_version) || '?'} · ${escapeHtml(health.lifecycle_state || 'unknown')}\nRemote checks: ${health.remote_check_configured ? 'configured' : 'unavailable'}`;
  if (!mappings.length) return `${header}\nNo Vapi mappings are recorded.`;
  const lines = mappings.map((mapping) => {
    const flags = Array.isArray(mapping.drift_flags) && mapping.drift_flags.length
      ? mapping.drift_flags.join(', ')
      : 'no drift detected';
    return `• Mapping <code>${Number(mapping.mapping_id) || '?'}</code> · template v${Number(mapping.template_version) || '?'}${mapping.current_template ? ' (current)' : ' (stale)'}\n  Sync: ${escapeHtml(mapping.sync_status || 'unknown')} · remote: ${escapeHtml(mapping.remote_status || 'unknown')} · version ${escapeHtml(mapping.remote_assistant_version || 'unknown')}\n  ${escapeHtml(flags)}${mapping.resync_available ? '\n  Resync available' : ''}`;
  });
  return `${header}\n\n${lines.join('\n\n')}${health.truncated ? '\n\nShowing the newest 20 mappings.' : ''}${health.remote_checks_limited ? '\nOnly the newest five current mappings received a remote check.' : ''}\n\nThis check is read-only. Resync updates assistant configuration only; it does not publish or place calls.`;
}

function buildVapiKeyboard(ctx) {
  return new InlineKeyboard()
    .text('🩺 Readiness', buildCallbackData(ctx, 'VAPI_STATUS'))
    .text('📞 Phone numbers', buildCallbackData(ctx, 'VAPI_NUMBERS')).row()
    .text('📡 Recent events', buildCallbackData(ctx, 'VAPI_EVENTS'))
    .text('📋 Campaign drafts', buildCallbackData(ctx, 'VAPI_CAMPAIGNS')).row()
    .text('🔎 Call details', buildCallbackData(ctx, 'VAPI_CALL_INFO'))
    .text('🔄 Reconcile call', buildCallbackData(ctx, 'VAPI_RECONCILE')).row()
    .text('⛔ End active call', buildCallbackData(ctx, 'VAPI_END'))
    .text('↗️ Transfer active call', buildCallbackData(ctx, 'VAPI_TRANSFER')).row()
    .text('🧰 Approved tools', buildCallbackData(ctx, 'VAPI_TOOLS')).row()
    .text('🧭 Template health', buildCallbackData(ctx, 'VAPI_MAPPING_HEALTH'))
    .text('🧪 Simulations', buildCallbackData(ctx, 'VAPI_SIMULATIONS'))
    .text('🧠 Eval Center', buildCallbackData(ctx, 'VAPI_EVALS'))
    .text('👥 Squads', buildCallbackData(ctx, 'VAPI_SQUADS')).row()
    .text('➕ Create eval', buildCallbackData(ctx, 'VAPI_EVAL_CREATE')).row()
    .text('⬅️ Main menu', buildCallbackData(ctx, 'MENU'));
}

async function renderVapiCenter(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('Vapi operations are available to administrators only.');
    return;
  }
  await renderMenu(ctx,
    '<b>Vapi Operations</b>\nInspect configuration and saved call records. Ending or transferring a call requires a separate confirmation. This menu does not place calls.',
    buildVapiKeyboard(ctx), { parseMode: 'HTML' });
}

async function ask(conversation, ctx, prompt, ensureActive) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await ctx.reply(`${prompt}${attempt ? ` (attempt ${attempt + 1}/3)` : ''}\nType cancel to stop.`);
    const update = await conversation.wait();
    ensureActive();
    const value = String(update?.message?.text || '').trim();
    if (['cancel', 'exit', 'quit'].includes(value.toLowerCase())) return null;
    return value;
  }
  return null;
}

async function runReadAction(ctx, action) {
  if (action === 'VAPI_STATUS') {
    const response = await httpClient.get(ctx, `${apiBase()}/status`, { timeout: 10000 });
    await ctx.reply(formatVapiStatus(response?.data?.status || {}), { parse_mode: 'HTML' });
    return;
  }
  if (action === 'VAPI_EVENTS') {
    const response = await httpClient.get(ctx, `${apiBase()}/call-events`, { params: { limit: 20 }, timeout: 12000 });
    await ctx.reply(formatVapiEvents(Array.isArray(response?.data?.events) ? response.data.events : []), { parse_mode: 'HTML' });
    return;
  }
  if (action === 'VAPI_CAMPAIGNS') {
    const response = await httpClient.get(ctx, `${apiBase()}/campaigns`, { params: { limit: 20 }, timeout: 12000 });
    await ctx.reply(formatVapiCampaigns(Array.isArray(response?.data?.campaigns) ? response.data.campaigns : []), { parse_mode: 'HTML' });
    return;
  }
  if (action === 'VAPI_NUMBERS') {
    if (!requirePrivateChat(ctx)) {
      await ctx.reply('Open a private chat with the bot to view Vapi phone-number inventory.');
      return;
    }
    const response = await httpClient.get(ctx, `${apiBase()}/phone-numbers`, { params: { page: 1, limit: 25 }, timeout: 15000 });
    await ctx.reply(formatVapiPhoneNumbers(response?.data || {}), { parse_mode: 'HTML' });
  }
}

function formatVapiEvals(evaluations = []) {
  if (!evaluations.length) return '<b>Vapi evals</b>\nNo saved evaluations are available.';
  return `<b>Vapi evals</b>\n${evaluations.slice(0, 20).map((evaluation) =>
    `• <code>${escapeHtml(evaluation.id || 'unknown')}</code> · ${escapeHtml(evaluation.name || 'Unnamed eval')}`,
  ).join('\n')}\n\nMock conversation content is hidden in this summary.`;
}

function formatVapiEvalRuns(runs = []) {
  if (!runs.length) return '<b>Recent Vapi eval runs</b>\nNo eval runs are recorded.';
  return `<b>Recent Vapi eval runs</b>\n${runs.slice(0, 10).map((run) => {
    const resultStatuses = (Array.isArray(run.results) ? run.results : []).map((result) => result.status).join(', ') || 'pending';
    const cost = run.cost_usd !== null && run.cost_usd !== undefined && Number.isFinite(Number(run.cost_usd)) ? ` · $${Number(run.cost_usd).toFixed(4)}` : '';
    return `• <code>${escapeHtml(run.id || 'unknown')}</code> · ${escapeHtml(run.status || 'unknown')} · ${escapeHtml(resultStatuses)}${cost}`;
  }).join('\n')}\n\nConversation transcripts and checkpoint content are hidden.`;
}

function formatVapiSquads(squads = []) {
  if (!squads.length) return '<b>Vapi squads</b>\nNo saved squads were returned.';
  return `<b>Vapi squads</b>\n${squads.slice(0, 20).map((squad) =>
    `• <code>${escapeHtml(squad.id || 'unknown')}</code> · ${escapeHtml(squad.name || 'Unnamed squad')} · v${escapeHtml(squad.latest_version || 'unversioned')} · ${Number(squad.member_count) || 0} members · ${Number(squad.handoff_count) || 0} handoffs`,
  ).join('\n')}\n\nSquad details show member versions and handoff destinations only; assistant prompts and webhook URLs are hidden.`;
}

function formatVapiSquadDetail(squad = {}) {
  const members = Array.isArray(squad.members) ? squad.members : [];
  const lines = members.map((member) => {
    const handoffs = Array.isArray(member.handoffs) ? member.handoffs : [];
    const routeText = handoffs.length
      ? handoffs.map((route) => `    ↳ ${escapeHtml(route.type)} → ${escapeHtml(route.target)}${route.description ? ` · ${escapeHtml(route.description)}` : ''}`).join('\n')
      : '    ↳ no saved handoff destination found';
    return `• ${Number(member.position) || '?'} · ${escapeHtml(member.assistant_name || 'Unnamed assistant')} · <code>${escapeHtml(member.assistant_id || 'inline')}</code> · ${escapeHtml(member.assistant_version || 'latest')}\n${routeText}`;
  });
  return `<b>Squad detail</b>\n${escapeHtml(squad.name || 'Unnamed squad')} · <code>${escapeHtml(squad.id || 'unknown')}</code> · ${escapeHtml(squad.latest_version || 'unversioned')}\n\n${lines.length ? lines.join('\n\n') : 'No members were returned.'}${squad.truncated ? '\n\nMember list truncated to the first 50.' : ''}\n\nRead-only inspection. No squad settings or calls were changed.`;
}

async function vapiOperationFlow(conversation, ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('Vapi operations are available to administrators only.');
    return;
  }
  const action = String(ctx.session?.vapiOperationAction || '');
  if (!ACTIONS.has(action)) {
    await ctx.reply('That Vapi action expired. Reopen /vapi and choose an action again.');
    return;
  }
  const operationId = `vapi:${action.toLowerCase()}`;
  const { startOperation, ensureOperationActive } = require('../utils/sessionState');
  const token = startOperation(ctx, operationId);
  const ensureActive = () => ensureOperationActive(ctx, token);

  try {
    if (['VAPI_STATUS', 'VAPI_NUMBERS', 'VAPI_EVENTS', 'VAPI_CAMPAIGNS'].includes(action)) {
      await runReadAction(ctx, action);
      return;
    }
    if (!requirePrivateChat(ctx)) {
      await ctx.reply('Open a private chat with the bot to inspect or control Vapi operations.');
      return;
    }
    if (action === 'VAPI_SQUADS') {
      const response = await httpClient.get(ctx, `${apiBase()}/squads`, { params: { limit: 20 }, timeout: 20000 });
      const squads = Array.isArray(response?.data?.squads) ? response.data.squads : [];
      await ctx.reply(formatVapiSquads(squads), { parse_mode: 'HTML' });
      if (!squads.length) return;
      const squadId = await ask(conversation, ctx, 'Enter a listed squad ID to inspect its members and handoff routes, or type cancel.', ensureActive);
      if (!squadId) return;
      if (!squads.some((squad) => String(squad.id) === squadId)) {
        await ctx.reply('That squad is not in the current saved list.');
        return;
      }
      const details = await httpClient.get(ctx, `${apiBase()}/squads/${encodeURIComponent(squadId)}`, { timeout: 20000 });
      await ctx.reply(formatVapiSquadDetail(details?.data?.squad || {}), { parse_mode: 'HTML' });
      return;
    }
    if (action === 'VAPI_EVALS') {
      const [evalResponse, runResponse] = await Promise.all([
        httpClient.get(ctx, `${apiBase()}/evals`, { params: { limit: 20 }, timeout: 15000 }),
        httpClient.get(ctx, `${apiBase()}/eval-runs`, { params: { limit: 10 }, timeout: 15000 }),
      ]);
      const evaluations = Array.isArray(evalResponse?.data?.evaluations) ? evalResponse.data.evaluations : [];
      const runs = Array.isArray(runResponse?.data?.runs) ? runResponse.data.runs : [];
      await ctx.reply(`${formatVapiEvals(evaluations)}\n\n${formatVapiEvalRuns(runs)}\n\nRuns use mock conversations, not phone calls, and may incur model charges.`, { parse_mode: 'HTML' });
      if (!evaluations.length) return;
      const evalId = await ask(conversation, ctx, 'Enter a listed eval ID to run, or type cancel.', ensureActive);
      if (!evalId) return;
      const selected = evaluations.find((evaluation) => String(evaluation.id) === evalId);
      if (!selected) {
        await ctx.reply('That eval is not in the current saved list.');
        return;
      }
      const targetTypeInput = await ask(conversation, ctx, 'Target type: assistant or squad.', ensureActive);
      const targetType = String(targetTypeInput || '').toLowerCase();
      if (!['assistant', 'squad'].includes(targetType)) {
        await ctx.reply('Eval run canceled. Target type must be assistant or squad.');
        return;
      }
      const targetId = await ask(conversation, ctx, `Enter the Vapi ${targetType} ID.`, ensureActive);
      if (!targetId || !CALL_ID_PATTERN.test(targetId)) {
        await ctx.reply('Eval run canceled. Target ID format is invalid.');
        return;
      }
      const phrase = `RUN VAPI EVAL ${evalId} AGAINST ${targetType} ${targetId}`;
      const confirmation = await ask(conversation, ctx, `This runs a saved mock-conversation eval against the selected ${targetType}. Vapi/model charges may apply; no phone call is placed. Type ${phrase} to confirm.`, ensureActive);
      if (confirmation !== phrase) {
        await ctx.reply('Vapi eval run canceled.');
        return;
      }
      const started = await httpClient.post(ctx, `${apiBase()}/eval-runs`, {
        eval_id: evalId,
        target_type: targetType,
        target_id: targetId,
        confirmation,
      }, { timeout: 30000 });
      const run = started?.data?.run || {};
      await ctx.reply(`Vapi eval run submitted.\nRun: <code>${escapeHtml(run.id || 'unknown')}</code>\nStatus: ${escapeHtml(run.status || 'queued')}\nNo phone call was placed. Model charges may apply.`, { parse_mode: 'HTML' });
      return;
    }
    if (action === 'VAPI_EVAL_CREATE') {
      const name = await ask(conversation, ctx, 'Enter a short name for the mock-conversation eval (1–80 characters).', ensureActive);
      if (!name) return;
      const description = await ask(conversation, ctx, 'Enter a short purpose description, or type skip.', ensureActive);
      if (description === null) return;
      const messagesInput = await ask(conversation, ctx, 'Paste the Vapi eval messages as a JSON array of message objects (1–100; up to 30 KB). This content will be stored by Vapi.', ensureActive);
      if (!messagesInput) return;
      if (messagesInput.length > 3500) {
        await ctx.reply('Eval creation canceled. Telegram input must be 3,500 characters or fewer; use the API for larger fixtures.');
        return;
      }
      let messages;
      try { messages = JSON.parse(messagesInput); } catch {
        await ctx.reply('Eval creation canceled. Messages must be valid JSON.');
        return;
      }
      if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100 || messages.some((message) => !message || typeof message !== 'object' || Array.isArray(message))) {
        await ctx.reply('Eval creation canceled. Use a JSON array with 1–100 message objects.');
        return;
      }
      const confirmation = await ask(conversation, ctx, `This creates a reusable eval definition in Vapi and stores its messages there. Type CREATE VAPI EVAL to confirm.`, ensureActive);
      if (confirmation !== 'CREATE VAPI EVAL') {
        await ctx.reply('Vapi eval creation canceled.');
        return;
      }
      const created = await httpClient.post(ctx, `${apiBase()}/evals`, {
        name,
        ...(description.toLowerCase() === 'skip' ? {} : { description }),
        messages,
        confirmation,
      }, { timeout: 30000 });
      const evaluation = created?.data?.evaluation || {};
      await ctx.reply(`Vapi eval created.\nID: <code>${escapeHtml(evaluation.id || 'unknown')}</code>\nName: ${escapeHtml(evaluation.name || name)}\nUse Eval Center to review history or run it against an assistant or squad.`, { parse_mode: 'HTML' });
      return;
    }
    if (action === 'VAPI_TOOLS') {
      const templateInput = await ask(conversation, ctx, 'Enter the call template ID to configure its read-only business context tool.', ensureActive);
      if (!templateInput) return;
      if (!/^\d{1,10}$/.test(templateInput) || Number(templateInput) <= 0) {
        await ctx.reply('Call template ID must be a positive integer.');
        return;
      }
      const templateId = Number(templateInput);
      const apiRoot = config.apiUrl.replace(/\/+$/, '');
      const current = await httpClient.get(ctx, `${apiRoot}/api/call-scripts/${templateId}/vapi-tools`, { timeout: 12000 });
      const tool = current?.data?.tool || {};
      await ctx.reply(
        `<b>Vapi read-only business context</b>\nTemplate: ${Number(tool.template_id) || templateId} · version ${Number(tool.template_version) || '?'} · ${escapeHtml(tool.lifecycle_state || 'unknown')}\nCurrently: ${tool.enabled ? 'enabled' : 'disabled'}\nApproved context: ${tool.business_context_available ? 'available' : 'missing'}\n\nChanging this policy sends the template back for review. After approval, sync the template to Vapi. No calls are placed.`,
        { parse_mode: 'HTML' },
      );
      const choice = await ask(conversation, ctx, 'Type enable or disable.', ensureActive);
      if (!choice || !['enable', 'disable'].includes(choice.toLowerCase())) {
        await ctx.reply('Tool policy change canceled.');
        return;
      }
      const enabled = choice.toLowerCase() === 'enable';
      const phrase = enabled ? `ENABLE VAPI BUSINESS CONTEXT TOOL ${templateId}` : `DISABLE VAPI BUSINESS CONTEXT TOOL ${templateId}`;
      const confirmation = await ask(conversation, ctx, `Type ${phrase} to confirm.`, ensureActive);
      if (confirmation !== phrase) {
        await ctx.reply('Tool policy change canceled.');
        return;
      }
      const updated = await httpClient.put(ctx, `${apiRoot}/api/call-scripts/${templateId}/vapi-tools`, {
        tool_id: BUSINESS_CONTEXT_TOOL_ID,
        enabled,
      }, { timeout: 15000 });
      const saved = updated?.data?.tool || {};
      await ctx.reply(`Vapi business context tool ${saved.enabled ? 'enabled' : 'disabled'} for template ${templateId}.\nLifecycle: ${escapeHtml(saved.lifecycle_state || 'draft')}. Review and approval are required before syncing. No calls were placed.`);
      return;
    }
    if (action === 'VAPI_MAPPING_HEALTH') {
      const templateInput = await ask(conversation, ctx, 'Enter the call template ID to inspect its Vapi mappings.', ensureActive);
      if (!templateInput) return;
      if (!/^\d{1,10}$/.test(templateInput) || Number(templateInput) <= 0) {
        await ctx.reply('Call template ID must be a positive integer.');
        return;
      }
      const templateId = Number(templateInput);
      const apiRoot = config.apiUrl.replace(/\/+$/, '');
      const response = await httpClient.get(ctx, `${apiRoot}/api/call-scripts/${templateId}/vapi-health`, { timeout: 30000 });
      const health = response?.data?.health || {};
      await ctx.reply(formatVapiMappingHealth(health), { parse_mode: 'HTML' });
      const resyncable = (Array.isArray(health.mappings) ? health.mappings : []).filter((mapping) => mapping.resync_available);
      if (!resyncable.length) return;
      const mappingInput = await ask(conversation, ctx, `Enter a mapping ID to resync (${resyncable.map((mapping) => Number(mapping.mapping_id)).join(', ')}), or type cancel.`, ensureActive);
      if (!mappingInput) return;
      const mappingId = Number(mappingInput);
      if (!resyncable.some((mapping) => Number(mapping.mapping_id) === mappingId)) {
        await ctx.reply('That mapping is not eligible for resynchronization.');
        return;
      }
      const phrase = `RESYNC VAPI TEMPLATE ${templateId} MAPPING ${mappingId}`;
      const confirmation = await ask(conversation, ctx, `This writes the VOICEDNUT template configuration to the mapped Vapi assistant. It does not publish or place calls. Type ${phrase} to confirm.`, ensureActive);
      if (confirmation !== phrase) {
        await ctx.reply('Vapi resync canceled.');
        return;
      }
      const updated = await httpClient.post(ctx,
        `${apiRoot}/api/call-scripts/${templateId}/vapi-mappings/${mappingId}/resync`,
        { confirmation }, { timeout: 30000 });
      const result = updated?.data?.result || {};
      await ctx.reply(`Vapi template configuration resynced for mapping ${mappingId}.\nAssistant version: ${escapeHtml(result.assistant_version || 'unchanged/unknown')}\nNo call was placed or assistant published.`);
      return;
    }
    if (action === 'VAPI_SIMULATIONS') {
      const templateInput = await ask(conversation, ctx, 'Enter the live call template ID to inspect its mapped Vapi simulation suites.', ensureActive);
      if (!templateInput) return;
      if (!/^\d{1,10}$/.test(templateInput) || Number(templateInput) <= 0) {
        await ctx.reply('Call template ID must be a positive integer.');
        return;
      }
      const templateId = Number(templateInput);
      const apiRoot = config.apiUrl.replace(/\/+$/, '');
      const suitesResponse = await httpClient.get(ctx, `${apiRoot}/api/call-scripts/${templateId}/vapi-simulation-suites`, { timeout: 30000 });
      const suites = Array.isArray(suitesResponse?.data?.suites) ? suitesResponse.data.suites : [];
      const historyResponse = await httpClient.get(ctx, `${apiRoot}/api/call-scripts/${templateId}/vapi-simulation-runs`, { params: { limit: 5 }, timeout: 15000 });
      const runs = Array.isArray(historyResponse?.data?.runs) ? historyResponse.data.runs : [];
      const baseline = historyResponse?.data?.local_baseline || null;
      const suiteSummary = suites.length ? suites.map((suite) =>
        `• <code>${escapeHtml(suite.id)}</code> · ${escapeHtml(suite.name)} · ${Number(suite.simulation_count) || 0} scenarios`).join('\n')
        : 'No Vapi suites are assigned to this template’s mapped assistant.';
      const runSummary = runs.length ? runs.map((run) => {
        const summary = run.summary || {};
        const delta = run.score_delta_vs_local_baseline != null && Number.isFinite(Number(run.score_delta_vs_local_baseline)) ? ` · Δ ${Number(run.score_delta_vs_local_baseline) > 0 ? '+' : ''}${Number(run.score_delta_vs_local_baseline)}pp vs local` : '';
        const passRate = summary.pass_rate_percent != null && Number.isFinite(Number(summary.pass_rate_percent)) ? ` · pass ${Number(summary.pass_rate_percent)}%` : '';
        return `• <code>${escapeHtml(run.run_id || 'unknown')}</code> · ${escapeHtml(summary.status || 'queued')}${passRate}${delta} · suite <code>${escapeHtml(run.suite_id || '?')}</code> · v${Number(run.template_version) || '?'}`;
      }).join('\n') : 'No saved Vapi simulation runs.';
      const baselineSummary = baseline ? `Local offline baseline: ${Number(baseline.score) || 0}% (${Number(baseline.passed_count) || 0} passed / ${Number(baseline.failed_count) || 0} failed). Vapi pass-rate deltas are shown side by side as directional signals.` : 'No local offline baseline is saved for this template version yet.';
      await ctx.reply(`<b>Vapi simulation coverage</b>\nTemplate ${templateId} · v${Number(suitesResponse?.data?.template_version) || '?'}\n${escapeHtml(baselineSummary)}\n\n<b>Suites</b>\n${suiteSummary}\n\n<b>Recent runs</b>\n${runSummary}\n\nSimulation runs use Vapi’s webchat transport. They do not place PSTN calls, but may incur Vapi/model charges.`, { parse_mode: 'HTML' });
      if (!suites.length) return;
      const suiteId = await ask(conversation, ctx, 'Enter a suite ID to run, or type cancel.', ensureActive);
      if (!suiteId) return;
      if (!suites.some((suite) => suite.id === suiteId)) {
        await ctx.reply('That suite is not assigned to the currently mapped assistant.');
        return;
      }
      const phrase = `RUN VAPI SIMULATION TEMPLATE ${templateId} SUITE ${suiteId} WITH WEBHOOKS DISABLED`;
      const confirmation = await ask(conversation, ctx, `The API checks assistant/scenario hooks, suite Slack notifications, and verifies each assistant tool is mocked. Vapi organization-level webhook configuration cannot be inspected here; verify it is disabled for this simulation. It will start up to five webchat iterations, which may incur Vapi/model charges. Type ${phrase} to confirm.`, ensureActive);
      if (confirmation !== phrase) {
        await ctx.reply('Vapi simulation canceled.');
        return;
      }
      const previousRequest = ctx.session?.vapiSimulationPending;
      const idempotencyKey = previousRequest?.template_id === templateId && previousRequest?.suite_id === suiteId
        ? previousRequest.idempotency_key
        : `voicednut-vapi-sim-${crypto.randomUUID()}`;
      if (ctx.session) ctx.session.vapiSimulationPending = { template_id: templateId, suite_id: suiteId, idempotency_key: idempotencyKey };
      const started = await httpClient.post(ctx, `${apiRoot}/api/call-scripts/${templateId}/vapi-simulation-runs`, {
        suite_id: suiteId,
        iterations: 5,
        confirmation,
        idempotency_key: idempotencyKey,
      }, { timeout: 45000 });
      if (ctx.session) ctx.session.vapiSimulationPending = null;
      const run = started?.data?.result || {};
      await ctx.reply(`Vapi simulation run queued.\nRun: <code>${escapeHtml(run.vapi_run_id || 'unknown')}</code>\nStatus: ${escapeHtml(run.status || 'queued')}\nScenarios: ${Number(run.simulation_count) || 0}\nSafety: ${escapeHtml(run.safety || 'validated')}\n${run.dashboard_url ? `Dashboard: ${escapeHtml(run.dashboard_url)}` : ''}\n\nNo live calls or messages were initiated.`, { parse_mode: 'HTML' });
      return;
    }
    const callId = await ask(conversation, ctx, 'Enter the Vapi call ID.', ensureActive);
    if (!callId) return;
    if (!CALL_ID_PATTERN.test(callId)) {
      await ctx.reply('Vapi call ID format is invalid.');
      return;
    }
    if (action === 'VAPI_CALL_INFO') {
      const response = await httpClient.get(ctx, `${apiBase()}/calls/${encodeURIComponent(callId)}`, { timeout: 12000 });
      const call = response?.data?.call || {};
      const events = Array.isArray(response?.data?.events) ? response.data.events : [];
      const latest = events[0] || {};
      await ctx.reply(
        `<b>Vapi call</b>\nID: <code>${escapeHtml(callId)}</code>\nStatus: ${escapeHtml(call.status || latest.provider_status || 'unknown')}\nLatest event: ${escapeHtml(latest.event_type || 'none')}\nDuration: ${Number.isFinite(Number(latest.duration_seconds)) ? `${Number(latest.duration_seconds)}s` : 'unknown'}\nEvents: ${events.length}\n\nNo transcript or destination number is shown.`,
        { parse_mode: 'HTML' },
      );
      return;
    }
    if (action === 'VAPI_RECONCILE') {
      const result = await httpClient.post(ctx, `${apiBase()}/calls/${encodeURIComponent(callId)}/reconcile`, {}, { timeout: 20000 });
      const state = result?.data?.result || {};
      await ctx.reply(`Vapi call reconciliation completed.\nStatus: ${escapeHtml(state.providerStatus || state.status || 'refreshed')}\nThis refresh did not place or end a call.`);
      return;
    }
    if (action === 'VAPI_END') {
      const confirmation = await ask(conversation, ctx, `Type END VAPI CALL ${callId} to end this active call.`, ensureActive);
      if (confirmation !== `END VAPI CALL ${callId}`) {
        await ctx.reply('Call end canceled.');
        return;
      }
      const result = await httpClient.post(ctx, `${apiBase()}/calls/${encodeURIComponent(callId)}/end`, {}, { timeout: 15000 });
      await ctx.reply(result?.data?.result?.alreadyEnded ? 'The Vapi call was already ended.' : 'Vapi accepted the end-call request.');
      return;
    }
    if (action === 'VAPI_TRANSFER') {
      const destinationType = await ask(conversation, ctx, 'Destination type: number or sip.', ensureActive);
      if (!destinationType || !['number', 'sip'].includes(destinationType.toLowerCase())) {
        await ctx.reply('Transfer canceled. Destination type must be number or sip.');
        return;
      }
      const destinationValue = await ask(conversation, ctx,
        destinationType.toLowerCase() === 'number' ? 'Enter the approved E.164 destination number.' : 'Enter the approved SIP URI.', ensureActive);
      if (!destinationValue) return;
      const content = await ask(conversation, ctx, 'Optional transfer message, or type skip.', ensureActive);
      if (content === null) return;
      const confirmation = await ask(conversation, ctx, `Type TRANSFER VAPI CALL ${callId} to confirm the live transfer.`, ensureActive);
      if (confirmation !== `TRANSFER VAPI CALL ${callId}`) {
        await ctx.reply('Call transfer canceled.');
        return;
      }
      const destination = destinationType.toLowerCase() === 'number'
        ? { type: 'number', number: destinationValue }
        : { type: 'sip', sipUri: destinationValue };
      const result = await httpClient.post(ctx, `${apiBase()}/calls/${encodeURIComponent(callId)}/transfer`, {
        destination,
        ...(content.toLowerCase() === 'skip' ? {} : { content }),
      }, { timeout: 15000 });
      await ctx.reply(result?.data?.result?.accepted ? 'Vapi accepted the transfer request.' : 'Vapi transfer request completed.');
    }
  } catch (error) {
    if (error?.response?.status === 404) {
      await ctx.reply('Vapi call was not found in the local correlated call records.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Vapi operation failed.'));
  }
}

function registerVapiCommand(bot) {
  bot.command('vapi', async (ctx) => {
    const access = await getAccessProfile(ctx);
    if (!access?.isAdmin) {
      await ctx.reply('Vapi operations are available to administrators only.');
      return;
    }
    await renderVapiCenter(ctx);
  });
}

module.exports = {
  ACTIONS,
  buildVapiKeyboard,
  formatVapiCampaigns,
  formatVapiEvents,
  formatVapiPhoneNumbers,
  formatVapiMappingHealth,
  formatVapiEvals,
  formatVapiEvalRuns,
  formatVapiSquads,
  formatVapiSquadDetail,
  formatVapiStatus,
  registerVapiCommand,
  renderVapiCenter,
  vapiOperationFlow,
};
