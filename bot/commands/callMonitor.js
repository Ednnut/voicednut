'use strict';

const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { escapeHtml } = require('../utils/ui');

function maskPhoneNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `•••${digits.slice(-4)}` : 'unavailable';
}

function formatCallLines(calls = []) {
  return calls.slice(0, 5).map((call) => {
    const ref = escapeHtml(String(call.call_sid || 'unknown'));
    const status = escapeHtml(String(call.status || 'unknown'));
    const phone = escapeHtml(maskPhoneNumber(call.destination || call.phone_number));
    const provider = escapeHtml(String(call.telephony_provider || 'provider unavailable'));
    const engine = call.ai_voice_engine
      ? ` · AI ${escapeHtml(String(call.ai_voice_engine))}`
      : '';
    const errorCode = call.error_code
      ? ` · code <code>${escapeHtml(String(call.error_code).slice(0, 80))}</code>`
      : '';
    return `• <code>${ref}</code> · ${status} · ${phone} · ${provider}${engine}${errorCode}`;
  });
}

function formatVapiCallLines(events = []) {
  const latestByCall = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const callId = String(event?.provider_call_id || '').trim();
    if (callId && !latestByCall.has(callId)) latestByCall.set(callId, event);
  }
  return [...latestByCall.entries()].slice(0, 3).map(([callId, event]) => {
    const status = escapeHtml(String(event.provider_status || event.event_type || 'unknown').slice(0, 40));
    const eventType = event.event_type
      ? ` · ${escapeHtml(String(event.event_type).slice(0, 40))}`
      : '';
    const reason = event.ended_reason
      ? ` · ${escapeHtml(String(event.ended_reason).slice(0, 60))}`
      : '';
    const timestamp = event.event_timestamp || event.received_at;
    const time = timestamp ? ` · ${escapeHtml(String(timestamp).slice(0, 40))}` : '';
    const duration = event.duration_seconds !== null
      && event.duration_seconds !== undefined
      && Number.isFinite(Number(event.duration_seconds))
      ? ` · ${Math.max(0, Math.floor(Number(event.duration_seconds)))}s`
      : '';
    return `• <code>${escapeHtml(callId.slice(0, 60))}</code> · ${status}${eventType}${reason}${duration}${time}`;
  });
}

function formatCartesiaCallLines(calls = []) {
  return (Array.isArray(calls) ? calls : []).slice(0, 5).map((call) => {
    const id = escapeHtml(String(call?.callId || 'unknown').slice(0, 60));
    const status = escapeHtml(String(call?.status || 'unknown').slice(0, 40));
    const destination = escapeHtml(String(call?.to || 'number unavailable').slice(0, 20));
    const agent = escapeHtml(String(call?.agentName || 'Cartesia agent').slice(0, 60));
    const time = call?.startTime ? ` · ${escapeHtml(String(call.startTime).slice(0, 40))}` : '';
    return `• <code>${id}</code> · ${status} · ${destination} · ${agent}${time}`;
  });
}

function formatCallELines(rows = []) {
  return (Array.isArray(rows) ? rows : []).slice(0, 3).map((call) => {
    const callId = escapeHtml(String(call?.localCallId || 'unknown').slice(0, 60));
    const status = escapeHtml(String(call?.executionStatus || 'unknown').slice(0, 40));
    const outcome = call?.callOutcome
      ? ` · outcome ${escapeHtml(String(call.callOutcome).slice(0, 40))}`
      : '';
    const result = call?.resultStatus
      ? ` · result ${escapeHtml(String(call.resultStatus).slice(0, 40))}`
      : '';
    const errorCode = call?.errorCode
      ? ` · code <code>${escapeHtml(String(call.errorCode).slice(0, 40))}</code>`
      : '';
    const timestamp = call?.updatedAt
      ? ` · ${escapeHtml(String(call.updatedAt).slice(0, 40))}`
      : '';
    return `• <code>${callId}</code> · ${status}${outcome}${result}${errorCode}${timestamp}`;
  });
}

function formatUnifiedCallLines(calls = []) {
  return (Array.isArray(calls) ? calls : []).slice(0, 10).map((call) => {
    const id = escapeHtml(String(call.call_sid || call.provider_call_id || 'unknown').slice(0, 60));
    const status = escapeHtml(String(call.status || 'unknown').slice(0, 40));
    const provider = escapeHtml(String(call.telephony_provider || 'unknown').slice(0, 40));
    const destination = escapeHtml(maskPhoneNumber(call.destination));
    const when = call.created_at ? ` · ${escapeHtml(String(call.created_at).slice(0, 40))}` : '';
    return `• <code>${id}</code> · ${provider} · ${status} · ${destination}${when}`;
  });
}

