'use strict';

const crypto = require('node:crypto');
const { MAX_REALTIME_STT_AUDIO_BYTES } = require('./cartesiaStudioClient');
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

function sendError(ctx, req, res, status, code, message) {
  if (typeof ctx.sendApiError === 'function') return ctx.sendApiError(res, status, code, message, req.requestId || null);
  return res.status(status).json({ success: false, code, error: message, request_id: req.requestId || null });
}

async function service(ctx, req, res) {
  if (typeof ctx.isCartesiaAdminActor !== 'function' || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
    return { response: sendError(ctx, req, res, 403, 'cartesia_admin_required', 'Cartesia Studio actions are restricted to administrators') };
  }
  const instance = typeof ctx.createCartesiaStudioService === 'function' ? ctx.createCartesiaStudioService() : null;
  if (!instance) return { response: sendError(ctx, req, res, 503, 'cartesia_studio_unavailable', 'Cartesia Studio is unavailable') };
  return { instance };
}

async function speechProfileService(ctx, req, res, write) {
  const businessId = String(req.query?.business_id || req.body?.business_id || '').trim();
  if (!businessId) return service(ctx, req, res);
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId)) {
    return { response: sendError(ctx, req, res, 400, 'cartesia_speech_settings_scope_invalid', 'A valid business ID is required') };
  }
  if (typeof ctx.db?.hasCallTemplateBusinessId !== 'function') {
    return { response: sendError(ctx, req, res, 503, 'cartesia_speech_settings_scope_unavailable', 'Business membership is unavailable') };
  }
  if (!(await ctx.db.hasCallTemplateBusinessId(businessId))) {
    return { response: sendError(ctx, req, res, 404, 'cartesia_speech_settings_business_not_found', 'The selected business was not found') };
  }
  const actorId = String(req.callEActorId || '');
  const isAdmin = typeof ctx.isCartesiaAdminActor === 'function' && await ctx.isCartesiaAdminActor(actorId);
  if (!isAdmin) {
    if (typeof ctx.db?.getCallEBusinessOperator !== 'function') {
      return { response: sendError(ctx, req, res, 503, 'cartesia_speech_settings_scope_unavailable', 'Business membership is unavailable') };
    }
    const membership = await ctx.db.getCallEBusinessOperator(businessId, actorId);
    const allowed = write
      ? membership?.role === 'policy_manager'
      : ['call_operator', 'policy_manager'].includes(membership?.role);
    if (!allowed) {
      return { response: sendError(ctx, req, res, 403, 'cartesia_speech_settings_access_denied', 'Business speech settings access is denied') };
    }
  }
  const instance = typeof ctx.createCartesiaStudioService === 'function' ? ctx.createCartesiaStudioService() : null;
  if (!instance) return { response: sendError(ctx, req, res, 503, 'cartesia_studio_unavailable', 'Cartesia Studio is unavailable') };
  return { instance, businessId };
}

