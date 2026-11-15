const assert = require('node:assert/strict');
const test = require('node:test');

process.env.ADMIN_TELEGRAM_ID ||= '1';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'test-admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= 'test-token';
process.env.API_SECRET ||= 'test-api-secret';

const axios = require('axios');
const config = require('../config');
const httpClient = require('./httpClient');
const { CONVERSATION_EXTERNAL } = require('./persistentSessions');
const { runInConversation } = require('./conversationEffects');

test('VOICEDNUT API requests carry a correlation id that is stable across retries', async () => {
  const originalGet = axios.get;
  const requestHeaders = [];
  axios.get = async (_url, options) => {
    requestHeaders.push(options.headers);
    if (requestHeaders.length === 1) {
      const error = new Error('temporary request failure');
      error.code = 'ECONNRESET';
      throw error;
    }
    return { data: {} };
  };

  try {
    await httpClient.get({}, `${config.apiUrl}/api/provider/status`, {
      retry: { retries: 1, baseDelayMs: 0, jitterRatio: 0 },
    });
    const requestId = requestHeaders[0]['x-request-id'];
    assert.match(requestId, /^[0-9a-f-]{36}$/i);
    assert.equal(requestHeaders[1]['x-request-id'], requestId);
  } finally {
    axios.get = originalGet;
  }
});

test('VOICEDNUT API requests preserve a caller supplied request id', async () => {
  const originalGet = axios.get;
  let requestHeaders;
  axios.get = async (_url, options) => {
    requestHeaders = options.headers;
    return { data: {} };
  };

  try {
    await httpClient.get({}, `${config.apiUrl}/api/provider/status`, {
      headers: { 'X-Request-ID': 'telegram-update-123' },
      retry: { retries: 0 },
    });
    assert.equal(requestHeaders['X-Request-ID'], 'telegram-update-123');
    assert.equal(Object.keys(requestHeaders).filter((key) => key.toLowerCase() === 'x-request-id').length, 1);
  } finally {
    axios.get = originalGet;
  }
});

test('API error codes map to safe, actionable Bot guidance', () => {
  assert.match(httpClient.mapErrorToUserMessage({
    response: { status: 409, data: { error: { code: 'vapi_template_incompatible' } } },
  }), /incompatible/i);
  assert.match(httpClient.mapErrorToUserMessage({
    response: { status: 409, data: { code: 'cartesia_consent_missing' } },
  }), /consent and contact policy/i);
  assert.match(httpClient.mapErrorToUserMessage({
    response: { status: 409, data: { error: { code: 'vapi_call_outcome_unresolved' } } },
  }), /being reconciled.*Do not submit it again/i);
  assert.match(httpClient.mapErrorToUserMessage({
    response: { status: 500, data: { code: 'workflow_event_requires_recovery' } },
  }), /administrator review/i);
  assert.doesNotMatch(httpClient.mapErrorToUserMessage({
    response: { status: 502, data: { message: 'provider key sk-super-secret' } },
  }), /sk-super-secret/);
});

test('conversation HTTP effects replay their stored response without repeating the request', async () => {
  const originalPost = axios.post;
  let requestCount = 0;
  axios.post = async () => {
    requestCount += 1;
    return { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json', authorization: 'hidden' }, data: { id: 'draft-1' }, request: {}, config: {} };
  };
  let recorded;
  const ctx = {
    [CONVERSATION_EXTERNAL]: {
      async external(task) {
        if (recorded === undefined) recorded = await task();
        return recorded;
      },
    },
  };
  try {
    const first = await httpClient.post(ctx, `${config.apiUrl}/api/drafts`, { name: 'example' }, { retry: { retries: 0 } });
    const replayed = await httpClient.post(ctx, `${config.apiUrl}/api/drafts`, { name: 'example' }, { retry: { retries: 0 } });
    assert.equal(first.status, 201);
    assert.deepEqual(replayed.data, { id: 'draft-1' });
    assert.equal(requestCount, 1);
    assert.equal(replayed.headers.authorization, undefined);
  } finally {
    axios.post = originalPost;
  }
});

test('conversation HTTP errors replay as sanitized, actionable errors', async () => {
  const originalPost = axios.post;
  let requestCount = 0;
  axios.post = async () => {
    requestCount += 1;
    const error = new Error('destination +15555550123 was rejected with token sk-secret');
    error.response = { status: 409, statusText: 'Conflict', data: { code: 'outbound_consent_blocked', error: 'destination +15555550123 rejected' } };
    throw error;
  };
  let recorded;
  const ctx = {
    [CONVERSATION_EXTERNAL]: {
      async external(task) {
        if (recorded === undefined) recorded = await task();
        return recorded;
      },
    },
  };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(() => httpClient.post(ctx, `${config.apiUrl}/outbound-call`, {}, { retry: { retries: 0 } }), (error) => {
        assert.equal(error.response.status, 409);
        assert.equal(error.response.data.code, 'outbound_consent_blocked');
        assert.match(httpClient.getUserMessage(error), /destination is not eligible/i);
        assert.doesNotMatch(JSON.stringify(error), /15555550123|sk-secret/);
        return true;
      });
    }
    assert.equal(requestCount, 1);
  } finally {
    axios.post = originalPost;
  }
});

test('uncertain mutating API outcomes recommend status verification before retry', () => {
  assert.match(httpClient.mapErrorToUserMessage({
    config: { method: 'post' },
    response: { status: 503, data: { code: 'service_unavailable' } },
  }), /result is uncertain.*before retrying/i);
  assert.match(httpClient.mapErrorToUserMessage({
    code: 'conversation_response_too_large',
    config: { method: 'post' },
  }), /check the operation status before retrying/i);
});

test('nested Bot API clients inherit the active conversation replay context', async () => {
  const originalGet = axios.get;
  let requestCount = 0;
  axios.get = async () => {
    requestCount += 1;
    return { status: 200, headers: {}, data: { available: true } };
  };
  let recorded;
  const conversation = {
    async external(task) {
      if (recorded === undefined) recorded = await task();
      return recorded;
    },
  };
  try {
    const fetchNestedStatus = () => httpClient.get(null, `${config.apiUrl}/api/status`, { retry: { retries: 0 } });
    const first = await runInConversation(conversation, fetchNestedStatus);
    const replayed = await runInConversation(conversation, fetchNestedStatus);
    assert.deepEqual(first.data, { available: true });
    assert.deepEqual(replayed.data, { available: true });
    assert.equal(requestCount, 1);
  } finally {
    axios.get = originalGet;
  }
});
