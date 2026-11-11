'use strict';

const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { escapeHtml } = require('../utils/ui');

const RUN_STATUSES = new Set([
  'queued',
  'running',
  'waiting',
  'waiting_approval',
  'completed',
  'failed',
  'canceled',
  'needs_review',
]);
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const MAX_RUNS = 8;
const MAX_STEPS = 8;

function safeText(value, fallback = 'unknown', maxLength = 100) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().slice(0, maxLength);
}

function safeErrorCode(value) {
  const code = safeText(value, '', 40).toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,39}$/.test(code) ? code : '';
}

function safeStepStatus(value) {
  const status = safeText(value, 'unknown', 20).toLowerCase();
  return /^[a-z][a-z0-9_-]{0,19}$/.test(status) ? status : 'unknown';
}

function formatRunStatusCounts(runs) {
  const counts = new Map();
  runs.forEach((run) => {
    const rawStatus = safeText(run?.status, 'unknown', 40).toLowerCase();
    const status = RUN_STATUSES.has(rawStatus) ? rawStatus : 'unknown';
    counts.set(status, (counts.get(status) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([status, count]) => `${escapeHtml(status)} ${count}`)
    .join(' · ');
}

async function handleWorkflowRuns(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('Access denied. Workflow run status is available to administrators only.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the bot to view workflow run status.');
    return;
  }

  const status = String(ctx.match || '').trim().toLowerCase();
  if (status && !RUN_STATUSES.has(status)) {
    await ctx.reply(`Invalid status. Use one of: ${[...RUN_STATUSES].join(', ')}.`);
    return;
  }

  try {
    const response = await httpClient.get(
      ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/post-call/workflows/runs`,
      { params: { limit: MAX_RUNS, status: status || undefined }, timeout: 12000 },
    );
    if (!Array.isArray(response?.data?.runs)) {
      throw new Error('Workflow run response was invalid.');
    }

    const runs = response.data.runs.slice(0, MAX_RUNS);
    if (!runs.length) {
      await ctx.reply(status
        ? `No workflow runs found with status ${escapeHtml(status)}.`
        : 'No workflow runs were returned.');
      return;
    }

    const lines = runs.map((run) => {
      const runId = escapeHtml(safeText(run?.run_id, 'unknown', 120));
      const workflowId = escapeHtml(safeText(run?.workflow_id, 'unknown', 32));
      const rawStatus = safeText(run?.status, 'unknown', 40).toLowerCase();
      const runStatus = escapeHtml(RUN_STATUSES.has(rawStatus) ? rawStatus : 'unknown');
      const errorCode = safeErrorCode(run?.error_code);
      const blocker = errorCode ? ` · ${escapeHtml(errorCode)}` : '';
      return `• <code>${runId}</code> · ${workflowId} · ${runStatus}${blocker}`;
    });

    await ctx.reply(
      `<b>Post-call workflow runs</b> · latest ${runs.length}${status ? ` · ${escapeHtml(status)}` : ''}\n` +
      `${formatRunStatusCounts(runs)}\n\n${lines.join('\n')}\n\n` +
      'Status only; trigger payloads and action results are not displayed.',
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('Workflow status access was denied by the API.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load workflow run status.'));
  }
}

async function handleWorkflowRun(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('Access denied. Workflow run details are available to administrators only.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the bot to view workflow run details.');
    return;
  }

  const runId = String(ctx.match || '').trim();
  if (!RUN_ID_PATTERN.test(runId)) {
    await ctx.reply('Usage: /workflowrun <run_id>');
    return;
  }

  try {
    const response = await httpClient.get(
      ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/post-call/workflows/runs/${encodeURIComponent(runId)}`,
      { timeout: 12000 },
    );
    const run = response?.data?.run;
    if (!run || typeof run !== 'object' || Array.isArray(run)) {
      throw new Error('Workflow run response was invalid.');
    }

    const steps = Array.isArray(run.steps) ? run.steps.slice(0, MAX_STEPS) : [];
    const stepLines = steps.map((step) => {
      const stepId = escapeHtml(safeText(step?.step_id, 'unnamed step', 24));
      const stepType = escapeHtml(safeText(step?.step_type, 'unknown', 24));
      const stepStatus = escapeHtml(safeStepStatus(step?.status));
      const errorCode = safeErrorCode(step?.error_code);
      const error = errorCode ? ` · ${escapeHtml(errorCode)}` : '';
      return `• ${stepId} · ${stepType} · ${stepStatus}${error}`;
    });
    const runError = safeErrorCode(run.error_code);
    await ctx.reply(
      `<b>Post-call workflow run</b>\n` +
      `Run: <code>${escapeHtml(runId)}</code>\n` +
      `Workflow: ${escapeHtml(safeText(run.workflow_id, 'unknown', 120))} · v${Number.isSafeInteger(run.workflow_version) ? run.workflow_version : 'unknown'}\n` +
      `Status: ${escapeHtml(safeText(run.status, 'unknown', 40))}\n` +
      `Current step: ${escapeHtml(safeText(run.current_step_id, 'none', 24))}` +
      `${runError ? ` · ${escapeHtml(runError)}` : ''}\n` +
      `Step audit:\n${stepLines.length ? stepLines.join('\n') : '• No step audit available'}` +
      `${steps.length === MAX_STEPS ? '\n(Showing at most 8 steps.)' : ''}\n\n` +
      'Stored trigger payloads and action result contents are not displayed.',
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 404) {
      await ctx.reply('Workflow run was not found.');
      return;
    }
    if (error?.response?.status === 403) {
      await ctx.reply('Workflow run access was denied by the API.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load workflow run details.'));
  }
}

function registerPostCallWorkflowCommands(bot) {
  bot.command('workflowruns', handleWorkflowRuns);
  bot.command('workflowrun', handleWorkflowRun);
}

module.exports = {
  handleWorkflowRuns,
  handleWorkflowRun,
  registerPostCallWorkflowCommands,
};