function handle(ctx, method, { confirm, status = 200, message, speechProfile = false, write = false } = {}) {
  return async (req, res) => {
    try {
      const context = speechProfile
        ? await speechProfileService(ctx, req, res, write)
        : await service(ctx, req, res);
      if (context.response) return context.response;
      if (confirm && String(confirm(req) || '') !== String(req.body?.confirmation_phrase || '')) {
        throw Object.assign(new Error('An exact confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
      }
      const result = await method(context.instance, req, res, context);
      if (Buffer.isBuffer(result)) return res.type(result.contentType || 'audio/wav').send(result);
      if (result?.stream && typeof result.stream.pipe === 'function') {
        res.status(status);
        if (typeof res.set === 'function') res.set('Content-Type', result.contentType || 'text/event-stream');
        if (typeof res.set === 'function') res.set('Cache-Control', 'no-cache, no-transform');
        if (typeof res.set === 'function') res.set('X-Accel-Buffering', 'no');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        if (typeof res.once === 'function' && typeof result.abort === 'function') {
          res.once('close', () => { if (!res.writableEnded) result.abort(); });
        }
        result.stream.on('error', (error) => {
          console.error('cartesia_studio_stream_error', { code: String(error?.code || 'stream_error') });
          if (!res.headersSent) sendError(ctx, req, res, 502, 'cartesia_stream_failed', message || 'Cartesia stream failed');
          else res.destroy(error);
        });
        return result.stream.pipe(res);
      }
      return res.status(status).json({ success: true, ...(result || {}) });
    } catch (error) {
      const code = String(error?.code || 'cartesia_studio_operation_failed');
      const mappedStatus = Number(error?.status) || (code.includes('invalid') || code.includes('required') || code.includes('confirmation') ? 400 : code.includes('not_configured') ? 503 : code.includes('not_found') ? 404 : 502);
      console.error('cartesia_studio_route_error', { code, status: mappedStatus });
      return sendError(ctx, req, res, mappedStatus, code, mappedStatus >= 500 ? (message || 'Cartesia Studio operation failed') : error.message);
    }
  };
}

function registerCartesiaStudioRoutes(app, ctx = {}, express) {
  const limiter = typeof ctx.cartesiaApprovalLimiter === 'function' ? ctx.cartesiaApprovalLimiter : (_req, _res, next) => next();
  const authorize = typeof ctx.requireOutboundAuthorization === 'function' ? ctx.requireOutboundAuthorization : (_req, _res, next) => next();
  const actor = typeof ctx.requireCallEActorAssertion === 'function' ? ctx.requireCallEActorAssertion : (_req, _res, next) => next();
  const rawAudio = express?.raw ? express.raw({ type: 'application/octet-stream', limit: '16mb' }) : (_req, _res, next) => next();
  const root = '/api/cartesia/studio';

  app.get(`${root}/speech-profile`, limiter, authorize, actor, handle(ctx, async (_studio, req, _res, context) => {
    if (!ctx.cartesiaSpeechSettingsStore) throw Object.assign(new Error('Cartesia speech settings are unavailable'), { code: 'cartesia_speech_settings_unavailable', status: 503 });
    return {
      profile: context.businessId
        ? await ctx.cartesiaSpeechSettingsStore.getBusinessProfile(context.businessId)
        : await ctx.cartesiaSpeechSettingsStore.getProfile(),
      ...(context.businessId ? { business_id: context.businessId } : {}),
    };
  }, { message: 'Cartesia speech settings could not be loaded', speechProfile: true }));
  if (typeof app.put === 'function') {
    app.put(`${root}/speech-profile`, limiter, authorize, actor, handle(ctx, async (studio, req, _res, context) => {
      if (!ctx.cartesiaSpeechSettingsStore) throw Object.assign(new Error('Cartesia speech settings are unavailable'), { code: 'cartesia_speech_settings_unavailable', status: 503 });
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      if (Object.keys(body).some((key) => !['business_id', 'profile', 'confirmation_phrase'].includes(key))) {
        throw Object.assign(new Error('Cartesia speech settings contain unsupported fields'), { code: 'cartesia_speech_settings_invalid', status: 400 });
      }
      const result = context.businessId
        ? await ctx.cartesiaSpeechSettingsStore.saveBusinessProfile(context.businessId, body.profile, studio)
        : await ctx.cartesiaSpeechSettingsStore.save(body.profile, studio);
      return { ...result, ...(context.businessId ? { business_id: context.businessId } : {}) };
    }, { confirm: () => 'SAVE CARTESIA TTS PROFILE', message: 'Cartesia speech settings could not be saved', speechProfile: true, write: true }));
  }
  app.post(`${root}/speech-profile/reset`, limiter, authorize, actor, handle(ctx, async (_studio, req, _res, context) => {
    if (!ctx.cartesiaSpeechSettingsStore) throw Object.assign(new Error('Cartesia speech settings are unavailable'), { code: 'cartesia_speech_settings_unavailable', status: 503 });
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (Object.keys(body).some((key) => !['business_id', 'confirmation_phrase'].includes(key))) {
      throw Object.assign(new Error('Cartesia speech settings contain unsupported fields'), { code: 'cartesia_speech_settings_invalid', status: 400 });
    }
    const result = context.businessId
      ? await ctx.cartesiaSpeechSettingsStore.resetBusinessProfile(context.businessId)
      : await ctx.cartesiaSpeechSettingsStore.reset();
    return { ...result, ...(context.businessId ? { business_id: context.businessId } : {}) };
  }, { confirm: () => 'RESET CARTESIA TTS PROFILE', message: 'Cartesia speech settings could not be reset', speechProfile: true, write: true }));

  app.get(`${root}/voices`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.listVoices(req.query || {}), {
    message: 'Cartesia voices could not be listed', speechProfile: true,
  }));
  app.get(`${root}/models`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.listModels(req.query || {}), {
    message: 'Cartesia models could not be listed', speechProfile: true,
  }));
  app.get(`${root}/voices/:voiceId`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getVoice(req.params?.voiceId), {
    message: 'Cartesia voice details could not be loaded', speechProfile: true,
  }));
  app.get(`${root}/accents`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.listAccents(req.query || {}), { message: 'Cartesia accents could not be listed' }));
  app.post(`${root}/voices/localize`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const voiceId = String(req.body?.voice_id || req.body?.voiceId || '');
    const accent = String(req.body?.accent || '');
    const expected = `LOCALIZE CARTESIA VOICE ${voiceId} TO ${accent}`;
    if (String(req.body?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact voice localization confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.localizeVoice(req.body || {});
  }, { status: 201, message: 'Cartesia voice could not be localized' }));
  app.patch(`${root}/voices/:voiceId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const expected = `UPDATE CARTESIA VOICE ${req.params?.voiceId}`;
    if (String(req.body?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact voice update confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.updateVoice(req.params?.voiceId, req.body || {});
  }));
  app.delete(`${root}/voices/:voiceId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const expected = `DELETE CARTESIA VOICE ${req.params?.voiceId}`;
    if (String(req.body?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact voice deletion confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.deleteVoice(req.params?.voiceId);
  }));
  app.patch(`${root}/voices/:voiceId/accents`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const expected = `ADD ACCENTS TO CARTESIA VOICE ${req.params?.voiceId}`;
    if (String(req.body?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact voice accent confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.addVoiceAccents(req.params?.voiceId, req.body || {});
  }));
  app.delete(`${root}/voices/:voiceId/accents/:accentId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const expected = `REMOVE CARTESIA ACCENT ${req.params?.accentId} FROM VOICE ${req.params?.voiceId}`;
    if (String(req.body?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact accent removal confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.deleteVoiceAccent(req.params?.voiceId, req.params?.accentId);
  }));
  app.post(`${root}/voices/clone`, limiter, authorize, rawAudio, actor, handle(ctx, (studio, req) => {
    const name = String(req.query?.name || '').trim();
    if (!Buffer.isBuffer(req.body) || !req.body.length || req.body.length > 16 * 1024 * 1024) {
      throw Object.assign(new Error('A supported voice sample up to 16 MB is required'), { code: 'cartesia_voice_sample_invalid', status: 400 });
    }
    if (!/^[A-Za-z0-9 _.'-]{1,80}$/.test(name)) throw Object.assign(new Error('A valid voice name is required'), { code: 'cartesia_voice_name_invalid', status: 400 });
    if (String(req.query?.confirmation_phrase || '') !== `I CONFIRM SPEAKER CONSENT AND CREATE CARTESIA CLONE ${name.toUpperCase()}`) {
      throw Object.assign(new Error('An exact clone confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.createInstantVoiceClone({
      clip: req.body, name, language: String(req.query?.language || ''),
      description: String(req.query?.description || '').slice(0, 300), contentType: String(req.query?.content_type || 'application/octet-stream'),
      consentActorId: String(req.callEActorId || ''),
      consentPhrase: String(req.query?.confirmation_phrase || ''),
    });
  }, { status: 201, message: 'Cartesia voice clone could not be created' }));
  app.post(`${root}/tts-preview`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== 'GENERATE CARTESIA TTS PREVIEW') {
      throw Object.assign(new Error('An exact preview confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    const previewInput = { ...(req.body || {}) };
    delete previewInput.business_id;
    return studio.synthesizePreview(previewInput);
  }, { message: 'Cartesia speech preview could not be generated', speechProfile: true }));
  app.post(`${root}/tts-stream`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== 'STREAM CARTESIA TTS PREVIEW') throw Object.assign(new Error('An exact streaming TTS confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.streamSpeech(req.body || {});
  }, { message: 'Cartesia streaming speech could not be generated' }));
  app.post(`${root}/tts-continuations`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== 'GENERATE CARTESIA TTS CONTINUATIONS') throw Object.assign(new Error('An exact continuation generation confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.synthesizeContinuations(req.body || {});
  }, { message: 'Cartesia continuation speech could not be generated' }));
  app.post(`${root}/stt/transcribe`, limiter, authorize, rawAudio, actor, handle(ctx, (studio, req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length || req.body.length > 25 * 1024 * 1024) throw Object.assign(new Error('An audio sample up to 25 MB is required'), { code: 'cartesia_stt_audio_invalid', status: 400 });
    if (String(req.query?.confirmation_phrase || '') !== 'TRANSCRIBE AUDIO WITH CARTESIA INK') throw Object.assign(new Error('An exact transcription confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.transcribeAudio({ file: req.body, filename: String(req.query?.filename || 'speech.wav').slice(0, 120), contentType: String(req.query?.content_type || 'application/octet-stream'), model: String(req.query?.model || 'ink-whisper'), language: String(req.query?.language || ''), timestampGranularities: String(req.query?.timestamps || '') === 'word' ? ['word'] : [] });
  }, { message: 'Cartesia transcription failed' }));
  app.post(`${root}/stt/realtime`, limiter, authorize, rawAudio, actor, handle(ctx, (studio, req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length || req.body.length > MAX_REALTIME_STT_AUDIO_BYTES) {
      throw Object.assign(new Error('Realtime Ink requires raw PCM audio of no more than 50 seconds (1.6 MB)'), { code: 'cartesia_stt_realtime_audio_invalid', status: 400 });
    }
    const turnMode = String(req.query?.turn_mode || 'auto');
    if (!['auto', 'manual'].includes(turnMode)) throw Object.assign(new Error('STT turn_mode must be auto or manual'), { code: 'cartesia_stt_turn_mode_invalid', status: 400 });
    const expectedPhrase = turnMode === 'manual'
      ? 'TRANSCRIBE AUDIO WITH CARTESIA INK MANUAL'
      : 'TRANSCRIBE AUDIO WITH CARTESIA INK REALTIME';
    if (String(req.query?.confirmation_phrase || '') !== expectedPhrase) throw Object.assign(new Error('An exact realtime transcription confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    const profileHeader = String(req.headers?.['x-cartesia-stt-profile'] || '');
    const profileHash = String(req.query?.stt_profile_sha256 || '');
    let profile = {};
    if (profileHeader) {
      if (!/^[A-Za-z0-9_-]{1,12000}$/.test(profileHeader) || !/^[a-f0-9]{64}$/.test(profileHash)) throw Object.assign(new Error('Invalid signed STT profile metadata'), { code: 'cartesia_stt_profile_invalid', status: 400 });
      let profileJson;
      try { profileJson = Buffer.from(profileHeader, 'base64url').toString('utf8'); profile = JSON.parse(profileJson); }
      catch { throw Object.assign(new Error('Invalid signed STT profile metadata'), { code: 'cartesia_stt_profile_invalid', status: 400 }); }
      if (crypto.createHash('sha256').update(profileJson).digest('hex') !== profileHash || !profile || typeof profile !== 'object' || Array.isArray(profile)) throw Object.assign(new Error('STT profile signature did not match'), { code: 'cartesia_stt_profile_invalid', status: 400 });
    }
    const input = {
      audio: req.body,
      encoding: String(req.query?.encoding || 'pcm_s16le'),
      sampleRate: Number(req.query?.sample_rate) || 16000,
      keyterms: Array.isArray(profile.keyterms) ? profile.keyterms : [],
    };
    if (turnMode === 'manual') return studio.transcribeAudioManual(input);
    return studio.transcribeAudioRealtime({ ...input, turnSettings: profile.turnSettings || {} });
  }, { message: 'Cartesia realtime transcription failed' }));
  app.post(`${root}/infill`, limiter, authorize, rawAudio, actor, handle(ctx, (studio, req) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length || req.body.length > 16 * 1024 * 1024) throw Object.assign(new Error('One audio context clip up to 16 MB is required'), { code: 'cartesia_infill_audio_invalid', status: 400 });
    const side = String(req.query?.side || 'left');
    const voiceId = String(req.query?.voice_id || '');
    const transcript = String(req.headers?.['x-cartesia-infill-transcript'] || '');
    const transcriptHash = String(req.query?.transcript_sha256 || '');
    const expected = `GENERATE CARTESIA INFILL FOR VOICE ${voiceId}`;
    if (String(req.query?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact infill generation confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    if (!['left', 'right'].includes(side)) throw Object.assign(new Error('Audio context side must be left or right'), { code: 'cartesia_infill_input_invalid', status: 400 });
    if (!transcript || transcript.length > 600 || !/^[a-f0-9]{64}$/.test(transcriptHash) || crypto.createHash('sha256').update(transcript).digest('hex') !== transcriptHash) throw Object.assign(new Error('A valid signed speech segment is required'), { code: 'cartesia_infill_input_invalid', status: 400 });
    return Promise.resolve(studio.infillSpeech({ [side === 'left' ? 'leftAudio' : 'rightAudio']: req.body, filename: String(req.query?.filename || 'context.wav').slice(0, 120), contentType: String(req.query?.content_type || 'audio/wav'), voiceId, transcript, language: String(req.query?.language || 'en') })).then((audio) => {
      if (!Buffer.isBuffer(audio) || !audio.length || audio.length > 16 * 1024 * 1024) throw Object.assign(new Error('Cartesia returned invalid infill audio'), { code: 'cartesia_infill_response_invalid', status: 502 });
      audio.contentType = audio.contentType || 'audio/wav';
      return audio;
    });
  }, { message: 'Cartesia speech infill failed' }));
  app.get(`${root}/pronunciation-dictionaries`, limiter, authorize, actor, handle(ctx, (studio) => studio.listPronunciationDictionaries()));
  app.get(`${root}/pronunciation-dictionaries/:dictionaryId`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getPronunciationDictionary(req.params?.dictionaryId)));
  app.post(`${root}/pronunciation-dictionaries`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const name = String(req.body?.name || '').trim();
    if (String(req.body?.confirmation_phrase || '') !== `CREATE CARTESIA PRONUNCIATION DICTIONARY ${name.toUpperCase()}`) {
      throw Object.assign(new Error('An exact dictionary confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.createPronunciationDictionary(req.body || {});
  }, { status: 201 }));
  app.patch(`${root}/pronunciation-dictionaries/:dictionaryId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== `UPDATE CARTESIA PRONUNCIATION DICTIONARY ${req.params?.dictionaryId}`) {
      throw Object.assign(new Error('An exact dictionary update confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.updatePronunciationDictionary(req.params?.dictionaryId, req.body || {});
  }));
  app.delete(`${root}/pronunciation-dictionaries/:dictionaryId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== `DELETE CARTESIA PRONUNCIATION DICTIONARY ${req.params?.dictionaryId}`) {
      throw Object.assign(new Error('An exact dictionary deletion confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.deletePronunciationDictionary(req.params?.dictionaryId);
  }));

  app.get(`${root}/metrics`, limiter, authorize, actor, handle(ctx, (studio) => studio.listMetrics()));
  app.post(`${root}/metrics`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const name = String(req.body?.name || '').trim();
    if (String(req.body?.confirmation_phrase || '') !== `CREATE CARTESIA METRIC ${name.toUpperCase()}`) {
      throw Object.assign(new Error('An exact metric creation confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.createMetric(req.body || {});
  }, { status: 201 }));
  app.post(`${root}/agents/:agentId/metrics/:metricId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const expected = `ASSIGN CARTESIA METRIC ${req.params?.metricId} TO AGENT ${req.params?.agentId}`;
    if (String(req.body?.confirmation_phrase || '') !== expected) {
      throw Object.assign(new Error('An exact metric assignment confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.assignMetric(req.params?.agentId, req.params?.metricId);
  }));
  app.get(`${root}/quality`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.listMetricResults(req.query || {}), { message: 'Cartesia quality results could not be loaded' }));
  app.get(`${root}/calls/:callId/logs`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getCallRuntimeLogs(req.params?.callId), { message: 'Cartesia call diagnostics could not be loaded' }));
  app.get(`${root}/agents`, limiter, authorize, actor, handle(ctx, (studio) => studio.listAgents(), { message: 'Cartesia agents could not be listed' }));
  app.get(`${root}/agent-templates`, limiter, authorize, actor, handle(ctx, (studio) => studio.listAgentTemplates(), { message: 'Cartesia agent templates could not be listed' }));
  app.get(`${root}/agent-profiles`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.listAgentProfiles(req.callEActorId), { message: 'Cartesia agent profiles could not be loaded' }));
  app.post(`${root}/agent-profiles`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const name = String(req.body?.name || '').trim();
    if (String(req.body?.confirmation_phrase || '') !== `SAVE CARTESIA AGENT PROFILE ${name.toUpperCase()}`) throw Object.assign(new Error('An exact agent profile save confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.saveAgentProfile(req.body || {}, req.callEActorId);
  }, { status: 201, message: 'Cartesia agent profile could not be saved' }));
  app.delete(`${root}/agent-profiles/:profileId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const profileId = String(req.params?.profileId || '');
    if (String(req.body?.confirmation_phrase || '') !== `DELETE CARTESIA AGENT PROFILE ${profileId}`) throw Object.assign(new Error('An exact agent profile deletion confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.deleteAgentProfile(profileId, req.callEActorId);
  }, { message: 'Cartesia agent profile could not be deleted' }));
  app.post(`${root}/agents/:agentId/profiles/:profileId/apply`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const agentId = String(req.params?.agentId || '');
    const profileId = String(req.params?.profileId || '');
    if (String(req.body?.confirmation_phrase || '') !== `APPLY CARTESIA AGENT PROFILE ${profileId} TO AGENT ${agentId}`) throw Object.assign(new Error('An exact agent profile application confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.applyAgentProfile(agentId, profileId, req.callEActorId);
  }, { message: 'Cartesia agent profile could not be applied' }));
  app.patch(`${root}/agents/:agentId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const expected = `UPDATE CARTESIA AGENT ${req.params?.agentId}`;
    if (String(req.body?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact Cartesia agent update confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.updateAgent(req.params?.agentId, req.body || {});
  }, { message: 'Cartesia agent settings could not be updated' }));
  app.get(`${root}/agents/:agentId/versions`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.listAgentVersions(req.params?.agentId), { message: 'Cartesia agent versions could not be listed' }));
  app.get(`${root}/agents/:agentId/config-summary`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getManagedAgentConfigSummary(req.params?.agentId), { message: 'Cartesia current agent configuration could not be loaded' }));
  app.get(`${root}/agents/:agentId/versions/:versionId`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getAgentVersion(req.params?.agentId, req.params?.versionId), { message: 'Cartesia agent version could not be loaded' }));
  app.get(`${root}/agents/:agentId/language-readiness`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getAgentLanguageReadiness(req.params?.agentId), { message: 'Cartesia agent language readiness could not be loaded' }));
  app.post(`${root}/agents/:agentId/versions/:versionId/evaluation-gate`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const callIds = Array.isArray(req.body?.call_ids) ? req.body.call_ids.map((id) => String(id || '').trim()) : [];
    const versionId = String(req.params?.versionId || '');
    const attestation = `I ATTEST CARTESIA TEST CALLS ${callIds.join(',')} USED VERSION ${versionId}`;
    if (String(req.body?.operator_attestation || '') !== attestation) throw Object.assign(new Error('An exact test-version attestation is required'), { code: 'cartesia_agent_evaluation_attestation_required', status: 400 });
    return studio.evaluateAgentVersionGate(req.params?.agentId, versionId, {
      callIds, metricIds: req.body?.metric_ids,
      metricThresholds: req.body?.metric_thresholds,
      minimumSamples: req.body?.minimum_samples, minimumPassRate: req.body?.minimum_pass_rate,
    });
  }, { message: 'Cartesia agent version evaluation could not be completed' }));
  app.post(`${root}/agents/:agentId/versions/:versionId/restore`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const evaluation = req.body?.evaluation && typeof req.body.evaluation === 'object' && !Array.isArray(req.body.evaluation) ? req.body.evaluation : {};
    const callIds = Array.isArray(evaluation.call_ids) ? evaluation.call_ids.map((id) => String(id || '').trim()) : [];
    const versionId = String(req.params?.versionId || '');
    const attestation = `I ATTEST CARTESIA TEST CALLS ${callIds.join(',')} USED VERSION ${versionId}`;
    if (String(evaluation.operator_attestation || '') !== attestation) throw Object.assign(new Error('An exact test-version attestation is required'), { code: 'cartesia_agent_evaluation_attestation_required', status: 400 });
    return studio.restoreAgentVersion(req.params?.agentId, versionId, {
      callIds, metricIds: evaluation.metric_ids,
      metricThresholds: evaluation.metric_thresholds,
      minimumSamples: evaluation.minimum_samples, minimumPassRate: evaluation.minimum_pass_rate,
    });
  }, {
    confirm: (req) => `RESTORE CARTESIA AGENT ${req.params?.agentId} FROM VERSION ${req.params?.versionId}`,
    message: 'Cartesia agent version could not be restored',
  }));
  app.get(`${root}/agents/:agentId/deployments`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.listDeployments(req.params?.agentId), { message: 'Cartesia deployments could not be listed' }));
  app.get(`${root}/webhooks`, limiter, authorize, actor, handle(ctx, (studio) => studio.listAgentWebhooks(), { message: 'Cartesia lifecycle webhooks could not be listed' }));
  app.get(`${root}/webhooks/:webhookId`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getAgentWebhook(req.params?.webhookId), { message: 'Cartesia lifecycle webhook could not be loaded' }));
  app.post(`${root}/webhooks`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const name = String(req.body?.display_name || req.body?.displayName || '').trim();
    if (String(req.body?.confirmation_phrase || '') !== `CREATE CARTESIA AGENT WEBHOOK ${name.toUpperCase()}`) {
      throw Object.assign(new Error('An exact lifecycle webhook confirmation is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.createAgentWebhook(req.body || {});
  }, { status: 201, message: 'Cartesia lifecycle webhook could not be created' }));
  app.patch(`${root}/webhooks/:webhookId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== `UPDATE CARTESIA AGENT WEBHOOK ${req.params?.webhookId}`) {
      throw Object.assign(new Error('An exact lifecycle webhook update confirmation is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.updateAgentWebhook(req.params?.webhookId, req.body || {});
  }, { message: 'Cartesia lifecycle webhook could not be updated' }));
  app.delete(`${root}/webhooks/:webhookId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== `DELETE CARTESIA AGENT WEBHOOK ${req.params?.webhookId}`) {
      throw Object.assign(new Error('An exact lifecycle webhook deletion confirmation is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.deleteAgentWebhook(req.params?.webhookId);
  }, { message: 'Cartesia lifecycle webhook could not be deleted' }));
  app.get(`${root}/phone-numbers`, limiter, authorize, actor, handle(ctx, (studio) => studio.listPhoneNumbers(), { message: 'Cartesia phone numbers could not be listed' }));
  app.post(`${root}/phone-numbers/import`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const number = String(req.body?.number || '').trim();
    const providerId = String(req.body?.provider?.id || req.body?.provider_id || '');
    const label = String(req.body?.label || '').trim().toUpperCase();
    const agentId = String(req.body?.agent_id || 'UNASSIGNED');
    const expected = `IMPORT CARTESIA PHONE ENDING ${number.slice(-4)} FROM PROVIDER ${providerId} LABEL ${label} FOR AGENT ${agentId}`;
    if (!/^\+[1-9]\d{7,14}$/.test(number) || !providerId || String(req.body?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact phone-number import confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.importPhoneNumber(req.body || {});
  }, { status: 201, message: 'Cartesia phone number could not be imported' }));
  app.post(`${root}/phone-numbers/provision`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const label = String(req.body?.label || '').trim();
    const agentId = String(req.body?.agent_id || '');
    const expected = `PROVISION CARTESIA US PHONE ${label.toUpperCase()}${agentId ? ` FOR AGENT ${agentId}` : ''}`;
    if (!label || String(req.body?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact Cartesia phone-number provisioning confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.provisionPhoneNumber(req.body || {});
  }, { status: 201, message: 'Cartesia phone number could not be provisioned' }));
  app.patch(`${root}/phone-numbers/:phoneNumberId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const agentId = String(req.body?.agent_id || '');
    const expected = `ASSIGN CARTESIA PHONE ${req.params?.phoneNumberId} TO AGENT ${agentId}`;
    if (!agentId || String(req.body?.confirmation_phrase || '') !== expected) throw Object.assign(new Error('An exact phone-number assignment confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.updatePhoneNumber(req.params?.phoneNumberId, { agent_id: agentId, label: req.body?.label });
  }));
  app.get(`${root}/usage/credits`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getCreditUsage(req.query || {}), { message: 'Cartesia credit usage could not be loaded' }));
  app.get(`${root}/usage/agents`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getAgentUsage(req.query || {}), { message: 'Cartesia agent usage could not be loaded' }));
  app.get(`${root}/privacy-readiness`, limiter, authorize, actor, handle(ctx, (studio) => studio.getEnterpriseDataReadiness(), { message: 'Cartesia data-readiness information could not be loaded' }));
  app.get(`${root}/readiness`, limiter, authorize, actor, handle(ctx, (studio) => studio.getReadiness(), { message: 'Cartesia integration readiness could not be loaded' }));
  app.get(`${root}/voice-governance`, limiter, authorize, actor, handle(ctx, (studio) => studio.listVoiceGovernance(), { message: 'Cartesia clone governance records could not be loaded' }));
  app.post(`${root}/voice-governance/:consentId/revoke`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const consentId = String(req.params?.consentId || '');
    if (String(req.body?.confirmation_phrase || '') !== `REVOKE CARTESIA VOICE CONSENT ${consentId}`) throw Object.assign(new Error('An exact clone-consent revocation confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.revokeVoiceConsent(consentId);
  }));
  app.post(`${root}/voice-governance/:consentId/delete-clone`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const consentId = String(req.params?.consentId || '');
    if (String(req.body?.confirmation_phrase || '') !== `DELETE CARTESIA CLONE LINKED TO CONSENT ${consentId}`) throw Object.assign(new Error('An exact tracked-clone deletion confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.deleteGovernedClone(consentId);
  }));
  app.post(`${root}/voice-governance/:consentId/delete-pro-data`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const consentId = String(req.params?.consentId || '');
    if (String(req.body?.confirmation_phrase || '') !== `DELETE CARTESIA PRO CLONE DATA LINKED TO CONSENT ${consentId}`) throw Object.assign(new Error('An exact Pro Clone data deletion confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    return studio.deleteGovernedProCloneData(consentId);
  }));
  app.get(`${root}/tools`, limiter, authorize, actor, handle(ctx, (studio) => studio.listTools()));
  app.post(`${root}/tools`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const name = String(req.body?.name || '').trim();
    if (String(req.body?.confirmation_phrase || '') !== `CREATE CARTESIA WEBHOOK TOOL ${name.toUpperCase()}`) {
      throw Object.assign(new Error('An exact tool creation confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.createTool(req.body || {});
  }, { status: 201 }));
  app.post(`${root}/tools/client`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const name = String(req.body?.name || '').trim();
    if (String(req.body?.confirmation_phrase || '') !== `CREATE CARTESIA CLIENT TOOL ${name.toUpperCase()}`) {
      throw Object.assign(new Error('An exact client-tool creation confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.createClientTool(req.body || {});
  }, { status: 201, message: 'Cartesia client tool could not be created' }));
  app.patch(`${root}/tools/:toolId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== `UPDATE CARTESIA WEBHOOK TOOL ${req.params?.toolId}`) {
      throw Object.assign(new Error('An exact tool update confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.updateTool(req.params?.toolId, req.body || {});
  }));
  app.delete(`${root}/tools/:toolId`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== `DELETE CARTESIA WEBHOOK TOOL ${req.params?.toolId}`) {
      throw Object.assign(new Error('An exact tool deletion confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.deleteTool(req.params?.toolId);
  }));
  app.post(`${root}/stt-profile/validate`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.validateSttProfile(req.body || {})));
  app.get(`${root}/stt-profile`, limiter, authorize, actor, handle(ctx, (studio) => studio.getSttProfile()));
  app.post(`${root}/stt-profile`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== 'SAVE CARTESIA STT PROFILE') {
      throw Object.assign(new Error('An exact STT profile save confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.saveSttProfile(req.body || {}, req.callEActorId);
  }));
  app.post(`${root}/phrase-cache`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    if (String(req.body?.confirmation_phrase || '') !== 'CACHE CARTESIA STOCK PHRASE') {
      throw Object.assign(new Error('An exact phrase-cache confirmation is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.createPhraseCache(req.body || {});
  }, { status: 201, message: 'Cartesia phrase could not be generated and cached' }));
  app.get(`${root}/phrase-cache/:cacheKey`, limiter, authorize, actor, handle(ctx, async (studio, req, res) => {
    const cached = await studio.getCachedPhrase(req.params?.cacheKey);
    if (!cached) return sendError(ctx, req, res, 404, 'cartesia_phrase_cache_not_found', 'Cached Cartesia phrase was not found');
    const audio = Buffer.from(cached.audioBase64, 'base64');
    audio.contentType = cached.contentType;
    return audio;
  }));

  app.post(`${root}/pro-clones/datasets`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const name = String(req.body?.name || '').trim();
    if (String(req.body?.confirmation_phrase || '') !== `CREATE CARTESIA PRO CLONE DATASET ${name.toUpperCase()}`) {
      throw Object.assign(new Error('An exact dataset confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.createDataset({ ...(req.body || {}), consentActorId: String(req.callEActorId || ''), consentPhrase: String(req.body?.confirmation_phrase || '') });
  }, { status: 201 }));
  app.post(`${root}/pro-clones/datasets/:datasetId/files`, limiter, authorize, rawAudio, actor, handle(ctx, (studio, req) => {
    const datasetId = String(req.params?.datasetId || '');
    if (!ID_PATTERN.test(datasetId) || !Buffer.isBuffer(req.body) || !req.body.length || req.body.length > 16 * 1024 * 1024) {
      throw Object.assign(new Error('A valid dataset and audio file up to 16 MB are required'), { code: 'cartesia_dataset_file_invalid', status: 400 });
    }
    if (String(req.query?.confirmation_phrase || '') !== `UPLOAD CONSENTED CARTESIA PRO CLONE SAMPLE TO ${datasetId}`) {
      throw Object.assign(new Error('An exact sample upload confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.uploadDatasetFile(datasetId, {
      file: req.body,
      filename: String(req.query?.filename || 'voice-sample.wav').slice(0, 120),
      contentType: String(req.query?.content_type || 'application/octet-stream'),
      consentId: String(req.query?.consent_id || ''),
    });
  }, { status: 201 }));
  app.post(`${root}/pro-clones/fine-tunes`, limiter, authorize, actor, handle(ctx, (studio, req) => {
    const datasetId = String(req.body?.dataset_id || '');
    if (String(req.body?.confirmation_phrase || '') !== `I CONFIRM SPEAKER CONSENT AND START CARTESIA PRO CLONE TRAINING ${datasetId}`) {
      throw Object.assign(new Error('An exact training confirmation phrase is required'), { code: 'cartesia_confirmation_required', status: 400 });
    }
    return studio.createFineTune({ ...(req.body || {}), consentId: String(req.body?.consent_id || '') });
  }, { status: 201 }));
  app.get(`${root}/pro-clones/fine-tunes/:fineTuneId`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.getFineTune(req.params?.fineTuneId)));
  app.get(`${root}/pro-clones/fine-tunes/:fineTuneId/voices`, limiter, authorize, actor, handle(ctx, (studio, req) => studio.listFineTuneVoices(req.params?.fineTuneId)));
}

module.exports = { registerCartesiaStudioRoutes, __testables: { sendError } };
