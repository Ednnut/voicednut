const config = require('../config');
const httpClient = require('../utils/httpClient');
const { InlineKeyboard } = require('grammy');
const { startOperation, ensureOperationActive, registerAbortController } = require('../utils/sessionState');
const {
    renderMenu,
    escapeMarkdown,
    buildLine,
    section,
    sendEphemeral,
    buildBackToMenuKeyboard,
    cancelledMessage,
    setupStepMessage
} = require('../utils/ui');
const { buildCallbackData } = require('../utils/actions');
const { getAccessProfile } = require('../utils/capabilities');

const CANCEL_KEYWORDS = new Set(['cancel', 'exit', 'quit']);

function isCancelInput(value) {
    return CANCEL_KEYWORDS.has(String(value || '').trim().toLowerCase());
}

function parseRecentFilter(input = '') {
    const trimmed = String(input || '').trim();
    if (!trimmed) return null;
    if (/^date:/i.test(trimmed)) {
        const match = trimmed.match(/^date:(\d{4}-\d{2}-\d{2})$/i);
        if (!match) return { invalid: true };
        const date = match[1];
        const parsed = new Date(`${date}T00:00:00.000Z`);
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
            return { invalid: true };
        }
        return { date_from: date, date_to: date };
    }
    const looksLikePhone = /^[+\d\s().-]+$/.test(trimmed);
    if (looksLikePhone) {
        return { phone: trimmed };
    }
    return { status: trimmed };
}

function maskPhoneNumber(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits ? `•••${digits.slice(-4)}` : 'N/A';
}

function formatCallTimeline(states = [], call = {}) {
    const orderedStates = states
        .filter((state) => state && typeof state === 'object')
        .slice()
        .sort((left, right) => {
            const leftSequence = Number(left.sequence_number);
            const rightSequence = Number(right.sequence_number);
            if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence)) {
                return leftSequence - rightSequence;
            }
            return Date.parse(left.timestamp || '') - Date.parse(right.timestamp || '');
        })
        .slice(-8);
    const lines = [
        buildLine('☎️', 'Telephony', escapeMarkdown(call.telephony_provider || call.provider || 'Unavailable')),
        ...(call.provider_call_id
            ? [buildLine('🔗', 'Provider call ID', escapeMarkdown(String(call.provider_call_id).slice(0, 120)))]
            : []),
        ...orderedStates.map((state) => {
            const stateName = String(state.state || 'event').slice(0, 80);
            const when = state.timestamp && Number.isFinite(Date.parse(state.timestamp))
                ? new Date(state.timestamp).toLocaleString()
                : 'unknown time';
            const eventStatus =
                state.data && typeof state.data === 'object' && typeof state.data.status === 'string'
                    ? ` · ${state.data.status.slice(0, 40)}`
                    : '';
            return `• ${escapeMarkdown(stateName + eventStatus)} — ${escapeMarkdown(when)}`;
        }),
    ];
    if (String(call.status || '').toLowerCase() === 'unknown') {
        lines.push('⚠️ Submission outcome is unknown. Reconcile or verify provider state before any retry.');
    }
    return section('🧾 Call Timeline', lines);
}

async function fetchRecentCalls(ctx, ensureActive, { limit = 10, filter } = {}) {
    const filterParams = parseRecentFilter(filter);
    const params = { limit };
    if (filterParams?.status) params.status = filterParams.status;
    if (filterParams?.phone) params.q = filterParams.phone;
    if (filterParams?.date_from) params.date = filterParams.date_from;
    const res = await guardedGet(ctx, ensureActive, `${config.apiUrl}/api/calls/activity`, { params });
    return { calls: res.data?.calls || [], filtered: Boolean(filterParams) };
}

async function guardedGet(ctx, ensureActive, url, options = {}) {
    const controller = new AbortController();
    const release = registerAbortController(ctx, controller);
    try {
        const response = await httpClient.get(null, url, {
            timeout: 12000,
            signal: controller.signal,
            headers: ctx.from?.id
                ? { 'x-telegram-chat-id': String(ctx.from.id) }
                : {},
            ...options
        });
        if (typeof ensureActive === 'function') {
            ensureActive();
        }
        return response;
    } finally {
        release();
    }
}

async function guardedPost(ctx, ensureActive, url, data = {}, options = {}) {
    const controller = new AbortController();
    const release = registerAbortController(ctx, controller);
    try {
        const response = await httpClient.post(null, url, data, {
            timeout: 15000,
            signal: controller.signal,
            headers: ctx.from?.id ? { 'x-telegram-chat-id': String(ctx.from.id) } : {},
            ...options,
        });
        if (typeof ensureActive === 'function') ensureActive();
        return response;
    } finally {
        release();
    }
}

