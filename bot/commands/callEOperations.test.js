'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.ADMIN_TELEGRAM_ID ||= '100000001';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'test-admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= '123456:mock-bot-token';
process.env.ADMIN_API_TOKEN ||= 'mock-api-token';
process.env.API_HMAC_SECRET ||= 'mock-api-hmac-secret';
const { ACTIONS, buildCallEKeyboard, selectPendingReviews, selectMissionAttention, runReviewInbox, runMissionAlerts, runMissionSafety, runRetention, runGoalBrowser, runGoalRunCreate, runGoalRunReview, runGoalRunAdvance, runGoalRunStatus, runMissionApprovalPolicy, runProviderRouting, runMissionReport, runAlertSubscription, runReportDigestSubscription, runContactPolicy, runReviewAssignments, runMissionUsage, runMissionRecovery, runMissionReadiness, runProviderDiagnostics, runCdrImport, runResultFollowup } = require('./callEOperations');
const { parseCallbackData } = require('../utils/actions');
const httpClient = require('../utils/httpClient');

test('CALL-E center exposes all key workflows through signed menu buttons', () => {
  const keyboard = buildCallEKeyboard({ session: {} });
  const actions = keyboard.inline_keyboard.flat()
    .map((button) => parseCallbackData(button.callback_data)?.action);
  for (const action of [
    'CALL_E_PLAN', 'CALL_E_RESULTS', 'CALL_E_REVIEW_INBOX', 'CALL_E_MISSION_ALERTS',
    'CALL_E_GOALS', 'CALL_E_GOAL_RUN_CREATE', 'CALL_E_GOAL_RUNS', 'CALL_E_GOAL_RUN_REVIEW',
    'CALL_E_GOAL_RUN_ADVANCE', 'CALL_E_GOAL_RUN_RECONCILE', 'CALL_E_GOAL_RUN_STATUS',
    'CALL_E_MISSION_SAFETY', 'CALL_E_RETENTION', 'CALL_E_OPERATIONS_AUDIT',
    'CALL_E_CAMPAIGNS', 'CALL_E_CAMPAIGN_CREATE',
    'CALL_E_CAMPAIGN_INFO', 'CALL_E_CAMPAIGN_REVIEW', 'CALL_E_CALL_RESULT',
    'CALL_E_RECONCILE', 'CALL_E_QUALITY', 'CALL_E_MISSIONS', 'CALL_E_MISSION_CREATE',
    'CALL_E_MISSION_REVIEW', 'CALL_E_MISSION_ADVANCE', 'CALL_E_MISSION_RESOLVE',
    'CALL_E_MISSION_INFO', 'MENU',
    'CALL_E_MISSION_APPROVAL_POLICY', 'CALL_E_PROVIDER_ROUTING', 'CALL_E_MISSION_REPORT', 'CALL_E_ALERT_SUBSCRIPTION', 'CALL_E_REPORT_DIGEST', 'CALL_E_MISSION_RETRY',
    'CALL_E_CONTACT_POLICY', 'CALL_E_REVIEW_ASSIGNMENTS', 'CALL_E_MISSION_USAGE', 'CALL_E_RESULT_FOLLOWUP',
    'CALL_E_MISSION_RECOVERY', 'CALL_E_CDR_IMPORT', 'CALL_E_PROVIDER_DIAGNOSTICS', 'CALL_E_MISSION_READINESS',
  ]) assert.ok(actions.includes(action), `missing menu action ${action}`);
});

test('recovery workflow only reconciles after exact interactive confirmation', async () => {
  const priorGet = httpClient.get;
  const priorPost = httpClient.post;
  const posts = [];
  const missionId = `mission_${'a'.repeat(64)}`;
  httpClient.get = async () => ({ data: { items: [{ mission_id: missionId, position: 0, recipient_status: 'accepted', action: 'reconcile_only', error_code: null }] } });
  httpClient.post = async (_ctx, url, body) => { posts.push({ url, body }); return { data: { state: 'completed' } }; };
  const replies = [];
  const answers = ['biz-recover', '1', 'RECONCILE ONLY'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runMissionRecovery(conversation, ctx, () => {}); } finally { httpClient.get = priorGet; httpClient.post = priorPost; }
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/mission-recovery-actions'));
  assert.equal(posts[0].body.action, 'reconcile_only');
  assert.match(replies.join('\n'), /No call was dispatched/);
});

