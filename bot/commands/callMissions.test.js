'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ADMIN_TELEGRAM_ID ||= '100000001';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'test-admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= '123456:mock-bot-token';
process.env.ADMIN_API_TOKEN ||= 'mock-api-token';
process.env.API_HMAC_SECRET ||= 'mock-api-hmac-secret';
const { callMissionCreateFlow } = require('./callMissions');
const httpClient = require('../utils/httpClient');

test('mission creation menu captures scheduled launch and budget reservation inputs before policy review', async () => {
  const priorGet = httpClient.get;
  const priorPost = httpClient.post;
  const campaignId = `campaign_${'a'.repeat(64)}`;
  const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const posts = [];
  httpClient.get = async () => ({ data: {
    campaign: { status: 'approved', template_id: 7 },
    recipients: [{ position: 0, destination_masked: '+••••0101' }],
  } });
  httpClient.post = async (_ctx, url, body, options) => {
    posts.push({ url, body, options });
    return { data: { mission: { mission_id: `mission_${'b'.repeat(64)}`, status: 'pending_approval', recipient_count: 1, scheduled_at: body.scheduled_at, budget_limit_minor: body.budget_limit_minor } } };
  };
  const answers = [
    '+14155550101',
    '{"type":"object","additionalProperties":false,"required":[],"properties":{}}',
    scheduledAt,
    '5000',
    'USD',
    '500',
    'YES CREATE MISSION',
  ];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const replies = [];
  const ctx = {
    match: `biz-mission ${campaignId} mission-idempotency-key`,
    from: { id: 100000001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, role: 'admin', checkedAt: Date.now() } },
    async reply(message) { replies.push(message); },
  };
  try { await callMissionCreateFlow(conversation, ctx); }
  finally { httpClient.get = priorGet; httpClient.post = priorPost; }
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/missions'));
  assert.equal(posts[0].body.scheduled_at, scheduledAt);
  assert.equal(posts[0].body.budget_limit_minor, 5000);
  assert.equal(posts[0].body.budget_currency, 'USD');
  assert.equal(posts[0].body.per_call_cost_ceiling_minor, 500);
  assert.ok(posts[0].options.headers['Idempotency-Key'].includes('mission-idempotency-key'));
  assert.match(replies.join('\n'), /No calls were placed/);
});
