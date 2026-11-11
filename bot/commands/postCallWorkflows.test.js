'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.ADMIN_TELEGRAM_ID ||= '100000001';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'test-admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= '123456:mock-bot-token';
process.env.ADMIN_API_TOKEN ||= 'mock-api-token';
process.env.API_HMAC_SECRET ||= 'mock-api-hmac-secret';

const config = require('../config');
const httpClient = require('../utils/httpClient');
const { getCapabilityForCommand } = require('../utils/capabilities');
const { handleWorkflowRuns, handleWorkflowRun, registerPostCallWorkflowCommands } = require('./postCallWorkflows');

function createContext(match = '', isAdmin = true) {
  const replies = [];
  return {
    match,
    session: {
      accessProfile: { isAdmin, isAuthorized: isAdmin, checkedAt: Date.now() },
    },
    from: { id: 123 },
    chat: { type: 'private' },
    replies,
    async reply(text, options) {
      replies.push({ text, options });
    },
  };
}

test('workflow runs requires administrator access and bounds/filter list requests', async () => {
  const originalGet = httpClient.get;
  const ctx = createContext('failed');
  let request;
  httpClient.get = async (...args) => {
    request = args;
    return {
      data: {
        runs: [{
          run_id: 'run_1',
          workflow_id: '<img src=x>',
          status: 'failed',
          error_code: 'step_failed',
          payload_json: '{"secret":"never display"}',
        }],
      },
    };
  };
  try {
    await handleWorkflowRuns(ctx);
    assert.equal(request[1], `${config.apiUrl.replace(/\/+$/, '')}/post-call/workflows/runs`);
    assert.deepEqual(request[2].params, { limit: 8, status: 'failed' });
    assert.match(ctx.replies[0].text, /&lt;img src=x&gt;/);
    assert.doesNotMatch(ctx.replies[0].text, /secret|payload_json|never display/);
  } finally {
    httpClient.get = originalGet;
  }

  const denied = createContext('', false);
  httpClient.get = async () => {
    throw new Error('must not fetch for non-admin');
  };
  try {
    await handleWorkflowRuns(denied);
    assert.match(denied.replies[0].text, /Access denied/);
  } finally {
    httpClient.get = originalGet;
  }
});

test('workflow run list rejects invalid status without making an API request', async () => {
  const originalGet = httpClient.get;
  const ctx = createContext('secret');
  httpClient.get = async () => {
    throw new Error('must not fetch invalid status');
  };
  try {
    await handleWorkflowRuns(ctx);
    assert.match(ctx.replies[0].text, /Invalid status/);
  } finally {
    httpClient.get = originalGet;
  }

  const group = createContext('');
  group.chat.type = 'supergroup';
  httpClient.get = async () => {
    throw new Error('must not fetch in a group chat');
  };
  try {
    await handleWorkflowRuns(group);
    assert.match(group.replies[0].text, /private chat/);
  } finally {
    httpClient.get = originalGet;
  }
});

test('workflow run detail displays sanitized step metadata, not payloads or results', async () => {
  const originalGet = httpClient.get;
  const ctx = createContext('run_abc-123');
  let request;
  httpClient.get = async (...args) => {
    request = args;
    return {
      data: {
        run: {
          run_id: 'run_abc-123',
          workflow_id: 'follow_up',
          workflow_version: 3,
          status: 'needs_review',
          current_step_id: 'send_email',
          payload_json: '{"email":"person@example.test"}',
          result: { body: 'private result' },
          steps: [{
            step_id: 'send_email',
            step_type: 'send_email',
            status: 'failed',
            error_code: 'provider_timeout',
            action_result: { body: 'private result' },
          }],
        },
      },
    };
  };
  try {
    await handleWorkflowRun(ctx);
    assert.equal(request[1], `${config.apiUrl.replace(/\/+$/, '')}/post-call/workflows/runs/run_abc-123`);
    assert.match(ctx.replies[0].text, /send_email · send_email · failed · provider_timeout/);
    assert.doesNotMatch(ctx.replies[0].text, /payload_json|person@example\.test|private result|action_result/);
  } finally {
    httpClient.get = originalGet;
  }
});

test('workflow run detail validates IDs before requesting and registers both read commands', async () => {
  const originalGet = httpClient.get;
  const invalid = createContext('../private');
  httpClient.get = async () => {
    throw new Error('must not fetch invalid ID');
  };
  try {
    await handleWorkflowRun(invalid);
    assert.match(invalid.replies[0].text, /Usage: \/workflowrun/);
  } finally {
    httpClient.get = originalGet;
  }

  const registered = [];
  registerPostCallWorkflowCommands({
    command(name, handler) {
      registered.push([name, handler]);
    },
  });
  assert.deepEqual(registered.map(([name]) => name), ['workflowruns', 'workflowrun']);
  assert.equal(getCapabilityForCommand('workflowruns'), 'post_call_workflows_view');
  assert.equal(getCapabilityForCommand('workflowrun'), 'post_call_workflows_view');
});