test('readiness and provider diagnostics workflows are scoped read-only views', async () => {
  const priorGet = httpClient.get;
  const requests = [];
  httpClient.get = async (_ctx, url, options) => {
    requests.push({ url, options });
    return url.includes('/readiness')
      ? { data: { readiness: { ready: false, checks: [{ key: 'consent_and_template', ready: false, reason: 'blocked' }], budget: { actual_minor: 5, reserved_minor: 10, cap_minor: 100, currency: 'USD' }, provider: { selected_provider: null } } } }
      : { data: { current: [{ provider: 'twilio', ready: true, circuit_state: 'closed', score: 90 }], history: [] } };
  };
  const replies = [];
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try {
    const readinessAnswers = ['biz-ready', `mission_${'b'.repeat(64)}`];
    await runMissionReadiness({ async wait() { return { message: { text: readinessAnswers.shift() } }; } }, ctx, () => {});
    await runProviderDiagnostics({ async wait() { return { message: { text: 'biz-provider' } }; } }, ctx, () => {});
  } finally { httpClient.get = priorGet; }
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.endsWith('/readiness'));
  assert.ok(requests[1].url.endsWith('/provider-diagnostics'));
  assert.ok(requests.every((request) => request.options.params.actor_id === '100000001'));
  assert.match(replies.join('\n'), /read-only and never dispatches/);
  assert.match(replies.join('\n'), /no provider account is queried/);
});

test('CDR import stages a preview and only commits after typed confirmation', async () => {
  const priorPost = httpClient.post;
  const posts = [];
  httpClient.post = async (_ctx, url, body) => {
    posts.push({ url, body });
    return url.endsWith('/commit')
      ? { data: { records_saved: 1 } }
      : { data: { import_id: 'cdrimp_123e4567-e89b-12d3-a456-426614174000', preview: { record_count: 1, duplicate_count: 0, new_record_count: 1, projected_actual_by_currency: { USD: 120 }, budget_exceeded: false } } };
  };
  const replies = [];
  const answers = ['biz-cdr', `mission_${'c'.repeat(64)}`, 'opaque-cdr-2026-01', '[{"recipient_position":0,"provider":"twilio","provider_call_id":"CA123","amount_minor":120,"currency":"USD","occurred_at":"2026-10-30T10:00:00Z"}]', 'COMMIT CDR IMPORT'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runCdrImport(conversation, ctx, () => {}); } finally { httpClient.post = priorPost; }
  assert.equal(posts.length, 2);
  assert.ok(posts[0].url.endsWith('/mission-cdr-imports'));
  assert.match(posts[0].body.idempotency_key, /^bot-cdr-import:/);
  assert.ok(posts[1].url.endsWith('/commit'));
  assert.match(replies.join('\n'), /CDR import committed/);
});

test('review inbox filters pending items and excludes campaigns the API marks ineligible', () => {
  const campaignId = `campaign_${'a'.repeat(64)}`;
  const missionId = `mission_${'b'.repeat(64)}`;
  const goalRunId = 'goal-run-request-1';
  const items = selectPendingReviews([
    { campaign_id: campaignId, status: 'draft', can_review: true, recipient_count: 3 },
    { campaign_id: `campaign_${'c'.repeat(64)}`, status: 'approved', can_review: true },
    { campaign_id: `campaign_${'d'.repeat(64)}`, status: 'draft', can_review: false },
  ], [
    { mission_id: missionId, status: 'pending_approval', created_by: '222', recipient_count: 4 },
    { mission_id: `mission_${'g'.repeat(64)}`, status: 'pending_approval', created_by: '222', reviewed_by: '111', recipient_count: 10 },
    { mission_id: `mission_${'e'.repeat(64)}`, status: 'pending_approval', created_by: '111' },
    { mission_id: `mission_${'f'.repeat(64)}`, status: 'approved', created_by: '222' },
  ], '111', [
    { goal_run_request_id: goalRunId, status: 'pending_approval', created_by: '222' },
    { goal_run_request_id: 'goal-run-request-self', status: 'pending_approval', created_by: '111' },
  ]);
  assert.deepEqual(items.map(({ type, id }) => ({ type, id })), [
    { type: 'campaign', id: campaignId },
    { type: 'mission', id: missionId },
    { type: 'goal_run', id: goalRunId },
  ]);
});

