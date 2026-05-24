const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? 'null' : stableStringify(item)));
    return `[${items.join(',')}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${entries.join(',')}}`;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  if (!email || !email.includes('@')) return false;
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  if (!parts[0] || !parts[1]) return false;
  return true;
}

function getDomain(email) {
  const normalized = normalizeEmail(email);
  const parts = normalized.split('@');
  return parts.length === 2 ? parts[1] : '';
}

function redactEmailForLog(value = '') {
  const email = normalizeEmail(value);
  if (!email || !email.includes('@')) return '[redacted-email]';
  const [local, domain] = email.split('@');
  const localTail = local ? local.slice(-2) : '**';
  return `***${localTail}@${domain || 'redacted'}`;
}

function previewForLog(value = '', max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '[empty]';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function getNestedValue(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, key) => {
    if (acc && Object.prototype.hasOwnProperty.call(acc, key)) {
      return acc[key];
    }
    return undefined;
  }, obj);
}

function extractTemplateVariables(text) {
  if (!text) return [];
  const matches = text.match(/{{\s*([\w.-]+)\s*}}/g) || [];
  const vars = new Set();
  matches.forEach((match) => {
    const cleaned = match.replace(/{{|}}/g, '').trim();
    if (cleaned) {
      vars.add(cleaned);
    }
  });
  return Array.from(vars);
}

function renderTemplateString(text, variables) {
  if (!text) return text;
  return text.replace(/{{\s*([\w.-]+)\s*}}/g, (_, key) => {
    const value = getNestedValue(variables, key);
    if (value === undefined || value === null) {
      return '';
    }
    return String(value);
  });
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function safeParseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

const SUPPORTED_EMAIL_PROVIDERS = ['sendgrid', 'mailgun'];
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ECONNABORTED',
]);
const TEMPLATE_SELECTABLE_LIFECYCLES = new Set(['approved', 'live']);
const TEMPLATE_CONTEXT_FIELDS = [
  'call_intent',
  'intent',
  'customer_status',
  'booking_state',
  'payment_state',
  'payment_status',
  'call_outcome',
  'outcome',
  'escalation_state',
  'ticket_state',
  'transcript_summary',
  'transcript',
];

function normalizeLifecycleState(value) {
  return String(value || '').trim().toLowerCase() || 'draft';
}

function parseTemplateRequiredVars(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  if (!value) return [];
  if (typeof value === 'string') {
    const parsed = safeParseJson(value);
    return Array.isArray(parsed)
      ? parsed.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
  }
  return [];
}

function addSignalTokens(value, tokens) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => addSignalTokens(entry, tokens));
    return;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((entry) => addSignalTokens(entry, tokens));
    return;
  }
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && token.length <= 32)
    .forEach((token) => tokens.add(token));
}

function buildTemplateContextTokens(context = {}) {
  const tokens = new Set();
  TEMPLATE_CONTEXT_FIELDS.forEach((field) => addSignalTokens(context[field], tokens));

  const paymentState = String(
    context.payment_state || context.payment_status || '',
  ).toLowerCase();
  if (['paid', 'succeeded', 'success', 'completed', 'complete'].includes(paymentState)) {
    ['receipt', 'payment', 'paid', 'success'].forEach((token) => tokens.add(token));
  }
  if (['failed', 'declined', 'past_due', 'pastdue'].includes(paymentState)) {
    ['payment', 'failed', 'retry'].forEach((token) => tokens.add(token));
  }

  const bookingState = String(context.booking_state || '').toLowerCase();
  if (['missed', 'no_show', 'noshow'].includes(bookingState)) {
    ['missed', 'appointment', 'booking', 'reschedule'].forEach((token) => tokens.add(token));
  }
  if (['booked', 'scheduled', 'confirmed'].includes(bookingState)) {
    ['booking', 'appointment', 'confirmation'].forEach((token) => tokens.add(token));
  }

  const escalationState = String(
    context.escalation_state || context.ticket_state || context.call_outcome || context.outcome || '',
  ).toLowerCase();
  if (['escalated', 'support', 'ticket', 'case'].some((token) => escalationState.includes(token))) {
    ['support', 'case', 'ticket', 'summary', 'escalation'].forEach((token) => tokens.add(token));
  }

  return Array.from(tokens);
}

function normalizeTemplateSelectionContext(payload = {}) {
  const context = {
    ...(payload.context && typeof payload.context === 'object' ? payload.context : {}),
    ...(payload.template_context && typeof payload.template_context === 'object'
      ? payload.template_context
      : {}),
  };
  TEMPLATE_CONTEXT_FIELDS.forEach((field) => {
    if (payload[field] !== undefined && context[field] === undefined) {
      context[field] = payload[field];
    }
  });
  if (payload.metadata && typeof payload.metadata === 'object') {
    TEMPLATE_CONTEXT_FIELDS.forEach((field) => {
      if (payload.metadata[field] !== undefined && context[field] === undefined) {
        context[field] = payload.metadata[field];
      }
    });
  }
  return context;
}

function isSqliteCorruptionError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
    return true;
  }
  return (
    message.includes('database disk image is malformed') ||
    message.includes('file is not a database')
  );
}

function normalizeProviderName(value) {
  return String(value || '').trim().toLowerCase();
}

function mapProviderError(provider, err) {
  const status = Number(err?.response?.status || err?.status || err?.statusCode);
  const code = String(err?.code || err?.name || '').toUpperCase();
  const retryable =
    status === 429 ||
    (status >= 500 && status < 600) ||
    RETRYABLE_NETWORK_CODES.has(code);
  const wrapped = new Error(
    err?.response?.data?.error_description ||
      err?.response?.data?.error ||
      err?.message ||
      'email_provider_error',
  );
  wrapped.code = err?.code === 'email_provider_timeout' ? 'email_provider_timeout' : 'email_provider_error';
  wrapped.statusCode = Number.isFinite(status) ? status : null;
  wrapped.status = wrapped.statusCode;
  wrapped.retryable = retryable;
  wrapped.provider = normalizeProviderName(provider) || 'unknown';
  wrapped.providerCode = code || null;
  wrapped.cause = err;
  return wrapped;
}

function createProviderTimeoutError(provider, timeoutMs, action = 'request') {
  const normalizedProvider = normalizeProviderName(provider) || 'unknown';
  const safeTimeoutMs = Math.max(1000, Number(timeoutMs) || 15000);
  const error = new Error(
    `${normalizedProvider} ${action} timed out after ${safeTimeoutMs}ms`,
  );
  error.code = 'email_provider_timeout';
  error.provider = normalizedProvider;
  error.retryable = true;
  error.statusCode = 504;
  error.status = 504;
  return error;
}

