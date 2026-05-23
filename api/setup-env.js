#!/usr/bin/env node
require('./utils/bootstrapLogger');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SECTIONS = [
  {
    comments: [
      '# --- API Environment --------------------------',
      '# Primary call provider (twilio | plivo | vonage)',
    ],
    fields: [
      { key: 'CALL_PROVIDER', prompt: 'Primary call provider', defaultValue: 'twilio' },
      { key: 'SMS_PROVIDER', prompt: 'Primary SMS provider', defaultValue: 'twilio' },
      { key: 'EMAIL_PROVIDER', prompt: 'Primary email provider', defaultValue: 'sendgrid' },
    ],
  },
  {
    comments: ['# API secret (shared for admin + HMAC signing)'],
    fields: [
      { key: 'API_SECRET', prompt: 'API Secret', defaultValue: 'change-me' },
      { key: 'API_HMAC_MAX_SKEW_MS', prompt: 'API HMAC max skew (ms)', defaultValue: '300000' },
      { key: 'API_HMAC_REPLAY_VALIDATION', prompt: 'API HMAC replay validation mode (warn|strict|off)', defaultValue: 'warn' },
      { key: 'API_HMAC_REPLAY_WINDOW_MS', prompt: 'API HMAC replay window (ms)', defaultValue: '300000' },
    ],
  },
  {
    comments: ['# Twilio credentials (required when CALL_PROVIDER=twilio)'],
    fields: [
      { key: 'TWILIO_ACCOUNT_SID', prompt: 'Twilio Account SID' },
      { key: 'TWILIO_AUTH_TOKEN', prompt: 'Twilio Auth Token' },
      { key: 'FROM_NUMBER', prompt: 'Twilio From Number (E.164 format)' },
    ],
  },
  {
    comments: ['# Plivo Voice/SMS (required when CALL_PROVIDER=plivo or SMS_PROVIDER=plivo)'],
    fields: [
      { key: 'PLIVO_AUTH_ID', prompt: 'Plivo Auth ID' },
      { key: 'PLIVO_AUTH_TOKEN', prompt: 'Plivo Auth Token' },
      { key: 'PLIVO_VOICE_FROM_NUMBER', prompt: 'Plivo Voice From Number (E.164)' },
      { key: 'PLIVO_SMS_FROM_NUMBER', prompt: 'Plivo SMS From Number (E.164)' },
      { key: 'PLIVO_ANSWER_URL', prompt: 'Plivo Answer URL (optional)' },
      { key: 'PLIVO_EVENT_URL', prompt: 'Plivo Event URL (optional)' },
      { key: 'PLIVO_WEBHOOK_SECRET', prompt: 'Plivo Webhook Secret (optional)' },
    ],
  },
  {
    comments: ['# Vonage Voice/SMS (required when CALL_PROVIDER=vonage)', '# Provide either the PEM contents (use \\n escapes) or a path to the private key file'],
    fields: [
      { key: 'VONAGE_API_KEY', prompt: 'Vonage API Key' },
      { key: 'VONAGE_API_SECRET', prompt: 'Vonage API Secret' },
      { key: 'VONAGE_APPLICATION_ID', prompt: 'Vonage Application ID' },
      { key: 'VONAGE_PRIVATE_KEY', prompt: 'Vonage Private Key (PEM contents or file path)' },
      { key: 'VONAGE_VOICE_FROM_NUMBER', prompt: 'Vonage Voice From Number (E.164)' },
      { key: 'VONAGE_SMS_FROM_NUMBER', prompt: 'Vonage SMS From Number (E.164)' },
      { key: 'VONAGE_ANSWER_URL', prompt: 'Vonage Answer URL (optional)' },
      { key: 'VONAGE_EVENT_URL', prompt: 'Vonage Event URL (optional)' },
    ],
  },
  {
    comments: ['# Server configuration'],
    fields: [
      { key: 'PORT', prompt: 'API Port', defaultValue: '3000' },
      { key: 'SERVER', prompt: 'Public server hostname (optional)' },
      { key: 'CORS_ORIGINS', prompt: 'Comma-separated CORS origins (optional)' },
    ],
  },
  {
    comments: ['# OpenRouter AI configuration'],
    fields: [
      { key: 'OPENROUTER_API_KEY', prompt: 'OpenRouter API Key' },
      { key: 'OPENROUTER_MODEL', prompt: 'Default OpenRouter Model', defaultValue: 'meta-llama/llama-3.1-8b-instruct:free' },
      { key: 'YOUR_SITE_URL', prompt: 'Your site URL', defaultValue: 'http://localhost:3000' },
      { key: 'YOUR_SITE_NAME', prompt: 'Your site name', defaultValue: 'Voice Call Bot' },
    ],
  },
  {
    comments: ['# Deepgram configuration'],
    fields: [
      { key: 'DEEPGRAM_API_KEY', prompt: 'Deepgram API Key' },
      { key: 'VOICE_MODEL', prompt: 'Deepgram Voice Model', defaultValue: 'aura-2-andromeda-en' },
    ],
  },
  {
    comments: ['# Telegram webhook fallback'],
    fields: [
      { key: 'TELEGRAM_BOT_TOKEN', prompt: 'Telegram Bot Token (optional fallback)' },
    ],
  },
  {
    comments: ['# Telegram Mini App security (required when Mini App admin dashboard is enabled)'],
    fields: [
      { key: 'MINI_APP_URL', prompt: 'Mini App URL (optional)' },
      { key: 'MINI_APP_SESSION_SECRET', prompt: 'Mini App Session Secret' },
      { key: 'MINI_APP_SESSION_TTL_SECONDS', prompt: 'Mini App Session TTL (seconds)', defaultValue: '900' },
      { key: 'MINI_APP_INITDATA_MAX_AGE_SECONDS', prompt: 'Mini App Init Data max age (seconds)', defaultValue: '86400' },
      { key: 'MINI_APP_INITDATA_EXPIRY_GRACE_SECONDS', prompt: 'Mini App Init Data expiry grace (seconds)', defaultValue: '604800' },
      { key: 'MINI_APP_REPLAY_WINDOW_SECONDS', prompt: 'Mini App replay window (seconds)', defaultValue: '600' },
      { key: 'MINI_APP_REPLAY_VALIDATION', prompt: 'Mini App replay validation mode (warn|strict|off)', defaultValue: 'warn' },
    ],
  },
  {
    comments: ['# Call recording'],
    fields: [
      { key: 'RECORDING_ENABLED', prompt: 'Enable call recording? (true/false)', defaultValue: 'false' },
    ],
  },
];