test('mission alerts use persisted mission and recipient attention summaries only', () => {
  const attentionId = `mission_${'a'.repeat(64)}`;
  const alerts = selectMissionAttention([
    { mission_id: attentionId, status: 'needs_review', attention_count: 1, active_count: 0, queued_count: 2 },
    { mission_id: `mission_${'b'.repeat(64)}`, status: 'running', attention_count: 0 },
    { mission_id: `mission_${'c'.repeat(64)}`, status: 'completed', attention_count: 0 },
    { mission_id: `mission_${'d'.repeat(64)}`, status: 'running', attention_count: 2 },
  ]);
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((row) => row.missionId), [attentionId, `mission_${'d'.repeat(64)}`]);
  assert.equal(alerts[0].status, 'needs_review');
  assert.equal(alerts[0].attentionCount, 1);
});

test('review inbox uses selected business scope and delegates decision to existing backend review route', async () => {
  const campaignId = `campaign_${'a'.repeat(64)}`;
  const priorGet = httpClient.get;
  const priorPost = httpClient.post;
  const getCalls = [];
  const postCalls = [];
  httpClient.get = async (_ctx, url, options) => {
    getCalls.push({ url, options });
    return url.endsWith('/campaigns')
      ? { data: { campaigns: [{ campaign_id: campaignId, status: 'draft', can_review: true, recipient_count: 2 }] } }
      : { data: { missions: [] } };
  };
  httpClient.post = async (_ctx, url, body) => {
    postCalls.push({ url, body });
    return { data: { campaign: { campaign_id: campaignId, status: 'approved' } } };
  };
  const replies = [];
  const answers = ['biz-selected', '1', 'approve'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = {
    from: { id: 100000001 },
    chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, role: 'admin', checkedAt: Date.now() } },
    async reply(message) { replies.push(message); },
  };
  try {
    await runReviewInbox(conversation, ctx, () => {});
  } finally {
    httpClient.get = priorGet;
    httpClient.post = priorPost;
  }
  assert.equal(getCalls.length, 3);
  assert.ok(getCalls.every(({ options }) => options.params.business_id === 'biz-selected'));
  assert.ok(getCalls.every(({ options }) => options.params.actor_id === '100000001'));
  assert.equal(postCalls.length, 1);
  assert.ok(postCalls[0].url.endsWith(`/campaigns/${campaignId}/review`));
  assert.deepEqual(postCalls[0].body, { business_id: 'biz-selected', actor_id: '100000001', decision: 'approve' });
  assert.ok(replies.some((message) => String(message).includes('Pending CALL-E reviews')));
});