function formatTelephonyReadiness(status = {}) {
  const call = status.providers?.call || {};
  const provider = String(call.provider || status.provider || '').trim().toLowerCase();
  if (!provider) return ['Telephony configuration readiness: unavailable'];

  const readiness = call.readiness || {};
  const ready = readiness[provider];
  const label = ready === true ? 'ready' : ready === false ? 'not ready' : 'unknown';
  const supported = Array.isArray(call.supported_providers)
    ? call.supported_providers
    : Array.isArray(status.supported_providers) ? status.supported_providers : [];
  const lines = [`Telephony configuration readiness: ${escapeHtml(provider.toUpperCase())} ${label}`];
  const providerHealth = status.provider_health?.[provider];
  if (providerHealth?.degraded === true || providerHealth?.circuit_state === 'open') {
    lines.push('⚠️ Provider health alert: degraded/circuit-open; verify status before dispatch.');
  }
  if (supported.length) {
    const readinessLines = supported.slice(0, 8).map((item) => {
      const name = String(item).trim().toLowerCase();
      const providerReady = readiness[name];
      const providerLabel = providerReady === true ? 'ready' : providerReady === false ? 'not ready' : 'unknown';
      return `${escapeHtml(name.toUpperCase())} ${providerLabel}`;
    });
    lines.push(`Provider configuration: ${readinessLines.join(' · ')}`);
  }
  return lines;
}

function formatUnknownSubmissionLines(calls = []) {
  return (Array.isArray(calls) ? calls : []).slice(0, 5).map((call) => {
    const callId = escapeHtml(String(call?.call_sid || 'unknown').slice(0, 80));
    const status = escapeHtml(String(call?.status || 'unknown').slice(0, 40));
    const destination = escapeHtml(maskPhoneNumber(call?.destination || call?.phone_number));
    const provider = escapeHtml(String(call?.telephony_provider || 'provider unavailable').slice(0, 40));
    const providerCallId = call?.provider_call_id
      ? ` · provider call <code>${escapeHtml(String(call.provider_call_id).slice(0, 80))}</code>`
      : '';
    const lastEvent = call?.last_event_at
      ? ` · last event ${escapeHtml(String(call.last_event_at).slice(0, 40))}`
      : '';
    return `• <code>${callId}</code> · ${status} · ${destination} · ${provider}${providerCallId}${lastEvent}`;
  });
}

