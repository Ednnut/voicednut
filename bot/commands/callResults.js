'use strict';

const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { escapeHtml } = require('../utils/ui');

async function handleCallResults(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E result summaries are available to administrators.');
    return;
  }
  const actorId = String(ctx.from?.id || '').trim();
  try {
    const response = await httpClient.get(ctx, `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/call-results`, {
      params: { actor_id: actorId, limit: 10, offset: 0 },
      timeout: 12000,
    });
    const rows = Array.isArray(response?.data?.rows) ? response.data.rows : [];
    const summary = response?.data?.summary || {};
    if (!rows.length) {
      await ctx.reply('<b>CALL-E results</b>\nNo recent calls are available in your operator scope.', { parse_mode: 'HTML' });
      return;
    }
    const lines = rows.map((row) => {
      const callId = escapeHtml(String(row.localCallId || 'unknown'));
      const execution = escapeHtml(String(row.executionStatus || 'unknown'));
      const outcome = row.callOutcome ? ` · ${escapeHtml(String(row.callOutcome))}` : '';
      const result = escapeHtml(String(row.resultStatus || 'pending'));
      const updatedAt = escapeHtml(String(row.updatedAt || row.createdAt || 'time unavailable'));
      return `• <code>${callId}</code> · ${execution}${outcome} · result ${result} · ${updatedAt}`;
    });
    await ctx.reply(
      `<b>CALL-E results</b> · ${Number(summary.resultsReady) || 0} ready · ${Number(summary.active) || 0} active · ${Number(summary.failed) || 0} failed\n\n${lines.join('\n')}\n\nStructured result values and transcripts are not shown here.`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('❌ You do not have current CALL-E operator membership.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load CALL-E result summaries.'));
  }
}

async function handleCallResult(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. Structured CALL-E results are available to administrators.');
    return;
  }
  if (ctx.chat?.type !== 'private') {
    await ctx.reply('Open a private chat with the bot to view structured CALL-E results.');
    return;
  }
  const localCallId = String(ctx.match || '').trim();
  if (!/^call_e_[0-9a-f-]{36}$/i.test(localCallId)) {
    await ctx.reply('Usage: /callresult <local_call_id>');
    return;
  }
  try {
    const response = await httpClient.get(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/calls/${encodeURIComponent(localCallId)}/result`,
      { params: { actor_id: String(ctx.from?.id || '') }, timeout: 15000 });
    const data = response?.data || {};
    if (data.resultOmittedForSize) {
      await ctx.reply('The validated result exceeds the display limit. Use the authorized API client to retrieve it.');
      return;
    }
    if (data.resultAvailable !== true) {
      await ctx.reply(`CALL-E result for ${localCallId}: ${String(data.resultStatus || 'pending')}. No result values are ready.`);
      return;
    }
    const serialized = JSON.stringify(data.result, null, 2);
    const displayed = serialized.length > 3000 ? `${serialized.slice(0, 3000)}\n… (truncated)` : serialized;
    await ctx.reply(
      `<b>Validated CALL-E result</b> · ${escapeHtml(String(data.resultStatus || 'available'))}\n<pre>${escapeHtml(displayed)}</pre>`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403 && error?.response?.data?.code === 'admin_token_required') {
      await ctx.reply('BOT API authentication failed. Check the server-side API credential configuration.');
      return;
    }
    if (error?.response?.status === 403 || error?.response?.status === 404) {
      await ctx.reply('CALL-E call not found in your current business-operator scope.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load the structured CALL-E result.'));
  }
}

async function handleCallReconcile(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E recovery reads are available to administrators.');
    return;
  }
  const localCallId = String(ctx.match || '').trim();
  if (!/^call_e_[0-9a-f-]{36}$/i.test(localCallId)) {
    await ctx.reply('Usage: /callreconcile <local_call_id>');
    return;
  }
  try {
    const response = await httpClient.post(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/calls/${encodeURIComponent(localCallId)}/operator-reconcile`,
      { actor_id: String(ctx.from?.id || '') },
      { timeout: 20000 });
    const result = response?.data?.result || {};
    await ctx.reply(
      `<b>CALL-E recovery read</b> · <code>${escapeHtml(localCallId)}</code>\n` +
      `Execution: ${escapeHtml(String(result.executionStatus || 'unknown'))} · outcome: ${escapeHtml(String(result.callOutcome || 'unknown'))}\n` +
      `Result: ${escapeHtml(String(result.resultStatus || 'unknown'))} · events read: ${Number(result.eventCount) || 0} across ${Number(result.eventPagesRead) || 0} pages` +
      `${result.eventsHaveMore === true ? ' · more events available; run again to continue reconciliation' : ''}\n` +
      'This refreshed provider state and durable event cursors. It did not initiate or cancel a call, and no transcript or phone number is displayed.',
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    if (error?.response?.status === 403 && error?.response?.data?.code === 'admin_token_required') {
      await ctx.reply('BOT API authentication failed. Check the server-side API credential configuration.');
      return;
    }
    if (error?.response?.status === 403 || error?.response?.status === 404) {
      await ctx.reply('CALL-E call not found in your current business-operator scope.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'CALL-E recovery reconciliation failed. No call was initiated.'));
  }
}

function registerCallResultsCommand(bot) {
  bot.command('callresults', handleCallResults);
  bot.command('callresult', handleCallResult);
  bot.command('callreconcile', handleCallReconcile);
}

module.exports = { handleCallResults, handleCallResult, handleCallReconcile, registerCallResultsCommand };