test('Goal Run draft collects private inputs and stages only a pending review using idempotency', async () => {
  const priorGet = httpClient.get;
  const priorPost = httpClient.post;
  const getCalls = [];
  const postCalls = [];
  httpClient.get = async (_ctx, url, options) => {
    getCalls.push({ url, options });
    if (url.endsWith('/goals')) return { data: { goals: [{ goal_id: 'published-goal-1', name: 'Appointment check' }] } };
    return { data: { goal: { id: 'published-goal-1', title: 'Appointment check', published_run_spec: {
      input_schema: { type: 'object', properties: { contact_name: { type: 'string' } } },
      result_schema: { type: 'object', properties: { confirmed: { type: 'boolean' } } },
    } } } };
  };
  httpClient.post = async (_ctx, url, body, options) => {
    postCalls.push({ url, body, options });
    return { data: { goal_run: { goal_run_request_id: 'goal-run-request-1', status: 'pending_approval' } } };
  };
  const replies = [];
  const answers = ['biz-goals', '1', '+14155550123', '{"contact_name":"Avery"}', 'skip', 'YES I HAVE AUTHORIZATION'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { chat: { type: 'private' }, from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try {
    await runGoalRunCreate(conversation, ctx, () => {});
  } finally {
    httpClient.get = priorGet;
    httpClient.post = priorPost;
  }
  assert.equal(getCalls.length, 2);
  assert.ok(getCalls[0].url.endsWith('/goals'));
  assert.ok(getCalls[1].url.endsWith('/goals/published-goal-1'));
  assert.equal(postCalls.length, 1);
  assert.ok(postCalls[0].url.endsWith('/goal-runs'));
  assert.deepEqual(postCalls[0].body, {
    business_id: 'biz-goals', actor_id: '100000001', goal_id: 'published-goal-1',
    phone: '+14155550123', variables: { contact_name: 'Avery' }, authorized: true,
  });
  assert.ok(postCalls[0].options.headers['Idempotency-Key'].startsWith('bot-goal-run:'));
  assert.ok(replies.some((message) => String(message).includes('pending approval')));
  assert.ok(replies.some((message) => String(message).includes('goal-run-request-1')));
  assert.ok(replies.some((message) => String(message).includes('No call was placed')));
});

test('published-goal browser renders the API nested published input schema', async () => {
  const priorGet = httpClient.get;
  httpClient.get = async (_ctx, url) => url.endsWith('/goals')
    ? { data: { goals: [{ id: 'goal-1', title: 'Appointment check' }] } }
    : { data: { goal: { id: 'goal-1', title: 'Appointment check', published_run_spec: {
      input_schema: { type: 'object', properties: { contact_name: { type: 'string' } } },
    } } } };
  const replies = [];
  const answers = ['biz-goals', 'skip', '1'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try {
    await runGoalBrowser(conversation, ctx, () => {});
  } finally {
    httpClient.get = priorGet;
  }
  assert.match(replies.join('\n'), /contact_name/);
});

test('Goal Run review uses the existing scoped review route and never advances execution', async () => {
  const priorPost = httpClient.post;
  const requests = [];
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ url, body });
    return { data: { goal_run: { status: 'approved' } } };
  };
  const answers = ['biz-review', 'request-id-123', 'approve'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const replies = [];
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try {
    await runGoalRunReview(conversation, ctx, () => {});
  } finally {
    httpClient.post = priorPost;
  }
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/goal-runs/request-id-123/review'));
  assert.deepEqual(requests[0].body, { business_id: 'biz-review', actor_id: '100000001', decision: 'approve' });
  assert.match(replies.join('\n'), /No call was placed/);
});

test('Goal Run advance requires typed confirmation before the mocked advance request', async () => {
  const priorPost = httpClient.post;
  const requests = [];
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ url, body });
    return { data: { goal_run: { status: 'completed' } } };
  };
  const answers = ['biz-advance', 'request-id-456', 'ADVANCE'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const replies = [];
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try {
    await runGoalRunAdvance(conversation, ctx, () => {});
  } finally {
    httpClient.post = priorPost;
  }
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/goal-runs/request-id-456/advance'));
  assert.deepEqual(requests[0].body, { business_id: 'biz-advance', actor_id: '100000001' });
  assert.ok(replies.some((message) => /may place a live call/.test(message)));
});

test('Goal Run results are only exposed in a private chat', async () => {
  const priorGet = httpClient.get;
  let getCalled = false;
  httpClient.get = async () => {
    getCalled = true;
    return { data: { goal_run: { status: 'completed', result: { confirmed: true } } } };
  };
  const replies = [];
  const conversation = { async wait() { return { message: { text: 'unused' } }; } };
  try {
    await runGoalRunStatus(conversation, { chat: { type: 'group' }, async reply(message) { replies.push(message); } }, () => {});
  } finally {
    httpClient.get = priorGet;
  }
  assert.equal(getCalled, false);
  assert.match(replies.join('\n'), /private chat/);
});

