'use strict';

/*
 * Configuration for the Telegram bot
 */

require('dotenv').config();
const DEFAULT_BOT_EPHEMERAL_TTL_MS = 8000;
const required = ['ADMIN_TELEGRAM_ID', 'ADMIN_TELEGRAM_USERNAME', 'API_URL', 'BOT_TOKEN'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('❌ Bot environment is missing required variables:');
  missing.forEach((key) => console.error(`   - ${key}`));
  console.error('Edit bot/.env and supply the values. You can scaffold the file with `npm run setup --prefix bot` from the repo root.');
  process.exit(1);
}

const apiSecret = process.env.API_SECRET;
const adminApiToken = apiSecret || process.env.ADMIN_API_TOKEN;
const apiHmacSecret = apiSecret || process.env.API_HMAC_SECRET;
if (!adminApiToken || !apiHmacSecret) {
  console.error('❌ Bot environment is missing API credentials. Set API_SECRET (preferred) or both ADMIN_API_TOKEN + API_HMAC_SECRET.');
  process.exit(1);
}

function normalizeApiBaseUrl(value, label) {
  const raw = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new Error('Invalid ' + label + ': ' + (raw || 'undefined') + ' (' + error.message + ')');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(label + ' must be an HTTP(S) API origin without credentials, query, or fragment.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(label + ' must be the API origin only; do not include a path such as /api.');
  }
  return parsed.origin;
}

let apiUrl;
let scriptsApiUrl;
try {
  apiUrl = normalizeApiBaseUrl(process.env.API_URL, 'API_URL');
  scriptsApiUrl = normalizeApiBaseUrl(
    process.env.SCRIPTS_API_URL || process.env.TEMPLATES_API_URL || apiUrl,
    'SCRIPTS_API_URL',
  );
} catch (error) {
  console.error('❌ ' + error.message);
  process.exit(1);
}
function resolveMiniAppUrl() {
  const explicit = String(process.env.MINI_APP_URL || '').trim();
  if (explicit) return explicit;
  try {
    return new URL('/miniapp', apiUrl).toString();
  } catch {
    return '';
  }
}
const miniAppUrl = resolveMiniAppUrl();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// API URLs are normalized once so all bot routes use a consistent origin.

module.exports = {
  admin: {
    userId: process.env.ADMIN_TELEGRAM_ID,
    username: process.env.ADMIN_TELEGRAM_USERNAME,
    apiToken: adminApiToken
  },
  apiUrl,
  botToken: process.env.BOT_TOKEN,
  scriptsApiUrl,
  miniApp: {
    url: miniAppUrl
  },
  defaultVoiceModel: process.env.DEFAULT_VOICE_MODEL || 'aura-asteria-en',
  defaultBusinessId: process.env.DEFAULT_BUSINESS_ID || 'general',
  defaultPurpose: process.env.DEFAULT_CALL_PURPOSE || 'general',
  ui: {
    ephemeralTtlMs: parsePositiveInt(process.env.BOT_EPHEMERAL_TTL_MS, DEFAULT_BOT_EPHEMERAL_TTL_MS),
  },
  apiAuth: {
    hmacSecret: apiHmacSecret,
  },
  normalizeApiBaseUrl,
};
