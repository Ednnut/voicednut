'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_TELEGRAM_ID ||= '1';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= 'test-token';
process.env.API_SECRET ||= 'test-api-secret';

const httpClient = require('../utils/httpClient');

const {
  ACTIONS,
  buildCartesiaKeyboard,
  cartesiaOperationFlow,
  __testables: {
    buildReconciliationPayload, buildAgentChoices, formatAgentChoices,
    formatPhoneNumberChoices, maskDestination, pendingRequestMatches,
    runCartesiaAgentRuntime, runCartesiaCallOperations, formatCallDetails, formatCallTranscript, formatCampaignOutcomes,
    formatCampaignStatus,
    runCartesiaBusinessScope,
  },
} = require('./cartesiaOperations');

test('Cartesia operations keep single calls outside the Cartesia action set', () => {
  assert.equal(ACTIONS.has('CARTESIA_CALL'), false);
  assert.equal(ACTIONS.has('CARTESIA_RECONCILE'), true);
  assert.equal(ACTIONS.has('CARTESIA_BATCH'), false);
  assert.equal(ACTIONS.has('CARTESIA_CALLS'), true);
  assert.equal(ACTIONS.has('CARTESIA_CAMPAIGN'), false);
  assert.equal(ACTIONS.has('CARTESIA_CAMPAIGN_STATUS'), true);
  assert.equal(ACTIONS.has('CARTESIA_CAMPAIGN_RECONCILE'), true);
  assert.equal(ACTIONS.has('CARTESIA_BATCH_RECONCILE'), true);
  assert.equal(ACTIONS.has('CARTESIA_BATCH_CANCEL'), true);
  assert.equal(ACTIONS.has('CARTESIA_BATCH_RETRY'), false);
  assert.equal(ACTIONS.has('CARTESIA_AGENT_HEALTH'), true);
  assert.equal(ACTIONS.has('CARTESIA_AGENT_RUNTIME'), true);
  assert.equal(ACTIONS.has('CARTESIA_REVIEW_RULES'), true);
  assert.equal(ACTIONS.has('CARTESIA_REVIEW_QUEUE'), true);
  assert.equal(ACTIONS.has('CARTESIA_BUSINESS_SCOPE'), true);
});

test('Cartesia single-call action is not handled by the Cartesia operations flow', () => {
  const keyboard = buildCartesiaKeyboard({ session: {} });
  const callback = keyboard.inline_keyboard.flat().find((button) => button.text.includes('Place a single call'));
  assert.ok(callback);
  assert.match(callback.callback_data, /CALL/);
  const reconcile = keyboard.inline_keyboard.flat().find((button) => button.text.includes('Reconcile a call'));
  assert.ok(reconcile);
  assert.match(reconcile.callback_data, /CARTESIA_RECONCILE/);
  const calls = keyboard.inline_keyboard.flat().find((button) => button.text.includes('Recent calls'));
  assert.ok(calls);
  assert.match(calls.callback_data, /CARTESIA_CALLS/);
  assert.equal(keyboard.inline_keyboard.flat().some((button) => button.text.includes('Plan a batch campaign')), false);
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_BATCH_RECONCILE/.test(button.callback_data)));
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_BATCH_CANCEL/.test(button.callback_data)));
  assert.equal(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_BATCH_RETRY/.test(button.callback_data)), false);
  const campaignReconcile = keyboard.inline_keyboard.flat().find((button) => button.callback_data.includes('CARTESIA_CAMPAIGN_RECONCILE'));
  assert.ok(campaignReconcile);
  assert.match(campaignReconcile.text, /provider progress/i);
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_STUDIO_CENTER/.test(button.callback_data)));
  const health = keyboard.inline_keyboard.flat().find((button) => button.callback_data.includes('CARTESIA_AGENT_HEALTH'));
  assert.ok(health);
  assert.match(health.text, /health/i);
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_AGENT_RUNTIME/.test(button.callback_data)));
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_REVIEW_RULES/.test(button.callback_data)));
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_BUSINESS_SCOPE/.test(button.callback_data)));
});