function buildCallActivityListKeyboard(ctx, calls = []) {
    const keyboard = new InlineKeyboard();
    calls.slice(0, 10).forEach((call, index) => {
        const provider = String(call.provider || 'call').toUpperCase();
        const lastFour = String(call.phone_number || '').replace(/\D/g, '').slice(-4) || '????';
        keyboard.text(`${index + 1}. ${provider} · ••••${lastFour} · ${String(call.status || 'unknown').slice(0, 16)}`, buildCallbackData(ctx, `CALLLOG_ITEM:${index}`)).row();
    });
    keyboard.text('⬅️ Call Log', buildCallbackData(ctx, 'CALLLOG'));
    return keyboard;
}

function buildCallActivityDetailKeyboard(ctx, refreshAvailable = true, reconcileAvailable = false) {
    const keyboard = new InlineKeyboard();
    if (reconcileAvailable) keyboard.text('🧭 Reconcile outcome', buildCallbackData(ctx, 'CALLLOG_RECONCILE')).row();
    if (refreshAvailable) keyboard.text('🔄 Refresh status', buildCallbackData(ctx, 'CALLLOG_REFRESH')).row();
    keyboard.text('⬅️ Recent calls', buildCallbackData(ctx, 'CALLLOG_RECENT'));
    return keyboard;
}

async function renderCallActivityDetail(ctx, callSid, { refresh = false, reconcile = false, ensureActive } = {}) {
    const url = `${config.apiUrl}/api/calls/activity/${encodeURIComponent(callSid)}`;
    const response = refresh || reconcile
        ? await guardedPost(ctx, ensureActive, `${url}/${reconcile ? 'reconcile' : 'refresh'}`)
        : await guardedGet(ctx, ensureActive, url);
    const payload = response.data || {};
    const call = payload.call || {};
    const lines = [
        buildLine('🆔', 'Call', escapeMarkdown(call.call_sid || callSid)),
        buildLine('📞', 'Destination', escapeMarkdown(maskPhoneNumber(call.phone_number))),
        buildLine('☎️', 'Provider', escapeMarkdown(call.provider || 'unknown')),
        ...(call.provider_call_id ? [buildLine('🔗', 'Provider call ID', escapeMarkdown(String(call.provider_call_id).slice(0, 120)))] : []),
        ...(call.ai_voice_engine ? [buildLine('🎙️', 'AI voice engine', escapeMarkdown(call.ai_voice_engine))] : []),
        buildLine('📊', 'Status', escapeMarkdown(call.status || 'unknown')),
        buildLine('🕒', 'Created', escapeMarkdown(call.created_at ? new Date(call.created_at).toLocaleString() : 'N/A')),
        ...(payload.status_source ? [buildLine('🔎', 'Updated from', escapeMarkdown(payload.status_source.replace(/_/g, ' ')))] : []),
        ...(payload.reconciliation?.outcome === 'unresolved'
            ? [buildLine('⚠️', 'Reconciliation', 'Still unresolved; verify directly with the provider before retrying.')]
            : []),
    ];
    const states = Array.isArray(payload.lifecycle_events) && payload.lifecycle_events.length
        ? payload.lifecycle_events.map((event) => ({
            state: event.event_type,
            timestamp: event.occurred_at,
            data: {
                status: event.status,
                provider_status: event.provider_status,
            },
        }))
        : payload.recent_states || [];
    if (states.length) {
        lines.push('', '*Recent events*');
        for (const state of states.slice(-8)) {
            const when = state.timestamp && Number.isFinite(Date.parse(state.timestamp)) ? new Date(state.timestamp).toLocaleString() : 'unknown time';
            const status = state.data?.provider_status || state.data?.status;
            lines.push(`• ${escapeMarkdown(String(state.state || 'event').slice(0, 60))}${status ? ` · ${escapeMarkdown(String(status).slice(0, 30))}` : ''} — ${escapeMarkdown(when)}`);
        }
    }
    lines.push('', '⚠️ Status checks never enable a retry. Confirm the provider outcome before placing another call.');
    if (call.refresh_available === false) lines.push('No provider call ID is recorded. Searching by destination or time could match another call, so this call remains unresolved until it can be verified with the provider.');
    await ctx.reply(section('📄 Call Activity', lines), {
        parse_mode: 'Markdown',
        reply_markup: buildCallActivityDetailKeyboard(ctx, call.refresh_available !== false,
            ['unknown', 'submission_pending', 'submission-pending'].includes(String(call.status || '').toLowerCase())),
    });
}