test('mission alerts are scoped reads over persisted mission summaries', async () => {
  const priorGet = httpClient.get;
  const requests = [];
  httpClient.get = async (_ctx, url, options) => {
    requests.push({ url, options });
    return { data: { missions: [
      { mission_id: `mission_${'a'.repeat(64)}`, status: 'needs_review', attention_count: 2, active_count: 0, queued_count: 1 },
      { mission_id: `mission_${'b'.repeat(64)}`, status: 'running', attention_count: 0 },
    ] } };
  };
  const replies = [];
  const conversation = { async wait() { return { message: { text: 'biz-alerts' } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try {
    await runMissionAlerts(conversation, ctx, () => {});
  } finally {
    httpClient.get = priorGet;
  }
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/missions'));
  assert.deepEqual(requests[0].options.params, { business_id: 'biz-alerts', actor_id: '100000001', limit: 50 });
  const report = replies.join('\n');
  assert.match(report, /needs review \/ recovery/);
  assert.match(report, /failed, blocked, or need review\/recovery/);
  assert.doesNotMatch(report, /running/);
});

test('business provider routing is configured through a scoped guided conversation', async () => {
  const priorGet = httpClient.get;
  const priorPut = httpClient.put;
  const priorPost = httpClient.post;
  const requests = [];
  httpClient.get = async (_ctx, _url, options) => ({ data: { policy: { provider_order: ['twilio', 'plivo'] } } });
  httpClient.post = async (_ctx, url, body) => {
    assert.ok(url.endsWith('/provider-routing/preview'));
    requests.push({ preview: true, body });
    return { data: { preview: { selected_provider: 'plivo', eligible_order: ['plivo', 'vonage'], blocked_providers: ['twilio'], provider_health: [{ provider: 'plivo', ready: true, state: 'closed', score: 100 }], dispatch_performed: false } } };
  };
  httpClient.put = async (_ctx, url, body) => { requests.push({ url, body }); return { data: { policy: { provider_order: body.provider_order } } }; };
  const replies = [];
  const answers = ['biz-route', 'plivo,vonage,twilio', 'SAVE ROUTING'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runProviderRouting(conversation, ctx, () => {}); } finally { httpClient.get = priorGet; httpClient.put = priorPut; httpClient.post = priorPost; }
  assert.equal(requests.length, 2);
  assert.ok(requests[0].preview);
  assert.deepEqual(requests[0].body, { business_id: 'biz-route', actor_id: '100000001', preferred_provider: 'plivo', provider_order: ['plivo', 'vonage', 'twilio'] });
  assert.ok(requests[1].url.endsWith('/provider-routing'));
  assert.deepEqual(requests[1].body, { business_id: 'biz-route', actor_id: '100000001', provider_order: ['plivo', 'vonage', 'twilio'] });
  assert.match(replies.join('\n'), /No-call routing preview/);
});

test('contact consent status is looked up through a private guided flow and displayed masked', async () => {
  const priorGet = httpClient.get;
  const requests = [];
  httpClient.get = async (_ctx, url, options) => { requests.push({ url, options }); return { data: { destination_masked: '••••0123', eligible: false, reason: 'opted_out', events: [] } }; };
  const replies = [];
  const answers = ['biz-consent', '+14155550123', 'status'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runContactPolicy(conversation, ctx, () => {}); } finally { httpClient.get = priorGet; }
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/contact-policy'));
  assert.equal(requests[0].options.params.business_id, 'biz-consent');
  assert.match(replies.join('\n'), /••••0123/);
  assert.match(replies.join('\n'), /Twilio, Plivo, Vonage, Vapi, and CALL-E/);
  assert.match(replies.join('\n'), /fresh outbound call/);
  assert.doesNotMatch(replies.join('\n'), /\+14155550123/);
});

test('review assignment flow asks for an explicit policy manager and acknowledges through the API', async () => {
  const priorGet = httpClient.get;
  const priorPost = httpClient.post;
  const missionId = `mission_${'a'.repeat(64)}`;
  const posts = [];
  httpClient.get = async () => ({ data: { items: [{ mission_id: missionId, escalated_at: '2026-10-30', assigned_to: null }] } });
  httpClient.post = async (_ctx, url, body) => { posts.push({ url, body }); return { data: { success: true } }; };
  const replies = [];
  const answers = ['biz-reviews', '1', 'assign', '100000002', 'ASSIGN REVIEW'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runReviewAssignments(conversation, ctx, () => {}); } finally { httpClient.get = priorGet; httpClient.post = priorPost; }
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/mission-review-actions'));
  assert.equal(posts[0].body.assigned_to, '100000002');
  assert.equal(posts[0].body.action, 'assign');
  assert.match(replies.join('\n'), /Review assigned/);
});

test('mission usage report states imported provider figures are not independently verified', async () => {
  const priorGet = httpClient.get;
  const requests = [];
  httpClient.get = async (_ctx, url, options) => { requests.push({ url, options }); return { data: { report: { reserved_minor: 1000, budget_currency: 'USD', actual_by_currency: { USD: 1250 }, budget_exceeded: true } } }; };
  const replies = [];
  const answers = ['biz-usage', `mission_${'a'.repeat(64)}`, 'report'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runMissionUsage(conversation, ctx, () => {}); } finally { httpClient.get = priorGet; }
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/usage'));
  assert.match(replies.join('\n'), /operator-entered records/);
  assert.match(replies.join('\n'), /exceeded/);
});

test('result follow-up action approval sends an idempotency key after typed confirmation', async () => {
  const priorGet = httpClient.get;
  const priorPost = httpClient.post;
  const posts = [];
  httpClient.get = async () => ({ data: { workflows: [{ workflow_id: 'ticket-rule', version: 2, name: 'Ticket rule', needs_action_approval: true }] } });
  httpClient.post = async (_ctx, url, body) => { posts.push({ url, body }); return { data: { idempotent_replay: false } }; };
  const replies = [];
  const answers = ['biz-result', 'approve_actions', '1', 'APPROVE TICKET ACTION'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runResultFollowup(conversation, ctx, () => {}); } finally { httpClient.get = priorGet; httpClient.post = priorPost; }
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/result-follow-up-workflows/ticket-rule/versions/2/approve-actions'));
  assert.match(posts[0].body.idempotency_key, /^bot-result-action-approval:/);
  assert.match(replies.join('\n'), /Per-result approval remains required/);
});

test('result follow-up draft exits when template prompt is canceled', async () => {
  const priorPost = httpClient.post;
  let postCalled = false;
  httpClient.post = async () => { postCalled = true; return { data: {} }; };
  const answers = ['biz-result', 'create', 'ticket-rule', 'Ticket rule', null];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply() {} };
  try { await runResultFollowup(conversation, ctx, () => {}); } finally { httpClient.post = priorPost; }
  assert.equal(postCalled, false);
});

test('mission report and alert notification choices remain business scoped', async () => {
  const priorGet = httpClient.get;
  const priorPut = httpClient.put;
  const gets = [];
  const puts = [];
  httpClient.get = async (_ctx, url, options) => {
    gets.push({ url, options });
    return url.endsWith('/mission-report')
      ? { data: { report: { from: '2026-10-01', to: '2026-10-31', mission_count: 4, completed_missions: 2, attention_missions: 1, recipient_count: 10, completion_rate: 60, completed_recipients: 6, failed_recipients: 2, review_recipients: 1, open_recipients: 1 } } }
      : { data: { subscription: { enabled: false } } };
  };
  httpClient.put = async (_ctx, url, body) => { puts.push({ url, body }); return { data: { worker_enabled: false, subscription: body } }; };
  const replies = [];
  const reportAnswers = ['biz-report', '2026-10-01', '2026-10-31'];
  const conversation = { async wait() { return { message: { text: reportAnswers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try {
    await runMissionReport(conversation, ctx, () => {});
    const subscriptionAnswers = ['biz-report', 'on'];
    await runAlertSubscription({ async wait() { return { message: { text: subscriptionAnswers.shift() } }; } }, ctx, () => {});
  } finally { httpClient.get = priorGet; httpClient.put = priorPut; }
  assert.ok(gets[0].url.endsWith('/mission-report'));
  assert.equal(gets[0].options.params.business_id, 'biz-report');
  assert.equal(puts.length, 1);
  assert.ok(puts[0].url.endsWith('/mission-alert-subscription'));
  assert.equal(puts[0].body.enabled, true);
  assert.match(replies.join('\n'), /completion rate: 60%/);
  assert.match(replies.join('\n'), /worker is currently disabled/);
});

test('report digest enrollment is private, scoped, and uses daily or weekly cadence through the API', async () => {
  const priorGet = httpClient.get;
  const priorPut = httpClient.put;
  const requests = [];
  httpClient.get = async (_ctx, url, options) => {
    assert.ok(url.endsWith('/mission-report-digest-subscription'));
    assert.deepEqual(options.params, { business_id: 'biz-digest', actor_id: '100000001' });
    return { data: { subscription: { enabled: false, interval_hours: 24 } } };
  };
  httpClient.put = async (_ctx, url, body) => { requests.push({ url, body }); return { data: { worker_enabled: true, subscription: body } }; };
  const replies = [];
  const answers = ['biz-digest', 'on', 'weekly'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runReportDigestSubscription(conversation, ctx, () => {}); }
  finally { httpClient.get = priorGet; httpClient.put = priorPut; }
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/mission-report-digest-subscription'));
  assert.deepEqual(requests[0].body, { business_id: 'biz-digest', actor_id: '100000001', enabled: true, interval_hours: 168 });
  assert.match(replies.join('\n'), /weekly/);
});

test('mission safety menu reads business-scoped policy and presents daily cap, timezone, and emergency stop', async () => {
  const priorGet = httpClient.get;
  const requests = [];
  httpClient.get = async (_ctx, url, options) => {
    requests.push({ url, options });
    return { data: { safety_policy: { configured: true, max_calls_per_day: 12, calls_used_today: 3,
      quiet_hours_start: '21:00', quiet_hours_end: '07:00', timezone: 'America/Los_Angeles', emergency_stop: true } } };
  };
  const replies = [];
  const answers = ['biz-safety', 'view'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runMissionSafety(conversation, ctx, () => {}); } finally { httpClient.get = priorGet; }
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith('/mission-safety'));
  assert.deepEqual(requests[0].options.params, { business_id: 'biz-safety', actor_id: '100000001' });
  assert.match(replies.join('\n'), /Daily cap: 12/);
  assert.match(replies.join('\n'), /America\/Los_Angeles/);
  assert.match(replies.join('\n'), /Emergency stop: <b>ON<\/b>/);
});

test('retention BOT only submits a purge after interactive exact phrase and reports the result', async () => {
  const priorGet = httpClient.get;
  const priorPost = httpClient.post;
  const posts = [];
  httpClient.get = async () => ({ data: { retention: { retention_days: 90, expired_goal_runs: 2, expired_missions: 1, cutoff: '2026-10-31T00:00:00.000Z' } } });
  httpClient.post = async (_ctx, url, body) => { posts.push({ url, body }); return { data: { retention: { expired_goal_runs: 2, expired_missions: 1 } } }; };
  const replies = [];
  const answers = ['biz-retention', 'PURGE EXPIRED SENSITIVE DATA'];
  const conversation = { async wait() { return { message: { text: answers.shift() } }; } };
  const ctx = { from: { id: 100000001 }, async reply(message) { replies.push(message); } };
  try { await runRetention(conversation, ctx, () => {}); } finally { httpClient.get = priorGet; httpClient.post = priorPost; }
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.endsWith('/retention/purge'));
  assert.equal(posts[0].body.business_id, 'biz-retention');
  assert.equal(posts[0].body.confirmation, 'PURGE EXPIRED SENSITIVE DATA');
  assert.match(replies.join('\n'), /Purged expired sensitive data/);
});

test('every prompted CALL-E workflow has an implementation and mission advance requires typed confirmation', () => {
  assert.ok(Object.keys(ACTIONS).length >= 13);
  assert.match(ACTIONS.CALL_E_MISSION_ADVANCE.prompts[2], /Type ADVANCE/);
  assert.deepEqual(ACTIONS.CALL_E_MISSION_ADVANCE.choices[2], ['advance']);
  assert.equal(ACTIONS.CALL_E_MISSION_ADVANCE.handlerArgumentCount, 2);
});
