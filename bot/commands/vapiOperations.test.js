'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ADMIN_TELEGRAM_ID ||= '1';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= 'test-token';
process.env.API_SECRET ||= 'test-api-secret';
const {
  ACTIONS,
  formatVapiMappingHealth,
  formatVapiCampaigns,
  formatVapiEvents,
  formatVapiPhoneNumbers,
  formatVapiStatus,
  formatVapiEvals,
  formatVapiEvalRuns,
  formatVapiSquads,
  formatVapiSquadDetail,
} = require('./vapiOperations');

test('Vapi interactive operations expose the simulation coverage workflow action', () => {
  assert.equal(ACTIONS.has('VAPI_SIMULATIONS'), true);
});

test('Vapi interactive operations expose eval review, create, and run workflows', () => {
  assert.equal(ACTIONS.has('VAPI_EVALS'), true);
  assert.equal(ACTIONS.has('VAPI_EVAL_CREATE'), true);
});

test('Vapi interactive operations expose squad inspection', () => {
  assert.equal(ACTIONS.has('VAPI_SQUADS'), true);
});

test('Vapi squad views show handoff topology while hiding assistant prompts and webhook URLs', () => {
  const list = formatVapiSquads([{ id: 'squad-1', name: 'Support', latest_version: 'v2', member_count: 2, handoff_count: 1 }]);
  assert.match(list, /squad-1/);
  assert.match(list, /1 handoffs/);
  const detail = formatVapiSquadDetail({
    id: 'squad-1', name: 'Support', latest_version: 'v2', members: [{
      position: 1, assistant_id: 'assistant-1', assistant_name: 'Front desk', assistant_version: 'v3',
      prompt: 'private prompt', handoffs: [{ type: 'assistant', target: 'Billing', description: 'billing questions' }],
      webhook_url: 'https://secret.example/route',
    }],
  });
  assert.match(detail, /Front desk/);
  assert.match(detail, /assistant → Billing/);
  assert.doesNotMatch(detail, /private prompt|secret\.example/);
});

test('Vapi eval summaries include status and cost while omitting transcripts', () => {
  const evals = formatVapiEvals([{ id: 'eval-safe', name: 'Greeting', messages: [{ content: 'private eval prompt' }] }]);
  assert.match(evals, /eval-safe/);
  assert.doesNotMatch(evals, /private eval prompt/);
  const runs = formatVapiEvalRuns([{ id: 'run-safe', status: 'ended', cost_usd: 0.025, results: [{ status: 'fail', messages: [{ content: 'private transcript' }] }] }]);
  assert.match(runs, /run-safe/);
  assert.match(runs, /\$0\.0250/);
  assert.doesNotMatch(runs, /private transcript/);
});

test('Vapi template health formatter exposes drift and eligible resync without config payloads', () => {
  const result = formatVapiMappingHealth({
    template_id: 9,
    template_version: 3,
    lifecycle_state: 'live',
    remote_check_configured: true,
    mappings: [{
      mapping_id: 11,
      template_version: 3,
      current_template: true,
      sync_status: 'synced',
      remote_status: 'available',
      remote_assistant_version: 'v4',
      drift_flags: ['remote_updated_after_sync'],
      resync_available: true,
      prompt: 'private prompt',
      assistant_id: 'private-assistant-id',
    }],
  });
  assert.match(result, /Mapping <code>11<\/code>/);
  assert.match(result, /remote_updated_after_sync/);
  assert.match(result, /Resync available/);
  assert.doesNotMatch(result, /private prompt|private-assistant-id/);
});

test('Vapi readiness formatter reports booleans without exposing credentials', () => {
  const result = formatVapiStatus({
    enabled: true,
    configured: true,
    webhook_configured: false,
    private_api_key: 'never-show-this',
  });
  assert.match(result, /Server credentials: configured/);
  assert.match(result, /Webhook: not configured/);
  assert.doesNotMatch(result, /never-show-this/);
});

test('Vapi event list excludes transcript and destination details', () => {
  const result = formatVapiEvents([{
    provider_call_id: 'call_safe_1',
    event_type: 'status-update',
    provider_status: 'in-progress',
    transcript: 'private transcript',
    destination_number: '+14155550123',
  }]);
  assert.match(result, /call_safe_1/);
  assert.doesNotMatch(result, /private transcript|\+14155550123/);
});

test('Vapi campaign drafts show identifiers and pinned template version only', () => {
  const result = formatVapiCampaigns([{
    campaign_id: 'campaign-safe',
    status: 'draft',
    template_id: 4,
    template_version: 7,
    contacts: ['+14155550123'],
  }]);
  assert.match(result, /template 4 v7/);
  assert.doesNotMatch(result, /\+14155550123/);
});

test('Vapi phone inventory formatter omits numbers in the private operator summary', () => {
  const result = formatVapiPhoneNumbers({ phoneNumbers: [{
    id: 'pn_safe_1',
    number: '+14155550123',
    status: 'active',
  }] });
  assert.match(result, /pn_safe_1/);
  assert.doesNotMatch(result, /\+14155550123/);
});