async function confirmOverwrite(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return true;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`⚠️ ${targetPath} already exists. Overwrite? (y/N) `, resolve));
  rl.close();
  return /^y(es)?$/i.test((answer || '').trim());
}

async function collectInputs() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers = {};

  console.log('Provide values for each variable. Press Enter to accept the default or leave blank.');

  const ask = (field) => {
    const defaultLabel = field.defaultValue ? ` [${field.defaultValue}]` : '';
    const question = `${field.prompt}${defaultLabel}: `;
    return new Promise((resolve) => {
      rl.question(question, (input) => {
        const value = input.trim();
        if (value) {
          resolve(value);
        } else if (field.defaultValue !== undefined) {
          resolve(field.defaultValue);
        } else {
          resolve('');
        }
      });
    });
  };

  for (const section of SECTIONS) {
    for (const field of section.fields) {
      // eslint-disable-next-line no-await-in-loop
      answers[field.key] = await ask(field);
    }
  }

  rl.close();
  return answers;
}

function buildEnvContent(values) {
  const lines = [];
  SECTIONS.forEach((section, index) => {
    if (index > 0) {
      lines.push('');
    }
    lines.push(...section.comments);
    section.fields.forEach((field) => {
      lines.push(`${field.key}=${values[field.key] ?? ''}`);
    });
  });
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const targetPath = path.resolve(__dirname, '.env');
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

  if (!(await confirmOverwrite(targetPath))) {
    console.log('Skipping overwrite.');
    return;
  }

  const values = await collectInputs();
  const content = buildEnvContent(values);
  await fs.promises.writeFile(targetPath, content, 'utf8');
  console.log(`✅ Created ${targetPath}`);
  console.log('   Update any remaining blanks before starting the API.');
  console.log('   Optional advanced settings reference: api/.env.advanced.example');
}

main().catch((error) => {
  console.error('❌ Failed to scaffold API .env file:', error.message);
  process.exit(1);
});
