'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_TELEGRAM_ID ||= '1';
process.env.ADMIN_TELEGRAM_USERNAME ||= 'admin';
process.env.API_URL ||= 'http://127.0.0.1:3000';
process.env.BOT_TOKEN ||= 'test-token';
process.env.API_SECRET ||= 'test-api-secret';

const httpClient = require('../utils/httpClient');
const { ACTIONS, buildCartesiaStudioKeyboard, cartesiaStudioFlow, __testables } = require('./cartesiaStudio');
const { Readable } = require('node:stream');

test('Cartesia Studio menu exposes the requested capability families with signed callbacks', () => {
  for (const action of [
    'CARTESIA_STUDIO_VOICES', 'CARTESIA_STUDIO_PREVIEW', 'CARTESIA_STUDIO_DICTIONARIES',
    'CARTESIA_STUDIO_QUALITY', 'CARTESIA_STUDIO_LOGS', 'CARTESIA_STUDIO_TOOLS',
    'CARTESIA_STUDIO_STT', 'CARTESIA_STUDIO_PHRASE_CACHE',
    'CARTESIA_STUDIO_VOICE_MANAGE', 'CARTESIA_STUDIO_STREAMS', 'CARTESIA_STUDIO_INFILL',
    'CARTESIA_STUDIO_AGENTS', 'CARTESIA_STUDIO_USAGE', 'CARTESIA_STUDIO_CONTINUATIONS',
    'CARTESIA_STUDIO_KNOWLEDGE_BASE', 'CARTESIA_STUDIO_SIP_PROVIDERS', 'CARTESIA_STUDIO_ENTERPRISE_PRIVACY',
    'CARTESIA_STUDIO_WEBHOOKS',
    'CARTESIA_STUDIO_READINESS',
  ]) assert.equal(ACTIONS.has(action), true);
  const keyboard = buildCartesiaStudioKeyboard({ session: {} });
  const buttons = keyboard.inline_keyboard.flat();
  const data = buttons.map((button) => button.callback_data).filter(Boolean);
  assert.ok(data.some((value) => value.includes('CARTESIA_STUDIO_VOICES')));
  assert.ok(data.some((value) => value.includes('CARTESIA_STUDIO_QUALITY')));
  assert.ok(data.some((value) => value.includes('CARTESIA_STUDIO_KNOWLEDGE_BASE')));
  assert.ok(data.some((value) => value.includes('CARTESIA_STUDIO_WEBHOOKS')));
  assert.ok(data.some((value) => value.includes('CARTESIA_STUDIO_READINESS')));
  assert.ok(data.some((value) => value.includes('CARTESIA_STUDIO_SIP_PROVIDERS')));
  assert.ok(data.every((value) => value.startsWith('cb|')));
  assert.ok(buttons.some((button) => button.url === 'https://www.cartesia.ai/product/voice-conversion'));
});

test('Cartesia Ink manual mode uploads bounded PCM with explicit turn finalization', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  httpClient.get = async (_ctx, url) => {
    assert.match(url, /\/stt-profile/);
    return { data: { profile: { keyterms: ['Acme'], turnSettings: { end_timeout_ms: 5600 } } } };
  };
  httpClient.post = async (_ctx, url, body, options) => {
    requests.push({ url, body, options });
    return { data: { transcript: '  preserve spacing ', language: 'en', durationSeconds: 0.2 } };
  };
  const updates = [
    { message: { text: 'manual' } },
    { message: { document: { file_id: 'telegram-file-1', file_name: 'clip.pcm', file_size: 6400, mime_type: 'application/octet-stream' } } },
    { message: { text: 'TRANSCRIBE AUDIO WITH CARTESIA INK MANUAL' } },
  ];
  const ctx = {
    from: { id: 7001 },
    api: { async getFile(id) { assert.equal(id, 'telegram-file-1'); return { file_path: 'audio/clip.pcm' }; } },
    async reply(message) { replies.push(String(message)); },
  };
  try {
    await __testables.runInkTranscription(
      { async wait() { return updates.shift(); } },
      ctx,
      () => {},
      { async downloadAudio(_ctx, file, maxBytes) {
        assert.equal(file.file_path, 'audio/clip.pcm');
        assert.equal(maxBytes, 1_600_000);
        return Buffer.alloc(6400);
      } },
    );
  } finally {
    httpClient.get = originalGet;
    httpClient.post = originalPost;
  }
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('turn_mode'), 'manual');
  assert.equal(url.searchParams.get('confirmation_phrase'), 'TRANSCRIBE AUDIO WITH CARTESIA INK MANUAL');
  assert.equal(url.searchParams.get('encoding'), 'pcm_s16le');
  assert.equal(url.searchParams.get('sample_rate'), '16000');
  assert.deepEqual(requests[0].body, Buffer.alloc(6400));
  assert.equal(requests[0].options.retry.retries, 0);
  assert.match(replies.join('\n'), /manual turn finalization transcript/);
  assert.match(replies.join('\n'), /  preserve spacing /);
});

