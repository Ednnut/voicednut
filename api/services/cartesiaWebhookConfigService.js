const crypto = require('node:crypto');
const { CartesiaApiError } = require('./cartesiaClient');

function webhookConfigError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function validId(value, code, label) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw webhookConfigError(code, `A valid Cartesia ${label} ID is required`);
  }
  return id;
}

function normalizeAgent(payload, expectedId) {
  const agentId = String(payload?.id || '').trim();
  const webhookId = payload?.webhook_id == null ? null : String(payload.webhook_id).trim();
  if (agentId !== expectedId || (webhookId !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(webhookId))) {
    throw webhookConfigError('cartesia_agent_webhook_response_invalid', 'Cartesia returned invalid agent webhook metadata', 502);
  }
  return { agentId, webhookId };
}

function normalizeWebhook(payload, expectedId) {
  const id = String(payload?.id || '').trim();
  let url;
  try {
    url = new URL(String(payload?.url || ''));
  } catch {
    throw webhookConfigError('cartesia_webhook_response_invalid', 'Cartesia returned invalid webhook metadata', 502);
  }
  if (id !== expectedId || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw webhookConfigError('cartesia_webhook_response_invalid', 'Cartesia returned invalid webhook metadata', 502);
  }
  return {
    id,
    displayName: typeof payload.display_name === 'string' ? payload.display_name.slice(0, 120) : null,
    endpoint: `${url.origin}${url.pathname}`,
  };
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
    throw webhookConfigError('cartesia_idempotency_key_required', 'A valid Cartesia operation idempotency key is required');
  }
  return key;
}

function parseStoredPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

class CartesiaWebhookConfigService {
  constructor(options = {}) {
    this.client = options.client;
    this.db = options.db;
    this.enabled = options.enabled === true;
    this.mutationsEnabled = options.mutationsEnabled === true;
    this.webhookSecret = String(options.webhookSecret || '').trim();
    this.fingerprintSecret = String(options.fingerprintSecret || '').trim();
    this.publicWebhookUrl = String(options.publicWebhookUrl || '').trim();
  }

  ensureEnabled() {
    if (!this.enabled || !this.client?.isConfigured?.()) {
      throw webhookConfigError('cartesia_not_configured', 'Cartesia Managed Agents is disabled or not configured', 503);
    }
  }

  normalizeWebhookId(value) {
    if (value === null) return null;
    return validId(value, 'cartesia_invalid_webhook_id', 'webhook');
  }

  async readAgent(agentId) {
    let payload;
    try {
      payload = await this.client.getAgent(agentId);
    } catch (error) {
      if (error instanceof CartesiaApiError && error.status === 404) {
        throw webhookConfigError('cartesia_agent_not_found', 'Cartesia agent was not found', 404);
      }
      throw error;
    }
    return normalizeAgent(payload, agentId);
  }

  async readWebhook(webhookId) {
    let payload;
    try {
      payload = await this.client.getWebhook(webhookId);
    } catch (error) {
      if (error instanceof CartesiaApiError && error.status === 404) {
        throw webhookConfigError('cartesia_webhook_not_found', 'Cartesia webhook was not found', 404);
      }
      throw error;
    }
    return normalizeWebhook(payload, webhookId);
  }

  createFingerprint(input) {
    const serialized = JSON.stringify(input);
    const digest = this.fingerprintSecret
      ? crypto.createHmac('sha256', this.fingerprintSecret).update(serialized).digest('hex')
      : crypto.createHash('sha256').update(serialized).digest('hex');
    return digest;
  }

  normalizePublicWebhookUrl() {
    let url;
    try {
      url = new URL(this.publicWebhookUrl);
    } catch {
      throw webhookConfigError('cartesia_webhook_url_not_configured', 'Set SERVER to the public VOICEDNUT hostname before creating a Cartesia webhook', 503);
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/api/webhooks/cartesia' || host === 'localhost' || host.endsWith('.localhost') ||
        host === '0.0.0.0' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
      throw webhookConfigError('cartesia_webhook_url_not_configured', 'SERVER must resolve to a public HTTPS hostname for the Cartesia webhook endpoint', 503);
    }
    return url.toString();
  }

  async prepareWebhookCreation() {
    this.ensureEnabled();
    if (!this.webhookSecret) {
      throw webhookConfigError('cartesia_webhook_secret_not_configured', 'Configure CARTESIA_WEBHOOK_SECRET before creating a Cartesia webhook', 503);
    }
    const url = this.normalizePublicWebhookUrl();
    const secretDigest = crypto.createHash('sha256').update(this.webhookSecret).digest('hex');
    const requestFingerprint = this.createFingerprint({
      operation: 'webhook_create',
      url,
      secretDigest,
    });
    return Object.freeze({
      operation: 'webhook_create',
      endpointHost: new URL(url).host,
      endpointPath: new URL(url).pathname,
      secretConfigured: true,
      externalOperation: true,
      requestFingerprint,
    });
  }

