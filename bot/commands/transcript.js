const config = require('../config');
const axios = require('axios');
const { getUser, isAdmin } = require('../db/db');

const MAX_PREVIEW_MESSAGES = 12;
const MAX_CHUNK_LENGTH = 3800;

function getDtmfLabel(input = {}) {
    if (input.label && typeof input.label === 'string') {
        return input.label;
    }
    if (input.stage_key && typeof input.stage_key === 'string' && input.stage_key.length) {
        return input.stage_key.replace(/_/g, ' ');
    }
    return 'Entry';
}

function hasRawDigits(input = {}) {
    if (!input) return false;
    const digits = typeof input.digits === 'string' ? input.digits : null;
    const masked = typeof input.masked_digits === 'string' ? input.masked_digits : null;
    const raw = typeof input.raw_digits === 'string' ? input.raw_digits : digits;
    if (!raw) return false;
    if (!masked) return true;
    return raw !== masked;
}

function buildDtmfSection(dtmfInputs = [], { useHtml = true } = {}) {
    if (!Array.isArray(dtmfInputs) || dtmfInputs.length === 0) {
        return '';
    }

    const lines = dtmfInputs.map((input) => {
        const label = getDtmfLabel(input);
        const displayDigits = String(
            input.digits ??
            input.raw_digits ??
            input.masked_digits ??
            '••••'
        );
        const maskedDigits = typeof input.masked_digits === 'string' ? input.masked_digits : null;
        const timestamp = formatTimestamp(input.received_at);
        const hasTimestamp = timestamp && timestamp !== 'Unknown time';
        const showMasked = hasRawDigits(input) && maskedDigits && maskedDigits !== displayDigits;

        if (useHtml) {
            let line = `• <b>${escapeHtml(label)}</b>: <code>${escapeHtml(displayDigits)}</code>`;
            if (showMasked) {
                line += ` (masked: <code>${escapeHtml(maskedDigits)}</code>)`;
            }
            if (hasTimestamp) {
                line += ` <i>(${escapeHtml(timestamp)})</i>`;
            }
            return line;
        }

        let line = `• ${label}: ${displayDigits}`;
        if (showMasked) {
            line += ` (masked: ${maskedDigits})`;
        }
        if (hasTimestamp) {
            line += ` (${timestamp})`;
        }
        return line;
    });

    const rawPresent = dtmfInputs.some((input) => hasRawDigits(input));
    const complianceNote = rawPresent
        ? (useHtml
            ? '<i>🚧 Dev compliance mode — raw keypad digits displayed. Handle with care.</i>'
            : '🚧 Dev compliance mode — raw keypad digits displayed. Handle with care.')
        : (useHtml
            ? '<i>Digits masked per active compliance policy.</i>'
            : 'Digits masked per active compliance policy.');

    const separator = useHtml ? '\n' : '\n';
    const sectionHeader = '🔢 Keypad Inputs:\n';

    return `${sectionHeader}${lines.join(separator)}\n${complianceNote}\n`;
}