async function handleCallMonitor(ctx) {
  const access = await getAccessProfile(ctx);
  if (!access?.isAdmin) {
    await ctx.reply('❌ Access denied. Call operations monitoring is available to administrators.');
    return;
  }

  try {
    const apiBase = config.apiUrl.replace(/\/+$/, '');
    const actorId = String(ctx?.from?.id || '').trim();
    const requests = [
      httpClient.get(ctx, `${apiBase}/api/calls/operations`, { timeout: 12000 }),
      httpClient.get(ctx, `${apiBase}/admin/provider`, {
        timeout: 8000,
        retry: { retries: 0 },
      }),
      httpClient.get(ctx, `${apiBase}/api/vapi/call-events`, {
        params: { limit: 100 },
        timeout: 8000,
        retry: { retries: 0 },
      }),
      /^\d{1,20}$/.test(actorId)
        ? httpClient.get(ctx, `${apiBase}/api/call-e/call-results`, {
          params: { actor_id: actorId, limit: 5 },
          timeout: 8000,
          retry: { retries: 0 },
        })
        : Promise.resolve(null),
      /^\d{1,20}$/.test(actorId) && config.defaultBusinessId
        ? (async () => {
          const businessId = String(config.defaultBusinessId).trim();
          const defaults = await httpClient.get(ctx, `${apiBase}/api/cartesia/provider-defaults`, {
            params: { business_id: businessId }, timeout: 8000, retry: { retries: 0 },
          });
          const profile = defaults?.data?.profile || {};
          if (!profile.agent_id) return { data: { calls: [] } };
          return httpClient.get(ctx, `${apiBase}/api/cartesia/calls`, {
            params: { business_id: businessId, agent_id: profile.agent_id, limit: 5 },
            timeout: 12000, retry: { retries: 0 },
          });
        })()
        : Promise.resolve(null),
    ];
    const [operationsResult, providerResult, vapiResult, callEResult, cartesiaResult] = await Promise.allSettled(requests);
    if (operationsResult.status !== 'fulfilled') throw operationsResult.reason;
    const data = operationsResult.value?.data || {};
    const active = Array.isArray(data.active_calls) ? data.active_calls : [];
    const stale = Array.isArray(data.stale_calls) ? data.stale_calls : [];
    const failures = Array.isArray(data.recent_failures) ? data.recent_failures : [];
    const unknownSubmissions = Array.isArray(data.unknown_submissions) ? data.unknown_submissions : [];
    const counts = data.counts || {};
    const delivery = data.notification_delivery || {};
    const providerCounts = Object.entries(data.active_by_provider || {})
      .map(([provider, count]) => `${escapeHtml(provider)} ${Number(count) || 0}`)
      .join(' · ') || 'none';
    const lines = [
      '<b>Call Operations</b>',
      `Active: <b>${Number(counts.active) || 0}</b> · Stale (&gt;5m): <b>${Number(counts.stale) || 0}</b> · Recent failures (24h): <b>${Number(counts.recent_failures) || 0}</b>`,
      `Unknown submissions requiring reconciliation: <b>${Number(counts.unknown_submissions) || 0}</b>`,
      `Active by telephony provider: ${providerCounts}`,
      `Telegram notifications: ${Number(delivery.pending) || 0} pending · ${Number(delivery.retrying) || 0} retrying · ${Number(delivery.failed) || 0} failed`,
      `Webhook processing errors (24h): ${Number(data.webhook_processing_errors_24h?.count) || 0}`,
    ];
    lines.push('', '<b>Telephony provider</b>');
    if (providerResult.status === 'fulfilled') {
      lines.push(...formatTelephonyReadiness(providerResult.value?.data || {}));
    } else {
      lines.push('Telephony configuration readiness temporarily unavailable.');
    }
    if (active.length) lines.push('', '<b>Active calls</b>', ...formatCallLines(active));
    if (stale.length) lines.push('', '<b>Stale calls</b>', ...formatCallLines(stale));
    if (unknownSubmissions.length) {
      lines.push(
        '',
        '<b>Unknown submissions</b>',
        ...formatUnknownSubmissionLines(unknownSubmissions),
        '⚠️ This dashboard does not perform provider lookups or retries. Verify state directly with the provider before any retry.',
      );
    }
    if (failures.length) {
      lines.push('', '<b>Recent failures</b>', ...formatCallLines(failures));
    }
    lines.push('', '<b>Recent outbound calls · all providers</b>');
    const unifiedCalls = Array.isArray(data.recent_provider_calls) ? data.recent_provider_calls : [];
    lines.push(...(unifiedCalls.length ? formatUnifiedCallLines(unifiedCalls) : ['• No recent outbound calls found.']));
    if (data.webhook_processing_errors_24h?.latest_at) {
      lines.push(`Latest webhook processing error: ${escapeHtml(String(data.webhook_processing_errors_24h.latest_at))}`);
    }
    lines.push('', '<b>Vapi activity</b>');
    if (vapiResult.status === 'fulfilled') {
      const vapiLines = formatVapiCallLines(vapiResult.value?.data?.events);
      lines.push(...(vapiLines.length ? vapiLines : ['• No recent Vapi call events recorded.']));
    } else {
      lines.push('• Vapi activity temporarily unavailable.');
    }
    lines.push('', '<b>Cartesia Managed Agent activity</b>');
    if (cartesiaResult.status === 'fulfilled') {
      const cartesiaLines = formatCartesiaCallLines(cartesiaResult.value?.data?.calls);
      lines.push(...(cartesiaLines.length ? cartesiaLines : ['• No recent Cartesia Managed Agent calls found.']));
    } else if (!config.defaultBusinessId) {
      lines.push('• Set DEFAULT_BUSINESS_ID to include Cartesia calls in this monitor.');
    } else if (cartesiaResult.reason?.response?.status === 403) {
      lines.push('• This administrator has no Cartesia call-operator scope for the default business.');
    } else {
      lines.push('• Cartesia call history is unavailable for this business.');
    }
    lines.push('', '<b>CALL-E activity (operator-scoped)</b>');
    if (!/^\d{1,20}$/.test(actorId)) {
      lines.push('• Telegram actor context is unavailable.');
    } else if (callEResult.status === 'rejected' && callEResult.reason?.response?.status === 403) {
      lines.push('• No CALL-E operator scope for this administrator.');
    } else if (callEResult.status === 'fulfilled') {
      const callELines = formatCallELines(callEResult.value?.data?.rows);
      lines.push(...(callELines.length ? callELines : ['• No recent CALL-E calls in this operator scope.']));
    } else {
      lines.push('• CALL-E activity temporarily unavailable.');
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(httpClient.getUserMessage(error, 'Unable to load call operations monitoring.'));
  }
}

function registerCallMonitorCommand(bot) {
  bot.command('callmonitor', handleCallMonitor);
}

module.exports = {
  handleCallMonitor,
  registerCallMonitorCommand,
  maskPhoneNumber,
  formatCallLines,
  formatVapiCallLines,
  formatCartesiaCallLines,
  formatCallELines,
  formatUnifiedCallLines,
  formatUnknownSubmissionLines,
  formatTelephonyReadiness,
};
