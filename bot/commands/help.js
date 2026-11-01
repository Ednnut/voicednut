const { InlineKeyboard } = require('grammy');
const config = require('../config');
const { getAccessProfile } = require('../utils/capabilities');
const { escapeHtml, renderMenu } = require('../utils/ui');
const { buildCallbackData } = require('../utils/actions');

function getMiniAppLaunchUrl() {
    const configured = String(config.miniApp?.url || '').trim();
    if (configured) return configured;
    try {
        return new URL('/miniapp', config.apiUrl).toString();
    } catch {
        return '';
    }
}

function appendMiniAppLaunchButton(keyboard, label = '🧭 Admin Console') {
    const launchUrl = getMiniAppLaunchUrl();
    if (!launchUrl) return false;
    if (typeof keyboard.webApp === 'function') {
        keyboard.row().webApp(label, launchUrl);
    } else {
        keyboard.row().url(label, launchUrl);
    }
    return true;
}

async function handleHelp(ctx) {
    try {
        const access = await getAccessProfile(ctx);
        const isAuthorized = Boolean(access?.isAuthorized);
        const isOwner = Boolean(access?.isAdmin);

        const formatLines = (items) => items.map((item) => `• ${escapeHtml(item)}`).join('\n');

        const callList = [
            '📞 /call — launch a fresh voice session (requires access)',
            ...(isAuthorized ? ['🤖 /calle — guided CALL-E menu for planning, results, campaigns, approvals, recovery, and missions'] : []),
            ...(isOwner ? ['🟣 /vapi — Vapi readiness, phone inventory, call events, campaign drafts, and confirmed live call controls'] : []),
            ...(isOwner ? ['🔷 /cartesia — Cartesia Managed Agents operations, voice cloning, speech previews, quality metrics, and safe call reconciliation'] : []),
            '🧭 /callplan — plan a CALL-E template and check consent/compatibility without dialing',
            '📜 /calllog — browse recent calls, search, and events',
            ...(isOwner ? ['📊 /callresults — recent CALL-E execution and result readiness summaries'] : []),
            ...(isOwner ? ['🧾 /callresult <call_id> — view one validated structured result in a private chat'] : []),
            ...(isOwner ? ['🔄 /callreconcile <call_id> — refresh saved CALL-E status and event cursors; no call is started or canceled'] : []),
            ...(isOwner ? ['🔎 /callquality <call_id> — deterministic, content-free conversation signals'] : []),
            ...(isOwner ? ['🧪 /callcampaigns <business_id> — list campaign drafts, approvals, and rehearsal status'] : []),
            ...(isOwner ? ['📝 /callcampaigncreate <business_id> <template_id> [request_key] — consent-checked campaign review draft; no calls'] : []),
            ...(isOwner ? ['🔎 /callcampaigninfo <business_id> <campaign_id> — show campaign fingerprint and approval audit in private chat'] : []),
            ...(isOwner ? ['✅ /callcampaignreview <business_id> <campaign_id> <approve|reject> — policy-manager campaign review'] : []),
            ...(isOwner ? ['🧵 /callmissions <business_id> — view durable CALL-E mission state'] : []),
            ...(isOwner ? ['🧩 /callmissioncreate <business_id> <approved_campaign_id> [request_key] — stage a mission for separate review; no calls'] : []),
            ...(isOwner ? ['✅ /callmissionreview <business_id> <mission_id> <approve|reject> — separate mission approval'] : []),
            ...(isOwner ? ['🔐 /callmissioninfo <business_id> <mission_id> — show the exact approval fingerprint'] : []),
            ...(isOwner ? ['🛂 /callmissionresolve <business_id> <mission_id> <continue|cancel> [request_key] — resolve a paused mission; reuse the key on retry'] : []),
            ...(isOwner ? ['▶️ /callmissionadvance <business_id> <mission_id> — process one approved mission step'] : [])
        ];

        const smsList = [
            '💬 /sms — open the SMS center (send, schedule, status, threads, stats)'
        ];

        const emailList = [
            '📧 /email — open the Email center (send, status, templates)'
        ];

        const infoList = [
            '🩺 /health or /ping — check bot & API health',
            '📚 /guide — view the master user guide (access required)',
            '📋 /menu — reopen quick actions (access required)',
            '❓ /help — show this message again'
        ];

        const quickUsage = [
            'Use /call or the 📞 button to get started',
            'Enter phone numbers in E.164 format (+1234567890)',
            'Describe the AI agent personality and first message',
            'Monitor live updates and ask for transcripts',
            'End the call with the ✋ Interrupt or ⏹️ End button if needed'
        ];

        const exampleUsage = [
            '+1234567890 (not 123-456-7890)',
            '/calllog',
            '/health'
        ];

        const supportBlock = [
            `🆘 Contact admin: @${escapeHtml(config.admin.username || '')}`,
            '🧭 Bot edition: v2.0.0'
        ];

        const helpSections = [
            `<b>${escapeHtml('AI calling controls and command guide.')}</b>`,
            `<b>Call Tools</b>\n${formatLines(callList)}`,
            `<b>SMS Tools</b>\n${formatLines(smsList)}`,
            `<b>Email Tools</b>\n${formatLines(emailList)}`,
            `<b>Navigation & Info</b>\n${formatLines(infoList)}`,
            `<b>Quick Usage Flow</b>\n${formatLines(quickUsage)}`
        ];

        if (isOwner) {
            const adminList = [
                '👥 /users — manage authorized personnel',
                '📵 /callerflags — manage inbound caller flags',
                '📣 /smssender — bulk SMS center',
                '📦 /mailer — bulk email center',
                '🧪 /status — deep system status',
                '🧭 /admin — open the Mini App admin console',
                '🧰 /scripts — manage reusable prompts',
                '🍃 /persona — sculpt adaptive agents',
                '🔀 /provider — view or switch voice providers'
            ];
            helpSections.push(`<b>Admin Toolkit</b>\n${formatLines(adminList)}`);
        }

        helpSections.push(
            `<b>Examples</b>\n${formatLines(exampleUsage)}`,
            `<b>Support & Info</b>\n${formatLines(supportBlock)}`
        );

        const unauthSections = [
            `<b>${escapeHtml('⚠️ Access limited')}</b>\n${formatLines([
                'You can browse menus, but actions require approval.'
            ])}`,
            `<b>${escapeHtml('Welcome! Access is required to use most commands.')}</b>`,
            `<b>What this bot can do</b>\n${formatLines([
                '🤖 Run AI-powered voice calls and SMS outreach',
                '🧾 Track conversations and delivery status',
                '🛡️ Admins manage users, scripts, and providers'
            ])}`,
            `<b>Get access</b>\n${formatLines([
                `🆘 Contact admin: @${escapeHtml(config.admin.username || '')}`,
                'Share your Telegram @ and reason to be approved.',
                'Once approved, use /start to see your menu.'
            ])}`,
            `<b>${escapeHtml('🔒 Limited mode')}</b>\n${formatLines([
                'Menus are visible, but execution is locked.'
            ])}`
        ];

        const helpText = isAuthorized ? helpSections.join('\n\n') : unauthSections.join('\n\n');

        const adminUsername = (config.admin.username || '').replace(/^@/, '');

        const kb = isAuthorized
            ? (() => {
                const keyboard = new InlineKeyboard()
                    .text('📞 Call', buildCallbackData(ctx, 'CALL'))
                    .text('💬 SMS', buildCallbackData(ctx, 'SMS'))
                    .row()
                    .text('📧 Email', buildCallbackData(ctx, 'EMAIL'))
                    .text('📋 Menu', buildCallbackData(ctx, 'MENU'));

                keyboard.row()
                    .text('📚 Guide', buildCallbackData(ctx, 'GUIDE'))
                    .text('ℹ️ Help', buildCallbackData(ctx, 'HELP'));

                if (isOwner) {
                    keyboard.row()
                        .text('👥 Users', buildCallbackData(ctx, 'USERS'))
                        .text('📵 Caller Flags', buildCallbackData(ctx, 'CALLER_FLAGS'))
                        .row()
                        .text('☎️ Provider', buildCallbackData(ctx, 'PROVIDER_STATUS'));
                    appendMiniAppLaunchButton(keyboard);
                }
                return keyboard;
            })()
            : (() => {
                const keyboard = new InlineKeyboard()
                    .text('📚 Guide', buildCallbackData(ctx, 'GUIDE'))
                    .text('📋 Menu', buildCallbackData(ctx, 'MENU'));
                if (adminUsername) {
                    keyboard.row().url('🔓 Request Access', `https://t.me/${adminUsername}`);
                }
                return keyboard;
            })();

        await renderMenu(ctx, helpText, kb, { parseMode: 'HTML' });

    } catch (error) {
        console.error('Help command error:', error);
        await ctx.reply('❌ Error displaying help. Please try again.');
    }
}

function registerHelpCommand(bot) {
    bot.command('help', handleHelp);
}

module.exports = {
    registerHelpCommand,
    handleHelp
};