function escapeHtml(text = '') {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatDuration(seconds) {
    if (!seconds || Number.isNaN(seconds)) {
        return 'Unknown';
    }
    const totalSeconds = Math.max(0, parseInt(seconds, 10));
    const minutes = Math.floor(totalSeconds / 60);
    const remainder = totalSeconds % 60;
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatTimestamp(value) {
    if (!value) return 'Unknown time';
    try {
        return new Date(value).toLocaleTimeString();
    } catch (error) {
        return 'Unknown time';
    }
}

async function getTranscript(ctx, callSid) {
    try {
        const response = await axios.get(`${config.apiUrl}/api/calls/${callSid}`, {
            timeout: 15000
        });

        const { call, transcripts = [], dtmf_inputs: dtmfInputs = [] } = response.data || {};

        if (!call) {
            await ctx.reply('❌ Call not found');
            return;
        }

        const dtmfSection = buildDtmfSection(dtmfInputs, { useHtml: true }).trim();

        if (!transcripts.length) {
            let message = `<b>Call Details</b>\n\n`;
            message += `📞 Phone: <b>${escapeHtml(call.phone_number)}</b>\n`;
            message += `🆔 Call ID: <code>${escapeHtml(callSid)}</code>\n`;
            message += `📡 Provider: ${escapeHtml((call.provider || 'Unknown').toUpperCase())}\n`;
            message += `⏱️ Duration: ${formatDuration(call.duration)}\n`;
            message += `📊 Status: ${escapeHtml(call.status || 'Unknown')}\n`;
            if (dtmfSection) {
                message += `\n${dtmfSection}\n`;
            }
            if (dtmfInputs.length) {
                message += '\n❌ Transcript not ready yet, but keypad inputs were captured.';
            } else {
                message += `\n❌ No transcript available yet.`;
            }

            await ctx.reply(message, { parse_mode: 'HTML' });
            return;
        }

        let message = `<b>Call Transcript</b>\n\n`;
        message += `📞 Phone: <b>${escapeHtml(call.phone_number)}</b>\n`;
        message += `🆔 Call ID: <code>${escapeHtml(callSid)}</code>\n`;
        message += `📡 Provider: ${escapeHtml((call.provider || 'Unknown').toUpperCase())}\n`;
        message += `⏱️ Duration: ${formatDuration(call.duration)}\n`;
        message += `📊 Status: ${escapeHtml(call.status || 'Unknown')}\n`;
        message += `💬 Messages: ${transcripts.length}\n`;
        if (dtmfSection) {
            message += `\n${dtmfSection}\n`;
        }

        if (call.call_summary) {
            message += `\n<b>Summary</b>\n${escapeHtml(call.call_summary)}\n`;
        }

        message += `\n<b>Conversation</b>\n`;

        const previewMessages = transcripts.slice(0, MAX_PREVIEW_MESSAGES);

        previewMessages.forEach((entry) => {
            const speakerLabel = entry.speaker === 'user' ? '👤 User' : '🤖 AI';
            const timestamp = formatTimestamp(entry.timestamp);
            message += `\n<b>${speakerLabel}</b> <i>${escapeHtml(timestamp)}</i>\n`;
            const cleanMessage = entry.clean_message || entry.message || entry.raw_message || '';
            message += `${escapeHtml(cleanMessage)}\n`;
        });

        if (transcripts.length > previewMessages.length) {
            const remaining = transcripts.length - previewMessages.length;
            message += `\n… ${remaining} more message${remaining === 1 ? '' : 's'} (use /fullTranscript ${escapeHtml(callSid)} for full log)`;
        }

        await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Error fetching transcript:', error);

        if (error.response?.status === 404) {
            await ctx.reply('❌ Call not found or transcript not ready');
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            await ctx.reply('❌ Unable to reach API server. Please check the server status.');
        } else {
            await ctx.reply('❌ Error fetching transcript. Please try again later.');
        }
    }
}

async function getCallsList(ctx, limit = 10) {
    try {
        const endpoints = [
            `${config.apiUrl}/api/calls/list?limit=${limit}`,
            `${config.apiUrl}/api/calls?limit=${limit}`
        ];

        let calls = [];
        let lastError = null;

        for (const endpoint of endpoints) {
            try {
                const response = await axios.get(endpoint, {
                    timeout: 15000,
                    headers: {
                        Accept: 'application/json'
                    }
                });

                if (Array.isArray(response.data)) {
                    calls = response.data;
                } else if (Array.isArray(response.data.calls)) {
                    calls = response.data.calls;
                }

                if (calls.length) {
                    break;
                }
            } catch (error) {
                lastError = error;
            }
        }

        if (!calls.length) {
            if (lastError) throw lastError;
            await ctx.reply('📋 No calls found');
            return;
        }

        let message = `<b>Recent Calls (${calls.length})</b>\n\n`;

        calls.forEach((call, index) => {
            const phone = escapeHtml(call.phone_number || 'Unknown');
            const status = escapeHtml(call.status || 'Unknown');
            const callId = escapeHtml(call.call_sid || 'N/A');
            const createdDate = escapeHtml(call.created_date || (call.created_at ? new Date(call.created_at).toLocaleDateString() : 'Unknown'));
            const durationLabel = escapeHtml(call.duration_formatted || formatDuration(call.duration));
            const transcriptCount = call.transcript_count || 0;
            const dtmfCount = call.dtmf_input_count || 0;
            const provider = escapeHtml((call.provider || 'unknown').toUpperCase());

            message += `${index + 1}. 📞 <b>${phone}</b>\n`;
            message += `&nbsp;&nbsp;🆔 <code>${callId}</code>\n`;
            message += `&nbsp;&nbsp;📅 ${createdDate} | ⏱️ ${durationLabel} | 📊 ${status}\n`;
            message += `&nbsp;&nbsp;📡 Provider: ${provider}\n`;
            if (dtmfCount > 0) {
                message += `&nbsp;&nbsp;🔢 Keypad entries: ${dtmfCount}\n`;
            }
            message += `&nbsp;&nbsp;💬 ${transcriptCount} message${transcriptCount === 1 ? '' : 's'}\n\n`;
        });

        message += `Use /transcript &lt;call_id&gt; to view details.`;

        await ctx.reply(message, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Error fetching calls list:', error);

        if (error.response?.status === 404) {
            await ctx.reply('❌ Calls API endpoint not available on the server.');
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            await ctx.reply(`❌ Unable to reach API server at ${config.apiUrl}`);
        } else if (error.response?.status === 500) {
            await ctx.reply('❌ Server error while fetching calls. Please try again later.');
        } else if (error.response) {
            await ctx.reply(`❌ API error (${error.response.status}): ${error.response.data?.error || 'Unknown error'}`);
        } else {
            await ctx.reply('❌ Error fetching calls list. Please try again later.');
        }
    }
}

async function sendFullTranscript(ctx, callSid) {
    try {
        const response = await axios.get(`${config.apiUrl}/api/calls/${callSid}`, {
            timeout: 20000
        });

        const { call, transcripts = [], dtmf_inputs: dtmfInputs = [] } = response.data || {};

        if (!call || !transcripts.length) {
            await ctx.reply('❌ Call or transcript not found');
            return;
        }

        let buffer = `📋 FULL CALL TRANSCRIPT\n\n`;
        buffer += `📞 Number: ${call.phone_number}\n`;
        buffer += `🆔 Call ID: ${callSid}\n`;
        buffer += `📡 Provider: ${(call.provider || 'Unknown').toUpperCase()}\n`;
        buffer += `⏱️ Duration: ${formatDuration(call.duration)}\n`;
        buffer += `📊 Status: ${call.status || 'Unknown'}\n`;
        buffer += `💬 Messages: ${transcripts.length}\n`;

        const dtmfPlainSection = buildDtmfSection(dtmfInputs, { useHtml: false }).trim();
        if (dtmfPlainSection) {
            buffer += `\n${dtmfPlainSection}\n`;
        }

        if (call.call_summary) {
            buffer += `\nSUMMARY:\n${call.call_summary}\n`;
        }

        buffer += `\nCONVERSATION:\n`;

        transcripts.forEach((entry) => {
            const speakerLabel = entry.speaker === 'user' ? '👤 USER' : '🤖 AI';
            const timestamp = formatTimestamp(entry.timestamp);
            const messageBody = entry.clean_message || entry.message || entry.raw_message || '';
            buffer += `\n${speakerLabel} (${timestamp}):\n${messageBody}\n`;
        });

        const chunks = [];
        let remaining = buffer;

        while (remaining.length > MAX_CHUNK_LENGTH) {
            let splitIndex = remaining.lastIndexOf('\n', MAX_CHUNK_LENGTH);
            if (splitIndex === -1) {
                splitIndex = MAX_CHUNK_LENGTH;
            }
            chunks.push(remaining.slice(0, splitIndex));
            remaining = remaining.slice(splitIndex);
        }

        if (remaining.trim().length) {
            chunks.push(remaining);
        }

        for (let i = 0; i < chunks.length; i++) {
            const suffix = i < chunks.length - 1 ? '\n\n… (continued)' : '';
            await ctx.reply(chunks[i] + suffix);
            if (i < chunks.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 700));
            }
        }
    } catch (error) {
        console.error('Full transcript error:', error);
        if (error.response?.status === 404) {
            await ctx.reply('❌ Call not found');
        } else {
            await ctx.reply('❌ Error fetching full transcript');
        }
    }
}

async function ensureAdmin(ctx) {
    const user = await new Promise((resolve) => getUser(ctx.from.id, resolve));
    if (!user) {
        await ctx.reply('❌ You are not authorized to use this bot.');
        return false;
    }

    const adminStatus = await new Promise((resolve) => isAdmin(ctx.from.id, resolve));
    if (!adminStatus) {
        await ctx.reply('❌ This command is for administrators only.');
        return false;
    }

    return true;
}

module.exports = (bot) => {
    bot.command('transcript', async (ctx) => {
        try {
            if (!(await ensureAdmin(ctx))) {
                return;
            }

            const parts = ctx.message.text.trim().split(/\s+/);
            if (parts.length < 2) {
                await ctx.reply('📋 Usage: /transcript <call_id>\nExample: /transcript CA1234567890abcdef');
                return;
            }

            const callSid = parts[1].trim();
            if (!/^CA[a-z0-9]+$/i.test(callSid)) {
                await ctx.reply('❌ Invalid Call SID format. Expected value starting with "CA".');
                return;
            }

            await getTranscript(ctx, callSid);
        } catch (error) {
            console.error('Transcript command error:', error);
            await ctx.reply('❌ Error processing transcript command');
        }
    });

    bot.command('calls', async (ctx) => {
        try {
            if (!(await ensureAdmin(ctx))) {
                return;
            }

            const parts = ctx.message.text.trim().split(/\s+/);
            const limit = parts.length > 1 ? Math.min(Math.max(parseInt(parts[1], 10) || 10, 1), 50) : 10;

            await ctx.reply('📋 Fetching recent calls...');
            await getCallsList(ctx, limit);
        } catch (error) {
            console.error('Calls command error:', error);
            await ctx.reply('❌ Error fetching calls list');
        }
    });

    bot.command('fullTranscript', async (ctx) => {
        try {
            if (!(await ensureAdmin(ctx))) {
                return;
            }

            const parts = ctx.message.text.trim().split(/\s+/);
            if (parts.length < 2) {
                await ctx.reply('📋 Usage: /fullTranscript <call_id>');
                return;
            }

            const callSid = parts[1].trim();
            if (!/^CA[a-z0-9]+$/i.test(callSid)) {
                await ctx.reply('❌ Invalid Call SID format. Expected value starting with "CA".');
                return;
            }

            await ctx.reply('📋 Fetching full transcript...');
            await sendFullTranscript(ctx, callSid);
        } catch (error) {
            console.error('Full transcript command error:', error);
            await ctx.reply('❌ Error fetching full transcript');
        }
    });
};
