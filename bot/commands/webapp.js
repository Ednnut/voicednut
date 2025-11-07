const crypto = require('crypto');
const { z } = require('zod');
const config = require('../config');

// Validate WebApp data
function validateWebAppData(rawInitData) {
  if (typeof rawInitData !== 'string' || rawInitData.length === 0) {
    return false;
  }

  const params = new URLSearchParams(rawInitData);
  const data = {};

  for (const [key, value] of params.entries()) {
    data[key] = value;
  }

  if (!data.hash) {
    return false;
  }

  const dataCheckString = Object.keys(data)
    .filter((key) => key !== 'hash')
    .map((key) => {
      return `${key}=${data[key]}`;
    })
    .sort()
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(config.botToken)
    .digest();

  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return hash === data.hash;
}

function parseInitData(rawInitData) {
  const params = new URLSearchParams(rawInitData);
  const data = {};

  for (const [key, value] of params.entries()) {
    data[key] = value;
  }

  return data;
}

function escapeMarkdown(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

const userSchema = z.object({
  id: z.number(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const envelopeSchema = z.object({
  action: z.string().min(1),
  timestamp: z.string().optional(),
  payload: z.unknown().optional(),
  initData: z.string().min(1),
});

const callInitiatedSchema = z.object({
  callSid: z.string().min(1),
  to: z.string().min(1).optional(),
  status: z.string().optional(),
});

const callEndedSchema = z.object({
  callSid: z.string().min(1),
  status: z.string().min(1),
  duration: z.number().nonnegative().optional(),
});

const smsSentSchema = z.object({
  phoneNumber: z.string().min(1),
  messageId: z.string().optional(),
});

const userAddedSchema = z.object({
  userId: z.string().min(1),
  name: z.string().optional(),
  username: z.string().optional(),
});

const userRemovedSchema = z.object({
  userId: z.string().min(1),
});

const actionHandlers = {
  call_initiated: {
    schema: callInitiatedSchema,
    handle: async (ctx, payload, meta) => {
      const target = escapeMarkdown(payload.to ?? 'unknown');
      const callSid = escapeMarkdown(payload.callSid);
      const status = escapeMarkdown(payload.status ?? 'pending');
      await ctx.reply(
        [
          '📞 *Call initiated*',
          `• To: ${target}`,
          `• SID: \`${callSid}\``,
          `• Status: ${status}`,
          `• Received: ${escapeMarkdown(meta.serverTimestamp)}`,
        ].join('\n'),
        { parse_mode: 'Markdown' }
      );
    },
  },
  call_ended: {
    schema: callEndedSchema,
    handle: async (ctx, payload, meta) => {
      const durationSeconds = payload.duration ?? 0;
      const mins = Math.floor(durationSeconds / 60);
      const secs = String(durationSeconds % 60).padStart(2, '0');
      const duration = durationSeconds ? `${mins}:${secs}` : 'n/a';
      const statusIcon = payload.status === 'completed' ? '✅' : '❌';
      const status = escapeMarkdown(payload.status);

      await ctx.reply(
        [
          `${statusIcon} *Call ${status}*`,
          `• SID: \`${escapeMarkdown(payload.callSid)}\``,
          `• Duration: ${escapeMarkdown(duration)}`,
          `• Received: ${escapeMarkdown(meta.serverTimestamp)}`,
        ].join('\n'),
        { parse_mode: 'Markdown' }
      );
    },
  },
  sms_sent: {
    schema: smsSentSchema,
    handle: async (ctx, payload, meta) => {
      await ctx.reply(
        [
          '📱 *SMS sent*',
          `• To: ${escapeMarkdown(payload.phoneNumber)}`,
          payload.messageId ? `• Message ID: \`${escapeMarkdown(payload.messageId)}\`` : null,
          `• Received: ${escapeMarkdown(meta.serverTimestamp)}`,
        ]
          .filter(Boolean)
          .join('\n'),
        { parse_mode: 'Markdown' }
      );
    },
  },
  user_added: {
    schema: userAddedSchema,
    handle: async (ctx, payload, meta) => {
      await ctx.reply(
        [
          '👤 *User added*',
          `• ID: \`${escapeMarkdown(payload.userId)}\``,
          payload.name ? `• Name: ${escapeMarkdown(payload.name)}` : null,
          payload.username ? `• Username: @${escapeMarkdown(payload.username)}` : null,
          `• Received: ${escapeMarkdown(meta.serverTimestamp)}`,
        ]
          .filter(Boolean)
          .join('\n'),
        { parse_mode: 'Markdown' }
      );
    },
  },
  user_removed: {
    schema: userRemovedSchema,
    handle: async (ctx, payload, meta) => {
      await ctx.reply(
        [
          '🚫 *User removed*',
          `• ID: \`${escapeMarkdown(payload.userId)}\``,
          `• Received: ${escapeMarkdown(meta.serverTimestamp)}`,
        ].join('\n'),
        { parse_mode: 'Markdown' }
      );
    },
  },
};

function formatZodError(zodError) {
  return zodError.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join(', ');
}

module.exports = (bot) => {
  // Handle data from Mini App
  bot.on('message:web_app_data', async (ctx) => {
    try {
      const { web_app_data } = ctx.message;

      let parsed;
      try {
        parsed = JSON.parse(web_app_data.data);
      } catch (parseError) {
        console.error('Failed to parse web_app_data payload', parseError);
        await ctx.reply('❌ Unable to process data from the mini app');
        return;
      }

      const envelope = envelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        console.warn('Mini App sent invalid envelope', envelope.error.format());
        await ctx.reply('❌ Received malformed payload from the mini app. Please try again.');
        return;
      }

      const { action, initData, timestamp, payload } = envelope.data;

      if (!validateWebAppData(initData)) {
        await ctx.reply('❌ Invalid mini app session. Please reopen the mini app from the bot.');
        return;
      }

      const parsedInitData = parseInitData(initData);
      const userRaw = parsedInitData.user;
      if (!userRaw) {
        await ctx.reply('❌ Mini app payload missing user information.');
        return;
      }

      let parsedUser;
      try {
        parsedUser = JSON.parse(userRaw);
      } catch (error) {
        console.warn('Failed to parse user from initData', error);
        await ctx.reply('❌ Mini app payload has invalid user data.');
        return;
      }

      const user = userSchema.safeParse(parsedUser);
      if (!user.success) {
        console.warn('Mini app sent invalid user data', user.error.format());
        await ctx.reply('❌ Mini app payload has invalid user data.');
        return;
      }

      if (user.data.id !== ctx.from.id) {
        console.warn('Mini app user mismatch', { miniAppUserId: user.data.id, telegramUserId: ctx.from.id });
        await ctx.reply('❌ Mini app session mismatch. Please reopen the mini app from the bot.');
        return;
      }

      const handler = actionHandlers[action];
      if (!handler) {
        console.warn('Received unhandled mini app action', action);
        return;
      }

      const validatedPayload = handler.schema.safeParse(payload ?? {});
      if (!validatedPayload.success) {
        console.warn('Mini app payload validation failed', {
          action,
          error: formatZodError(validatedPayload.error),
        });
        await ctx.reply(
          `❌ Mini app sent invalid data for action "${action}". Please try again.`
        );
        return;
      }

      const serverTimestamp = new Date((ctx.message?.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
      const meta = {
        serverTimestamp,
        clientTimestamp: timestamp ?? null,
      };

      await handler.handle(ctx, validatedPayload.data, meta);
    } catch (error) {
      console.error('Error handling WebApp data:', error);
      await ctx.reply('❌ Error processing WebApp data');
    }
  });
};
