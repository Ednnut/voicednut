const crypto = require('node:crypto');

const ALLOWED_PREVIEW_FIELDS = new Set(['voice_id', 'expected_version']);
const ALLOWED_UPDATE_FIELDS = new Set([
  'voice_id',
  'expected_version',
  'approved',
  'confirmed_fingerprint',
]);

function parseScriptId(value) {
  const raw = String(value || '').trim();
  if (!/^\d{1,12}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseExpectedVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

function hasOnlyAllowedFields(body, allowed) {
  return Boolean(body) && typeof body === 'object' && !Array.isArray(body) &&
    Object.keys(body).every((key) => allowed.has(key));
}

function normalizeVoiceId(value) {
  const voiceId = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{1,200}$/.test(voiceId) ? voiceId : null;
}

function createSpeechProfileFingerprint(scriptId, version, voiceId) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ action: 'cartesia_speech_profile', script_id: scriptId, version, voice_id: voiceId }))
    .digest('hex');
}

function buildSpeechAgentConfig(existingConfig, voiceId) {
  const previous = existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig)
    ? existingConfig
    : {};
  return {
    ...previous,
    schema_version: 7,
    speech_settings: { provider: 'cartesia', voice_id: voiceId },
  };
}

function normalizeLifecycle(value) {
  const lifecycle = String(value || 'draft').trim().toLowerCase();
  return ['draft', 'review', 'approved', 'live'].includes(lifecycle) ? lifecycle : 'draft';
}