test('Cartesia business-scope workflow previews and explicitly approves a private tenant mapping', async () => {
  const originalPost = httpClient.post;
  const originalPut = httpClient.put;
  const requests = [];
  const replies = [];
  const phoneNumberId = 'pn_test_01';
  const businessId = 'business-01';
  const fingerprint = 'a'.repeat(64);
  httpClient.post = async (_ctx, url, body, options) => {
    requests.push({ method: 'post', url, body, options });
    return { data: { preview: {
      phoneNumberId, phoneNumber: '+15555550123', agentId: 'agent_test_01',
      businessId, currentBusinessId: null, requestFingerprint: fingerprint,
    } } };
  };
  httpClient.put = async (_ctx, url, body, options) => {
    requests.push({ method: 'put', url, body, options });
    return { data: { scope: { phoneNumberId, businessId, idempotentReplay: false } } };
  };
  const answers = [
    { message: { text: phoneNumberId } },
    { message: { text: businessId } },
    { message: { text: `SET CARTESIA BUSINESS SCOPE ${phoneNumberId} TO ${businessId}` } },
  ];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_BUSINESS_SCOPE' },
    async reply(message) { replies.push(String(message)); },
  };
  try {
    await cartesiaOperationFlow({ async wait() { return answers.shift(); } }, ctx);
  } finally {
    httpClient.post = originalPost;
    httpClient.put = originalPut;
  }
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/business-scope\/preview$/);
  assert.deepEqual(requests[0].body, { business_id: businessId });
  assert.match(requests[1].url, /\/business-scope$/);
  assert.equal(requests[1].body.approved, true);
  assert.equal(requests[1].body.confirmed_fingerprint, fingerprint);
  assert.match(requests[1].body.idempotency_key, /^scope-[\da-f-]{36}$/);
  assert.match(JSON.stringify(replies), /••••0123/);
  assert.doesNotMatch(JSON.stringify(replies), /\+15555550123/);
});

test('Cartesia business-scope workflow cancels without a write when the exact phrase is not provided', async () => {
  const originalPost = httpClient.post;
  const originalPut = httpClient.put;
  let writes = 0;
  httpClient.post = async () => ({ data: { preview: {
    phoneNumberId: 'pn_test_01', phoneNumber: '+15555550123', agentId: 'agent_test_01',
    businessId: 'business-01', currentBusinessId: null, requestFingerprint: 'b'.repeat(64),
  } } });
  httpClient.put = async () => { writes += 1; return { data: {} }; };
  const answers = [
    { message: { text: 'pn_test_01' } },
    { message: { text: 'business-01' } },
    { message: { text: 'yes' } },
  ];
  const replies = [];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_BUSINESS_SCOPE' },
    async reply(message) { replies.push(String(message)); },
  };
  try {
    await cartesiaOperationFlow({ async wait() { return answers.shift(); } }, ctx);
  } finally {
    httpClient.post = originalPost;
    httpClient.put = originalPut;
  }
  assert.equal(writes, 0);
  assert.match(replies.join('\n'), /canceled/i);
});

test('Cartesia review formatting escapes transcript content and campaign outcomes are readable', () => {
  const review = formatCallDetails({ callId: 'call_1', agentId: 'agent_1', status: 'failed', review: { required: true, reasons: ['call_failed'] }, summary: '<script>x</script>' });
  assert.match(review, /Review: <b>required<\/b>/);
  assert.doesNotMatch(review, /<script>/);
  const transcript = formatCallTranscript({ transcript: [{ role: 'user', text: '<img src=x>', toolNames: ['lookup'] }] }).join('\n');
  assert.doesNotMatch(transcript, /<img/);
  assert.match(transcript, /&lt;img/);
  assert.doesNotMatch(transcript, /private argument|private result/);
  assert.match(formatCampaignOutcomes({ outcome_summary: { total: 4, eligible: 4, blocked: 0, completed: 2, failed: 1, unanswered: 0, pending: 1, unknown: 0, completion_rate_percent: 50 } }), /Completion rate: 50% \(2\/4 eligible recipients\)/);
});

