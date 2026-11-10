const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const {
  registerCartesiaSpeechProfileRoutes,
} = require('../services/cartesiaSpeechProfileRoutes');

function createApp(overrides = {}) {
  const app = express();
  app.use(express.json());
  const calls = [];
  const template = overrides.template || {
    id: 42,
    version: 3,
    lifecycle_state: 'live',
    prompt: 'Answer questions about appointments.',
    first_message: 'Hello.',
    agent_config: {
      schema_version: 6,
      approved_tools: ['lookupAppointment'],
      voice_agent_settings: { provider: 'deepgram' },
    },
  };
  const auth = (req, res, next) => req.get('x-admin-token') === 'test-admin'
    ? next()
    : res.status(403).json({ success: false, code: 'admin_required' });
  registerCartesiaSpeechProfileRoutes(app, {
    requireAdminToken: auth,
    getTemplate: async (id) => id === template.id ? template : null,
    validateAgentConfig: async (_script, candidate) => {
      calls.push(['validate', candidate]);
      if (overrides.validationError) {
        return { valid: false, errors: ['Invalid Cartesia speech profile.'], normalized: null };
      }
      return { valid: true, errors: [], normalized: candidate };
    },
    updateProfile: async (input) => {
      calls.push(['update', input]);
      if (overrides.updateResult) return overrides.updateResult;
      return {
        ok: true,
        status: 200,
        data: {
          success: true,
          script: {
            id: template.id,
            version: template.version + 1,
            lifecycle_state: 'draft',
            agent_config: input.agentConfig,
          },
        },
      };
    },
  });
  return { app, calls, template };
}

