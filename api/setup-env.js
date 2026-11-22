#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const SECTIONS = [
  {
    comments: [
      '# --- API Environment --------------------------',
      '# Speko is the default voice provider; SMS remains separate.',
    ],
    fields: [
      { key: 'CALL_PROVIDER', prompt: 'Voice provider (speko|twilio|plivo|vonage)', defaultValue: 'speko', choices: ['speko', 'twilio', 'plivo', 'vonage'] },
      { key: 'SMS_PROVIDER', prompt: 'SMS provider (twilio|plivo|vonage)', defaultValue: 'twilio', choices: ['twilio', 'plivo', 'vonage'] },
      { key: 'EMAIL_PROVIDER', prompt: 'Primary email provider', defaultValue: 'sendgrid' },
    ],
  },
  {
    comments: ['# API security and server'],
    fields: [
      { key: 'API_SECRET', prompt: 'API Secret (press Enter to generate securely)' },
      { key: 'PORT', prompt: 'API Port', defaultValue: '3000' },
      { key: 'SERVER', prompt: 'Public HTTPS API hostname (domain only, no path; optional)' },
      { key: 'CORS_ORIGINS', prompt: 'Allowed web origins, comma-separated (optional)' },
    ],
  },
  {
    comments: ['# Speko voice calls'],
    includeWhen: (values) => String(values.CALL_PROVIDER || '').toLowerCase() === 'speko',
    fields: [
      { key: 'SPEKO_ENABLED', prompt: 'Enable Speko calls?', defaultValue: 'true' },
      { key: 'SPEKO_EXCLUSIVE_MODE', prompt: 'Lock all voice calls to Speko?', defaultValue: 'true' },
      { key: 'SPEKO_AGENT_RELEASE_GATE_REQUIRED', prompt: 'Require the agent release checklist?', defaultValue: 'true' },
      { key: 'SPEKO_INBOUND_ENABLED', prompt: 'Enable Speko inbound calls?', defaultValue: 'false' },
      { key: 'SPEKO_INBOUND_PHONE_NUMBER', prompt: 'Speko inbound phone number (E.164; optional)' },
      { key: 'INBOUND_NUMBER_ROUTES', prompt: 'Inbound number routes (JSON object; optional)' },
      { key: 'SPEKO_API_KEY', prompt: 'Speko API Key' },
      { key: 'SPEKO_WEBHOOK_SECRET', prompt: 'Speko Webhook Secret (whsec_...)' },
      { key: 'SPEKO_BASE_URL', prompt: 'Speko API URL', defaultValue: 'https://api.speko.dev' },
      { key: 'SPEKO_MONTHLY_SPEND_LIMIT_USD', prompt: 'Monthly spend limit in USD (0 disables)', defaultValue: '0' },
      { key: 'SPEKO_LOW_BALANCE_ALERT_USD', prompt: 'Low balance alert threshold in USD (0 disables)', defaultValue: '0' },
      { key: 'SPEKO_RECONCILE_INTERVAL_MS', prompt: 'Stale call check interval in milliseconds', defaultValue: '120000' },
      { key: 'SPEKO_RECONCILE_STALE_MINUTES', prompt: 'Reconcile calls older than minutes', defaultValue: '5' },
    ],
  },
  {
    comments: ['# Twilio credentials'],
    includeWhen: (values) => [values.CALL_PROVIDER, values.SMS_PROVIDER].some((provider) => String(provider || '').toLowerCase() === 'twilio'),
    fields: [
      { key: 'TWILIO_ACCOUNT_SID', prompt: 'Twilio Account SID' },
      { key: 'TWILIO_AUTH_TOKEN', prompt: 'Twilio Auth Token' },
      { key: 'FROM_NUMBER', prompt: 'Twilio From Number (E.164)' },
    ],
  },
  {
    comments: ['# Plivo credentials'],
    includeWhen: (values) => [values.CALL_PROVIDER, values.SMS_PROVIDER].some((provider) => String(provider || '').toLowerCase() === 'plivo'),
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
    comments: ['# Vonage credentials', '# Provide either PEM contents (use \\n escapes) or a private-key file path.'],
    includeWhen: (values) => [values.CALL_PROVIDER, values.SMS_PROVIDER].some((provider) => String(provider || '').toLowerCase() === 'vonage'),
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
    comments: ['# SendGrid email credentials'],
    includeWhen: (values) => String(values.EMAIL_PROVIDER || '').toLowerCase() === 'sendgrid',
    fields: [
      { key: 'SENDGRID_API_KEY', prompt: 'SendGrid API Key (optional)' },
      { key: 'EMAIL_DEFAULT_FROM', prompt: 'Verified sender email (optional)' },
    ],
  },
  {
    comments: ['# OpenRouter AI configuration'],
    fields: [
      { key: 'OPENROUTER_API_KEY', prompt: 'OpenRouter API Key' },
    ],
  },
  {
    comments: ['# Deepgram configuration'],
    fields: [
      { key: 'DEEPGRAM_API_KEY', prompt: 'Deepgram API Key' },
    ],
  },
  {
    comments: ['# Telegram webhook fallback'],
    fields: [
      { key: 'TELEGRAM_BOT_TOKEN', prompt: 'Telegram Bot Token (optional fallback)' },
    ],
  },
];

function selectedSections(values) {
  return SECTIONS.filter((section) => !section.includeWhen || section.includeWhen(values));
}

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

  const ask = async (field) => {
    const defaultLabel = field.defaultValue ? ` [${field.defaultValue}]` : '';
    const question = `${field.prompt}${defaultLabel}: `;
    const answer = await new Promise((resolve) => {
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
    const normalized = String(answer || '').toLowerCase();
    if (field.choices && !field.choices.includes(normalized)) {
      console.log(`Choose one of: ${field.choices.join(', ')}.`);
      return ask(field);
    }
    return field.choices ? normalized : answer;
  };

  for (const section of SECTIONS) {
    if (section.includeWhen) continue;
    for (const field of section.fields) {
      // eslint-disable-next-line no-await-in-loop
      answers[field.key] = await ask(field);
    }
  }

  for (const section of SECTIONS) {
    if (!section.includeWhen || !section.includeWhen(answers)) continue;
    for (const field of section.fields) {
      // eslint-disable-next-line no-await-in-loop
      answers[field.key] = await ask(field);
    }
  }

  rl.close();
  if (!answers.API_SECRET) answers.API_SECRET = crypto.randomBytes(32).toString('base64url');
  return answers;
}

function buildEnvContent(values) {
  const lines = [];
  selectedSections(values).forEach((section, index) => {
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
  if (!values.SPEKO_API_KEY || !values.SPEKO_WEBHOOK_SECRET) {
    console.log('   Add your Speko API key and webhook secret before using Speko. Select an agent in the Telegram call flow; SPEKO_AGENT_ID is only an optional legacy default.');
  }
  if (String(values.CALL_PROVIDER || '').toLowerCase() === 'speko') {
    console.log('   Speko exclusive mode locks voice provider switching and cross-provider failover.');
    console.log('   After starting the API, run: npm run preflight:provider --prefix api -- --channel call --provider speko --network 1 --reachability 1');
  }
  console.log('   Update any remaining blanks before starting the API.');
  console.log('   Optional advanced settings reference: api/.env.advanced.example');
}

if (require.main === module) {
  require('./utils/bootstrapLogger');
  main().catch((error) => {
    console.error('❌ Failed to scaffold API .env file:', error.message);
    process.exit(1);
  });
}

module.exports = { SECTIONS, selectedSections, buildEnvContent };
