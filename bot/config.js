'use strict';

/*
 * Configuration for the Telegram bot
 */

require('dotenv').config();
const required = ['ADMIN_TELEGRAM_ID', 'ADMIN_TELEGRAM_USERNAME', 'API_URL', 'BOT_TOKEN', 'ADMIN_API_TOKEN'];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('❌ Bot environment is missing required variables:');
  missing.forEach((key) => console.error(`   - ${key}`));
  console.error('Edit bot/.env and supply the values. You can scaffold the file with `npm run setup --prefix bot` from the repo root.');
  process.exit(1);
}

const miniAppUrl = process.env.MINI_APP_URL || process.env.WEB_APP_URL;

if (!miniAppUrl) {
  console.error('❌ Missing environment variable: MINI_APP_URL (or WEB_APP_URL fallback)');
  process.exit(1);
}

const templatesApiUrl = process.env.TEMPLATES_API_URL || process.env.API_URL;

try {
  // eslint-disable-next-line no-new
  new URL(templatesApiUrl);
} catch (error) {
  console.error(`❌ Invalid TEMPLATES_API_URL: ${templatesApiUrl || 'undefined'} (${error.message})`);
  process.exit(1);
}

// Check for required environment variables

module.exports = {
  admin: {
    userId: process.env.ADMIN_TELEGRAM_ID,
    username: process.env.ADMIN_TELEGRAM_USERNAME,
    apiToken: process.env.ADMIN_API_TOKEN
  },
  apiUrl: process.env.API_URL,
  botToken: process.env.BOT_TOKEN,
  templatesApiUrl,
  defaultVoiceModel: process.env.DEFAULT_VOICE_MODEL || 'aura-asteria-en',
  defaultBusinessId: process.env.DEFAULT_BUSINESS_ID || 'general',
  defaultPurpose: process.env.DEFAULT_CALL_PURPOSE || 'general',

  // New Mini App configuration
  webAppUrl: miniAppUrl,
  miniAppUrl,
  webAppSecret: process.env.WEB_APP_SECRET || 'your-web-app-secret',
  webAppPort: process.env.WEB_APP_PORT || 8080,

  // CORS settings for Mini App
  cors: {
    origins: [
      'https://web.telegram.org',
      miniAppUrl
    ].filter(Boolean)
  }
};