describe('Cartesia call script speech profile routes', () => {
  const admin = { 'x-admin-token': 'test-admin' };

  it('requires admin authorization for previews and updates', async () => {
    const { app } = createApp();
    const preview = await request(app)
      .post('/api/call-scripts/42/cartesia-speech-profile/preview')
      .send({ voice_id: 'voice_test_01', expected_version: 3 });
    const update = await request(app)
      .put('/api/call-scripts/42/cartesia-speech-profile')
      .send({ voice_id: 'voice_test_01', expected_version: 3, approved: true });

    assert.equal(preview.status, 403);
    assert.equal(update.status, 403);
  });

  it('previews a compatible Cartesia voice without persisting or calling the provider', async () => {
    const { app, calls } = createApp();
    const response = await request(app)
      .post('/api/call-scripts/42/cartesia-speech-profile/preview')
      .set(admin)
      .send({ voice_id: 'voice_test_02', expected_version: 3 });

    assert.equal(response.status, 200);
    assert.equal(response.body.persisted, false);
    assert.equal(response.body.preview.provider, 'cartesia');
    assert.equal(response.body.preview.voice_id, 'voice_test_02');
    assert.equal(response.body.preview.current_lifecycle_state, 'live');
    assert.equal(response.body.preview.resulting_lifecycle_state, 'draft');
    assert.equal(response.body.preview.provider_voice_validation, 'format_only');
    assert.match(response.body.preview.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(calls[0][0], 'validate');
    assert.deepEqual(calls[0][1].voice_agent_settings, { provider: 'deepgram' });
    assert.deepEqual(calls[0][1].speech_settings, { provider: 'cartesia', voice_id: 'voice_test_02' });
    assert.equal(calls.some(([kind]) => kind === 'update'), false);
  });

  it('rejects malformed fields, invalid voice IDs, missing scripts, and stale versions', async () => {
    const { app } = createApp();
    const malformed = await request(app)
      .post('/api/call-scripts/42/cartesia-speech-profile/preview')
      .set(admin)
      .send({ voice_id: 'voice_test_01', expected_version: 3, api_key: 'must_not_be_accepted' });
    const invalidVoice = await request(app)
      .post('/api/call-scripts/42/cartesia-speech-profile/preview')
      .set(admin)
      .send({ voice_id: 'https://evil.test/voice', expected_version: 3 });
    const missing = await request(app)
      .post('/api/call-scripts/43/cartesia-speech-profile/preview')
      .set(admin)
      .send({ voice_id: 'voice_test_01', expected_version: 3 });
    const stale = await request(app)
      .post('/api/call-scripts/42/cartesia-speech-profile/preview')
      .set(admin)
      .send({ voice_id: 'voice_test_01', expected_version: 2 });

    assert.equal(malformed.status, 400);
    assert.equal(invalidVoice.status, 400);
    assert.equal(missing.status, 404);
    assert.equal(stale.status, 409);
  });

  it('rejects runtime-incompatible profile updates during preview', async () => {
    const { app, calls } = createApp({ validationError: true });
    const response = await request(app)
      .post('/api/call-scripts/42/cartesia-speech-profile/preview')
      .set(admin)
      .send({ voice_id: 'voice_test_01', expected_version: 3 });

    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'cartesia_speech_profile_invalid');
    assert.equal(calls.some(([kind]) => kind === 'update'), false);
  });

  it('requires explicit approval, a matching preview fingerprint, and an idempotency key', async () => {
    const { app, calls } = createApp();
    const preview = await request(app)
      .post('/api/call-scripts/42/cartesia-speech-profile/preview')
      .set(admin)
      .send({ voice_id: 'voice_test_01', expected_version: 3 });
    const base = { voice_id: 'voice_test_01', expected_version: 3 };
    const unapproved = await request(app)
      .put('/api/call-scripts/42/cartesia-speech-profile')
      .set({ ...admin, 'Idempotency-Key': 'speech-profile-test-1' })
      .send({ ...base, approved: false, confirmed_fingerprint: preview.body.preview.fingerprint });
    const noKey = await request(app)
      .put('/api/call-scripts/42/cartesia-speech-profile')
      .set(admin)
      .send({ ...base, approved: true, confirmed_fingerprint: preview.body.preview.fingerprint });
    const staleConfirmation = await request(app)
      .put('/api/call-scripts/42/cartesia-speech-profile')
      .set({ ...admin, 'Idempotency-Key': 'speech-profile-test-2' })
      .send({ ...base, approved: true, confirmed_fingerprint: 'a'.repeat(64) });

    assert.equal(unapproved.status, 400);
    assert.equal(noKey.status, 400);
    assert.equal(staleConfirmation.status, 409);
    assert.equal(calls.some(([kind]) => kind === 'update'), false);
  });

  it('updates only the Cartesia speech profile and returns the versioned draft state', async () => {
    const { app, calls } = createApp();
    const preview = await request(app)
      .post('/api/call-scripts/42/cartesia-speech-profile/preview')
      .set(admin)
      .send({ voice_id: 'voice_test_03', expected_version: 3 });
    const update = await request(app)
      .put('/api/call-scripts/42/cartesia-speech-profile')
      .set({ ...admin, 'Idempotency-Key': 'speech-profile-update-42' })
      .send({
        voice_id: 'voice_test_03',
        expected_version: 3,
        approved: true,
        confirmed_fingerprint: preview.body.preview.fingerprint,
      });

    assert.equal(update.status, 200);
    assert.equal(update.body.script_id, 42);
    assert.equal(update.body.version, 4);
    assert.equal(update.body.lifecycle_state, 'draft');
    assert.deepEqual(update.body.speech_settings, { provider: 'cartesia', voice_id: 'voice_test_03' });
    const updateCall = calls.find(([kind]) => kind === 'update')[1];
    assert.equal(updateCall.expectedVersion, 3);
    assert.equal(updateCall.idempotencyKey, 'speech-profile-update-42');
    assert.equal(updateCall.agentConfig.voice_agent_settings.provider, 'deepgram');
  });

  it('does not leak persistence errors in responses', async () => {
    const { app } = createApp({ updateResult: { ok: false, status: 500, data: { success: false, error: 'private db detail' } } });
    const preview = await request(app)
      .post('/api/call-scripts/42/cartesia-speech-profile/preview')
      .set(admin)
      .send({ voice_id: 'voice_test_03', expected_version: 3 });
    const update = await request(app)
      .put('/api/call-scripts/42/cartesia-speech-profile')
      .set({ ...admin, 'Idempotency-Key': 'speech-profile-update-error' })
      .send({
        voice_id: 'voice_test_03',
        expected_version: 3,
        approved: true,
        confirmed_fingerprint: preview.body.preview.fingerprint,
      });

    assert.equal(update.status, 500);
    assert.doesNotMatch(JSON.stringify(update.body), /private db detail/);
  });
});
