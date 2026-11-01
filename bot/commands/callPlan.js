'use strict';

const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getAccessProfile } = require('../utils/capabilities');
const { startOperation, ensureOperationActive } = require('../utils/sessionState');
const { isValidPhone, isValidGoalText, isValidRegion, isValidLocale, parseResultSchema } = require('../utils/callPlanInputs');

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const CANCEL_WORDS = new Set(['cancel', 'exit', 'quit']);

function isCancel(value) {
  return CANCEL_WORDS.has(String(value || '').trim().toLowerCase());
}

async function askText(conversation, ctx, prompt, ensureActive, options = {}) {
  await ctx.reply(prompt);
  const update = await conversation.wait();
  ensureActive();
  const value = String(update?.message?.text || '').trim();
  if (isCancel(value)) return null;
  if (options.optional && (!value || value.toLowerCase() === 'skip')) return '';
  return value;
}

async function askValidatedText(conversation, ctx, prompt, ensureActive, validator, clarification, options = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await askText(conversation, ctx, prompt, ensureActive, options);
    if (value === null) return null;
    if (validator(value)) return value;
    await ctx.reply(`Clarification needed: ${clarification} (${2 - attempt} attempts left).`);
  }
  return null;
}

async function callPlanFlow(conversation, ctx) {
  const operationId = startOperation(ctx, 'call-plan');
  const ensureActive = () => ensureOperationActive(ctx, operationId);
  try {
    const access = await getAccessProfile(ctx);
    ensureActive();
    if (!access?.isAuthorized) {
      await ctx.reply('Access denied. CALL-E planning requires an authorized BOT account and current business operator membership.');
      return;
    }

    const businessId = await askText(conversation, ctx, 'Enter the business ID for the approved CALL-E templates. Type cancel to stop.', ensureActive);
    if (!businessId) return;
    if (!BUSINESS_ID_PATTERN.test(businessId)) {
      await ctx.reply('Business ID format is invalid.');
      return;
    }

    const goalText = await askValidatedText(conversation, ctx,
      'Describe the call outcome you want in one sentence (8–500 characters). Do not include a phone number. Type cancel to stop.',
      ensureActive, isValidGoalText, 'describe the intended outcome in 8–500 characters');
    if (!goalText) return;

    const templateResponse = await httpClient.post(ctx, `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/planner/suggest`, {
      business_id: businessId,
      actor_id: String(ctx.from?.id || ''),
      goal_text: goalText,
    }, { timeout: 12000 });
    ensureActive();
    const templates = Array.isArray(templateResponse?.data?.templates) ? templateResponse.data.templates : [];
    if (!templates.length) {
      await ctx.reply('No live CALL-E-compatible templates were found for that business.');
      return;
    }
    const templateLines = templates.map((template) =>
      `${template.template_id} · ${String(template.name || 'Unnamed').slice(0, 100)} · v${template.version} · ${Number(template.goal_match_percent) || 0}% keyword match`);
    await ctx.reply(`Choose a suggested live template (ranked by deterministic keyword overlap):\n${templateLines.join('\n')}\n\nType cancel to stop.`);
    const templateInput = String((await conversation.wait())?.message?.text || '').trim();
    ensureActive();
    if (isCancel(templateInput)) return;
    const template = templates.find((row) => Number(row.template_id) === Number(templateInput));
    if (!template) {
      await ctx.reply('Choose one of the listed template IDs.');
      return;
    }

    const phone = await askValidatedText(conversation, ctx, 'Enter the authorized destination in E.164 format. Type cancel to stop.', ensureActive,
      isValidPhone, 'enter a destination like +14155550123');
    if (!phone) return;
    const region = await askValidatedText(conversation, ctx, 'Optional destination region code (two letters), or type skip for inference.', ensureActive,
      isValidRegion, 'enter two letters or skip', { optional: true });
    if (region === null) return;
    const locale = await askValidatedText(conversation, ctx, 'Optional spoken locale such as en-US, or type skip for inference.', ensureActive,
      isValidLocale, 'enter a locale such as en-US or skip', { optional: true });
    if (locale === null) return;
    let resultSchema = null;
    for (let attempt = 0; attempt < 3 && !resultSchema; attempt += 1) {
      const schemaText = await askText(conversation, ctx,
        'Send the result schema as JSON. Use a flat object with scalar fields; example: {"type":"object","additionalProperties":false,"required":["confirmed"],"properties":{"confirmed":{"type":"boolean"}}}. Type cancel to stop.', ensureActive);
      if (!schemaText) return;
      resultSchema = parseResultSchema(schemaText);
      if (!resultSchema) await ctx.reply(`Clarification needed: the result schema must be a JSON object (${2 - attempt} attempts left).`);
    }
    if (!resultSchema) return;

    let plan = {};
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await httpClient.post(ctx, `${config.apiUrl.replace(/\/+$/, '')}/api/call-e/planner/preview`, {
        business_id: businessId,
        actor_id: String(ctx.from?.id || ''),
        template_id: Number(template.template_id),
        phone,
        region: region || null,
        locale: locale || null,
        result_schema: resultSchema,
      }, { timeout: 15000 });
      ensureActive();
      plan = response?.data?.plan || {};
      const schemaErrors = Array.isArray(plan.schema_errors) ? plan.schema_errors : [];
      if (!schemaErrors.length || attempt === 2) break;
      await ctx.reply(`The schema needs these corrections:\n${schemaErrors.slice(0, 5).map((item) => `• ${String(item).slice(0, 150)}`).join('\n')}`);
      const correctedText = await askValidatedText(conversation, ctx, 'Send a corrected result schema as a JSON object, or type cancel to stop.', ensureActive,
        (value) => parseResultSchema(value) !== null, 'the result schema must be a JSON object');
      if (correctedText === null) return;
      resultSchema = parseResultSchema(correctedText);
    }
    const questions = Array.isArray(plan.clarification_questions) ? plan.clarification_questions : [];
    const lines = [
      `Template: ${String(plan.template_name || template.name)} v${Number(plan.template_version) || Number(template.version)}`,
      `Goal: ${String(plan.goal_preview || 'Template task is unavailable').slice(0, 500)}`,
      `Destination: ${String(plan.destination_masked || 'masked')}`,
      `Result fields: ${Array.isArray(plan.result_fields) ? plan.result_fields.join(', ') : 'none'}`,
      `Template compatible: ${plan.compatible === true ? 'yes' : 'no'}`,
      `Current consent: ${plan.consent_eligible === true ? 'eligible' : 'blocked'}`,
      ...(questions.length ? ['Clarifications:', ...questions.map((question) => `• ${String(question).slice(0, 240)}`)] : []),
      ...(Array.isArray(plan.schema_errors) && plan.schema_errors.length
        ? ['Schema corrections:', ...plan.schema_errors.slice(0, 8).map((message) => `• ${String(message).slice(0, 180)}`)]
        : []),
      ...(Array.isArray(plan.unsupported) && plan.unsupported.length ? [`Unsupported behavior: ${plan.unsupported.join(', ')}`] : []),
      'Planning only: no call was placed and nothing was saved.',
    ];
    await ctx.reply(lines.join('\n'));
  } catch (error) {
    if (error?.response?.status === 403) {
      await ctx.reply('Access denied. Your BOT account must have current CALL-E operator membership for the selected business.');
      return;
    }
    await ctx.reply(httpClient.getUserMessage(error, 'CALL-E planning could not be completed. No call was placed.'));
  }
}

function registerCallPlanCommand(bot) {
  bot.command('callplan', async (ctx) => {
    await ctx.conversation.enter('call-plan-conversation');
  });
}

module.exports = { callPlanFlow, registerCallPlanCommand, askValidatedText };