function registerCartesiaSpeechProfileRoutes(app, options = {}) {
  const requireAdminToken = options.requireAdminToken || ((_req, _res, next) => next());
  const limiter = options.limiter || ((_req, _res, next) => next());
  const getTemplate = options.getTemplate;
  const validateAgentConfig = options.validateAgentConfig;
  const updateProfile = options.updateProfile;

  function sendFailure(res, status, code, error) {
    return res.status(status).json({ success: false, code, error });
  }

  async function resolveCandidate(scriptId, body, allowedFields) {
    if (!hasOnlyAllowedFields(body, allowedFields)) {
      return { error: { status: 400, code: 'cartesia_speech_profile_input_invalid', message: 'Unsupported speech profile fields' } };
    }
    const voiceId = normalizeVoiceId(body.voice_id);
    const expectedVersion = parseExpectedVersion(body.expected_version);
    if (!voiceId || !expectedVersion) {
      return { error: { status: 400, code: 'cartesia_speech_profile_input_invalid', message: 'A valid voice_id and expected_version are required' } };
    }
    const template = await getTemplate(scriptId);
    if (!template) {
      return { error: { status: 404, code: 'call_script_not_found', message: 'Call script not found' } };
    }
    const currentVersion = parseExpectedVersion(template.version) || 1;
    if (currentVersion !== expectedVersion) {
      return { error: { status: 409, code: 'call_script_version_conflict', message: 'The call script changed; load a fresh preview before updating' } };
    }
    const config = buildSpeechAgentConfig(template.agent_config, voiceId);
    const validation = await validateAgentConfig(template, config);
    if (!validation?.valid) {
      return {
        error: {
          status: 400,
          code: 'cartesia_speech_profile_invalid',
          message: Array.isArray(validation?.errors) ? validation.errors.join(' ') : 'Cartesia speech profile is invalid',
        },
      };
    }
    return {
      template,
      voiceId,
      expectedVersion,
      agentConfig: validation.normalized,
      fingerprint: createSpeechProfileFingerprint(scriptId, currentVersion, voiceId),
    };
  }

  app.post('/api/call-scripts/:id/cartesia-speech-profile/preview', requireAdminToken, limiter, async (req, res) => {
    const scriptId = parseScriptId(req.params?.id);
    if (!scriptId) return sendFailure(res, 400, 'call_script_id_invalid', 'A valid call script ID is required');
    try {
      const candidate = await resolveCandidate(scriptId, req.body, ALLOWED_PREVIEW_FIELDS);
      if (candidate.error) {
        return sendFailure(res, candidate.error.status, candidate.error.code, candidate.error.message);
      }
      const lifecycle = normalizeLifecycle(candidate.template.lifecycle_state);
      return res.json({
        success: true,
        persisted: false,
        preview: {
          script_id: scriptId,
          expected_version: candidate.expectedVersion,
          provider: 'cartesia',
          voice_id: candidate.voiceId,
          current_lifecycle_state: lifecycle,
          resulting_lifecycle_state: 'draft',
          fingerprint: candidate.fingerprint,
          provider_voice_validation: 'format_only',
        },
      });
    } catch (_) {
      return sendFailure(res, 500, 'cartesia_speech_profile_preview_failed', 'Unable to preview the Cartesia speech profile');
    }
  });

  app.put('/api/call-scripts/:id/cartesia-speech-profile', requireAdminToken, limiter, async (req, res) => {
    const scriptId = parseScriptId(req.params?.id);
    if (!scriptId) return sendFailure(res, 400, 'call_script_id_invalid', 'A valid call script ID is required');
    if (!hasOnlyAllowedFields(req.body, ALLOWED_UPDATE_FIELDS)) {
      return sendFailure(res, 400, 'cartesia_speech_profile_input_invalid', 'Unsupported speech profile fields');
    }
    if (req.body.approved !== true) {
      return sendFailure(res, 400, 'cartesia_speech_profile_approval_required', 'Explicit approval is required to update the call script');
    }
    const idempotencyKey = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      return sendFailure(res, 400, 'idempotency_key_required', 'A valid Idempotency-Key header is required');
    }
    try {
      const candidate = await resolveCandidate(scriptId, {
        voice_id: req.body.voice_id,
        expected_version: req.body.expected_version,
      }, ALLOWED_PREVIEW_FIELDS);
      if (candidate.error) {
        return sendFailure(res, candidate.error.status, candidate.error.code, candidate.error.message);
      }
      const confirmedFingerprint = String(req.body.confirmed_fingerprint || '').trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(confirmedFingerprint) || confirmedFingerprint !== candidate.fingerprint) {
        return sendFailure(res, 409, 'cartesia_speech_profile_confirmation_mismatch', 'The preview confirmation is stale or does not match this profile');
      }
      const result = await updateProfile({
        scriptId,
        expectedVersion: candidate.expectedVersion,
        voiceId: candidate.voiceId,
        agentConfig: candidate.agentConfig,
        confirmedFingerprint,
        idempotencyKey,
        requestId: req.requestId || null,
      });
      if (!result || result.status < 200 || result.status >= 300 || result.data?.success !== true) {
        if (Number(result?.status) >= 500 || !result?.data) {
          return sendFailure(res, 500, 'cartesia_speech_profile_update_failed', 'Unable to update the Cartesia speech profile');
        }
        return res.status(Number(result?.status) || 500).json(result?.data || {
          success: false,
          code: 'cartesia_speech_profile_update_failed',
          error: 'Unable to update the Cartesia speech profile',
        });
      }
      const script = result.data.script || {};
      const persistedConfig = script.agent_config && typeof script.agent_config === 'object'
        ? script.agent_config
        : candidate.agentConfig;
      return res.status(200).json({
        success: true,
        updated: true,
        script_id: scriptId,
        version: Number(script.version) || candidate.expectedVersion + 1,
        speech_settings: persistedConfig.speech_settings || candidate.agentConfig.speech_settings,
        lifecycle_state: normalizeLifecycle(script.lifecycle_state),
      });
    } catch (_) {
      return sendFailure(res, 500, 'cartesia_speech_profile_update_failed', 'Unable to update the Cartesia speech profile');
    }
  });
}

module.exports = {
  registerCartesiaSpeechProfileRoutes,
  buildSpeechAgentConfig,
  createSpeechProfileFingerprint,
  normalizeVoiceId,
  parseExpectedVersion,
};