test('campaign status gives state-specific next steps and avoids unsafe retries', () => {
  const queued = formatCampaignStatus({
    campaign_id: `cartesia_campaign_${'a'.repeat(64)}`,
    status: 'approved',
    dispatch_queued: true,
    ready_count: 101,
    recipient_count: 101,
  });
  assert.match(queued, /Queued on VOICEDNUT/);
  assert.match(queued, /do not create a duplicate/);
  const unknown = formatCampaignStatus({
    campaign_id: `cartesia_campaign_${'b'.repeat(64)}`,
    status: 'unknown',
    error_code: '<img src=x>',
  });
  assert.match(unknown, /do not resubmit/);
  assert.doesNotMatch(unknown, /<img/);
  assert.match(unknown, /&lt;img/);
});

test('campaign reconciliation explicitly refreshes provider progress through the protected API flow', async () => {
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const campaignId = `cartesia_campaign_${'c'.repeat(64)}`;
  httpClient.post = async (_ctx, url, body, options) => {
    requests.push({ url, body, options });
    return { data: { campaign: {
      campaign_id: campaignId, status: 'submitted', provider_batch_id: 'batch_test_01',
      ready_count: 1, recipient_count: 1,
      outcome_summary: { total: 1, eligible: 1, completed: 1, failed: 0, unanswered: 0, pending: 0, not_started: 0, blocked: 0, unknown: 0, completion_rate_percent: 100 },
    } } };
  };
  const answers = [{ message: { text: 'biz-1' } }, { message: { text: campaignId } }];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CAMPAIGN_RECONCILE' },
    async reply(message) { replies.push(String(message)); },
  };
  try {
    await cartesiaOperationFlow({ async wait() { return answers.shift(); } }, ctx);
  } finally {
    httpClient.post = originalPost;
  }
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, new RegExp(`/api/cartesia/campaigns/${campaignId}/reconcile$`));
  assert.deepEqual(requests[0].body, { business_id: 'biz-1' });
  assert.equal(requests[0].options.timeout, 20000);
  assert.match(replies.join('\n'), /Provider progress refreshed/);
  assert.match(replies.join('\n'), /provider batch was accepted/);
  assert.match(replies.join('\n'), /completed/);
});

test('Managed Agent runtime status is available through the interactive bot flow', async () => {
  const originalGet = httpClient.get;
  const replies = [];
  let requestCount = 0;
  httpClient.get = async (_ctx, url) => {
    requestCount += 1;
    if (url.endsWith('/api/cartesia/agents')) return { data: { agents: [{ id: 'agent_1', name: 'Support', phoneNumbers: [] }] } };
    return { data: { agent_id: 'agent_1', enabled: true, websocket_path: '/api/cartesia/agents/agent_1/runtime',
      audio_input_formats: ['pcm_16000'], supported_tool_handlers: ['get_campaign_status'] } };
  };
  const answers = ['biz-1', '1'].map((text) => ({ message: { text } }));
  const ctx = { from: { id: 1 }, async reply(message) { replies.push(String(message)); } };
  try { await runCartesiaAgentRuntime({ async wait() { return answers.shift(); } }, ctx, () => {}); }
  finally { httpClient.get = originalGet; }
  assert.equal(requestCount, 2);
  assert.match(replies.join('\n'), /runtime: <b>enabled<\/b>/);
  assert.match(replies.join('\n'), /get_campaign_status/);
  assert.doesNotMatch(replies.join('\n'), /No provider session was started/);
});

test('interactive private admin health flow displays sanitized Cartesia deployment status', async () => {
  const originalGet = httpClient.get;
  const requests = [];
  const replies = [];
  httpClient.get = async (_ctx, url) => {
    requests.push(url);
    if (url.endsWith('/api/cartesia/agents')) return { data: { agents: [{ id: 'agent_1', name: 'Support', ready: false, deleted: false, phoneNumbers: [] }] } };
    return { data: { agent: { id: 'agent_1', name: 'Support', attachedNumberCount: 0, deploymentCount: 1 }, ready: false,
      warnings: ['no_attached_phone_number'], deployments: [{ id: 'deploy_1', status: 'failed', isLive: false, isPinned: false, buildFailed: true }] } };
  };
  const ctx = {
    chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_AGENT_HEALTH' },
    async reply(text, options) { replies.push({ text, options }); },
  };
  const conversation = { async wait() { return { message: { text: '1' } }; } };
  try { await cartesiaOperationFlow(conversation, ctx); }
  finally { httpClient.get = originalGet; }
  assert.equal(requests.length, 2);
  assert.match(requests[1], /\/api\/cartesia\/agents\/agent_1\/health$/);
  assert.match(replies.at(-1).text, /Needs attention/);
  assert.match(replies.at(-1).text, /deploy_1/);
  assert.doesNotMatch(replies.at(-1).text, /secret|private|build_logs/);
});

