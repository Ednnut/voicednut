const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const { createCallEActorAssertionHeaders } = require('./callEActorAssertion');
const { CONVERSATION_EXTERNAL } = require('./persistentSessions');
const { getCurrentConversation } = require('./conversationEffects');

const DEFAULT_TIMEOUT_MS = 12000;
const ADMIN_HEADER = 'x-admin-token';
const ADMIN_ORIGINS = new Set();
try {
  if (config.apiUrl) {
    ADMIN_ORIGINS.add(new URL(config.apiUrl).origin);
  }
} catch (_) {}
try {
  if (config.scriptsApiUrl) {
    ADMIN_ORIGINS.add(new URL(config.scriptsApiUrl).origin);
  }
} catch (_) {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 300,
    maxDelayMs = 3000,
    jitterRatio = 0.2,
    retryOn = (error) => {
      if (!error) return false;
      if (error.code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED'].includes(error.code)) {
        return true;
      }
      const status = error.response?.status;
      if (status === 429) return true;
      return status >= 500 && status < 600;
    }
  } = options;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt > retries || !retryOn(error)) {
        throw error;
      }
      const retryAfter = Number(error?.response?.headers?.['retry-after']);
      const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const baseDelay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : expDelay;
      const jitter = baseDelay * jitterRatio * (Math.random() * 2 - 1);
      const delay = Math.max(0, Math.round(baseDelay + jitter));
      await sleep(delay);
    }
  }
}

function sanitizeUrl(url = '') {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return String(url || '');
  }
}

function shouldAttachAdmin(url) {
  if (!url) return false;
  try {
    const origin = new URL(url).origin;
    return ADMIN_ORIGINS.has(origin);
  } catch (_) {
    return false;
  }
}

function withAdminHeader(headers = {}, enableAdmin = true) {
  const merged = { ...headers };
  if (enableAdmin && config.admin?.apiToken && !merged[ADMIN_HEADER]) {
    merged[ADMIN_HEADER] = config.admin.apiToken;
  }
  return merged;
}

function normalizeOptions(options = {}, url) {
  const enableAdmin = options.admin !== false && shouldAttachAdmin(url);
  const headers = withAdminHeader(options.headers || {}, enableAdmin);
  const timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT_MS;
  const hasRequestId = Object.keys(headers).some((key) => key.toLowerCase() === 'x-request-id');
  if (shouldAttachAdmin(url) && !hasRequestId) {
    headers['x-request-id'] = crypto.randomUUID();
  }
  return {
    ...options,
    headers,
    timeout
  };
}

function extractRequestId(error) {
  return (
    error?.response?.headers?.['x-request-id'] ||
    error?.response?.headers?.['x-requestid'] ||
    error?.response?.data?.request_id ||
    error?.response?.data?.requestId ||
    null
  );
}

function extractApiErrorCode(error) {
  const data = error?.response?.data;
  const candidate = data?.error && typeof data.error === 'object'
    ? data.error.code
    : data?.code;
  const normalized = String(candidate || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_.-]{0,99}$/.test(normalized) ? normalized : '';
}

function mapErrorToUserMessage(error) {
  const status = error?.response?.status;
  const code = extractApiErrorCode(error) || String(error?.code || '').trim().toLowerCase();
  const method = String(error?.config?.method || '').toUpperCase();
  if (code === 'conversation_response_too_large') {
    return 'The API completed without a usable response. Check the operation status before retrying.';
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && (status >= 500 || (!error?.response && error?.request))) {
    return 'The operation may have reached the service, but its result is uncertain. Check its status before retrying.';
  }
  if (status === 401 || status === 403) {
    return 'Not authorized. Check the ADMIN token / API secret.';
  }
  if (/provider_(not_configured|credentials_missing|preflight_failed)|(?:vapi|cartesia)_not_configured/.test(code)) {
    return 'Provider configuration is incomplete. Ask an administrator to review the provider setup.';
  }
  if (/(?:agent|template|runtime).*incompatible|incompatible.*(?:agent|template|runtime)/.test(code)) {
    return 'This agent or template is incompatible with the selected provider or runtime.';
  }
  if (/consent|opted_out|destination_(?:invalid|not_eligible)|contact_policy_.*(?:ineligible|blocked)/.test(code)) {
    return 'The destination is not eligible for this operation. Review its consent and contact policy status.';
  }
  if (/(?:submission|call|dispatch|provider).*?(?:ambiguous|unknown|unresolved)|reconcil/.test(code)) {
    return 'The request may have reached the provider and is being reconciled. Do not submit it again until its status is confirmed.';
  }
  if (/dead_letter|needs_review|requires_attention|manual_review|workflow_event_requires_recovery/.test(code)) {
    return 'This operation needs administrator review before it can continue.';
  }
  if (status === 404) {
    return 'API endpoint not found.';
  }
  if (status === 422) {
    return 'Invalid request. Please review the inputs.';
  }
  if (status === 429) {
    return 'Rate limited by the API. Please try again shortly.';
  }
  if (status >= 500) {
    return 'API error. Please try again.';
  }
  if (error?.code === 'ECONNABORTED') {
    return 'API timeout. Please try again.';
  }
  if (error?.request && !error?.response) {
    return 'API unreachable. Please check the server and network.';
  }
  return 'API request failed. Please try again.';
}

function enrichError(error, context = {}) {
  if (!error || typeof error !== 'object') {
    return error;
  }
  const requestId = extractRequestId(error);
  const status = error?.response?.status;
  const method = context.method || error?.config?.method?.toUpperCase() || 'GET';
  const url = sanitizeUrl(context.url || error?.config?.url || '');
  error.userMessage = error.userMessage || mapErrorToUserMessage(error);
  error.apiContext = {
    method,
    url,
    status,
    requestId
  };
  return error;
}

