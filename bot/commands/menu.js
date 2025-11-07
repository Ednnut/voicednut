const { InlineKeyboard } = require('grammy');
const { getUser, isAdmin } = require('../db/db');
const { cancelActiveFlow, resetSession } = require('../utils/sessionState');
const config = require('../config');

module.exports = (bot) => {
    // Menu command
    bot.command('menu', async (ctx) => {
        try {
            // Check user authorization
            await cancelActiveFlow(ctx, 'command:/menu');
            resetSession(ctx);

            const user = await new Promise(r => getUser(ctx.from.id, r));
            if (!user) {
                return ctx.reply('❌ You are not authorized to use this bot.');
            }

            const isOwner = await new Promise(r => isAdmin(ctx.from.id, r));
            
            const kb = new InlineKeyboard();

            if (config.miniAppUrl) {
                kb.webApp('📱 Open Mini App', config.miniAppUrl).row();
            }

            kb.text('📞 New Call', 'CALL')
            .text('📱 Send SMS', 'SMS')
            .row()
            .text('📋 Recent Calls', 'CALLS')
            .text('📚 Guide', 'GUIDE')
            .row()
            .text('🏥 Health Check', 'HEALTH')
            .text('ℹ️ Help', 'HELP');

            if (isOwner) {
                kb.row()
                    .text('📤 Bulk SMS', 'BULK_SMS')
                    .text('⏰ Schedule SMS', 'SCHEDULE_SMS')
                    .row()
                    .text('➕ Add User', 'ADDUSER')
                    .text('⬆️ Promote', 'PROMOTE')
                    .row()
                    .text('👥 Users', 'USERS')
                    .text('❌ Remove', 'REMOVE')
                    .row()
                    .text('🧰 Templates', 'TEMPLATES')
                    .text('📊 SMS Stats', 'SMS_STATS')
                    .row()
                    .text('☎️ Provider', 'PROVIDER_STATUS')
                    .row()
                    .text('🔍 Status', 'STATUS')
                    .text('🧪 Test API', 'TEST_API');
            }

            const menuText = isOwner ? 
                '🛡️ *Administrator Menu*\n\nSelect an action below:' :
                '📋 *Quick Actions Menu*\n\nSelect an action below:';

            await ctx.reply(menuText, {
                parse_mode: 'Markdown',
                reply_markup: kb
            });
        } catch (error) {
            console.error('Menu command error:', error);
            await ctx.reply('❌ Error displaying menu. Please try again.');
        }
    });
};