  async createWebhook(input = {}) {
    this.ensureEnabled();
    if (!this.mutationsEnabled) {
      throw webhookConfigError('cartesia_webhook_mutations_disabled', 'Cartesia webhook configuration changes are disabled', 503);
    }
    normalizeIdempotencyKey(input.idempotency_key);
    const confirmedFingerprint = String(input.confirmed_fingerprint || '').trim().toLowerCase();
    if (input.approved !== true || !/^[a-f0-9]{64}$/.test(confirmedFingerprint)) {
      throw webhookConfigError('cartesia_webhook_creation_confirmation_required', 'Explicit approval and the exact webhook creation preview are required', 400);
    }
    const preview = await this.prepareWebhookCreation();
    if (preview.requestFingerprint !== confirmedFingerprint) {
      throw webhookConfigError('cartesia_webhook_creation_confirmation_mismatch', 'Cartesia webhook configuration changed; request a new preview', 409);
    }
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw webhookConfigError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }

    // One durable key per endpoint prevents a second webhook from being created
    // by a new client idempotency key after refreshes or worker restarts.
    const operationHash = crypto.createHash('sha256').update(preview.endpointHost + preview.endpointPath).digest('hex');
    const operationKey = `voicednut:cartesia:webhook_create:${operationHash}`;
    let existing;
    try {
      existing = await this.db.getOutboundCallIdempotency(operationKey);
    } catch {
      throw webhookConfigError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    if (existing) {
      if (existing.provider !== 'cartesia') {
        throw webhookConfigError('cartesia_idempotency_conflict', 'Cartesia webhook endpoint is already reserved by another operation', 409);
      }
      if (existing.status === 'completed') {
        if (existing.request_hash !== confirmedFingerprint) {
          throw webhookConfigError('cartesia_webhook_already_configured', 'A Cartesia webhook already exists for this endpoint with different server configuration; inspect Cartesia before changing it', 409);
        }
        return { ...parseStoredPayload(existing.response_payload), idempotentReplay: true };
      }
      if (existing.status === 'pending') {
        throw webhookConfigError('cartesia_webhook_creation_outcome_unknown', 'A prior Cartesia webhook creation may have succeeded; inspect Cartesia before taking further action', 409);
      }
      if (existing.request_hash !== confirmedFingerprint) {
        throw webhookConfigError('cartesia_idempotency_conflict', 'Cartesia webhook endpoint is reserved for a different configuration', 409);
      }
      throw webhookConfigError('cartesia_webhook_creation_consumed', 'A prior Cartesia webhook creation was rejected; inspect Cartesia before retrying', 409);
    }

    const reservation = await this.db.reserveOutboundCallIdempotency({
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: confirmedFingerprint,
    }).catch(() => { throw webhookConfigError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503); });
    if (!reservation?.reserved) {
      throw webhookConfigError('cartesia_webhook_creation_outcome_unknown', 'Cartesia webhook creation is already reserved; inspect Cartesia before retrying', 409);
    }
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: confirmedFingerprint,
      status: 'pending',
      response_payload: { endpointHost: preview.endpointHost, endpointPath: preview.endpointPath },
    }).catch(() => { throw webhookConfigError('cartesia_idempotency_storage_unavailable', 'Cartesia webhook creation intent could not be stored; no change was submitted', 503); });

    let created;
    try {
      created = await this.client.createWebhook({ url: this.normalizePublicWebhookUrl(), secret: this.webhookSecret });
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey, provider: 'cartesia', request_hash: confirmedFingerprint,
          status: 'failed', error_message: 'cartesia_webhook_creation_rejected',
        }).catch(() => {});
        throw webhookConfigError('cartesia_webhook_creation_rejected', 'Cartesia rejected the webhook creation request', error.status);
      }
      throw webhookConfigError('cartesia_webhook_creation_outcome_unknown', 'Cartesia webhook creation outcome is unknown; inspect Cartesia before retrying', 409);
    }

    const webhookId = String(created?.id || '').trim();
    let returnedUrl;
    try {
      returnedUrl = new URL(String(created?.url || '')).toString();
    } catch {
      returnedUrl = '';
    }
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(webhookId) || returnedUrl !== this.normalizePublicWebhookUrl()) {
      throw webhookConfigError('cartesia_webhook_creation_outcome_unknown', 'Cartesia created a webhook but returned invalid confirmation data; inspect Cartesia before retrying', 409);
    }
    if (typeof created.secret !== 'string' || !constantTimeEqual(created.secret, this.webhookSecret)) {
      throw webhookConfigError('cartesia_webhook_creation_outcome_unknown', 'Cartesia webhook secret confirmation did not match; inspect Cartesia before retrying', 409);
    }
    const result = {
      webhookId,
      endpointHost: preview.endpointHost,
      endpointPath: preview.endpointPath,
      requestFingerprint: confirmedFingerprint,
      secretReturnedByProvider: false,
      idempotentReplay: false,
    };
    try {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: operationKey,
        provider: 'cartesia',
        request_hash: confirmedFingerprint,
        status: 'completed',
        response_payload: result,
      });
    } catch {
      throw webhookConfigError('cartesia_webhook_creation_persistence_failed', 'Cartesia created the webhook but local confirmation could not be saved; inspect Cartesia before retrying', 503);
    }
    return result;
  }

  async prepareAssignment(agentIdValue, webhookIdValue) {
    this.ensureEnabled();
    const agentId = validId(agentIdValue, 'cartesia_invalid_agent_id', 'agent');
    const webhookId = this.normalizeWebhookId(webhookIdValue);
    if (webhookId !== null && !this.webhookSecret) {
      throw webhookConfigError('cartesia_webhook_secret_not_configured', 'Configure CARTESIA_WEBHOOK_SECRET before attaching a Cartesia webhook', 503);
    }
    const [agent, webhook] = await Promise.all([
      this.readAgent(agentId),
      webhookId === null ? Promise.resolve(null) : this.readWebhook(webhookId),
    ]);
    const requestFingerprint = this.createFingerprint({
      operation: 'agent_webhook_assignment',
      agentId,
      previousWebhookId: agent.webhookId,
      webhookId,
      endpoint: webhook?.endpoint || null,
    });
    return Object.freeze({
      operation: 'agent_webhook_assignment',
      agentId,
      previousWebhookId: agent.webhookId,
      webhookId,
      webhookSecretConfigured: Boolean(this.webhookSecret),
      webhookSecretMatchMustBeVerifiedInCartesia: webhookId !== null,
      webhookUrlMustBeVerifiedInCartesia: webhookId !== null,
      requestFingerprint,
    });
  }

  async readCurrentAssignment(agentId, expectedWebhookId) {
    const agent = await this.readAgent(agentId);
    if (agent.webhookId !== expectedWebhookId) {
      throw webhookConfigError('cartesia_agent_webhook_assignment_outcome_unknown', 'Cartesia webhook assignment could not be confirmed; inspect the agent before retrying', 409);
    }
    return agent;
  }

  async completeOperation(operationKey, fingerprint, result) {
    try {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: operationKey,
        provider: 'cartesia',
        request_hash: fingerprint,
        status: 'completed',
        response_payload: result,
      });
    } catch {
      throw webhookConfigError('cartesia_webhook_assignment_persistence_failed', 'Cartesia applied the webhook assignment but local confirmation could not be saved; inspect the agent before retrying', 503);
    }
    return result;
  }

  async assignAgentWebhook(input = {}) {
    this.ensureEnabled();
    if (!this.mutationsEnabled) {
      throw webhookConfigError('cartesia_webhook_mutations_disabled', 'Cartesia webhook configuration changes are disabled', 503);
    }
    const agentId = validId(input.agent_id, 'cartesia_invalid_agent_id', 'agent');
    const webhookId = this.normalizeWebhookId(input.webhook_id);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotency_key);
    const confirmedFingerprint = String(input.confirmed_fingerprint || '').trim().toLowerCase();
    if (input.approved !== true || !/^[a-f0-9]{64}$/.test(confirmedFingerprint)) {
      throw webhookConfigError('cartesia_webhook_assignment_confirmation_required', 'Explicit approval and the exact webhook assignment preview are required', 400);
    }
    if (webhookId !== null && !this.webhookSecret) {
      throw webhookConfigError('cartesia_webhook_secret_not_configured', 'Configure CARTESIA_WEBHOOK_SECRET before attaching a Cartesia webhook', 503);
    }

    const operationKey = `voicednut:cartesia:webhook_assignment:${idempotencyKey}`;
    if (typeof this.db?.getOutboundCallIdempotency !== 'function' ||
        typeof this.db?.reserveOutboundCallIdempotency !== 'function' ||
        typeof this.db?.completeOutboundCallIdempotency !== 'function') {
      throw webhookConfigError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }

    let existing;
    try {
      existing = await this.db.getOutboundCallIdempotency(operationKey);
    } catch {
      throw webhookConfigError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503);
    }
    if (existing) {
      if (existing.provider !== 'cartesia' || existing.request_hash !== confirmedFingerprint) {
        throw webhookConfigError('cartesia_idempotency_conflict', 'Cartesia idempotency key was already used for a different webhook assignment', 409);
      }
      if (existing.status === 'completed') {
        const stored = parseStoredPayload(existing.response_payload);
        await this.readCurrentAssignment(agentId, webhookId);
        return { ...stored, idempotentReplay: true };
      }
      if (existing.status === 'pending') {
        const agent = await this.readAgent(agentId);
        if (agent.webhookId === webhookId) {
          return this.completeOperation(operationKey, confirmedFingerprint, {
            agentId, webhookId, requestFingerprint: confirmedFingerprint,
            idempotentReplay: true, reconciled: true,
          });
        }
        throw webhookConfigError('cartesia_agent_webhook_assignment_outcome_unknown', 'A prior Cartesia webhook assignment is unresolved; inspect the agent before retrying', 409);
      }
      throw webhookConfigError('cartesia_webhook_assignment_consumed', 'This Cartesia webhook assignment operation key has already been consumed', 409);
    }

    const preview = await this.prepareAssignment(agentId, webhookId);
    if (preview.requestFingerprint !== confirmedFingerprint) {
      throw webhookConfigError('cartesia_webhook_assignment_confirmation_mismatch', 'Cartesia webhook assignment changed; request a new preview', 409);
    }

    const reservation = await this.db.reserveOutboundCallIdempotency({
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: confirmedFingerprint,
    }).catch(() => { throw webhookConfigError('cartesia_idempotency_storage_unavailable', 'Cartesia idempotency storage is unavailable', 503); });
    if (!reservation?.reserved) {
      throw webhookConfigError('cartesia_agent_webhook_assignment_outcome_unknown', 'Cartesia webhook assignment is already reserved; inspect the agent before retrying', 409);
    }
    await this.db.completeOutboundCallIdempotency({
      idempotency_key: operationKey,
      provider: 'cartesia',
      request_hash: confirmedFingerprint,
      status: 'pending',
      response_payload: { agentId, webhookId },
    }).catch(() => { throw webhookConfigError('cartesia_idempotency_storage_unavailable', 'Cartesia webhook assignment intent could not be stored; no change was submitted', 503); });

    const currentPreview = await this.prepareAssignment(agentId, webhookId);
    if (currentPreview.requestFingerprint !== confirmedFingerprint) {
      await this.db.completeOutboundCallIdempotency({
        idempotency_key: operationKey, provider: 'cartesia', request_hash: confirmedFingerprint,
        status: 'failed', error_message: 'cartesia_webhook_assignment_confirmation_mismatch',
      }).catch(() => {});
      throw webhookConfigError('cartesia_webhook_assignment_confirmation_mismatch', 'Cartesia agent webhook changed after preview; request a new preview', 409);
    }

    try {
      await this.client.updateAgentWebhook(agentId, webhookId);
    } catch (error) {
      if (error instanceof CartesiaApiError && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
        await this.db.completeOutboundCallIdempotency({
          idempotency_key: operationKey, provider: 'cartesia', request_hash: confirmedFingerprint,
          status: 'failed', error_message: 'cartesia_webhook_assignment_rejected',
        }).catch(() => {});
        throw webhookConfigError('cartesia_webhook_assignment_rejected', 'Cartesia rejected the webhook assignment', error.status);
      }
      const agent = await this.readAgent(agentId).catch(() => null);
      if (agent?.webhookId === webhookId) {
        return this.completeOperation(operationKey, confirmedFingerprint, {
          agentId, webhookId, requestFingerprint: confirmedFingerprint,
          idempotentReplay: false, reconciled: true,
        });
      }
      throw webhookConfigError('cartesia_agent_webhook_assignment_outcome_unknown', 'Cartesia webhook assignment outcome is unknown; inspect the agent before retrying', 409);
    }

    await this.readCurrentAssignment(agentId, webhookId);
    return this.completeOperation(operationKey, confirmedFingerprint, {
      agentId,
      webhookId,
      requestFingerprint: confirmedFingerprint,
      idempotentReplay: false,
      reconciled: false,
    });
  }
}

module.exports = { CartesiaWebhookConfigService };