async function handleCallActivityAction(ctx, action) {
    const match = String(action || '').match(/^CALLLOG_ITEM:(\d{1,2})$/);
    if (match) {
        const index = Number(match[1]);
        const callSid = ctx.session?.callActivityIds?.[index];
        if (!callSid) return ctx.reply('This call list has expired. Open /calllog and choose Recent Calls again.');
        ctx.session.callActivitySelected = callSid;
        return renderCallActivityDetail(ctx, callSid);
    }
    if (action === 'CALLLOG_REFRESH') {
        const callSid = ctx.session?.callActivitySelected;
        if (!callSid) return ctx.reply('Select a call first from Recent Calls.');
        return renderCallActivityDetail(ctx, callSid, { refresh: true });
    }
    if (action === 'CALLLOG_RECONCILE') {
        const callSid = ctx.session?.callActivitySelected;
        if (!callSid) return ctx.reply('Select a call first from Recent Calls.');
        if (!ctx.session) return ctx.reply('This call activity session has expired. Open /calllog and select the call again.');
        if (ctx.session?.callActivityReconcilePending) return ctx.reply('Reconciliation is already in progress for this session.');
        ctx.session.callActivityReconcilePending = true;
        try {
            return await renderCallActivityDetail(ctx, callSid, { reconcile: true });
        } catch (error) {
            const status = Number(error?.response?.status || error?.status);
            if (status === 409 || error?.code === 'provider_call_id_missing') {
                return ctx.reply('The call is still unresolved because no provider call ID is recorded. Verify directly with the provider before retrying.');
            }
            throw error;
        } finally {
            ctx.session.callActivityReconcilePending = false;
        }
    }
    return false;
}

function buildCalllogMenuKeyboard(ctx) {
    return new InlineKeyboard()
        .text('🕒 Activity Center', buildCallbackData(ctx, 'CALLLOG_RECENT'))
        .text('🔍 Search', buildCallbackData(ctx, 'CALLLOG_SEARCH'))
        .row()
        .text('⬅️ Main Menu', buildCallbackData(ctx, 'MENU'));
}

function buildCalllogLimitedKeyboard(ctx) {
    const adminUsername = (config.admin.username || '').replace(/^@/, '');
    const keyboard = new InlineKeyboard()
        .text('ℹ️ Help', buildCallbackData(ctx, 'HELP'))
        .text('⬅️ Main Menu', buildCallbackData(ctx, 'MENU'));
    if (adminUsername) {
        keyboard.row().url('📱 Request Access', `https://t.me/${adminUsername}`);
    }
    return keyboard;
}

function buildCalllogResultKeyboard(ctx) {
    return buildBackToMenuKeyboard(ctx, {
        backAction: 'CALLLOG',
        backLabel: '⬅️ Back to Call Log'
    });
}

async function replyCalllogUnauthorized(ctx) {
    await ctx.reply('❌ Access denied. Your account is not authorized for this action.', {
        reply_markup: buildCalllogResultKeyboard(ctx)
    });
}

async function renderCalllogMenu(ctx) {
    const access = await getAccessProfile(ctx);
    const isAuthorized = Boolean(access.isAuthorized);
    startOperation(ctx, 'calllog-menu');
    const keyboard = isAuthorized
        ? buildCalllogMenuKeyboard(ctx)
        : buildCalllogLimitedKeyboard(ctx);
    const title = isAuthorized ? '📜 *Call Log*' : '🔒 *Call Log (Access limited)*';
    const lines = [
        isAuthorized ? 'Browse recent calls, open a call for its timeline, or refresh provider status.' : 'Call log actions require approved account access.',
        isAuthorized ? 'Search by phone, call ID, status, or date.' : 'Use the Request Access button to unlock call history tools.',
        isAuthorized ? 'Authorized access enabled.' : 'Limited access mode is active.'
    ].filter(Boolean);
    await renderMenu(ctx, `${title}\n${lines.join('\n')}`, keyboard, { parseMode: 'Markdown' });
}

