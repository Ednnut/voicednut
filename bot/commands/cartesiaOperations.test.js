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
  buildCallConfirmationPhrase,
  cartesiaOperationFlow,
  __testables: {
    buildConfirmationPhrase, buildReconciliationPayload, buildAgentChoices, formatAgentChoices,
    formatPhoneNumberChoices, maskDestination, pendingRequestMatches,
    normalizeCampaignSchedule, campaignSubmitPhrase,
    runCartesiaAgentRuntime, runCartesiaCallOperations, formatCallDetails, formatCallTranscript, formatCampaignOutcomes,
  },
} = require('./cartesiaOperations');

test('Cartesia operations expose guarded single-call and batch campaign actions', () => {
  assert.equal(ACTIONS.has('CARTESIA_CALL'), true);
  assert.equal(ACTIONS.has('CARTESIA_RECONCILE'), true);
  assert.equal(ACTIONS.has('CARTESIA_BATCH'), false);
  assert.equal(ACTIONS.has('CARTESIA_CALLS'), true);
  assert.equal(ACTIONS.has('CARTESIA_CAMPAIGN'), true);
  assert.equal(ACTIONS.has('CARTESIA_CAMPAIGN_STATUS'), true);
  assert.equal(ACTIONS.has('CARTESIA_BATCH_RECONCILE'), true);
  assert.equal(ACTIONS.has('CARTESIA_BATCH_CANCEL'), true);
  assert.equal(ACTIONS.has('CARTESIA_BATCH_RETRY'), true);
  assert.equal(ACTIONS.has('CARTESIA_AGENT_HEALTH'), true);
  assert.equal(ACTIONS.has('CARTESIA_AGENT_RUNTIME'), true);
  assert.equal(ACTIONS.has('CARTESIA_REVIEW_RULES'), true);
  assert.equal(ACTIONS.has('CARTESIA_REVIEW_QUEUE'), true);
});

test('Cartesia menu uses signed callback data for the call action', () => {
  const keyboard = buildCartesiaKeyboard({ session: {} });
  const callback = keyboard.inline_keyboard.flat().find((button) => button.text.includes('Place a single call'));
  assert.ok(callback);
  assert.match(callback.callback_data, /CARTESIA_CALL/);
  const reconcile = keyboard.inline_keyboard.flat().find((button) => button.text.includes('Reconcile a call'));
  assert.ok(reconcile);
  assert.match(reconcile.callback_data, /CARTESIA_RECONCILE/);
  const calls = keyboard.inline_keyboard.flat().find((button) => button.text.includes('Recent calls'));
  assert.ok(calls);
  assert.match(calls.callback_data, /CARTESIA_CALLS/);
  const campaign = keyboard.inline_keyboard.flat().find((button) => button.text.includes('Plan a batch campaign'));
  assert.ok(campaign);
  assert.match(campaign.callback_data, /CARTESIA_CAMPAIGN/);
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_BATCH_RECONCILE/.test(button.callback_data)));
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_BATCH_CANCEL/.test(button.callback_data)));
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_BATCH_RETRY/.test(button.callback_data)));
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_STUDIO_CENTER/.test(button.callback_data)));
  const health = keyboard.inline_keyboard.flat().find((button) => button.callback_data.includes('CARTESIA_AGENT_HEALTH'));
  assert.ok(health);
  assert.match(health.text, /health/i);
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_AGENT_RUNTIME/.test(button.callback_data)));
  assert.ok(keyboard.inline_keyboard.flat().some((button) => /CARTESIA_REVIEW_RULES/.test(button.callback_data)));
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

test('interactive Cartesia campaign requires the campaign-specific phrase before submitting', async () => {
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

test('campaign schedule helper requires an explicit timezone and caps starts at 24 hours', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  assert.equal(normalizeCampaignSchedule('now', now), null);
  assert.equal(normalizeCampaignSchedule('2026-10-31T15:00:00+02:00', now), '2026-10-31T13:00:00.000Z');
  assert.equal(normalizeCampaignSchedule('2026-10-31T13:00:00', now), undefined);
  assert.equal(normalizeCampaignSchedule('2026-11-01T12:00:01Z', now), undefined);
  assert.equal(campaignSubmitPhrase({ campaign_id: 'cartesia_campaign_x', ready_count: 2, scheduled_at: '2026-10-31T15:00:00.000Z' }),
    'SUBMIT CARTESIA CAMPAIGN cartesia_campaign_x WITH 2 RECIPIENTS AT 2026-10-31T15:00:00.000Z');
});

test('interactive scheduled campaign previews UTC time and binds it into exact approval', async () => {
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

test('interactive batch cancellation and retry require exact campaign-bound approval', async () => {
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
    const retryPhrase = `RETRY CARTESIA CAMPAIGN ${campaignId} BATCH batch_1 RETRY 1 FOR 1 RECIPIENTS`;
    responses.push({ message: { text: retryPhrase } });
    await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /\/reconcile$/);
    assert.match(requests[1].url, /\/retry$/);
    assert.equal(requests[1].body.confirmation_phrase, retryPhrase);
    assert.ok(replies.some((text) => text.includes('accepted a retry')));
  } finally { httpClient.get = originalGet; httpClient.post = originalPost; }
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

test('interactive call flow verifies agent and source before asking for destination', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const calls = [];
  const responses = [
    { message: { text: 'biz-1' } },
    { message: { text: '1' } },
    { message: { text: '1' } },
    { message: { text: '+14155550123' } },
    { message: { text: '{}' } },
    { message: { text: 'PLACE CARTESIA CALL TO +14155550123 FROM ap_number_1 WITH AGENT agent_1' } },
  ];
  const replies = [];
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CALL' },
    async reply(message) { replies.push(String(message)); },
  };
  const conversation = { async wait() { return responses.shift(); } };
  httpClient.get = async (_ctx, url) => {
    calls.push({ method: 'GET', url });
    return { data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'ap_number_1', displayNumber: '••••0111' }] }] } };
  };
  httpClient.post = async (_ctx, url, body) => {
    calls.push({ method: 'POST', url, body });
    if (url.endsWith('/api/cartesia/call-approval')) return { data: { approval_token: 'signed-approval-token', request_fingerprint: 'a'.repeat(64) } };
    return { data: { provider_call_id: 'call_1', status: 'queued' } };
  };
  try {
    await cartesiaOperationFlow(conversation, ctx);
  } finally {
    httpClient.get = originalGet;
    httpClient.post = originalPost;
  }
  const sourcePromptIndex = replies.findIndex((message) => message.includes('Choose one of this agent'));
  const destinationPromptIndex = replies.findIndex((message) => message.includes('Enter the authorized destination'));
  assert.ok(sourcePromptIndex >= 0 && destinationPromptIndex > sourcePromptIndex);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST', 'POST']);
  assert.equal(calls[0].url.endsWith('/api/cartesia/agents'), true);
  assert.equal(calls[1].body.agent_id, 'agent_1');
  assert.equal(calls[1].body.from_number_id, 'ap_number_1');
  assert.equal(calls[2].body.number, '+14155550123');
  assert.equal(ctx.session.cartesiaCallPending, null);
});