async function runProviderRequestWithTimeout({
  timeoutMs = 15000,
  provider = 'unknown',
  action = 'request',
  request,
}) {
  const safeTimeoutMs = Math.max(1000, Number(timeoutMs) || 15000);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, safeTimeoutMs);
  try {
    return await request({ signal: controller.signal, timeoutMs: safeTimeoutMs });
  } catch (err) {
    if (
      controller.signal.aborted ||
      err?.code === 'ERR_CANCELED' ||
      err?.name === 'CanceledError'
    ) {
      throw createProviderTimeoutError(provider, safeTimeoutMs, action);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

class ProviderAdapter {
  constructor(providerName = 'unknown') {
    this.providerName = providerName;
  }

  mapError(err) {
    return mapProviderError(this.providerName, err);
  }

  async sendEmail() {
    throw new Error('ProviderAdapter.sendEmail not implemented');
  }
}

class SendGridAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super('sendgrid');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || 'https://api.sendgrid.com/v3';
    this.requestTimeoutMs = Number(options.requestTimeoutMs) || 15000;
  }

  async sendEmail(message) {
    if (!this.apiKey) {
      throw new Error('SendGrid API key is not configured');
    }
    const url = `${this.baseUrl}/mail/send`;
    const payload = {
      personalizations: [
        {
          to: [{ email: message.to }],
          ...(message.subject ? { subject: message.subject } : {}),
        },
      ],
      from: { email: message.from },
      subject: message.subject,
      content: [],
      headers: message.headers || {},
      custom_args: message.messageId ? { message_id: message.messageId } : undefined,
      ...(message.replyTo ? { reply_to: { email: message.replyTo } } : {})
    };
    if (message.text) {
      payload.content.push({ type: 'text/plain', value: message.text });
    }
    if (message.html) {
      payload.content.push({ type: 'text/html', value: message.html });
    }
    try {
      const response = await runProviderRequestWithTimeout({
        timeoutMs: this.requestTimeoutMs,
        provider: this.providerName,
        action: 'send_email',
        request: ({ signal, timeoutMs }) => axios.post(url, payload, {
          timeout: timeoutMs,
          signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }),
      });
      const providerMessageId = response.headers?.['x-message-id'] || null;
      return { providerMessageId, response: response.data };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async validateApiKey() {
    if (!this.apiKey) {
      throw new Error('SendGrid API key is not configured');
    }
    try {
      const response = await runProviderRequestWithTimeout({
        timeoutMs: this.requestTimeoutMs,
        provider: this.providerName,
        action: 'validate_api_key',
        request: ({ signal, timeoutMs }) => axios.get(`${this.baseUrl}/user/profile`, {
          timeout: timeoutMs,
          signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }),
      });
      return {
        ok: true,
        username: response.data?.username || null,
        user_id: response.data?.user_id || response.data?.id || null,
      };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  async listVerifiedSenders() {
    if (!this.apiKey) {
      throw new Error('SendGrid API key is not configured');
    }
    try {
      const response = await runProviderRequestWithTimeout({
        timeoutMs: this.requestTimeoutMs,
        provider: this.providerName,
        action: 'list_verified_senders',
        request: ({ signal, timeoutMs }) => axios.get(`${this.baseUrl}/verified_senders`, {
          timeout: timeoutMs,
          signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        }),
      });
      const senders = Array.isArray(response.data?.results)
        ? response.data.results
        : Array.isArray(response.data)
          ? response.data
          : [];
      return senders.map((sender) => ({
        from_email: normalizeEmail(sender.from_email || sender.from?.email || sender.email),
        verified: sender.verified === true || sender.valid === true,
        nickname: sender.nickname || sender.name || null,
      }));
    } catch (err) {
      throw this.mapError(err);
    }
  }
}

class MailgunAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super('mailgun');
    this.apiKey = options.apiKey;
    this.domain = options.domain;
    this.baseUrl = options.baseUrl || 'https://api.mailgun.net/v3';
    this.requestTimeoutMs = Number(options.requestTimeoutMs) || 15000;
  }

  async sendEmail(message) {
    if (!this.apiKey || !this.domain) {
      throw new Error('Mailgun API key or domain is not configured');
    }
    const url = `${this.baseUrl}/${this.domain}/messages`;
    const params = new URLSearchParams();
    params.append('from', message.from);
    params.append('to', message.to);
    if (message.subject) {
      params.append('subject', message.subject);
    }
    if (message.text) {
      params.append('text', message.text);
    }
    if (message.html) {
      params.append('html', message.html);
    }
    if (message.replyTo) {
      params.append('h:Reply-To', message.replyTo);
    }
    if (message.messageId) {
      params.append('v:message_id', message.messageId);
    }
    if (message.headers) {
      Object.entries(message.headers).forEach(([key, value]) => {
        params.append(`h:${key}`, value);
      });
    }
    try {
      const response = await runProviderRequestWithTimeout({
        timeoutMs: this.requestTimeoutMs,
        provider: this.providerName,
        action: 'send_email',
        request: ({ signal, timeoutMs }) => axios.post(url, params, {
          timeout: timeoutMs,
          signal,
          auth: {
            username: 'api',
            password: this.apiKey
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }),
      });
      const providerMessageId = response.data?.id || null;
      return { providerMessageId, response: response.data };
    } catch (err) {
      throw this.mapError(err);
    }
  }
}

class EmailService {
  constructor({
    db,
    logger = console,
    config: cfg = config,
    getActiveProvider = null,
    providerResolver = null,
  }) {
    this.db = db;
    this.logger = logger;
    this.rootConfig = cfg || {};
    this.config = cfg?.email || {};
    this.getActiveProvider =
      typeof getActiveProvider === 'function'
        ? getActiveProvider
        : typeof providerResolver === 'function'
          ? providerResolver
          : () => this.config.provider || 'sendgrid';
    this.adapters = new Map();
    this.processing = false;
    this.rateBuckets = new Map();
    this.requestTimeoutMs = Number(this.config.requestTimeoutMs) || 15000;
    this.dlqAlertThreshold = Number(this.config.dlqAlertThreshold) || 25;
    this.maxSubjectChars = Number(this.config.maxSubjectChars) || 200;
    this.maxBodyChars = Number(this.config.maxBodyChars) || 200000;
    this.maxBulkRecipients = Number(this.config.maxBulkRecipients) || 500;
    this.providerEventDedupe = new Map();
    this.providerEventDedupeTtlMs = 30 * 60 * 1000;
    this.queueClaimLeaseMs = Math.max(
      10000,
      Number(this.config.queueClaimLeaseMs) || 60000,
    );
    this.queueStaleSendingMs = Math.max(
      this.queueClaimLeaseMs * 2,
      Number(this.config.queueStaleSendingMs) || 180000,
    );
    this.providerEventsTtlDays = Math.max(
      1,
      Number(this.config.providerEventsTtlDays) || 14,
    );
    this.circuitBreakerEnabled = this.config.circuitBreaker?.enabled !== false;
    this.circuitFailureThreshold = Math.max(
      2,
      Number(this.config.circuitBreaker?.failureThreshold) || 5,
    );
    this.circuitFailureWindowMs = Math.max(
      10000,
      Number(this.config.circuitBreaker?.windowMs) || 120000,
    );
    this.circuitCooldownMs = Math.max(
      10000,
      Number(this.config.circuitBreaker?.cooldownMs) || 120000,
    );
    this.providerCircuits = new Map();
    this.providerEventsLastCleanupMs = 0;
    this.corruptDbPauseMs = 60000;
    this.corruptDbBackoffUntilMs = 0;
    this.lastCorruptDbLogAtMs = 0;
  }

  resolveProvider(providerOverride = null) {
    const resolved = normalizeProviderName(
      providerOverride || this.getActiveProvider?.() || this.config.provider || 'sendgrid',
    );
    if (!SUPPORTED_EMAIL_PROVIDERS.includes(resolved)) {
      const error = new Error(`Unsupported email provider: ${resolved || providerOverride}`);
      error.code = 'validation_error';
      throw error;
    }
    return resolved;
  }

  getProviderReadiness() {
    return {
      sendgrid: !!this.config?.sendgrid?.apiKey,
      mailgun: !!(this.config?.mailgun?.apiKey && this.config?.mailgun?.domain),
    };
  }

  getAdapter(provider) {
    const resolved = this.resolveProvider(provider);
    if (this.adapters.has(resolved)) {
      return this.adapters.get(resolved);
    }
    let adapter = null;
    if (resolved === 'sendgrid') {
      adapter = new SendGridAdapter({
        ...(this.config.sendgrid || {}),
        requestTimeoutMs: this.requestTimeoutMs,
      });
    } else if (resolved === 'mailgun') {
      adapter = new MailgunAdapter({
        ...(this.config.mailgun || {}),
        requestTimeoutMs: this.requestTimeoutMs,
      });
    } else {
      throw new Error(`Unsupported email provider: ${resolved}`);
    }
    this.adapters.set(resolved, adapter);
    return adapter;
  }

  getVerifiedDomains() {
    return Array.isArray(this.config.verifiedDomains) ? this.config.verifiedDomains : [];
  }

  isVerifiedSender(fromEmail) {
    const domains = this.getVerifiedDomains();
    if (!domains.length) return true;
    const domain = getDomain(fromEmail);
    return domains.includes(domain);
  }

  getDefaultFrom() {
    return this.config.defaultFrom || '';
  }

  getUnsubscribeSecret() {
    const configured = String(this.config.unsubscribeSecret || '').trim();
    if (configured) {
      return configured;
    }
    const fallback = String(this.rootConfig?.apiAuth?.hmacSecret || '').trim();
    return fallback || '';
  }

  hasUnsubscribeSignature() {
    return Boolean(this.getUnsubscribeSecret());
  }

  buildUnsubscribeSignature(email, messageId = '') {
    const secret = this.getUnsubscribeSecret();
    if (!secret) return '';
    const normalizedEmail = normalizeEmail(email);
    const normalizedMessageId = String(messageId || '').trim();
    return crypto
      .createHmac('sha256', secret)
      .update(`${normalizedEmail}|${normalizedMessageId}`)
      .digest('hex');
  }

  verifyUnsubscribeSignature(email, messageId = '', signature = '') {
    const expected = this.buildUnsubscribeSignature(email, messageId);
    const provided = String(signature || '').trim();
    if (!expected || !provided) return false;
    try {
      const expectedBuf = Buffer.from(expected, 'hex');
      const providedBuf = Buffer.from(provided, 'hex');
      if (expectedBuf.length !== providedBuf.length) return false;
      return crypto.timingSafeEqual(expectedBuf, providedBuf);
    } catch (_) {
      return false;
    }
  }

  buildHeaders(payload) {
    const headers = { ...(payload.headers || {}) };
    if (payload.is_marketing && this.config.unsubscribeUrl) {
      let url = this.config.unsubscribeUrl;
      try {
        const built = new URL(this.config.unsubscribeUrl);
        if (payload.to_email || payload.to) {
          built.searchParams.set('email', payload.to_email || payload.to);
        }
        if (payload.message_id) {
          built.searchParams.set('message_id', payload.message_id);
        }
        const signature = this.buildUnsubscribeSignature(
          payload.to_email || payload.to || '',
          payload.message_id || '',
        );
        if (signature) {
          built.searchParams.set('sig', signature);
        }
        url = built.toString();
      } catch {
        // keep provided URL as-is
      }
      headers['List-Unsubscribe'] = `<${url}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
    return headers;
  }

  validateVariables(script, variables) {
    const required = new Set();
    extractTemplateVariables(script.subject).forEach((v) => required.add(v));
    extractTemplateVariables(script.html).forEach((v) => required.add(v));
    extractTemplateVariables(script.text).forEach((v) => required.add(v));
    const missing = [];
    required.forEach((key) => {
      const value = getNestedValue(variables, key);
      if (value === undefined || value === null) {
        missing.push(key);
      }
    });
    return missing;
  }

  renderTemplate(script, variables) {
    return {
      subject: renderTemplateString(script.subject, variables),
      html: renderTemplateString(script.html, variables),
      text: renderTemplateString(script.text, variables)
    };
  }

  getTemplateRequiredVariables(template = {}) {
    const required = new Set(parseTemplateRequiredVars(template.required_vars));
    extractTemplateVariables(template.subject).forEach((key) => required.add(key));
    extractTemplateVariables(template.html).forEach((key) => required.add(key));
    extractTemplateVariables(template.text).forEach((key) => required.add(key));
    return Array.from(required).filter(Boolean);
  }

  getAllowedTemplateIds(payload = {}) {
    const raw =
      payload.allowed_template_ids ||
      payload.approved_templates ||
      payload.template_ids ||
      payload.script_ids ||
      [];
    const values = Array.isArray(raw) ? raw : [raw];
    return new Set(values.map((entry) => String(entry || '').trim()).filter(Boolean));
  }

  findMissingTemplateVariables(template = {}, variables = {}) {
    return this.getTemplateRequiredVariables(template).filter((key) => {
      const value = getNestedValue(variables, key);
      return value === undefined || value === null;
    });
  }

  isTemplateSelectable(template = {}, { requireLive = false } = {}) {
    const lifecycle = normalizeLifecycleState(template.lifecycle_state);
    if (requireLive) return lifecycle === 'live';
    return TEMPLATE_SELECTABLE_LIFECYCLES.has(lifecycle);
  }

  scoreTemplateForContext(template = {}, tokens = [], variables = {}) {
    const lifecycle = normalizeLifecycleState(template.lifecycle_state);
    const idText = String(template.template_id || '').toLowerCase();
    const subjectText = String(template.subject || '').toLowerCase();
    const bodyText = `${template.text || ''} ${template.html || ''}`.toLowerCase();
    const matchedTokens = [];
    let score = lifecycle === 'live' ? 25 : 10;

    tokens.forEach((token) => {
      const normalizedToken = String(token || '').toLowerCase();
      if (!normalizedToken) return;
      let tokenScore = 0;
      if (idText.includes(normalizedToken)) tokenScore += 14;
      if (subjectText.includes(normalizedToken)) tokenScore += 8;
      if (bodyText.includes(normalizedToken)) tokenScore += 3;
      if (tokenScore > 0) {
        matchedTokens.push(normalizedToken);
        score += tokenScore;
      }
    });

    const missing = this.findMissingTemplateVariables(template, variables);
    if (missing.length) {
      score -= missing.length * 30;
    }
    return { score, matched_tokens: Array.from(new Set(matchedTokens)), missing_variables: missing };
  }

  shouldAutoSelectTemplate(payload = {}) {
    if (payload.script_id || payload.template_id) return false;
    if (payload.select_template === true || payload.auto_select_template === true) return true;
    if (payload.subject || payload.html || payload.text) return false;
    const context = normalizeTemplateSelectionContext(payload);
    return buildTemplateContextTokens(context).length > 0;
  }

  async selectTemplateForContext(payload = {}) {
    const context = normalizeTemplateSelectionContext(payload);
    const tokens = buildTemplateContextTokens(context);
    const variables = payload.variables || {};
    const allowedTemplateIds = this.getAllowedTemplateIds(payload);
    const requireLive = payload.require_live_template === true || payload.require_live_templates === true;
    const allowMissingVariables = payload.allow_missing_template_vars === true;

    if (!tokens.length && !allowedTemplateIds.size) {
      return {
        selected_template_id: null,
        reason: 'no_selection_context',
        context_tokens: tokens,
        candidates: [],
      };
    }

    const templates = typeof this.db?.listEmailTemplates === 'function'
      ? await this.db.listEmailTemplates(200)
      : [];
    const candidates = templates
      .filter((template) => this.isTemplateSelectable(template, { requireLive }))
      .filter((template) => {
        if (!allowedTemplateIds.size) return true;
        return allowedTemplateIds.has(String(template.template_id || ''));
      })
      .map((template) => {
        const scored = this.scoreTemplateForContext(template, tokens, variables);
        return {
          template_id: template.template_id,
          lifecycle_state: normalizeLifecycleState(template.lifecycle_state),
          subject: template.subject || '',
          score: scored.score,
          matched_tokens: scored.matched_tokens,
          missing_variables: scored.missing_variables,
        };
      })
      .filter((candidate) => allowMissingVariables || !candidate.missing_variables.length)
      .filter((candidate) => allowedTemplateIds.size || candidate.matched_tokens.length > 0)
      .sort((a, b) => b.score - a.score || a.template_id.localeCompare(b.template_id));

    const selected = candidates[0] || null;
    return {
      selected_template_id: selected?.template_id || null,
      template_id: selected?.template_id || null,
      lifecycle_state: selected?.lifecycle_state || null,
      score: selected?.score || 0,
      matched_tokens: selected?.matched_tokens || [],
      missing_variables: selected?.missing_variables || [],
      context,
      context_tokens: tokens,
      candidates: candidates.slice(0, 5),
      reason: selected ? 'matched' : 'no_matching_template',
    };
  }

  async validateProviderHealth(payload = {}) {
    const provider = this.resolveProvider(payload.provider || 'sendgrid');
    const live = payload.live === true || String(payload.mode || '').toLowerCase() === 'live';
    const requireLiveTemplates = payload.require_live_templates === true || payload.require_live_template === true;
    const checks = [];
    const addCheck = (name, status, details = {}) => {
      checks.push({
        name,
        status,
        ...details,
      });
    };

    addCheck('provider_supported', 'pass', { provider });
    const readiness = this.getProviderReadiness();
    addCheck(`${provider}_credentials_configured`, readiness[provider] ? 'pass' : 'fail');

    const from = normalizeEmail(payload.from || this.getDefaultFrom());
    if (!isValidEmail(from)) {
      addCheck('sender_identity', 'fail', { message: 'A valid sender email is required.' });
    } else if (!this.isVerifiedSender(from)) {
      addCheck('sender_identity', 'fail', {
        from_domain: getDomain(from),
        message: 'Sender domain is not in EMAIL_VERIFIED_DOMAINS.',
      });
    } else {
      addCheck('sender_identity', 'pass', { from_domain: getDomain(from) });
    }

    const domains = this.getVerifiedDomains();
    addCheck('domain_allowlist', domains.length ? 'pass' : 'warn', {
      domains_configured: domains.length,
      message: domains.length
        ? undefined
        : 'EMAIL_VERIFIED_DOMAINS is empty; local sender-domain checks are permissive.',
    });

    const templateIds = Array.from(this.getAllowedTemplateIds(payload));
    if (!templateIds.length) {
      addCheck('approved_templates', 'warn', {
        message: 'No template ids supplied for approval validation.',
      });
    } else {
      for (const templateId of templateIds) {
        const template = await this.db.getEmailTemplate(templateId);
        if (!template) {
          addCheck('approved_template', 'fail', { template_id: templateId, message: 'Template not found.' });
          continue;
        }
        const lifecycle = normalizeLifecycleState(template.lifecycle_state);
        const selectable = this.isTemplateSelectable(template, { requireLive: requireLiveTemplates });
        addCheck('approved_template', selectable ? 'pass' : 'fail', {
          template_id: templateId,
          lifecycle_state: lifecycle,
          required_lifecycle: requireLiveTemplates ? 'live' : 'approved_or_live',
        });
      }
    }

    if (live && provider === 'sendgrid') {
      const adapter = this.getAdapter(provider);
      if (typeof adapter.validateApiKey === 'function') {
        try {
          const profile = await adapter.validateApiKey();
          addCheck('sendgrid_api_key_live', 'pass', {
            user_id: profile.user_id || null,
            username: profile.username || null,
          });
        } catch (err) {
          addCheck('sendgrid_api_key_live', 'fail', {
            status: err.statusCode || null,
            message: err.statusCode === 401
              ? 'SendGrid rejected the API key.'
              : previewForLog(err.message, 180),
          });
        }
      }

      if (isValidEmail(from) && typeof adapter.listVerifiedSenders === 'function') {
        try {
          const senders = await adapter.listVerifiedSenders();
          const sender = senders.find((entry) => entry.from_email === from);
          addCheck('sendgrid_sender_identity_live', sender?.verified ? 'pass' : 'fail', {
            from_domain: getDomain(from),
            sender_found: Boolean(sender),
          });
        } catch (err) {
          addCheck('sendgrid_sender_identity_live', err.statusCode === 401 ? 'fail' : 'warn', {
            status: err.statusCode || null,
            message: err.statusCode === 401
              ? 'SendGrid rejected the API key.'
              : 'Unable to list SendGrid sender identities with the configured key.',
          });
        }
      }
    }

    const ok = !checks.some((check) => check.status === 'fail');
    return {
      ok,
      provider,
      mode: live ? 'live' : 'dry_run',
      dry_run: !live,
      checked_at: new Date().toISOString(),
      checks,
    };
  }

  async resolveTemplate(payload) {
    const explicitTemplateId = payload.script_id || payload.template_id;
    if (explicitTemplateId) {
      const template = await this.db.getEmailTemplate(explicitTemplateId);
      if (!template) {
        throw new Error(`Script ${explicitTemplateId} not found`);
      }
      return {
        subject: template.subject || payload.subject || '',
        html: template.html || payload.html || '',
        text: template.text || payload.text || '',
        script_id: explicitTemplateId,
        template_selection: null,
      };
    }
    if (this.shouldAutoSelectTemplate(payload)) {
      const selection = await this.selectTemplateForContext(payload);
      if (selection.selected_template_id) {
        const template = await this.db.getEmailTemplate(selection.selected_template_id);
        if (!template) {
          const error = new Error(`Selected template ${selection.selected_template_id} not found`);
          error.code = 'validation_error';
          throw error;
        }
        return {
          subject: template.subject || payload.subject || '',
          html: template.html || payload.html || '',
          text: template.text || payload.text || '',
          script_id: selection.selected_template_id,
          template_selection: selection,
        };
      }
      const error = new Error('No approved email template matched selection context');
      error.code = 'validation_error';
      error.template_selection = selection;
      throw error;
    }
    return {
      subject: payload.subject || '',
      html: payload.html || '',
      text: payload.text || '',
      script_id: null,
      template_selection: null,
    };
  }

  async enqueueEmail(payload, options = {}) {
    const idempotencyKey = options.idempotencyKey;
    const to = normalizeEmail(payload.to);
    const from = normalizeEmail(payload.from || this.getDefaultFrom());
    if (!isValidEmail(to)) {
      throw new Error('Invalid recipient email');
    }
    if (!isValidEmail(from)) {
      throw new Error('Invalid sender email');
    }
    if (!this.isVerifiedSender(from)) {
      throw new Error('Sender domain not verified');
    }

    const script = await this.resolveTemplate(payload);
    const variables = payload.variables || {};
    const missing = this.validateVariables(script, variables);
    if (missing.length) {
      const error = new Error(`Missing script variables: ${missing.join(', ')}`);
      error.code = 'missing_variables';
      error.missing = missing;
      throw error;
    }

    const rendered = this.renderTemplate(script, variables);
    if (rendered.subject && rendered.subject.length > this.maxSubjectChars) {
      const error = new Error(
        `Subject exceeds ${this.maxSubjectChars} characters`,
      );
      error.code = 'validation_error';
      throw error;
    }
    if (rendered.text && rendered.text.length > this.maxBodyChars) {
      const error = new Error(
        `Text body exceeds ${this.maxBodyChars} characters`,
      );
      error.code = 'validation_error';
      throw error;
    }
    if (rendered.html && rendered.html.length > this.maxBodyChars) {
      const error = new Error(
        `HTML body exceeds ${this.maxBodyChars} characters`,
      );
      error.code = 'validation_error';
      throw error;
    }

    let scheduledAt = null;
    if (payload.send_at) {
      const parsed = new Date(payload.send_at);
      if (Number.isNaN(parsed.getTime())) {
        const error = new Error('send_at must be a valid ISO timestamp');
        error.code = 'validation_error';
        throw error;
      }
      if (parsed.getTime() <= Date.now()) {
        const error = new Error('send_at must be in the future');
        error.code = 'validation_error';
        throw error;
      }
      scheduledAt = parsed.toISOString();
    }

    const requestHash = hashPayload({
      to,
      from,
      subject: rendered.subject,
      script_id: script.script_id,
      template_selection: script.template_selection?.selected_template_id || null,
      variables,
      html: rendered.html,
      text: rendered.text,
      send_at: scheduledAt
    });
    const resolvedProvider = this.resolveProvider(payload.provider);
    let idempotencyReservationInserted = false;

    if (idempotencyKey) {
      const reservation = await this.db.reserveEmailIdempotency(
        idempotencyKey,
        requestHash,
        payload.bulk_job_id || null,
      );
      const existing = reservation.record;
      if (existing?.message_id) {
        if (existing.request_hash && existing.request_hash !== requestHash) {
          const error = new Error('Idempotency key reuse with different payload');
          error.code = 'idempotency_conflict';
          throw error;
        }
        return { message_id: existing.message_id, deduped: true };
      }
      if (existing?.request_hash && existing.request_hash !== requestHash) {
        const error = new Error('Idempotency key reuse with different payload');
        error.code = 'idempotency_conflict';
        throw error;
      }
      if (!reservation.inserted) {
        const error = new Error('Idempotency key is currently processing');
        error.code = 'idempotency_in_progress';
        throw error;
      }
      idempotencyReservationInserted = true;
    }

    const suppressed = await this.db.isEmailSuppressed(to);
    const status = suppressed ? 'suppressed' : 'queued';
    const messageId = `email_${crypto.randomUUID()}`;
    const metadata = { ...(payload.metadata || {}), is_marketing: !!payload.is_marketing };
    if (script.template_selection) {
      metadata.template_selection = {
        selected_template_id: script.template_selection.selected_template_id,
        reason: script.template_selection.reason,
        score: script.template_selection.score,
        matched_tokens: script.template_selection.matched_tokens || [],
      };
    }

    try {
      await this.db.saveEmailMessage({
        message_id: messageId,
        to_email: to,
        from_email: from,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        template_id: script.script_id,
        variables_json: JSON.stringify(variables),
        variables_hash: hashPayload(variables),
        metadata_json: JSON.stringify(metadata),
        status,
        provider: resolvedProvider,
        tenant_id: payload.tenant_id || null,
        bulk_job_id: payload.bulk_job_id || null,
        scheduled_at: scheduledAt,
        max_retries: payload.max_retries || this.config.maxRetries || 5
      });
    } catch (err) {
      if (idempotencyReservationInserted && idempotencyKey) {
        await this.db.clearPendingEmailIdempotency(idempotencyKey).catch(() => {});
      }
      throw err;
    }

    if (idempotencyKey) {
      await this.db.finalizeEmailIdempotency(
        idempotencyKey,
        messageId,
        payload.bulk_job_id || null,
        requestHash,
      );
    }

    if (suppressed) {
      await this.db.updateEmailMessageStatus(messageId, {
        status: 'suppressed',
        failure_reason: suppressed.reason || 'suppressed',
        suppressed_reason: suppressed.reason || 'suppressed',
        failed_at: new Date().toISOString()
      });
      await this.db.addEmailEvent(messageId, 'suppressed', { reason: suppressed.reason, source: suppressed.source });
      await this.db.incrementEmailMetric('suppressed');
      return { message_id: messageId, suppressed: true };
    }

    await this.db.addEmailEvent(messageId, 'queued', { scheduled_at: scheduledAt });
    await this.db.incrementEmailMetric('queued');
    return { message_id: messageId };
  }

  async enqueueBulk(payload, options = {}) {
    const idempotencyKey = options.idempotencyKey;
    const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
    if (!recipients.length) {
      throw new Error('Recipients list is required');
    }
    if (recipients.length > this.maxBulkRecipients) {
      const error = new Error(
        `Recipients exceed maximum of ${this.maxBulkRecipients}`,
      );
      error.code = 'validation_error';
      throw error;
    }

    const requestHash = hashPayload({
      recipients: recipients.map((r) => normalizeEmail(r.email)),
      script_id: payload.script_id,
      subject: payload.subject,
      variables: payload.variables || {},
      send_at: payload.send_at || null
    });
    let idempotencyReservationInserted = false;

    if (idempotencyKey) {
      const reservation = await this.db.reserveEmailIdempotency(
        idempotencyKey,
        requestHash,
        null,
      );
      const existing = reservation.record;
      if (existing?.bulk_job_id) {
        if (existing.request_hash && existing.request_hash !== requestHash) {
          const error = new Error('Idempotency key reuse with different payload');
          error.code = 'idempotency_conflict';
          throw error;
        }
        return { bulk_job_id: existing.bulk_job_id, deduped: true };
      }
      if (existing?.request_hash && existing.request_hash !== requestHash) {
        const error = new Error('Idempotency key reuse with different payload');
        error.code = 'idempotency_conflict';
        throw error;
      }
      if (!reservation.inserted) {
        const error = new Error('Idempotency key is currently processing');
        error.code = 'idempotency_in_progress';
        throw error;
      }
      idempotencyReservationInserted = true;
    }

    const jobId = `bulk_${crypto.randomUUID()}`;
    try {
      await this.db.createEmailBulkJob({
        job_id: jobId,
        status: 'queued',
        total: recipients.length,
        queued: 0,
        tenant_id: payload.tenant_id || null,
        template_id: payload.script_id || null
      });
    } catch (err) {
      if (idempotencyReservationInserted && idempotencyKey) {
        await this.db.clearPendingEmailIdempotency(idempotencyKey).catch(() => {});
      }
      throw err;
    }

    if (idempotencyKey) {
      await this.db.finalizeEmailIdempotency(
        idempotencyKey,
        null,
        jobId,
        requestHash,
      );
    }

    let queued = 0;
    let failed = 0;
    let suppressed = 0;
    for (const recipient of recipients) {
      const recipientKey = idempotencyKey
        ? `${idempotencyKey}:${crypto.createHash('sha1').update(normalizeEmail(recipient.email)).digest('hex')}`
        : null;
      try {
        const result = await this.enqueueEmail({
          ...payload,
          to: recipient.email,
          variables: { ...(payload.variables || {}), ...(recipient.variables || {}) },
          metadata: { ...(payload.metadata || {}), ...(recipient.metadata || {}) },
          bulk_job_id: jobId
        }, { idempotencyKey: recipientKey });
        if (result.deduped) {
          const existing = await this.db.getEmailMessage(result.message_id);
          if (existing?.status === 'suppressed') {
            suppressed += 1;
          } else if (existing?.status === 'failed') {
            failed += 1;
          } else {
            queued += 1;
          }
        } else if (result.suppressed) {
          suppressed += 1;
        } else {
          queued += 1;
        }
      } catch (err) {
        failed += 1;
        this.logger.warn('⚠️ Bulk email enqueue failed:', {
          email: redactEmailForLog(recipient.email),
          error: previewForLog(err.message)
        });
      }
    }

    const status = queued > 0 ? 'queued' : 'completed';
    const completedAt = queued > 0 ? null : new Date().toISOString();
    await this.db.updateEmailBulkJob(jobId, {
      queued,
      failed,
      suppressed,
      status,
      completed_at: completedAt
    });

    return { bulk_job_id: jobId };
  }

  async processQueue({ limit = 10 } = {}) {
    if (this.processing) return;
    const nowMs = Date.now();
    if (this.corruptDbBackoffUntilMs > nowMs) {
      return;
    }
    this.processing = true;
    try {
      const nowMs = Date.now();
      if (
        nowMs - this.providerEventsLastCleanupMs >
        60 * 60 * 1000
      ) {
        this.providerEventsLastCleanupMs = nowMs;
        await this.db
          .cleanupExpiredEmailProviderEvents(this.providerEventsTtlDays)
          .catch(() => {});
      }
      const messages = await this.db.claimPendingEmailMessages(limit, {
        leaseMs: this.queueClaimLeaseMs,
        staleSendingMs: this.queueStaleSendingMs,
      });
      for (const message of messages) {
        try {
          await this.processMessage(message);
        } catch (err) {
          this.logger.error('Email queue message processing failed:', {
            message_id: message?.message_id || null,
            error: previewForLog(err.message),
          });
          await this.handleSendFailure(message, err).catch((failureErr) => {
            this.logger.error('Email queue failure handling failed:', {
              message_id: message?.message_id || null,
              error: previewForLog(failureErr.message),
            });
          });
        } finally {
          await this.db
            .releaseEmailMessageClaim(message?.message_id, message?.queue_lock_token || null)
            .catch(() => {});
        }
      }
    } catch (err) {
      if (isSqliteCorruptionError(err)) {
        this.corruptDbBackoffUntilMs = Date.now() + this.corruptDbPauseMs;
        if (Date.now() - this.lastCorruptDbLogAtMs > 10000) {
          this.lastCorruptDbLogAtMs = Date.now();
          this.logger.error('Email queue paused due to SQLite corruption:', {
            error: previewForLog(err.message),
            pause_ms: this.corruptDbPauseMs,
          });
        }
        return;
      }
      this.logger.error('Email queue processing error:', err.message);
    } finally {
      this.processing = false;
    }
  }

  checkRateLimit(key, limit) {
    if (!limit || limit <= 0) return { allowed: true };
    const now = Date.now();
    const windowMs = 60000;
    const bucket = this.rateBuckets.get(key) || [];
    const filtered = bucket.filter((ts) => now - ts < windowMs);
    if (filtered.length >= limit) {
      const earliest = filtered[0];
      const retryAfterMs = Math.max(0, windowMs - (now - earliest));
      this.rateBuckets.set(key, filtered);
      return { allowed: false, retryAfterMs };
    }
    filtered.push(now);
    this.rateBuckets.set(key, filtered);
    return { allowed: true };
  }

  async checkWarmupLimit() {
    const warmup = this.config.warmup || {};
    if (!warmup.enabled || !warmup.maxPerDay) return { allowed: true };
    const count = await this.db.getEmailMetricCount('sent');
    if (count >= warmup.maxPerDay) {
      const now = new Date();
      const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return { allowed: false, retryAfterMs: nextDay - now };
    }
    return { allowed: true };
  }

  async processMessage(message) {
    const messageId = message.message_id;
    const provider = this.resolveProvider(message.provider);
    const now = new Date();
    const nowIso = now.toISOString();

    if (message.status === 'sending') {
      const lastAttemptMs = Date.parse(message.last_attempt_at || '');
      const staleForMs = Number.isFinite(lastAttemptMs)
        ? Date.now() - lastAttemptMs
        : Number.POSITIVE_INFINITY;
      if (staleForMs < this.queueStaleSendingMs) {
        return;
      }
      await this.db.addEmailEvent(messageId, 'retry_scheduled', {
        reason: 'stale_sending_recovered',
        stale_for_ms: staleForMs,
      });
    }

    const suppressed = await this.db.isEmailSuppressed(message.to_email);
    if (suppressed) {
      await this.db.updateEmailMessageStatus(messageId, {
        status: 'suppressed',
        failure_reason: suppressed.reason || 'suppressed',
        suppressed_reason: suppressed.reason || 'suppressed',
        failed_at: nowIso
      });
      await this.db.addEmailEvent(messageId, 'suppressed', { reason: suppressed.reason, source: suppressed.source });
      await this.db.incrementEmailMetric('suppressed');
      await this.updateBulkCounters(message.bulk_job_id, message.status, 'suppressed');
      return;
    }

    const circuitStatus = this.getProviderCircuitStatus(provider);
    if (circuitStatus.open) {
      const retryAt = new Date(Date.now() + circuitStatus.retryAfterMs).toISOString();
      await this.db.updateEmailMessageStatus(messageId, {
        status: 'retry',
        next_attempt_at: retryAt,
        failure_reason: 'provider_circuit_open',
      });
      await this.db.addEmailEvent(messageId, 'retry_scheduled', {
        provider,
        reason: 'provider_circuit_open',
        retry_at: retryAt,
      });
      return;
    }

    const warmup = await this.checkWarmupLimit();
    if (!warmup.allowed) {
      const retryAt = new Date(Date.now() + warmup.retryAfterMs).toISOString();
      await this.db.updateEmailMessageStatus(messageId, {
        status: 'queued',
        next_attempt_at: retryAt
      });
      await this.db.addEmailEvent(messageId, 'throttled', { reason: 'warmup', retry_at: retryAt });
      return;
    }

    const perProvider = this.config.rateLimits?.perProviderPerMinute;
    const perTenant = this.config.rateLimits?.perTenantPerMinute;
    const perDomain = this.config.rateLimits?.perDomainPerMinute;
    const tenantId = message.tenant_id || 'default';
    const domain = getDomain(message.to_email);

    const providerLimit = this.checkRateLimit(`provider:${provider}`, perProvider);
    const tenantLimit = this.checkRateLimit(`tenant:${tenantId}`, perTenant);
    const domainLimit = this.checkRateLimit(`domain:${domain}`, perDomain);

    const blocked = [providerLimit, tenantLimit, domainLimit].find((limit) => !limit.allowed);
    if (blocked) {
      const retryAt = new Date(Date.now() + blocked.retryAfterMs).toISOString();
      await this.db.updateEmailMessageStatus(messageId, {
        status: 'queued',
        next_attempt_at: retryAt
      });
      await this.db.addEmailEvent(messageId, 'throttled', { retry_at: retryAt });
      return;
    }

    await this.db.updateEmailMessageStatus(messageId, {
      status: 'sending',
      last_attempt_at: nowIso,
      queue_lock_expires_at_ms: Date.now() + this.queueClaimLeaseMs,
    });
    await this.db.addEmailEvent(messageId, 'sending', { provider });

    const metadata = safeParseJson(message.metadata_json) || {};
    const headers = this.buildHeaders({
      ...message,
      to: message.to_email,
      message_id: message.message_id,
      is_marketing: metadata.is_marketing
    });

    try {
      const adapter = this.getAdapter(provider);
      const result = await adapter.sendEmail({
        to: message.to_email,
        from: message.from_email,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers,
        replyTo: null,
        messageId: message.message_id
      });
      await this.db.updateEmailMessageStatus(messageId, {
        status: 'sent',
        provider_message_id: result.providerMessageId,
        provider_response: result.response ? JSON.stringify(result.response) : null,
        sent_at: nowIso,
      });
      await this.db.addEmailEvent(messageId, 'sent', { provider_message_id: result.providerMessageId }, provider);
      await this.db.incrementEmailMetric('sent');
      await this.updateBulkCounters(message.bulk_job_id, message.status, 'sent');
      this.recordProviderSuccess(provider);
    } catch (err) {
      await this.handleSendFailure(message, err, provider);
    }
  }

  shouldCountCircuitFailure(classification = {}) {
    if (!this.circuitBreakerEnabled) return false;
    if (classification.permanent) return false;
    if (classification.reason === 'rate_limited') return false;
    return ['provider_error', 'provider_timeout', 'network_error'].includes(
      classification.reason,
    );
  }

  getProviderCircuitState(provider) {
    const key = normalizeProviderName(provider) || 'unknown';
    if (!this.providerCircuits.has(key)) {
      this.providerCircuits.set(key, {
        failures: [],
        openUntilMs: 0,
      });
    }
    return this.providerCircuits.get(key);
  }

  pruneCircuitFailures(state, nowMs = Date.now()) {
    state.failures = (state.failures || []).filter(
      (timestamp) => nowMs - timestamp <= this.circuitFailureWindowMs,
    );
  }

  getProviderCircuitStatus(provider) {
    if (!this.circuitBreakerEnabled) {
      return { open: false, retryAfterMs: 0 };
    }
    const nowMs = Date.now();
    const state = this.getProviderCircuitState(provider);
    this.pruneCircuitFailures(state, nowMs);
    if (state.openUntilMs && state.openUntilMs > nowMs) {
      return { open: true, retryAfterMs: state.openUntilMs - nowMs };
    }
    if (state.openUntilMs && state.openUntilMs <= nowMs) {
      state.openUntilMs = 0;
      state.failures = [];
    }
    return { open: false, retryAfterMs: 0 };
  }

  recordProviderFailure(provider, classification = {}) {
    if (!this.circuitBreakerEnabled) return;
    const key = normalizeProviderName(provider) || 'unknown';
    const nowMs = Date.now();
    const state = this.getProviderCircuitState(key);
    state.failures.push(nowMs);
    this.pruneCircuitFailures(state, nowMs);
    if (state.failures.length < this.circuitFailureThreshold) {
      return;
    }
    const currentlyOpen = state.openUntilMs && state.openUntilMs > nowMs;
    state.openUntilMs = nowMs + this.circuitCooldownMs;
    if (currentlyOpen) {
      return;
    }
    const details = {
      provider: key,
      failure_reason: classification.reason || 'provider_error',
      failure_count: state.failures.length,
      threshold: this.circuitFailureThreshold,
      window_ms: this.circuitFailureWindowMs,
      cooldown_ms: this.circuitCooldownMs,
      opened_at: new Date(nowMs).toISOString(),
    };
    this.logger.warn('⚠️ Email provider circuit opened', details);
    this.db?.logServiceHealth?.('email_provider_circuit', 'open', details).catch(() => {});
  }

  recordProviderSuccess(provider) {
    if (!this.circuitBreakerEnabled) return;
    const key = normalizeProviderName(provider) || 'unknown';
    const state = this.getProviderCircuitState(key);
    if (!state.failures.length && !state.openUntilMs) {
      return;
    }
    const wasOpen = state.openUntilMs > Date.now();
    state.failures = [];
    state.openUntilMs = 0;
    if (wasOpen) {
      this.db
        ?.logServiceHealth?.('email_provider_circuit', 'closed', {
          provider: key,
          closed_at: new Date().toISOString(),
          reason: 'provider_request_succeeded',
        })
        .catch(() => {});
    }
  }

  shouldSuppressFromFailure(classification = {}, err) {
    if (!classification.permanent) return false;
    const text = `${classification.reason || ''} ${classification.message || ''} ${
      err?.providerCode || ''
    }`.toLowerCase();
    return (
      /invalid.+(recipient|address|mailbox)/.test(text) ||
      /recipient.+(rejected|invalid|unknown)/.test(text) ||
      /mailbox.+(invalid|unavailable|not found)/.test(text) ||
      /user unknown/.test(text) ||
      /hard bounce/.test(text) ||
      /5\.1\.1/.test(text)
    );
  }

  buildProviderEventKey(event = {}, resolvedMessageId = '') {
    const provider = normalizeProviderName(event.provider) || 'unknown';
    const eventId = String(event.event_id || event.eventId || '').trim();
    if (eventId) {
      return `${provider}:${eventId}`;
    }
    return hashPayload({
      provider,
      message_id: resolvedMessageId || event.message_id || null,
      provider_message_id: event.provider_message_id || null,
      type: event.type || null,
      reason: event.reason || null,
      occurred_at: event.occurred_at || null,
    });
  }

  getSuppressionReasonFromProviderEvent(event = {}) {
    if (event.suppression_reason) {
      return String(event.suppression_reason || '').trim().toLowerCase();
    }
    const type = this.normalizeStatus(event.type);
    if (type === 'bounced') return 'bounce';
    if (type === 'complained') return 'complaint';
    if (type !== 'failed') return null;
    const reason = String(event.reason || '').toLowerCase();
    if (
      /bounce|user unknown|mailbox|invalid|recipient|5\.1\.1|hard bounce/.test(
        reason,
      )
    ) {
      return 'hard_bounce';
    }
    if (/complaint|spam/.test(reason)) {
      return 'complaint';
    }
    return null;
  }

  classifyError(err) {
    const status = Number(err?.statusCode || err?.status || err?.response?.status);
    const code = String(err?.code || err?.providerCode || '').toUpperCase();
    const message = err?.response?.data?.error || err?.message || 'send_failed';
    if (err?.retryable === true) {
      return { permanent: false, reason: 'provider_error', statusCode: status || null, message };
    }
    if (err?.code === 'email_provider_timeout') {
      return { permanent: false, reason: 'provider_timeout', statusCode: status || null, message };
    }
    if (status === 429) return { permanent: false, reason: 'rate_limited', statusCode: status, message };
    if (status && status >= 500) return { permanent: false, reason: 'provider_error', statusCode: status, message };
    if (status && status >= 400) return { permanent: true, reason: 'invalid_request', statusCode: status, message };
    if (code && RETRYABLE_NETWORK_CODES.has(code)) {
      return { permanent: false, reason: 'network_error', statusCode: status, message };
    }
    return { permanent: true, reason: message, statusCode: status, message };
  }

  async handleSendFailure(message, err, providerOverride = null) {
    const messageId = message.message_id;
    const classification = this.classifyError(err);
    const retryCount = Number(message.retry_count || 0) + 1;
    const maxRetries = Number(message.max_retries || this.config.maxRetries || 5);
    let provider = normalizeProviderName(providerOverride || message.provider) || 'unknown';
    try {
      provider = this.resolveProvider(provider);
    } catch (_) {
      // keep normalized fallback for logging/suppression when provider config drifts
    }

    if (this.shouldCountCircuitFailure(classification)) {
      this.recordProviderFailure(provider, classification);
    }

    if (!classification.permanent && retryCount <= maxRetries) {
      const baseDelay = 30000;
      const backoff = Math.min(3600000, baseDelay * Math.pow(2, retryCount - 1));
      const jitter = Math.floor(Math.random() * 5000);
      const nextAttempt = new Date(Date.now() + backoff + jitter).toISOString();
      await this.db.updateEmailMessageStatus(messageId, {
        status: 'retry',
        retry_count: retryCount,
        next_attempt_at: nextAttempt,
        failure_reason: classification.reason,
      });
      await this.db.addEmailEvent(messageId, 'retry_scheduled', { retry_at: nextAttempt, reason: classification.reason });
      return;
    }

    if (this.shouldSuppressFromFailure(classification, err)) {
      await this.db
        .setEmailSuppression(message.to_email, 'provider_permanent_failure', provider)
        .catch(() => {});
      await this.db
        .addEmailEvent(
          messageId,
          'suppression_added',
          { reason: 'provider_permanent_failure', provider },
          provider,
        )
        .catch(() => {});
    }

    await this.db.updateEmailMessageStatus(messageId, {
      status: 'failed',
      failure_reason: classification.reason,
      failed_at: new Date().toISOString(),
    });
    await this.db.addEmailEvent(messageId, 'failed', { reason: classification.reason, status: classification.statusCode });
    await this.db.incrementEmailMetric('failed');
    await this.db.insertEmailDlq(messageId, classification.reason, {
      provider: message.provider,
      to: message.to_email
    });
    this.db
      ?.logServiceHealth?.('email_queue', 'message_dead_lettered', {
        message_id: messageId,
        reason: classification.reason,
        status_code: classification.statusCode || null,
        retry_count: retryCount,
        max_retries: maxRetries,
        at: new Date().toISOString(),
      })
      .catch(() => {});
    const openDlq = await this.db.countOpenEmailDlq().catch(() => null);
    if (openDlq !== null && openDlq >= this.dlqAlertThreshold) {
      this.db
        ?.logServiceHealth?.('email_queue', 'dlq_alert_threshold', {
          open_dlq: openDlq,
          alert_threshold: this.dlqAlertThreshold,
          at: new Date().toISOString(),
        })
        .catch(() => {});
    }
    await this.updateBulkCounters(message.bulk_job_id, message.status, 'failed');
  }

  async updateBulkCounters(jobId, previousStatus, nextStatus) {
    if (!jobId) return;
    const job = await this.db.getEmailBulkJob(jobId);
    if (!job) return;
    const updates = {};
    const decrement = (field) => {
      updates[field] = Math.max(0, Number(job[field] || 0) - 1);
    };
    const increment = (field) => {
      updates[field] = Number(job[field] || 0) + 1;
    };

    const statusMap = {
      queued: 'queued',
      retry: 'queued',
      sending: 'sending',
      sent: 'sent',
      failed: 'failed',
      delivered: 'delivered',
      bounced: 'bounced',
      complained: 'complained',
      suppressed: 'suppressed'
    };

    if (statusMap[previousStatus]) {
      decrement(statusMap[previousStatus]);
    }
    if (statusMap[nextStatus]) {
      increment(statusMap[nextStatus]);
    }
    const remaining = (updates.queued ?? job.queued) + (updates.sending ?? job.sending) + (updates.sent ?? job.sent);
    if (remaining <= 0) {
      updates.status = 'completed';
      updates.completed_at = new Date().toISOString();
    } else {
      updates.status = 'sending';
    }
    await this.db.updateEmailBulkJob(jobId, updates);
  }

  pruneProviderEventDedupe(nowMs = Date.now()) {
    for (const [key, expiresAt] of this.providerEventDedupe.entries()) {
      if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
        this.providerEventDedupe.delete(key);
      }
    }
  }

  markProviderEventSeen(event = {}) {
    const nowMs = Date.now();
    this.pruneProviderEventDedupe(nowMs);
    const key = [
      event.event_id || '',
      event.message_id || '',
      event.provider_message_id || '',
      event.provider || '',
      event.type || '',
      event.reason || ''
    ].join('|');
    if (!key.replace(/\|/g, '').trim()) {
      return false;
    }
    if (this.providerEventDedupe.has(key)) {
      return true;
    }
    this.providerEventDedupe.set(key, nowMs + this.providerEventDedupeTtlMs);
    return false;
  }

  normalizeStatus(status = '') {
    return String(status || '').trim().toLowerCase();
  }

  isTerminalStatus(status = '') {
    return ['delivered', 'bounced', 'complained', 'failed', 'suppressed'].includes(
      this.normalizeStatus(status),
    );
  }

  canTransitionStatus(currentStatus = '', targetStatus = '') {
    const current = this.normalizeStatus(currentStatus);
    const target = this.normalizeStatus(targetStatus);
    if (!target) return false;
    if (!current) return true;
    if (current === target) return false;
    const allowed = {
      queued: new Set(['sending', 'sent', 'failed', 'delivered', 'bounced', 'complained']),
      retry: new Set(['sending', 'sent', 'failed', 'delivered', 'bounced', 'complained']),
      sending: new Set(['sent', 'failed', 'delivered', 'bounced', 'complained']),
      sent: new Set(['delivered', 'bounced', 'complained', 'failed']),
      delivered: new Set(['complained']),
      failed: new Set([]),
      bounced: new Set([]),
      complained: new Set([]),
      suppressed: new Set([])
    };
    const allowedTargets = allowed[current];
    if (!allowedTargets) return false;
    return allowedTargets.has(target);
  }

  async handleProviderEvent(payload) {
    const events = this.normalizeProviderEvents(payload);
    let processed = 0;
    let deduped = 0;
    for (const event of events) {
      if (this.markProviderEventSeen(event)) {
        deduped += 1;
        continue;
      }
      let messageId = event.message_id;
      let message = null;
      if (messageId) {
        message = await this.db.getEmailMessage(messageId);
      }
      if (!message && event.provider_message_id) {
        message = await this.db.getEmailMessageByProviderId(event.provider_message_id);
        messageId = message?.message_id;
      }
      if (!messageId || !message) continue;

      const eventKey = this.buildProviderEventKey(event, messageId);
      if (eventKey) {
        const accepted = await this.db.saveEmailProviderEvent({
          event_key: eventKey,
          message_id: messageId,
          provider: event.provider,
          event_type: event.type,
          reason: event.reason || null,
          payload_json: JSON.stringify({
            message_id: messageId,
            provider_message_id: event.provider_message_id || null,
            event_id: event.event_id || null,
            type: event.type || null,
            provider: event.provider || null,
            reason: event.reason || null,
            suppression_reason: event.suppression_reason || null,
            occurred_at: event.occurred_at || null,
          }),
        });
        if (!accepted) {
          deduped += 1;
          continue;
        }
      }

      const statusMap = {
        delivered: { status: 'delivered', metric: 'delivered' },
        bounced: { status: 'bounced', metric: 'bounced', suppress: 'bounce' },
        complained: { status: 'complained', metric: 'complained' },
        failed: { status: 'failed', metric: 'failed' }
      };
      const statusInfo = statusMap[event.type];
      if (!statusInfo) continue;
      if (!this.canTransitionStatus(message.status, statusInfo.status)) {
        continue;
      }

      await this.db.updateEmailMessageStatus(messageId, {
        status: statusInfo.status,
        failure_reason: event.reason || null,
        delivered_at: statusInfo.status === 'delivered' ? new Date().toISOString() : null,
        failed_at: statusInfo.status !== 'delivered' ? new Date().toISOString() : null
      });
      await this.db.addEmailEvent(messageId, event.type, { reason: event.reason, provider: event.provider }, event.provider);
      await this.db.incrementEmailMetric(statusInfo.metric);
      await this.updateBulkCounters(message.bulk_job_id, message.status, statusInfo.status);

      const suppressionReason =
        statusInfo.suppress || this.getSuppressionReasonFromProviderEvent(event);
      if (suppressionReason) {
        await this.db.setEmailSuppression(message.to_email, suppressionReason, event.provider);
      }
      processed += 1;
    }
    return { processed, deduped, received: events.length };
  }

  normalizeProviderEvents(payload) {
    const provider = String(payload.provider || '').toLowerCase();
    if (!provider && Array.isArray(payload)) {
      return this.normalizeProviderEvents({ provider: 'sendgrid', events: payload });
    }
    const events = [];
    if (provider === 'sendgrid' && Array.isArray(payload.events)) {
      payload.events.forEach((event) => {
        const eventType = String(event.event || '').toLowerCase();
        const typeMap = {
          delivered: 'delivered',
          bounce: 'bounced',
          blocked: 'failed',
          dropped: 'failed',
          spamreport: 'complained',
          unsubscribe: 'complained'
        };
        const mapped = typeMap[eventType];
        if (!mapped) return;
        const customArgs = event.custom_args || event.unique_args || {};
        const timestampMs = Number(event.timestamp) * 1000;
        events.push({
          message_id: event.message_id || customArgs.message_id || null,
          provider_message_id: event.sg_message_id || event.message_id,
          event_id: event.sg_event_id || event.event_id || null,
          type: mapped,
          provider: 'sendgrid',
          reason: event.reason || event.response || eventType,
          suppression_reason:
            eventType === 'bounce'
              ? 'bounce'
              : eventType === 'spamreport'
                ? 'complaint'
                : eventType === 'unsubscribe'
                  ? 'unsubscribe'
                  : null,
          occurred_at: Number.isFinite(timestampMs)
            ? new Date(timestampMs).toISOString()
            : null,
        });
      });
      return events;
    }

    if (provider === 'mailgun') {
      const eventData = payload['event-data'] || payload.eventData || payload;
      const eventType = String(eventData.event || payload.event || '').toLowerCase();
      const typeMap = {
        delivered: 'delivered',
        failed: 'failed',
        bounced: 'bounced',
        complained: 'complained',
        unsubscribed: 'complained'
      };
      const mapped = typeMap[eventType];
      if (mapped) {
        const userVars = eventData['user-variables'] || {};
        const timestampMs = Number(eventData.timestamp || payload.timestamp) * 1000;
        events.push({
          message_id: payload.message_id || userVars.message_id || null,
          provider_message_id: eventData.message?.headers?.['message-id'],
          event_id: eventData.id || payload.id || null,
          type: mapped,
          provider: 'mailgun',
          reason: eventData.reason || eventData['delivery-status']?.message,
          occurred_at: Number.isFinite(timestampMs)
            ? new Date(timestampMs).toISOString()
            : null,
        });
      }
      return events;
    }

    if (payload.message_id && payload.event_type) {
      events.push({
        message_id: payload.message_id,
        provider_message_id: payload.provider_message_id,
        event_id: payload.event_id || null,
        type: payload.event_type,
        provider: payload.provider || 'custom',
        reason: payload.reason,
        occurred_at: payload.timestamp || payload.occurred_at || null,
      });
    }
    return events;
  }

  async previewScript(payload) {
    const script = await this.resolveTemplate(payload);
    const variables = payload.variables || {};
    const missing = this.validateVariables(script, variables);
    if (missing.length) {
      return { ok: false, missing };
    }
    const rendered = this.renderTemplate(script, variables);
    return {
      ok: true,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      script_id: script.script_id,
      template_selection: script.template_selection || null,
    };
  }
}

module.exports = {
  EmailService
};
