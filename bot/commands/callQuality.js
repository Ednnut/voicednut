'use strict';

const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { escapeHtml } = require('../utils/ui');

async function handleCallQuality(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. CALL-E quality summaries are available to administrators.');
    return;
  }
  const localCallId = String(ctx.match || '').trim();
  if (!/^call_e_[0-9a-f-]{36}$/i.test(localCallId)) {
    await ctx.reply('Usage: /callquality <local_call_id>');
    return;
  }
  try {
    const actorId = String(ctx.from?.id || '').trim();
    const response = await httpClient.get(ctx,
      `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/calls/${encodeURIComponent(localCallId)}/quality`,
      { params: { actor_id: actorId }, timeout: 12000 });
    const quality = response?.data?.quality || {};
    const transcript = quality.transcript || {};
    const result = quality.structuredResult || {};
    const ivr = quality.ivr || {};
    const completeness = Number.isInteger(result.requiredFieldCompletenessPercent)
      ? `${result.requiredFieldCompletenessPercent}%`
      : 'not available';
    const text = [
      '<b>CALL-E conversation signals</b>',
      `Call: <code>${escapeHtml(localCallId)}</code> · ${escapeHtml(String(response?.data?.executionStatus || 'unknown'))}`,
      `Transcript: ${Number(transcript.turnCount) || 0} turns · ${escapeHtml(String(transcript.shape || 'unknown'))}`,
      `Structured result: ${escapeHtml(String(result.status || 'pending'))} · schema ${result.schemaValid === true ? 'valid' : result.schemaValid === false ? 'invalid' : 'not ready'} · required fields ${Number(result.presentRequiredFieldCount) || 0}/${Number(result.requiredFieldCount) || 0} (${completeness})`,
      `Possible IVR menu prompt: ${ivr.possibleMenuPromptDetected === true ? 'detected in transcript text' : 'not detected'}`,
      '<i>These are deterministic transcript/result signals, not a quality score. The menu signal is a transcript heuristic; keypad interaction status is unavailable. Transcript and result contents are not shown.</i>',
    ].join('\n');
    await ctx.reply(text, { parse_mode: 'HTML' });
  } catch (error) {
    if (error?.response?.status === 403 || error?.response?.status === 404) {
      await ctx.reply('❌ CALL-E call was not found in your current business operator scope.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to evaluate CALL-E conversation signals.'));
  }
}

function registerCallQualityCommand(bot) {
  bot.command('callquality', handleCallQuality);
}

module.exports = { handleCallQuality, registerCallQualityCommand };