async function calllogRecentFlow(conversation, ctx) {
    const opId = startOperation(ctx, 'calllog-recent');
    const ensureActive = () => ensureOperationActive(ctx, opId);
    try {
        const access = await getAccessProfile(ctx);
        ensureActive();
        if (!access.isAuthorized) {
            await replyCalllogUnauthorized(ctx);
            return;
        }

        await ctx.reply(setupStepMessage('Call Log - Recent Calls', [
            'Enter a limit (max 30) and an optional status, phone, or exact date filter.',
            'Examples: `15 completed`, `20 +1234567890`, or `10 date:2026-11-14`.',
            'Type `cancel` to stop.'
        ]), {
            parse_mode: 'Markdown'
        });
        const update = await conversation.wait();
        ensureActive();
        const raw = update?.message?.text?.trim() || '';
        if (isCancelInput(raw)) {
            await ctx.reply(cancelledMessage('Call log lookup', 'Use /calllog to run another query.'), {
                parse_mode: 'Markdown',
                reply_markup: buildCalllogResultKeyboard(ctx)
            });
            return;
        }
        const parts = raw.split(/\s+/).filter(Boolean);
        const parsedLimit = parseInt(parts[0], 10);
        const limit = Number.isFinite(parsedLimit)
            ? Math.max(1, Math.min(parsedLimit, 30))
            : 10;
        const filter = parts.slice(1).join(' ');
        if (parseRecentFilter(filter)?.invalid) {
            await ctx.reply('❌ Use an exact valid date in `date:YYYY-MM-DD` format.', {
                reply_markup: buildCalllogResultKeyboard(ctx)
            });
            return;
        }

        const { calls, filtered } = await fetchRecentCalls(ctx, ensureActive, { limit, filter });
        if (!calls.length) {
            await ctx.reply('ℹ️ No recent calls found.', {
                reply_markup: buildCalllogResultKeyboard(ctx)
            });
            return;
        }

        ctx.session.callActivityIds = calls.slice(0, 10).map((call) => String(call.call_sid || '')).filter(Boolean);
        const lines = calls.map((call, index) => {
            const status = call.status || 'unknown';
            const when = new Date(call.created_at).toLocaleString();
            const duration = call.duration ? `${Math.floor(call.duration / 60)}:${String(call.duration % 60).padStart(2, '0')}` : 'N/A';
            return [
                `• ${index + 1}. ${escapeMarkdown(call.provider || 'call')} (${escapeMarkdown(status)})`,
                `📞 ${escapeMarkdown(maskPhoneNumber(call.phone_number))}`,
                `☎️ ${escapeMarkdown(call.telephony_provider || call.provider || 'Provider unavailable')}` +
                    (call.ai_voice_engine ? ` · 🎙️ ${escapeMarkdown(call.ai_voice_engine)}` : ''),
                `⏱️ ${duration} | 🕒 ${escapeMarkdown(when)}`
            ].join('\n');
        });

        const header = filter && !filtered
            ? 'ℹ️ Filter unavailable on this API; showing latest calls.\n\n'
            : '';
        await ctx.reply(`${header}${lines.join('\n\n')}`, {
            parse_mode: 'Markdown',
            reply_markup: buildCallActivityListKeyboard(ctx, calls)
        });
    } catch (error) {
        await ctx.reply(httpClient.getUserMessage(error, 'Failed to fetch recent calls.'), {
            reply_markup: buildCalllogResultKeyboard(ctx)
        });
    }
}

async function calllogSearchFlow(conversation, ctx) {
    const opId = startOperation(ctx, 'calllog-search');
    const ensureActive = () => ensureOperationActive(ctx, opId);
    try {
        const access = await getAccessProfile(ctx);
        ensureActive();
        if (!access.isAuthorized) {
            await replyCalllogUnauthorized(ctx);
            return;
        }
        await ctx.reply(setupStepMessage('Call Log - Search', [
            'Enter a search term (phone number, call SID, or status).',
            'Type `cancel` to stop.'
        ]), {
            parse_mode: 'Markdown'
        });
        const update = await conversation.wait();
        ensureActive();
        const query = update?.message?.text?.trim();
        if (isCancelInput(query)) {
            await ctx.reply(cancelledMessage('Call log search', 'Use /calllog to run another search.'), {
                parse_mode: 'Markdown',
                reply_markup: buildCalllogResultKeyboard(ctx)
            });
            return;
        }
        if (!query || query.length < 2) {
            await ctx.reply('❌ Please provide at least 2 characters.');
            return;
        }

        await sendEphemeral(ctx, '🔍 Searching call log…');
        const res = await guardedGet(ctx, ensureActive, `${config.apiUrl}/api/calls/activity`, {
            params: { q: query, limit: 10 },
        });
        const results = res.data?.calls || [];
        if (!results.length) {
            await ctx.reply('ℹ️ No matches found.', {
                reply_markup: buildCalllogResultKeyboard(ctx)
            });
            return;
        }

        ctx.session.callActivityIds = results.slice(0, 10).map((call) => String(call.call_sid || '')).filter(Boolean);
        const lines = results.slice(0, 5).map((c) => {
            const status = c.status || 'unknown';
            const when = new Date(c.created_at).toLocaleString();
            return `• ${escapeMarkdown(c.provider || 'call')} (${escapeMarkdown(status)})\n📞 ${escapeMarkdown(c.phone_number || 'N/A')}\n🕒 ${escapeMarkdown(when)}`;
        });
        await ctx.reply(lines.join('\n\n'), {
            parse_mode: 'Markdown',
            reply_markup: buildCallActivityListKeyboard(ctx, results)
        });
    } catch (error) {
        await ctx.reply(httpClient.getUserMessage(error, 'Search failed. Please try again later.'), {
            reply_markup: buildCalllogResultKeyboard(ctx)
        });
    }
}