function logError(error, context = {}) {
  const enriched = enrichError(error, context);
  const apiContext = enriched?.apiContext || {};
  console.error('API request failed', apiContext);
}

function getUserMessage(error, fallback = 'API request failed.') {
  if (!error) return fallback;
  return error.userMessage || mapErrorToUserMessage(error) || fallback;
}

async function request(method, ctx, url, data, options = {}) {
  const normalized = normalizeOptions(options, url);
  let callEActorHeaders = {};
  const pathname = new URL(url, config.apiUrl).pathname;
  if (pathname.startsWith('/api/call-e/') || pathname.startsWith('/api/cartesia/') || pathname.startsWith('/api/calls/activity') || pathname === '/outbound-call' || /\/api\/call-scripts\/\d+\/vapi-call$/.test(pathname)) {
    callEActorHeaders = createCallEActorAssertionHeaders({
      actorId: ctx?.from?.id || data?.user_chat_id || data?.actor_id,
      method,
      url,
      params: normalized.params,
      body: data,
      secret: config.apiAuth?.callEActorAssertionSecret,
    });
  }
  normalized.headers = { ...normalized.headers, ...callEActorHeaders };
  const { retry, ...axiosOptions } = normalized;
  const perform = async () => {
    if (method === 'get') return withRetry(() => axios.get(url, axiosOptions), retry);
    if (method === 'delete') return withRetry(() => axios.delete(url, { ...axiosOptions, ...(data !== undefined && data !== null ? { data } : {}) }), retry);
    if (method === 'put') return withRetry(() => axios.put(url, data, axiosOptions), retry);
    if (method === 'patch') return withRetry(() => axios.patch(url, data, axiosOptions), retry);
    return withRetry(() => axios.post(url, data, axiosOptions), retry);
  };
  try {
    return await withConversationExternal(ctx, perform, method);
  } catch (error) {
    logError(error, { method: method.toUpperCase(), url });
    const enriched = enrichError(error, { method: method.toUpperCase(), url });
    if (enriched?.userMessage && typeof enriched.message === 'string' && /request failed/i.test(enriched.message)) {
      enriched.message = enriched.userMessage;
    }
    throw enriched;
  }
}

function serializeHttpResponse(response = {}) {
  const headers = {};
  for (const name of ['content-type', 'x-request-id', 'retry-after']) {
    const value = response.headers?.[name];
    if (value !== undefined && value !== null) headers[name] = String(value).slice(0, 200);
  }
  const value = {
    status: Number(response.status) || 200,
    statusText: String(response.statusText || '').slice(0, 120),
    headers,
    data: response.data,
  };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 512 * 1024) {
    throw Object.assign(new Error('Conversation response exceeds the replay storage limit'), { code: 'conversation_response_too_large' });
  }
  return value;
}

function restoreHttpResponse(value = {}) {
  return {
    status: Number(value.status) || 200,
    statusText: String(value.statusText || ''),
    headers: value.headers && typeof value.headers === 'object' ? value.headers : {},
    data: value.data,
  };
}

function serializeHttpError(error = {}, method = '') {
  const status = Number(error.response?.status);
  const code = String(extractApiErrorCode(error) || error.code || '').slice(0, 100);
  return {
    message: 'API request failed',
    code: /^[A-Za-z0-9_.-]{1,100}$/.test(code) ? code : '',
    method: String(method || error.config?.method || '').toUpperCase().slice(0, 10),
    ...(Number.isFinite(status) ? {
      response: {
        status,
        statusText: String(error.response?.statusText || '').slice(0, 120),
        headers: {},
        data: { ...(code ? { code } : {}), error: 'API request failed' },
      },
    } : error.request ? { request: true } : {}),
  };
}

function restoreHttpError(value = {}) {
  const error = new Error('API request failed');
  if (value.code) error.code = value.code;
  if (value.method) error.config = { method: value.method.toLowerCase() };
  if (value.response) error.response = restoreHttpResponse(value.response);
  if (value.request) error.request = true;
  return error;
}

async function withConversationExternal(ctx, task, method = '') {
  const conversation = ctx?.[CONVERSATION_EXTERNAL] || getCurrentConversation();
  if (!conversation || typeof conversation.external !== 'function') return task();
  const outcome = await conversation.external(async () => {
    try {
      return { ok: true, response: serializeHttpResponse(await task()) };
    } catch (error) {
      return { ok: false, error: serializeHttpError(error, method) };
    }
  });
  if (outcome?.ok === false) throw restoreHttpError(outcome.error);
  if (outcome?.ok === true) return restoreHttpResponse(outcome.response);
  throw new Error('Conversation HTTP result is invalid');
}

async function get(ctx, url, options = {}) {
  return request('get', ctx, url, null, options);
}

async function post(ctx, url, data, options = {}) {
  return request('post', ctx, url, data, options);
}

async function put(ctx, url, data, options = {}) {
  return request('put', ctx, url, data, options);
}

async function del(ctx, url, options = {}) {
  return request('delete', ctx, url, options.data ?? null, options);
}

async function patch(ctx, url, data, options = {}) {
  return request('patch', ctx, url, data, options);
}

module.exports = {
  withRetry,
  getUserMessage,
  mapErrorToUserMessage,
  sanitizeUrl,
  get,
  post,
  put,
  del,
  patch,
  withConversationExternal,
};