test.skip('retired direct Cartesia campaign creation for more than 25 recipients', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const campaignId = `cartesia_campaign_${'f'.repeat(64)}`;
  const destinations = Array.from({ length: 26 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`);
  const responses = [
    { message: { text: 'biz-1' } }, { message: { text: '1' } }, { message: { text: '1' } },
    { message: { text: 'Larger campaign' } }, { message: { text: destinations.join('\n') } },
    { message: { text: '1' } }, { message: { text: '{}' } }, { message: { text: 'now' } },
    { message: { text: `SUBMIT CARTESIA CAMPAIGN ${campaignId} WITH 26 RECIPIENTS` } },
  ];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CAMPAIGN' },
    async reply(message) { replies.push(String(message)); },
  };
  httpClient.get = async () => ({ data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'number_1', displayNumber: '••••0111' }] }] } });
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ url, body });
    if (url.endsWith('/api/cartesia/campaigns')) return { data: { campaign: {
      campaign_id: campaignId, ready_count: 26, recipient_count: 26,
      recipients: destinations.map((destination) => ({ status: 'ready', destination_masked: `+••••${destination.slice(-4)}`, reason_code: 'ready' })),
    } } };
    return { data: { campaign: { status: 'submitted', provider_batch_id: 'batch_1' } } };
  };
  try { await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(requests[0].body.destinations.length, 26);
  assert.equal(requests[1].body.confirmation_phrase, `SUBMIT CARTESIA CAMPAIGN ${campaignId} WITH 26 RECIPIENTS`);
  assert.ok(replies.some((message) => message.includes('16 additional recipients omitted')));
  assert.ok(replies.every((message) => !destinations.some((destination) => message.includes(destination))));
});

test.skip('retired direct Cartesia campaign creation for more than 100 recipients', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const campaignId = `cartesia_campaign_${'e'.repeat(64)}`;
  const destinations = Array.from({ length: 101 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`);
  const responses = [
    { message: { text: 'biz-1' } }, { message: { text: '1' } }, { message: { text: '1' } },
    { message: { text: 'Large campaign' } },
    { message: { text: destinations.slice(0, 100).join('\n') } },
    { message: { text: destinations[100] } },
    { message: { text: '1' } }, { message: { text: '{}' } }, { message: { text: 'now' } },
    { message: { text: `SUBMIT CARTESIA CAMPAIGN ${campaignId} WITH 101 RECIPIENTS` } },
  ];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CAMPAIGN' },
    async reply(message) { replies.push(String(message)); },
  };
  httpClient.get = async () => ({ data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'number_1', displayNumber: '••••0111' }] }] } });
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ url, body });
    if (url.endsWith('/api/cartesia/campaigns')) return { data: { campaign: {
      campaign_id: campaignId, ready_count: 101, recipient_count: 101,
      recipients: destinations.map((destination) => ({ status: 'ready', destination_masked: `+••••${destination.slice(-4)}`, reason_code: 'ready' })),
    } } };
    return { data: { queued_for_async_dispatch: true, campaign: { status: 'approved', dispatch_queued: true } } };
  };
  try { await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(requests[0].body.destinations.length, 101);
  assert.deepEqual(requests[0].body.destinations, destinations);
  assert.equal(requests[1].body.confirmation_phrase, `SUBMIT CARTESIA CAMPAIGN ${campaignId} WITH 101 RECIPIENTS`);
  assert.ok(replies.some((message) => message.includes('queues the approved campaign for background dispatch')));
  assert.ok(replies.some((message) => message.includes('Queued for asynchronous dispatch')));
});

