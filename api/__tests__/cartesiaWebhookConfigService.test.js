const assert = require('node:assert/strict');
const { CartesiaApiError } = require('../services/cartesiaClient');
const { CartesiaWebhookConfigService } = require('../services/cartesiaWebhookConfigService');

function createHarness(overrides = {}) {
  const state = { webhookId: null };
  const records = new Map();
  const calls = [];
  const db = {
    async getOutboundCallIdempotency(key) { return records.get(key) || null; },
    async reserveOutboundCallIdempotency(input) {
      if (records.has(input.idempotency_key)) return { reserved: false };
      records.set(input.idempotency_key, {
        provider: input.provider,
        request_hash: input.request_hash,
        status: 'reserved',
      });
      return { reserved: true };
    },
    async completeOutboundCallIdempotency(input) {
      records.set(input.idempotency_key, {
        provider: input.provider,
        request_hash: input.request_hash,
        status: input.status,
        response_payload: input.response_payload,
      });
      return { updated: true };
    },
  };
  const client = {
    isConfigured: () => true,
    async getAgent(id) { calls.push(['getAgent', id]); return { id, webhook_id: state.webhookId }; },
    async getWebhook(id) {
      calls.push(['getWebhook', id]);
      return { id, url: overrides.webhookUrl || 'https://voice.example.test/api/webhooks/cartesia', display_name: 'VOICEDNUT' };
    },
    async updateAgentWebhook(agentId, webhookId) {
      calls.push(['updateAgentWebhook', agentId, webhookId]);
      if (overrides.updateError) {
        if (overrides.applyBeforeError) state.webhookId = webhookId;
        throw overrides.updateError;
      }
      state.webhookId = webhookId;
      return { id: agentId, webhook_id: webhookId };
    },
    async createWebhook(payload) {
      calls.push(['createWebhook', payload]);
      if (overrides.createError) throw overrides.createError;
      return {
        id: 'webhook_created_01',
        url: payload.url,
        secret: overrides.returnedSecret || payload.secret,
      };
    },
  };
  const service = new CartesiaWebhookConfigService({
    client,
    db,
    enabled: true,
    mutationsEnabled: overrides.mutationsEnabled !== false,
    webhookSecret: overrides.webhookSecret === undefined ? 'server-only-test-secret' : overrides.webhookSecret,
    fingerprintSecret: 'fingerprint-secret',
    publicWebhookUrl: overrides.publicWebhookUrl === undefined
      ? 'https://voice.example.test/api/webhooks/cartesia'
      : overrides.publicWebhookUrl,
  });
  return { service, state, records, calls };
}