test('Cartesia readiness menu renders safe diagnostics and labels local webhook receipts', async () => {
  const originalGet = httpClient.get;
  const replies = [];
  let requestedUrl;
  httpClient.get = async (_ctx, url) => {
    requestedUrl = url;
    return { data: {
      generatedAt: '2026-10-31T12:00:00.000Z',
      configuration: { enabled: true, apiConfigured: true, apiKeyPresent: true, adminCredentialPresent: true, apiVersion: '2026-08-14' },
      credentials: { api: 'ok' }, voices: { status: 'available', sampleCount: 1 },
      agents: { status: 'available', count: 2, attachedWebhookCount: 1 },
      webhook: { status: 'ready', secretConfigured: true, callbackConfigured: true, registered: true, attachedAgentCount: 1 },
      webhookReceipts: { status: 'received', count: 3, latestReceivedAt: '2026-10-31 11:00:00', eventTypes: { call_completed: 2, call_started: 1 }, source: 'VOICEDNUT received-event history; Cartesia delivery attempts are not exposed by the documented API' },
      recommendations: ['Confirm the agent has recent test activity.'],
    } };
  };
  const ctx = { from: { id: 1 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_READINESS' },
    async reply(message) { replies.push(String(message)); } };
  try { await cartesiaStudioFlow({ wait() { throw new Error('readiness flow must not prompt'); } }, ctx); }
  finally { httpClient.get = originalGet; }
  assert.match(requestedUrl, /\/api\/cartesia\/studio\/readiness/);
  assert.match(replies.join('\n'), /Cartesia integration readiness/);
  assert.match(replies.join('\n'), /Webhook: ready/);
  assert.match(replies.join('\n'), /VOICEDNUT webhook receipts \(3 in 30 days\)/);
  assert.match(replies.join('\n'), /API: verified/);
  assert.match(replies.join('\n'), /Cartesia delivery attempts are not exposed/);
  assert.match(replies.join('\n'), /Confirm the agent has recent test activity/);
});

test('Cartesia agent update summaries mask transfer numbers and hide keyterm values', () => {
  const summary = __testables.summarizeAgentUpdate({ config: {
    audio: { input: { keyterms: ['private term', 'customer name'] } },
    system_tools: { transfer_to_number: { transfers: [{ condition: 'support', destination: { type: 'phone', phone_number: '+14155550123' } }] } },
  } });
  assert.match(summary, /••••0123/);
  assert.match(summary, /\[2 keyterms\]/);
  assert.doesNotMatch(summary, /private term|\+14155550123/);
});

test('Cartesia Studio rejects group use and unknown actions before API requests', async () => {
  const originalGet = httpClient.get;
  let calls = 0;
  httpClient.get = async () => { calls += 1; return {}; };
  const replies = [];
  const base = {
    from: { id: 1 }, session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_QUALITY' },
    async reply(message) { replies.push(message); },
  };
  try {
    await cartesiaStudioFlow({ wait: async () => ({ message: { text: 'agent_1' } }) }, { ...base, chat: { type: 'group' } });
    await cartesiaStudioFlow({ wait: async () => ({ message: { text: 'agent_1' } }) }, { ...base, chat: { type: 'private' }, session: { ...base.session, cartesiaStudioAction: 'NOT_ALLOWED' } });
  } finally { httpClient.get = originalGet; }
  assert.equal(calls, 0);
  assert.match(replies.join('\n'), /private chat|expired/i);
});

test('speech tuning confirmation phrase is exact and locale choice is preserved in the preview profile', () => {
  assert.equal(__testables.readOnlyConfirmation('CARTESIA_STUDIO_CLONE', 'Support'), 'I CONFIRM SPEAKER CONSENT AND CREATE CARTESIA CLONE SUPPORT');
  assert.equal(__testables.readOnlyConfirmation('CARTESIA_STUDIO_PREVIEW'), 'GENERATE CARTESIA TTS PREVIEW');
  assert.equal(__testables.readOnlyConfirmation('CARTESIA_STUDIO_PHRASE_CACHE'), 'CACHE CARTESIA STOCK PHRASE');
  assert.equal(__testables.applyTtsMarkup('Call now', 'pause', '0.5'), 'Call now<break time="0.5s"/>');
  assert.equal(__testables.applyTtsMarkup('Read ABC123 aloud', 'spell', '', 'ABC123'), 'Read <spell>ABC123</spell> aloud');
  assert.equal(__testables.applyTtsMarkup('Say cat clearly', 'ipa', 'ˈ|k|æ|t', 'cat'), 'Say <<ˈ|k|æ|t>> clearly');
  assert.throws(() => __testables.applyTtsMarkup('Say cat then cat', 'ipa', 'ˈ|k|æ|t', 'cat'), /exact, single-occurrence/);
});

test('speech preview builds guided Cartesia pause markup before one confirmed mock request', async () => {
  const originalPost = httpClient.post;
  let request;
  const replies = [];
  httpClient.post = async (_ctx, url, body) => { request = { url, body }; return { data: { audioBase64: Buffer.from([1, 2, 3, 4]).toString('base64') } }; };
  const responses = ['voice_1', 'en-US', 'Hello there', 'pause', '0.5', '1', '1', 'none', 'GENERATE CARTESIA TTS PREVIEW'].map((text) => ({ message: { text } }));
  const ctx = {
    from: { id: 1 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_PREVIEW' },
    async reply(message) { replies.push(String(message)); },
    async replyWithAudio(audio) { this.audio = audio; },
  };
  try { await cartesiaStudioFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.post = originalPost; }
  assert.match(request.url, /\/tts-preview$/);
  assert.equal(request.body.transcript, 'Hello there<break time="0.5s"/>');
  assert.equal(request.body.speed, 1);
  assert.equal(ctx.audio.filename, 'cartesia-preview.wav');
  assert.equal(replies.some((reply) => reply.includes('GENERATE CARTESIA TTS PREVIEW')), true);
});

test('enterprise privacy view reads readiness without claiming remote ZDR verification', async () => {
  const originalGet = httpClient.get;
  const replies = [];
  httpClient.get = async (_ctx, url) => {
    assert.match(url, /\/privacy-readiness/);
    return { data: { providerConfigured: true, apiVersion: '2026-08-14', endpointStatus: 'default_endpoint', zeroDataRetention: { status: 'manual_account_verification_required', enterpriseOnly: true, coveredWorkflows: ['tts', 'stt'], excludedWorkflows: ['instant_voice_clone', 'pro_voice_clone'], remotelyVerifiable: false }, regionalEndpoint: { status: 'requires_cartesia_provisioning' } } };
  };
  const ctx = { from: { id: 1 }, chat: { type: 'private' }, session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_ENTERPRISE_PRIVACY' }, async reply(message) { replies.push(String(message)); } };
  try { await cartesiaStudioFlow({ async wait() { return null; } }, ctx); }
  finally { httpClient.get = originalGet; }
  assert.match(replies.join('\n'), /account setting cannot be read through this API/);
  assert.match(replies.join('\n'), /instant_voice_clone/);
  assert.match(replies.join('\n'), /requires Cartesia (?:Enterprise )?provisioning/);
});

test('clone governance revocation is interactive and warns that provider resources remain', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const posts = [];
  const replies = [];
  const consentId = 'a'.repeat(32);
  httpClient.get = async () => ({ data: { consents: [{ consentId, operation: 'pro_clone_dataset', resourceId: 'dataset_1', resourceType: 'dataset', status: 'active', sampleCount: 2 }] } });
  httpClient.post = async (_ctx, url, body) => { posts.push({ url, body }); return { data: { revoked: true } }; };
  const responses = ['revoke', consentId, `REVOKE CARTESIA VOICE CONSENT ${consentId}`].map((text) => ({ message: { text } }));
  const ctx = { from: { id: 1 }, async reply(message) { replies.push(String(message)); } };
  try { await __testables.runVoiceGovernance({ async wait() { return responses.shift(); } }, ctx, () => {}); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /voice-governance\/([a-f0-9]{32})\/revoke/);
  assert.equal(posts[0].body.confirmation_phrase, `REVOKE CARTESIA VOICE CONSENT ${consentId}`);
  assert.match(replies.join('\n'), /Existing Cartesia resources were retained/);
});

test('Pro Clone governance can check training status and resulting voice IDs', async () => {
  const originalGet = httpClient.get;
  const replies = [];
  const urls = [];
  httpClient.get = async (_ctx, url) => {
    urls.push(url);
    if (/\/fine-tunes\/ft_1\/voices/.test(url)) return { data: { voices: [{ id: 'voice_pvc_1', name: 'Support PVC' }] } };
    if (/\/fine-tunes\/ft_1/.test(url)) return { data: { fineTune: { id: 'ft_1', status: 'completed' } } };
    return { data: { consents: [] } };
  };
  const responses = ['status', 'ft_1'].map((text) => ({ message: { text } }));
  const ctx = { from: { id: 1 }, async reply(message) { replies.push(String(message)); } };
  try { await __testables.runVoiceGovernance({ async wait() { return responses.shift(); } }, ctx, () => {}); }
  finally { httpClient.get = originalGet; }
  assert.equal(urls.length, 3);
  assert.match(replies.join('\n'), /status: <b>completed<\/b>/);
  assert.match(replies.join('\n'), /voice_pvc_1/);
});

test('Managed Agent language readiness reports accent fallback without labeling it unsupported', async () => {
  const originalGet = httpClient.get;
  const replies = [];
  httpClient.get = async (_ctx, url) => {
    if (/\/agents\/agent_1\/deployments/.test(url)) return { data: { deployments: [] } };
    if (/\/agents\/agent_1\/language-readiness/.test(url)) return { data: { agentId: 'agent_1', voiceId: 'voice_1', originalAccent: 'en-US', languages: [{ code: 'en-US', voiceAccent: 'native_accent_listed' }, { code: 'fr-FR', voiceAccent: 'original_accent_fallback' }] } };
    if (/\/phone-numbers/.test(url)) return { data: { phoneNumbers: [] } };
    return { data: { agents: [{ id: 'agent_1', name: 'Support' }] } };
  };
  const responses = ['agent_1', 'language-readiness'].map((text) => ({ message: { text } }));
  const ctx = { from: { id: 1 }, chat: { type: 'private' }, session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_AGENTS' }, async reply(message) { replies.push(String(message)); } };
  try { await cartesiaStudioFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; }
  assert.match(replies.join('\n'), /falls back to original accent/);
  assert.match(replies.join('\n'), /does not by itself mean a language is unsupported/);
});

test('Managed Agent profile flow applies a saved profile only after exact interactive confirmation', async () => {
  const originalGet = httpClient.get; const originalPost = httpClient.post;
  const requests = []; const replies = [];
  httpClient.get = async (_ctx, url) => {
    if (/\/agents\/agent_1\/deployments/.test(url)) return { data: { deployments: [] } };
    if (/\/agent-profiles/.test(url)) return { data: { profiles: [{ id: 'profile_1', name: 'Support', configSummary: { voiceId: 'voice_1', voiceSpeed: 1, keytermCount: 2 } }] } };
    if (/\/phone-numbers/.test(url)) return { data: { phoneNumbers: [] } };
    return { data: { agents: [{ id: 'agent_1', name: 'Support' }] } };
  };
  httpClient.post = async (_ctx, url, body) => { requests.push({ url, body }); return { data: { profile: { id: 'profile_1', name: 'Support' }, agent: { currentVersionId: 'version_2' } } }; };
  const responses = ['agent_1', 'profiles', 'apply', 'profile_1', 'APPLY CARTESIA AGENT PROFILE profile_1 TO AGENT agent_1'].map((text) => ({ message: { text } }));
  const ctx = { from: { id: 1 }, chat: { type: 'private' }, session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_AGENTS' }, async reply(message) { replies.push(String(message)); } };
  try { await cartesiaStudioFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.match(replies.join('\n'), /Reusable Cartesia agent voice profiles/);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/agents\/agent_1\/profiles\/profile_1\/apply$/);
  assert.equal(requests[0].body.confirmation_phrase, 'APPLY CARTESIA AGENT PROFILE profile_1 TO AGENT agent_1');
});

test('Managed Agent flow browses sanitized Cartesia starter templates without creating or deploying them', async () => {
  const originalGet = httpClient.get; const urls = []; const replies = [];
  httpClient.get = async (_ctx, url) => {
    urls.push(url);
    if (/\/agent-templates/.test(url)) return { data: { templates: [{ id: 'template_1', name: 'Support starter', description: '<script>unsafe</script>', repositoryUrl: 'https://github.com/cartesia-ai/starter', requiredEnvironmentVariables: ['CARTESIA_API_KEY'] }] } };
    if (/\/phone-numbers/.test(url)) return { data: { phoneNumbers: [] } };
    return { data: { agents: [] } };
  };
  const responses = ['templates'].map((text) => ({ message: { text } }));
  const ctx = { from: { id: 1 }, chat: { type: 'private' }, session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_AGENTS' }, async reply(message) { replies.push(String(message)); } };
  try { await cartesiaStudioFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; }
  assert.ok(urls.some((url) => /\/agent-templates/.test(url)));
  assert.match(replies.join('\n'), /starter repositories; browsing them does not create or deploy an agent/);
  assert.match(replies.join('\n'), /CARTESIA_API_KEY/);
  assert.doesNotMatch(replies.join('\n'), /<script>/);
});

test('Managed Agent profile creation uses guided voice and audio settings instead of raw JSON', async () => {
  const originalGet = httpClient.get; const originalPost = httpClient.post;
  let request; const replies = [];
  httpClient.get = async (_ctx, url) => {
    if (/\/agents\/agent_1\/deployments/.test(url)) return { data: { deployments: [] } };
    if (/\/agent-profiles/.test(url)) return { data: { profiles: [] } };
    if (/\/phone-numbers/.test(url)) return { data: { phoneNumbers: [] } };
    return { data: { agents: [{ id: 'agent_1', name: 'Support' }] } };
  };
  httpClient.post = async (_ctx, url, body) => { request = { url, body }; return { data: { profile: { id: 'profile_2', name: 'Support voice' } } }; };
  const responses = ['agent_1', 'profiles', 'create', 'Support voice', 'voice_1', '1.1', '0.9', 'auto', 'Acme, VOICEDNUT', 'SAVE CARTESIA AGENT PROFILE SUPPORT VOICE'].map((text) => ({ message: { text } }));
  const ctx = { from: { id: 1 }, chat: { type: 'private' }, session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_AGENTS' }, async reply(message) { replies.push(String(message)); } };
  try { await cartesiaStudioFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(request.url.endsWith('/agent-profiles'), true);
  assert.deepEqual(request.body.config, { audio: { input: { noise_suppression: 'auto', keyterms: ['Acme', 'VOICEDNUT'] }, output: { voice_id: 'voice_1', speed: 1.1, volume: 0.9 } } });
  assert.match(replies.join('\n'), /guided prompts/);
  assert.equal(request.body.confirmation_phrase, 'SAVE CARTESIA AGENT PROFILE SUPPORT VOICE');
});

test('Cartesia client-tool registration is interactive and discloses the server runtime allowlist', async () => {
  const originalPost = httpClient.post;
  let request;
  const replies = [];
  httpClient.post = async (_ctx, url, body) => { request = { url, body }; return { data: { tool: { id: 'tool_client_1' } } }; };
  const schema = JSON.stringify({ type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] });
  const responses = ['lookup_order', 'Look up an order', schema, 'async', 'yes', 'CREATE CARTESIA CLIENT TOOL LOOKUP_ORDER'].map((text) => ({ message: { text } }));
  const ctx = { from: { id: 1 }, async reply(message) { replies.push(String(message)); } };
  try { await __testables.runClientToolCreate({ async wait() { return responses.shift(); } }, ctx, () => {}); }
  finally { httpClient.post = originalPost; }
  assert.match(request.url, /\/tools\/client/);
  assert.equal(request.body.type, 'client');
  assert.deepEqual(request.body.parameters, JSON.parse(schema));
  assert.equal(request.body.expects_response, true);
  assert.match(replies.join('\n'), /explicit safe allowlist/);
  assert.match(replies.join('\n'), /phone calls do not execute client_tool_call events/);
});

test('streaming TTS parser assembles Cartesia base64 chunks and writes a valid PCM WAV header', async () => {
  const stream = Readable.from([
    'event: chunk\ndata: {"type":"chunk","data":"AQI="}\n\n',
    'event: chunk\ndata: {"type":"chunk","data":"AwQ="}\n\n',
    'event: done\ndata: {"type":"done"}\n\n',
  ]);
  const pcm = await __testables.audioFromSse(stream);
  assert.deepEqual([...pcm], [1, 2, 3, 4]);
  const wav = __testables.pcm16ToWav(pcm, 24000);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 4);
});

test('interactive continuation flow collects ordered segments and sends only one confirmed API request', async () => {
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  const responses = [
    { message: { text: 'voice_1' } }, { message: { text: 'Hello, ' } },
    { message: { text: 'world.' } }, { message: { text: 'done' } },
    { message: { text: 'GENERATE CARTESIA TTS CONTINUATIONS' } },
  ];
  const ctx = {
    from: { id: 1 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_CONTINUATIONS' },
    async reply(message) { replies.push(String(message)); },
    async replyWithAudio(audio, options) { this.audio = audio; this.audioOptions = options; },
  };
  const conversation = { async wait() { return responses.shift(); } };
  httpClient.post = async (_ctx, url, body) => { requests.push({ url, body }); return { data: { audioBase64: Buffer.from([1, 2, 3, 4]).toString('base64') } }; };
  try { await cartesiaStudioFlow(conversation, ctx); }
  finally { httpClient.post = originalPost; }
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/tts-continuations$/);
  assert.deepEqual(requests[0].body.transcripts, ['Hello, ', 'world.']);
  assert.equal(requests[0].body.confirmation_phrase, 'GENERATE CARTESIA TTS CONTINUATIONS');
  assert.equal(ctx.audio.filename, 'cartesia-continuations.wav');
  assert.equal(ctx.audioOptions.caption.includes('2 segments'), true);
});

test('Knowledge Base bot listing shows document metadata without exposing source content', async () => {
  const originalGet = httpClient.get;
  const replies = [];
  httpClient.get = async () => ({ data: { documents: [{ id: 'doc_1', name: 'FAQ', status: 'indexed', contentLength: 100, content: 'sensitive source' }] } });
  const ctx = {
    from: { id: 1 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_KNOWLEDGE_BASE' },
    async reply(message) { replies.push(String(message)); },
  };
  try { await cartesiaStudioFlow({ async wait() { return { message: { text: 'documents' } }; } }, ctx); }
  finally { httpClient.get = originalGet; }
  assert.match(replies.join('\n'), /FAQ/);
  assert.match(replies.join('\n'), /100 chars/);
  assert.doesNotMatch(replies.join('\n'), /sensitive source/);
});

test('Cartesia quality scorecard is scoped to the asserted Telegram admin and hides transcripts', async () => {
  const originalGet = httpClient.get;
  const urls = [];
  const replies = [];
  httpClient.get = async (_ctx, url) => {
    urls.push(url);
    return { data: { results: [{ callId: 'call_1', status: 'completed', value: true }], summary: { resultCount: 1, booleanPassCount: 1, booleanFailCount: 0 } } };
  };
  const ctx = {
    from: { id: 1 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_QUALITY' },
    async reply(message) { replies.push(message); },
  };
  const conversation = { async wait() { return { message: { text: 'agent_1' } }; } };
  try { await cartesiaStudioFlow(conversation, ctx); }
  finally { httpClient.get = originalGet; }
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get('actor_id'), '1');
  assert.equal(new URL(urls[0]).searchParams.get('agent_id'), 'agent_1');
  assert.match(replies.join('\n'), /Boolean passes: 1/);
  assert.doesNotMatch(replies.join('\n'), /transcript text|private/);
});

test('agent version restore requires an evaluated candidate, operator attestation, and exact confirmation', async () => {
  const originalGet = httpClient.get;
  const originalPost = httpClient.post;
  const requests = [];
  const replies = [];
  httpClient.get = async (_ctx, url) => {
    requests.push({ method: 'GET', url });
    if (/\/agents\/agent_1\/versions\/version_1(?:\?|$)/.test(url)) return { data: { version: { id: 'version_1', configSummary: { model: 'gpt-4o-mini', language: 'en', voiceId: 'voice_1', voiceSpeed: 1.1, toolIds: ['tool_1'], systemTools: ['end_call'], hasInstructions: true, hasFirstMessage: true } } } };
    if (/\/agents\/agent_1\/config-summary/.test(url)) return { data: { currentVersionId: 'version_2', configSummary: { model: 'sonic-3.6', language: 'en', voiceId: 'voice_0', voiceSpeed: 1, toolIds: ['tool_1'], systemTools: ['end_call'], hasInstructions: false, hasFirstMessage: true } } };
    if (/\/agents\/agent_1\/versions(?:\?|$)/.test(url)) return { data: { versions: [{ id: 'version_1', description: 'Stable config', createdAt: '2026-10-01' }] } };
    if (/\/studio\/metrics(?:\?|$)/.test(url)) return { data: { metrics: [{ id: 'metric_goal', name: 'goal_resolved' }] } };
    if (/\/agents\/agent_1\/deployments/.test(url)) return { data: { deployments: [] } };
    if (/\/phone-numbers/.test(url)) return { data: { phoneNumbers: [] } };
    return { data: { agents: [{ id: 'agent_1', name: 'Support' }] } };
  };
  httpClient.post = async (_ctx, url, body) => {
    requests.push({ method: 'POST', url, body });
    if (/evaluation-gate$/.test(url)) return { data: { passed: true, sampleCount: 3, completeSampleCount: 3, passedSampleCount: 3, passRate: 1, limitations: ['operator attestation required'] } };
    return { data: { restoredFromVersionId: 'version_1', currentVersionId: 'version_2' } };
  };
  const callIds = ['call_1', 'call_2', 'call_3'];
  const responses = ['agent_1', 'versions', 'version_1', 'metric_goal', callIds.join(','), '90', '{}', `I ATTEST CARTESIA TEST CALLS ${callIds.join(',')} USED VERSION version_1`, 'RESTORE CARTESIA AGENT agent_1 FROM VERSION version_1'].map((text) => ({ message: { text } }));
  const ctx = {
    from: { id: 1 }, chat: { type: 'private' },
    session: { accessProfile: { isAdmin: true, checkedAt: Date.now() }, cartesiaStudioAction: 'CARTESIA_STUDIO_AGENTS' },
    async reply(message) { replies.push(String(message)); },
  };
  try { await cartesiaStudioFlow({ async wait() { return responses.shift(); } }, ctx); }
  finally { httpClient.get = originalGet; httpClient.post = originalPost; }
  assert.equal(requests.filter((request) => request.method === 'POST').length, 2);
  const evaluation = requests.find((request) => /evaluation-gate$/.test(request.url));
  const restore = requests.find((request) => /\/restore(?:\?|$)/.test(request.url));
  assert.deepEqual(evaluation.body.call_ids, callIds);
  assert.deepEqual(evaluation.body.metric_thresholds, {});
  assert.equal(evaluation.body.operator_attestation, `I ATTEST CARTESIA TEST CALLS ${callIds.join(',')} USED VERSION version_1`);
  assert.match(restore.url, /agents\/agent_1\/versions\/version_1\/restore/);
  assert.equal(restore.body.confirmation_phrase, 'RESTORE CARTESIA AGENT agent_1 FROM VERSION version_1');
  assert.deepEqual(restore.body.evaluation.metric_ids, ['metric_goal']);
  assert.match(replies.join('\n'), /Stable config/);
  assert.match(replies.join('\n'), /Current <code>version_2<\/code> → selected <code>version_1<\/code>/);
  assert.match(replies.join('\n'), /Model: sonic-3\.6 → gpt-4o-mini/);
  assert.match(replies.join('\n'), /Voice ID: voice_0 → voice_1/);
  assert.match(replies.join('\n'), /Instructions: not set → present \(content hidden\)/);
  assert.ok(replies.findIndex((reply) => reply.includes('Model: sonic-3.6 → gpt-4o-mini')) < replies.findIndex((reply) => reply.includes('RESTORE CARTESIA AGENT agent_1 FROM VERSION version_1')));
  assert.match(replies.join('\n'), /New version: version_2/);
  assert.match(replies.join('\n'), /Version evaluation gate: PASSED/);
  assert.doesNotMatch(replies.join('\n'), /private system prompt|secret prompt/);
});