test.skip('retired direct Cartesia campaign input validation', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const destinations = Array.from({ length: 101 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`);
  const responses = [
    { message: { text: 'biz-1' } }, { message: { text: '1' } }, { message: { text: '1' } },
    { message: { text: 'Too many' } }, { message: { text: destinations.join('\n') } },
  ];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CAMPAIGN' },
    async reply(message) { replies.push(String(message)); },
  };
  httpClient.get = async () => ({ data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'number_1', displayNumber: '••••0111' }] }] } });
  httpClient.post = async (_ctx, url, body) => { requests.push({ url, body }); return { data: {} }; };
  try { await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(requests.length, 0);
  assert.ok(replies.some((message) => message.includes('Provide 1–100 valid E.164 numbers')));
});

test.skip('retired direct Cartesia campaign submission', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const campaignId = `cartesia_campaign_${'a'.repeat(64)}`;
  const responses = [
    { message: { text: 'biz-1' } }, { message: { text: '1' } }, { message: { text: '1' } },
    { message: { text: 'Renewal reminders' } }, { message: { text: '+14155550123' } }, { message: { text: '1' } },
    { message: { text: '{}' } }, { message: { text: 'now' } },
    { message: { text: `SUBMIT CARTESIA CAMPAIGN ${campaignId} WITH 1 RECIPIENTS` } },
  ];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CAMPAIGN' },
    async reply(message) { replies.push(String(message)); },
  };
  const conversation = { async wait() { return responses.shift(); } };
  httpClient.get = async (_ctx, url) => {
    requests.push({ method: 'GET', url });
    return { data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'number_1', displayNumber: '••••0111' }] }] } };
  };
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ method: 'POST', url, body });
    if (url.endsWith('/api/cartesia/campaigns')) return { data: { campaign: {
      campaign_id: campaignId, ready_count: 1, recipient_count: 1,
      recipients: [{ status: 'ready', destination_masked: '+•••••••0123', reason_code: 'ready' }],
    } } };
    return { data: { campaign: { status: 'submitted', provider_batch_id: 'batch_1' } } };
  };
  try { await cartesiaOperationFlow(conversation, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'POST', 'POST']);
  assert.equal(requests[1].body.destinations[0], '+14155550123');
  assert.equal(requests[2].url.endsWith(`/api/cartesia/campaigns/${campaignId}/submit`), true);
  assert.equal(requests[2].body.confirmation_phrase, `SUBMIT CARTESIA CAMPAIGN ${campaignId} WITH 1 RECIPIENTS`);
  assert.equal(ctx.session.cartesiaCampaignPending.campaignId, campaignId);
  assert.ok(replies.some((message) => message.includes('Ready: 1/1')));
  assert.doesNotMatch(replies.join('\n'), /\+14155550123/);
});

test.skip('retired direct Cartesia scheduled campaign submission', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const campaignId = `cartesia_campaign_${'d'.repeat(64)}`;
  const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const responses = [
    { message: { text: 'biz-1' } }, { message: { text: '1' } }, { message: { text: '1' } },
    { message: { text: 'Renewal reminders' } }, { message: { text: '+14155550123' } }, { message: { text: '1' } },
    { message: { text: '{}' } }, { message: { text: scheduledAt } },
    { message: { text: `SUBMIT CARTESIA CAMPAIGN ${campaignId} WITH 1 RECIPIENTS AT ${scheduledAt}` } },
  ];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CAMPAIGN' },
    async reply(message) { replies.push(String(message)); },
  };
  const conversation = { async wait() { return responses.shift(); } };
  httpClient.get = async () => ({ data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'number_1', displayNumber: '••••0111' }] }] } });
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ url, body });
    if (url.endsWith('/api/cartesia/campaigns')) return { data: { campaign: {
      campaign_id: campaignId, scheduled_at: scheduledAt, ready_count: 1, recipient_count: 1,
      recipients: [{ status: 'ready', destination_masked: '+•••••••0123', reason_code: 'ready' }],
    } } };
    return { data: { campaign: { status: 'submitted', provider_batch_id: 'batch_1' } } };
  };
  try { await cartesiaOperationFlow(conversation, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.scheduled_at, scheduledAt);
  assert.equal(requests[1].body.confirmation_phrase, `SUBMIT CARTESIA CAMPAIGN ${campaignId} WITH 1 RECIPIENTS AT ${scheduledAt}`);
  const preview = replies.findIndex((message) => message.includes(`${scheduledAt} UTC`));
  const approvalPrompt = replies.findIndex((message) => message.includes(`type this exact phrase: SUBMIT CARTESIA CAMPAIGN ${campaignId}`));
  assert.ok(preview >= 0 && approvalPrompt >= 0);
});

test('interactive batch cancellation remains enabled and retry is rejected', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const campaignId = `cartesia_campaign_${'b'.repeat(64)}`;
  const pendingCampaign = { campaign_id: campaignId, provider_batch_id: 'batch_1', provider_status: 'pending', provider_retry_count: 0,
    recipients: [{ destination_masked: '+••••0123', provider_status: 'failed' }] };
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_BATCH_CANCEL',
      cartesiaCampaignPending: { businessId: 'biz-1', campaignId } },
    async reply(message) { replies.push(String(message)); },
  };
  const responses = [{ message: { text: `CANCEL CARTESIA CAMPAIGN ${campaignId} BATCH batch_1` } }];
  httpClient.get = async () => ({ data: { campaign: pendingCampaign } });
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ url, body });
    if (url.endsWith('/reconcile')) return { data: { campaign: pendingCampaign } };
    return { data: { campaign: { provider_status: 'cancelled' }, retried_recipient_count: 1 } };
  };
  try {
    await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/reconcile$/);
    assert.match(requests[1].url, /\/cancel$/);
    assert.equal(requests[1].body.confirmation_phrase, `CANCEL CARTESIA CAMPAIGN ${campaignId} BATCH batch_1`);

    requests.length = 0;
    ctx.session.cartesiaOperationAction = 'CARTESIA_BATCH_RETRY';
    pendingCampaign.provider_status = 'completed';
    await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx);
    assert.equal(requests.length, 0);
    assert.ok(replies.some((text) => text.includes('batch retries are disabled')));
  } finally { httpClient.get = originalGet; httpClient.post = originalPost; }
});

test('stale campaign actions explain the unified call path without API requests', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const replies = [];
  const requests = [];
  httpClient.get = async () => { requests.push('GET'); return {}; };
  httpClient.post = async () => { requests.push('POST'); return {}; };
  for (const action of ['CARTESIA_CAMPAIGN', 'CARTESIA_BATCH_RETRY']) {
    const ctx = {
      from: { id: 7001 }, chat: { type: 'private' },
      session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: action },
      async reply(message) { replies.push(String(message)); },
    };
    await cartesiaOperationFlow({ async wait() { return undefined; } }, ctx);
  }
  httpClient.get = originalGet;
  httpClient.post = originalPost;
  assert.deepEqual(requests, []);
  assert.equal(replies.length, 2);
  assert.ok(replies.every((message) => message.includes('/call') && message.includes('disabled')));
});

test('Cartesia call operations browse sanitized history and require call-specific cancellation confirmation', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const responses = [
    { message: { text: 'biz-1' } },
    { message: { text: '1' } },
    { message: { text: '1' } },
    { message: { text: 'CANCEL CARTESIA CALL call_1' } },
  ];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CALLS' },
    async reply(message) { replies.push(String(message)); },
  };
  const conversation = { async wait() { return responses.shift(); } };
  httpClient.get = async (_ctx, url) => {
    requests.push({ method: 'GET', url });
    if (url.endsWith('/api/cartesia/agents')) return { data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'number_1' }] }] } };
    if (url.includes('/api/cartesia/calls?')) return { data: { calls: [{ callId: 'call_1', agentId: 'agent_1', status: 'started', startTime: '2026-10-31T10:00:00Z', to: '••••0123' }] } };
    return { data: { call: { callId: 'call_1', agentId: 'agent_1', status: 'started', startTime: '2026-10-31T10:00:00Z', endTime: null, from: '••••0111', to: '••••0123', canCancel: true } } };
  };
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ method: 'POST', url, body });
    return { data: { cancelled: true } };
  };
  try {
    await cartesiaOperationFlow(conversation, ctx);
  } finally {
    httpClient.get = originalGet;
    httpClient.post = originalPost;
  }
  assert.deepEqual(requests.map(({ method }) => method), ['GET', 'GET', 'GET', 'POST']);
  assert.match(requests[1].url, /agent_id=agent_1/);
  assert.deepEqual(requests[3].body, { business_id: 'biz-1', confirmation_phrase: 'CANCEL CARTESIA CALL call_1' });
  assert.ok(replies.some((message) => message.includes('only while it is started')));
  assert.ok(replies.some((message) => message.includes('was canceled')));
  assert.doesNotMatch(replies.join('\n'), /\+1415555/);
});

test('Cartesia transcript review requires a call-specific typed opt-in and never displays tool arguments or results', async () => {
  const originalGet = httpClient.get;
  const requests = [];
  const replies = [];
  const callId = 'call_review_1';
  const responses = [
    { message: { text: 'biz-1' } },
    { message: { text: '1' } },
    { message: { text: '1' } },
    { message: { text: `SHOW CARTESIA TRANSCRIPT ${callId}` } },
  ];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CALLS' },
    async reply(message) { replies.push(String(message)); },
  };
  httpClient.get = async (_ctx, url) => {
    requests.push(url);
    if (url.endsWith('/api/cartesia/agents')) return { data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'number_1' }] }] } };
    if (url.includes('/api/cartesia/calls?')) return { data: { calls: [{ callId, agentId: 'agent_1', status: 'completed', startTime: '2026-10-31T10:00:00Z' }] } };
    if (url.includes('include_transcript=true')) return { data: { call: { callId, transcript: [{ role: 'user', text: '<sensitive text>', toolNames: ['lookup'] }] } } };
    return { data: { call: { callId, agentId: 'agent_1', status: 'completed', summary: 'safe summary', toolNames: ['lookup'], review: { required: false, reasons: [] }, zdrEnabled: false, redactedAt: null } } };
  };
  try { await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; }
  assert.equal(requests.filter((url) => url.includes('include_transcript=true')).length, 1);
  assert.ok(replies.some((text) => text.includes('safe summary')));
  assert.ok(replies.some((text) => text.includes('&lt;sensitive text&gt;')));
  assert.doesNotMatch(replies.join('\n'), /\+1415555|private argument|private result/);
});

test('admins can configure the three persistent Cartesia post-call review rules interactively', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_REVIEW_RULES' },
    async reply(message) { replies.push(String(message)); },
  };
  const responses = ['biz-1', '2', '1', '1'].map((text) => ({ message: { text } }));
  httpClient.get = async (_ctx, url) => { requests.push({ method: 'GET', url }); return { data: { rules: { review_failed_calls: true, review_tool_calls: false, review_missing_summary: false } } }; };
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ method: 'POST', url, body });
    return { data: { rules: { ...body.rules, updated_at: '2026-10-31T00:00:00Z' } } };
  };
  try { await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(requests[0].method, 'GET');
  assert.match(requests[0].url, /business_id=biz-1/);
  assert.deepEqual(requests[1], { method: 'POST', url: 'http://127.0.0.1:3000/api/cartesia/review-rules', body: { business_id: 'biz-1', rules: { review_failed_calls: false, review_tool_calls: true, review_missing_summary: true } } });
  assert.match(replies.join('\n'), /review rules saved/);
});

test('reconciliation payload carries only the original call identity and authenticated actor', () => {
  assert.deepEqual(buildReconciliationPayload({
    businessId: 'biz-1', destination: '+14155550123', agentId: 'agent-1',
    fromNumberId: 'number-1', idempotencyKey: 'cartesia:request-0001',
  }, '7001'), {
    business_id: 'biz-1', actor_id: '7001', destination: '+14155550123', agent_id: 'agent-1',
    from_number_id: 'number-1', idempotency_key: 'cartesia:request-0001',
  });
  assert.deepEqual(buildReconciliationPayload({ businessId: 'biz-1', destination: '+14155550123', agentId: 'agent-1',
    fromNumberId: 'number-1', idempotencyKey: 'cartesia:request-0001', dynamicVariables: { first_name: ' Ada ' } }, '7001').dynamic_variables,
  { first_name: 'Ada' });
});

test('agent selector shows only active agents with attached source numbers', () => {
  const choices = buildAgentChoices([
    { id: 'agent-1', name: 'Support', ready: true, deploymentCount: 2, phoneNumbers: [{ id: 'number-1', displayNumber: '••••0123' }] },
    { id: 'agent-2', name: 'No source', ready: false, phoneNumbers: [] },
    { id: 'bad/id', name: 'Invalid ID', ready: true, phoneNumbers: [{ id: 'number-2' }] },
  ]);
  assert.equal(choices.length, 1);
  assert.match(formatAgentChoices(choices), /Support/);
  assert.match(formatPhoneNumberChoices(choices[0].phoneNumbers), /••••0123/);
  assert.doesNotMatch(formatAgentChoices(choices), /No source|Invalid ID/);
});

test('legacy Cartesia single-call action cannot initiate a call from Cartesia operations', async () => {
  const calls = [];
  const replies = [];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CALL' },
    async reply(message) { replies.push(String(message)); },
  };
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  httpClient.get = async (_ctx, url) => calls.push({ method: 'GET', url });
  httpClient.post = async (_ctx, url) => calls.push({ method: 'POST', url });
  try {
    await cartesiaOperationFlow({ async wait() { throw new Error('No input should be requested'); } }, ctx);
  } finally {
    httpClient.get = originalGet;
    httpClient.post = originalPost;
  }
  assert.deepEqual(calls, []);
  assert.equal(ctx.session.cartesiaCallPending, undefined);
  assert.match(replies.join('\n'), /Start a single call with \/call/i);
});

test('Cartesia operator summary masks the destination', () => {
  assert.equal(maskDestination('+14155550123'), '••••0123');
  assert.doesNotMatch(maskDestination('+14155550123'), /\+1415555/);
});

test('pending Cartesia requests can only be reused with the exact original scope', () => {
  const pending = {
    businessId: 'biz-1',
    destination: '+14155550123',
    agentId: 'agent-1',
    fromNumberId: 'number-1',
    idempotencyKey: 'cartesia:request-0001',
  };
  assert.equal(pendingRequestMatches(pending, pending), true);
  assert.equal(pendingRequestMatches(pending, { ...pending, destination: '+14155550124' }), false);
  assert.equal(pendingRequestMatches(pending, { ...pending, businessId: 'biz-2' }), false);
});

test('Cartesia call review downloads recordings only after exact private-chat confirmation', async () => {
  const originalGet = httpClient.get;
  const audio = Buffer.from([1, 2, 3]);
  const requests = [];
  httpClient.get = async (_ctx, url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/api/cartesia/agents')) return { data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, deploymentCount: 1, phoneNumbers: [{ id: 'number_1' }] }] } };
    if (url.includes('/api/cartesia/calls?')) return { data: { calls: [{ callId: 'call_1', status: 'completed', to: '••••0123' }] } };
    if (url.includes('/api/cartesia/calls/call_1/audio?')) return { data: audio };
    return { data: { call: { callId: 'call_1', status: 'completed', zdrEnabled: false, redactedAt: null } } };
  };
  const replies = [];
  const sentFiles = [];
  const answers = ['biz-1', '1', '1', 'no', 'DOWNLOAD CARTESIA CALL AUDIO call_1', 'done'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = {
    from: { id: 1 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() } },
    async reply(message) { replies.push(String(message)); },
    async replyWithAudio(file) { sentFiles.push(file); },
  };
  try { await runCartesiaCallOperations(conversation, ctx, () => {}); }
  finally { httpClient.get = originalGet; }
  assert.equal(sentFiles.length, 1, replies.join('\n'));
  assert.equal(sentFiles[0].filename, 'cartesia-call-call_1.wav');
  assert.equal(requests.at(-1).options.responseType, 'arraybuffer');
  assert.equal(requests.at(-1).options.retry.retries, 0);
  assert.match(replies.join('\n'), /download it to this private chat/);
});
