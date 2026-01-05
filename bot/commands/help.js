const { InlineKeyboard } = require('grammy');
const { isAdmin, getUser } = require('../db/db');
const config = require('../config');
const { section, emphasize, tipLine, escapeMarkdown } = require('../utils/messageStyle');

module.exports = (bot) => {
    bot.command('help', async (ctx) => {
        try {
            // Check if user is authorized
            const user = await new Promise(r => getUser(ctx.from.id, r));
            if (!user) {
                return ctx.reply('❌ You are not authorized to use this bot.');
            }

            const isOwner = await new Promise(r => isAdmin(ctx.from.id, r));

            const basicList = [
                '📱 /start — warm restart plus menu reset',
                '📞 /call — launch a fresh voice session',
                '💬 /sms — send a quick AI-powered SMS',
                '🧾 /smsconversation <phone> — view recent SMS threads',
                '🔍 /search <term> — locate calls by number, intent, or ID',
                '🕒 /recent [limit] — list recent calls (max 50)',
                '🩺 /health or /ping — check bot & API health in one tap',
                '📚 /guide — view the master user guide',
                '📋 /menu — reopen quick actions',
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
                '/search refund',
                '/recent 20',
                '/health'
            ];

            const supportBlock = [
                tipLine('🆘', 'Contact admin: @' + escapeMarkdown(config.admin.username)),
                tipLine('🧭', 'Bot edition: v2.0.0 — secrets aged to perfection')
            ];

            const helpSections = [
                emphasize('Ready to guide your AI calls with sparkling clarity.'),
                section('Command Essentials', basicList),
                section('Quick Usage Flow', quickUsage.map(line => `• ${line}`))
            ];

            if (isOwner) {
                const adminList = [
                    '🛡️ /adduser — add a trusted operator',
                    '⭐ /promote — elevate a teammate to admin',
                    '❌ /removeuser — cut access cleanly',
                    '👥 /users — list all authorized personnel',
                    '📣 /bulksms — broadcast smart SMS',
                    '⏰ /schedulesms — plan future outreach',
                    '🧪 /status — deep system status',
                    '🧰 /templates — manage reusable prompts',
                    '🍃 /persona — sculpt adaptive agents',
                    '🔀 /provider — view or switch voice providers',
                    '📊 /smsstats — view SMS health & delivery'
                ];
                helpSections.push(section('Admin Toolkit', adminList));
            }

            helpSections.push(
                section('Examples', exampleUsage.map(line => `• ${line}`)),
                section('Support & Info', supportBlock)
            );

            const helpText = helpSections.join('\n\n');

            const kb = new InlineKeyboard()
                .text('📞 New Call', 'CALL')
                .text('📋 Menu', 'MENU')
                .row()
                .text('💬 New Sms', 'SMS')
                .text('📚 Full Guide', 'GUIDE');

            if (isOwner) {
                kb.row()
                    .text('👥 Users', 'USERS')
                    .text('➕ Add User', 'ADDUSER')
                    .row()
                    .text('☎️ Provider', 'PROVIDER_STATUS');
            }

            await ctx.reply(helpText, {
                parse_mode: 'Markdown',
                reply_markup: kb
            });

        } catch (error) {
            console.error('Help command error:', error);
            await ctx.reply('❌ Error displaying help. Please try again.');
        }
    });
};