describe('Cartesia webhook configuration service', () => {
  it('previews an agent webhook assignment without returning secrets', async () => {
    const { service } = createHarness();
    const preview = await service.prepareAssignment('agent_test_01', 'webhook_test_01');
    assert.equal(preview.previousWebhookId, null);
    assert.equal(preview.webhookId, 'webhook_test_01');
    assert.equal(preview.webhookSecretConfigured, true);
    assert.equal(preview.webhookSecretMatchMustBeVerifiedInCartesia, true);
    assert.equal(preview.webhookUrlMustBeVerifiedInCartesia, true);
    assert.equal(JSON.stringify(preview).includes('server-only-test-secret'), false);
    assert.equal(JSON.stringify(preview).includes('voice.example.test'), false);
    assert.match(preview.requestFingerprint, /^[a-f0-9]{64}$/);
  });

  it('rejects insecure or credential-bearing webhook URLs from the provider', async () => {
    const insecure = createHarness({ webhookUrl: 'http://voice.example.test/api/webhooks/cartesia' });
    await assert.rejects(insecure.service.prepareAssignment('agent_test_01', 'webhook_test_01'), {
      code: 'cartesia_webhook_response_invalid',
    });
    const credentialBearing = createHarness({ webhookUrl: 'https://voice.example.test/api/webhooks/cartesia?token=private' });
    await assert.rejects(credentialBearing.service.prepareAssignment('agent_test_01', 'webhook_test_01'), {
      code: 'cartesia_webhook_response_invalid',
    });
  });

  it('previews webhook creation without exposing the configured endpoint URL or shared secret', async () => {
    const { service } = createHarness();
    const preview = await service.prepareWebhookCreation();
    assert.equal(preview.operation, 'webhook_create');
    assert.equal(preview.endpointHost, 'voice.example.test');
    assert.equal(preview.endpointPath, '/api/webhooks/cartesia');
    assert.equal(preview.externalOperation, true);
    assert.match(preview.requestFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(preview).includes('server-only-test-secret'), false);
    assert.equal(JSON.stringify(preview).includes('https://'), false);
  });

  it('rejects webhook creation previews without server secret or public HTTPS URL', async () => {
    const noSecret = createHarness({ webhookSecret: '' });
    await assert.rejects(noSecret.service.prepareWebhookCreation(), { code: 'cartesia_webhook_secret_not_configured' });
    for (const publicWebhookUrl of [
      '',
      'http://voice.example.test/api/webhooks/cartesia',
      'https://localhost/api/webhooks/cartesia',
      'https://voice.example.test/not-cartesia',
    ]) {
      const harness = createHarness({ publicWebhookUrl });
      await assert.rejects(harness.service.prepareWebhookCreation(), { code: 'cartesia_webhook_url_not_configured' });
    }
  });

  it('creates a webhook once, never returns its secret, and replays from durable local idempotency', async () => {
    const { service, calls, records } = createHarness();
    const preview = await service.prepareWebhookCreation();
    const payload = {
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      idempotency_key: 'webhook-create-key-01',
    };
    const created = await service.createWebhook(payload);
    const replay = await service.createWebhook({ ...payload, idempotency_key: 'webhook-create-key-02' });
    assert.equal(created.webhookId, 'webhook_created_01');
    assert.equal(created.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(Object.hasOwn(created, 'secret'), false);
    assert.equal(JSON.stringify(created).includes('server-only-test-secret'), false);
    assert.equal(calls.filter(([name]) => name === 'createWebhook').length, 1);
    assert.equal([...records.values()][0].status, 'completed');
    assert.equal(JSON.stringify(calls).includes('server-only-test-secret'), true);
  });

  it('requires explicit approval, a matching preview, HTTPS, the default-off gate, and an audit-ready key at the route boundary', async () => {
    const disabled = createHarness({ mutationsEnabled: false });
    const disabledPreview = await disabled.service.prepareWebhookCreation();
    await assert.rejects(disabled.service.createWebhook({
      approved: true,
      confirmed_fingerprint: disabledPreview.requestFingerprint,
      idempotency_key: 'webhook-create-key-03',
    }), { code: 'cartesia_webhook_mutations_disabled' });

    const { service } = createHarness();
    const preview = await service.prepareWebhookCreation();
    await assert.rejects(service.createWebhook({
      approved: false,
      confirmed_fingerprint: preview.requestFingerprint,
      idempotency_key: 'webhook-create-key-04',
    }), { code: 'cartesia_webhook_creation_confirmation_required' });
    await assert.rejects(service.createWebhook({
      approved: true,
      confirmed_fingerprint: 'a'.repeat(64),
      idempotency_key: 'webhook-create-key-05',
    }), { code: 'cartesia_webhook_creation_confirmation_mismatch' });
  });

  it('leaves an ambiguous webhook creation pending and prevents duplicate POSTs', async () => {
    const { service, calls } = createHarness({
      createError: new CartesiaApiError('sanitized', { status: 503, code: 'cartesia_request_failed', retryable: true }),
    });
    const preview = await service.prepareWebhookCreation();
    const payload = {
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      idempotency_key: 'webhook-create-key-06',
    };
    await assert.rejects(service.createWebhook(payload), { code: 'cartesia_webhook_creation_outcome_unknown' });
    await assert.rejects(service.createWebhook({ ...payload, idempotency_key: 'webhook-create-key-07' }), {
      code: 'cartesia_webhook_creation_outcome_unknown',
    });
    assert.equal(calls.filter(([name]) => name === 'createWebhook').length, 1);
  });

  it('keeps the provider-created operation unresolved if the one-time secret response does not match', async () => {
    const { service, calls } = createHarness({ returnedSecret: 'different-secret' });
    const preview = await service.prepareWebhookCreation();
    await assert.rejects(service.createWebhook({
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      idempotency_key: 'webhook-create-key-08',
    }), { code: 'cartesia_webhook_creation_outcome_unknown' });
    await assert.rejects(service.createWebhook({
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      idempotency_key: 'webhook-create-key-09',
    }), { code: 'cartesia_webhook_creation_outcome_unknown' });
    assert.equal(calls.filter(([name]) => name === 'createWebhook').length, 1);
  });

  it('requires the independent mutation gate, server secret, preview confirmation, and idempotency key', async () => {
    const disabled = createHarness({ mutationsEnabled: false });
    await assert.rejects(disabled.service.assignAgentWebhook({}), { code: 'cartesia_webhook_mutations_disabled' });

    const missingSecret = createHarness({ webhookSecret: '' });
    await assert.rejects(missingSecret.service.prepareAssignment('agent_test_01', 'webhook_test_01'), {
      code: 'cartesia_webhook_secret_not_configured',
    });

    const { service } = createHarness();
    await assert.rejects(service.assignAgentWebhook({
      agent_id: 'agent_test_01', webhook_id: 'webhook_test_01', approved: true,
      confirmed_fingerprint: '0'.repeat(64), idempotency_key: 'webhook-test-key',
    }), { code: 'cartesia_webhook_assignment_confirmation_mismatch' });
    await assert.rejects(service.assignAgentWebhook({
      agent_id: 'agent_test_01', webhook_id: 'webhook_test_01', approved: true,
      confirmed_fingerprint: 'a'.repeat(64),
    }), { code: 'cartesia_idempotency_key_required' });
  });

  it('requires the current preview and stores a replay-safe result for the exact confirmed assignment', async () => {
    const { service, state, calls } = createHarness();
    const preview = await service.prepareAssignment('agent_test_01', 'webhook_test_01');
    const result = await service.assignAgentWebhook({
      agent_id: 'agent_test_01',
      webhook_id: 'webhook_test_01',
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      idempotency_key: 'webhook-test-key-01',
    });
    const replay = await service.assignAgentWebhook({
      agent_id: 'agent_test_01',
      webhook_id: 'webhook_test_01',
      approved: true,
      confirmed_fingerprint: preview.requestFingerprint,
      idempotency_key: 'webhook-test-key-01',
    });
    assert.equal(result.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(state.webhookId, 'webhook_test_01');
    assert.equal(calls.filter(([name]) => name === 'updateAgentWebhook').length, 1);
  });

  it('reconciles an ambiguous provider response without resubmitting the update', async () => {
    const { service, state, calls } = createHarness({
      updateError: new CartesiaApiError('sanitized', { status: 503, code: 'cartesia_request_failed', retryable: true }),
      applyBeforeError: true,
    });
    const preview = await service.prepareAssignment('agent_test_01', 'webhook_test_01');
    const result = await service.assignAgentWebhook({
      agent_id: 'agent_test_01', webhook_id: 'webhook_test_01', approved: true,
      confirmed_fingerprint: preview.requestFingerprint, idempotency_key: 'webhook-test-key-02',
    });
    assert.equal(result.reconciled, true);
    assert.equal(state.webhookId, 'webhook_test_01');
    assert.equal(calls.filter(([name]) => name === 'updateAgentWebhook').length, 1);
  });

  it('leaves an unresolved operation pending and refuses to submit it again', async () => {
    const { service, calls } = createHarness({
      updateError: new Error('network timeout'),
      applyBeforeError: false,
    });
    const preview = await service.prepareAssignment('agent_test_01', 'webhook_test_01');
    const payload = {
      agent_id: 'agent_test_01', webhook_id: 'webhook_test_01', approved: true,
      confirmed_fingerprint: preview.requestFingerprint, idempotency_key: 'webhook-test-key-03',
    };
    await assert.rejects(service.assignAgentWebhook(payload), { code: 'cartesia_agent_webhook_assignment_outcome_unknown' });
    await assert.rejects(service.assignAgentWebhook(payload), { code: 'cartesia_agent_webhook_assignment_outcome_unknown' });
    assert.equal(calls.filter(([name]) => name === 'updateAgentWebhook').length, 1);
  });
});