test('interactive call flow binds optional dynamic variables into both approval and outbound dispatch', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const input = { destination: '+14155550123', fromNumberId: 'ap_number_1', agentId: 'agent_1', dynamicVariables: { first_name: 'Ada' } };
  const responses = ['biz-1', '1', '1', input.destination, JSON.stringify(input.dynamicVariables), buildCallConfirmationPhrase(input)]
    .map((text) => ({ message: { text } }));
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CALL' },
    async reply(message) { replies.push(String(message)); },
  };
  httpClient.get = async () => ({ data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'ap_number_1' }] }] } });
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ url, body });
    return url.endsWith('/api/cartesia/call-approval') ? { data: { approval_token: 'approval', request_fingerprint: 'b'.repeat(64) } } : { data: { provider_call_id: 'call_1', status: 'queued' } };
  };
  try { await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.body.dynamic_variables), [input.dynamicVariables, input.dynamicVariables]);
  assert.equal(requests[0].body.confirmation_phrase, buildCallConfirmationPhrase(input));
  assert.doesNotMatch(replies.join('\n'), /Ada/);
});

test('uncertain Cartesia calls keep only a safe fingerprint in bot session for reconciliation', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const replies = [];
  const input = { destination: '+14155550123', fromNumberId: 'ap_number_1', agentId: 'agent_1', dynamicVariables: { first_name: 'Ada' } };
  const responses = ['biz-1', '1', '1', input.destination, JSON.stringify(input.dynamicVariables), buildCallConfirmationPhrase(input)]
    .map((text) => ({ message: { text } }));
  const ctx = {
    from: { id: 7001 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaOperationAction: 'CARTESIA_CALL' },
    async reply(message) { replies.push(String(message)); },
  };
  httpClient.get = async () => ({ data: { agents: [{ id: 'agent_1', name: 'Support', ready: true, phoneNumbers: [{ id: 'ap_number_1' }] }] } });
  httpClient.post = async (_ctx, url) => {
    if (url.endsWith('/api/cartesia/call-approval')) return { data: { approval_token: 'approval', request_fingerprint: 'c'.repeat(64) } };
    throw new Error('network timeout');
  };
  try { await cartesiaOperationFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(ctx.session.cartesiaCallPending.requestFingerprint, 'c'.repeat(64));
  assert.equal(Object.hasOwn(ctx.session.cartesiaCallPending, 'dynamicVariables'), false);
  assert.equal(Object.hasOwn(ctx.session.cartesiaCallPending, 'approvalToken'), false);
  assert.doesNotMatch(JSON.stringify(ctx.session.cartesiaCallPending), /Ada/);
  assert.match(replies.join('\n'), /Saved request fingerprint/);
  const payload = buildReconciliationPayload(ctx.session.cartesiaCallPending, '7001');
  assert.equal(payload.request_fingerprint, 'c'.repeat(64));
  assert.equal(Object.hasOwn(payload, 'dynamic_variables'), false);
});

test('Cartesia approval phrase binds the exact destination, source number, and agent', () => {
  assert.equal(
    buildConfirmationPhrase({ destination: '+14155550123', fromNumberId: 'ap_number_1', agentId: 'agent_1' }),
    'PLACE CARTESIA CALL TO +14155550123 FROM ap_number_1 WITH AGENT agent_1',
  );
});

test('dynamic call variables are bound to the explicit bot confirmation fingerprint', () => {
  const base = { destination: '+14155550123', fromNumberId: 'ap_number_1', agentId: 'agent_1' };
  const first = buildCallConfirmationPhrase({ ...base, dynamicVariables: { first_name: 'Ada', tier: 'gold' } });
  const reordered = buildCallConfirmationPhrase({ ...base, dynamicVariables: { tier: 'gold', first_name: 'Ada' } });
  const changed = buildCallConfirmationPhrase({ ...base, dynamicVariables: { first_name: 'Ada', tier: 'silver' } });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.match(first, /WITH VARIABLES [a-f0-9]{12}$/);
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