async function calllogDetailsFlow(conversation, ctx) {
    const opId = startOperation(ctx, 'calllog-details');
    const ensureActive = () => ensureOperationActive(ctx, opId);
    try {
        const access = await getAccessProfile(ctx);
        ensureActive();
        if (!access.isAuthorized) {
            await replyCalllogUnauthorized(ctx);
            return;
        }
        await ctx.reply(setupStepMessage('Call Log - Call Details', [
            'Enter the call SID to view detailed status and summary.',
            'Type `cancel` to stop.'
        ]), {
            parse_mode: 'Markdown'
        });
        const update = await conversation.wait();
        ensureActive();
        const callSid = update?.message?.text?.trim();
        if (isCancelInput(callSid)) {
            await ctx.reply(cancelledMessage('Call details lookup', 'Use /calllog to view another call.'), {
                parse_mode: 'Markdown',
                reply_markup: buildCalllogResultKeyboard(ctx)
            });
            return;
        }
        if (!callSid) {
            await ctx.reply('❌ Call SID is required.');
            return;
        }

        ctx.session.callActivitySelected = callSid;
        await renderCallActivityDetail(ctx, callSid, { ensureActive });
    } catch (error) {
        await ctx.reply(httpClient.getUserMessage(error, 'Failed to fetch call details.'), {
            reply_markup: buildCalllogResultKeyboard(ctx)
        });
    }
}

async function calllogEventsFlow(conversation, ctx) {
    const opId = startOperation(ctx, 'calllog-events');
    const ensureActive = () => ensureOperationActive(ctx, opId);
    try {
        const access = await getAccessProfile(ctx);
        ensureActive();
        if (!access.isAuthorized) {
            await replyCalllogUnauthorized(ctx);
            return;
        }
        await ctx.reply(setupStepMessage('Call Log - Recent Events', [
            'Enter the call SID to view the most recent call events.',
            'Type `cancel` to stop.'
        ]), {
            parse_mode: 'Markdown'
        });
        const update = await conversation.wait();
        ensureActive();
        const callSid = update?.message?.text?.trim();
        if (isCancelInput(callSid)) {
            await ctx.reply(cancelledMessage('Call events lookup', 'Use /calllog to review another call event stream.'), {
                parse_mode: 'Markdown',
                reply_markup: buildCalllogResultKeyboard(ctx)
            });
            return;
        }
        if (!callSid) {
            await ctx.reply('❌ Call SID is required.');
            return;
        }

        ctx.session.callActivitySelected = callSid;
        await renderCallActivityDetail(ctx, callSid, { ensureActive });
    } catch (error) {
        await ctx.reply(httpClient.getUserMessage(error, 'Failed to fetch recent events.'), {
            reply_markup: buildCalllogResultKeyboard(ctx)
        });
    }
}

function registerCalllogCommand(bot) {
    bot.command('calllog', async (ctx) => {
        try {
            await renderCalllogMenu(ctx);
        } catch (error) {
            await ctx.reply(httpClient.getUserMessage(error, 'Could not open call log.'));
        }
    });
}

module.exports = {
    maskPhoneNumber,
    parseRecentFilter,
    formatCallTimeline,
    renderCalllogMenu,
    calllogRecentFlow,
    calllogSearchFlow,
    calllogDetailsFlow,
    calllogEventsFlow,
    handleCallActivityAction,
    buildCallActivityDetailKeyboard,
    buildCallActivityListKeyboard,
    registerCalllogCommand
};
