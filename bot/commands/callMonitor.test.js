'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const httpClient = require('../utils/httpClient');
const {
  handleCallMonitor,
  maskPhoneNumber,
  formatCallLines,
  formatVapiCallLines,
  formatCartesiaCallLines,
  formatCallELines,
  formatUnifiedCallLines,
  formatUnknownSubmissionLines,
  formatTelephonyReadiness,
} = require('./callMonitor');

test('unified outbound activity renders providers with escaped IDs and masked numbers', () => {
  const lines = formatUnifiedCallLines([
    { call_sid: '<call>', telephony_provider: '<vapi>', status: 'completed', destination: '+15555550199', created_at: '2026-11-14T00:00:00Z' },
  ]);
  assert.match(lines[0], /&lt;call&gt;/);
  assert.match(lines[0], /&lt;vapi&gt;/);
  assert.match(lines[0], /•••0199/);
  assert.doesNotMatch(lines[0], /\+15555550199/);
});

test('call monitoring masks destinations and escapes provider metadata', () => {
  assert.equal(maskPhoneNumber('+15555550199'), '•••0199');
  const lines = formatCallLines([{
    call_sid: 'CA123',
    destination: '•••0199',
    status: 'ringing',
    telephony_provider: '<twilio>',
    ai_voice_engine: 'cartesia',
    error_code: '<error>',
  }]);

  assert.match(lines[0], /&lt;twilio&gt;/);
  assert.match(lines[0], /&lt;error&gt;/);
  assert.doesNotMatch(lines[0], /\+15555550199/);
});

test('provider call summaries escape metadata and collapse Vapi events to the latest event per call', () => {
  const vapiLines = formatVapiCallLines([
    {
      provider_call_id: 'vapi-<123>',
      provider_status: '<ended>',
      event_type: 'end-of-call-report',
      ended_reason: '<failed>',
      duration_seconds: 12,
    },
    {
      provider_call_id: 'vapi-<123>',
      provider_status: 'in-progress',
      event_type: 'status-update',
    },
  ]);
  assert.equal(vapiLines.length, 1);
  assert.match(vapiLines[0], /vapi-&lt;123&gt;/);
  assert.match(vapiLines[0], /&lt;ended&gt;/);
  assert.match(vapiLines[0], /&lt;failed&gt;/);
  assert.doesNotMatch(vapiLines[0], /in-progress/);

  const callELines = formatCallELines([{
    localCallId: 'call_e_123',
    executionStatus: '<completed>',
    callOutcome: 'answered',
    resultStatus: 'available',
    errorCode: '<bad>',
  }]);
  assert.match(callELines[0], /&lt;completed&gt;/);
  assert.match(callELines[0], /&lt;bad&gt;/);
});

test('telephony readiness is labeled as configuration status and escapes provider names', () => {
  const lines = formatTelephonyReadiness({
    providers: {
      call: {
        provider: '<twilio>',
        readiness: { '<twilio>': true },
        supported_providers: ['twilio', 'plivo', 'vonage'],
      },
    },
  });
  assert.match(lines[0], /&lt;TWILIO&gt; ready/);
  assert.match(lines[1], /TWILIO unknown · PLIVO unknown · VONAGE unknown/);
  assert.match(lines[0], /configuration readiness/);
  assert.deepEqual(formatTelephonyReadiness({}), ['Telephony configuration readiness: unavailable']);
});

test('unknown submission summaries mask destinations and escape provider correlation', () => {
  const lines = formatUnknownSubmissionLines([{
    call_sid: 'local-call-1',
    status: 'unknown',
    destination: '+15555550199',
    telephony_provider: 'twilio',
    provider_call_id: '<provider-call>',
    last_event_at: '2026-11-14T11:00:00.000Z',
  }]);
  assert.match(lines[0], /•••0199/);
  assert.match(lines[0], /&lt;provider-call&gt;/);
  assert.match(lines[0], /last event 2026-11-14/);
  assert.doesNotMatch(lines[0], /\+15555550199/);
});

test('Cartesia call monitor lines keep the masked destination and escape provider labels', () => {
  const lines = formatCartesiaCallLines([{
    callId: '<cartesia-call>', status: 'started', to: '••••0123', agentName: '<Agent>',
  }]);
  assert.match(lines[0], /&lt;cartesia-call&gt;/);
  assert.match(lines[0], /••••0123/);
  assert.match(lines[0], /&lt;Agent&gt;/);
});

test('call monitoring is admin-only and renders the shared operations summary', async () => {
  const originalGet = httpClient.get;
  const replies = [];
  const requested = [];
  httpClient.get = async (_ctx, url, options = {}) => {
    requested.push({ url, options });
    if (url.endsWith('/api/vapi/call-events')) {
      return {
        data: {
          events: [{
            provider_call_id: 'vapi-call-1',
            provider_status: 'ended',
            event_type: 'end-of-call-report',
            duration_seconds: 14,
          }],
        },
      };
    }
    if (url.endsWith('/admin/provider')) {
      return {
        data: {
          providers: {
            call: {
              provider: 'twilio',
              readiness: { twilio: true, plivo: false, vonage: true },
              supported_providers: ['twilio', 'plivo', 'vonage'],
            },
          },
          provider_health: {
            twilio: { circuit_state: 'open', degraded: true },
          },
        },
      };
    }
    if (url.endsWith('/api/call-e/call-results')) {
      return {
        data: {
          rows: [{
            localCallId: 'call_e_123',
            executionStatus: 'completed',
            callOutcome: 'answered',
            resultStatus: 'available',
          }],
        },
      };
    }
    return {
      data: {
        active_calls: [{
          call_sid: 'CA123',
          destination: '•••0199',
          status: 'ringing',
          telephony_provider: 'twilio',
          ai_voice_engine: 'cartesia',
        }],
        stale_calls: [],
        recent_failures: [],
        counts: { active: 1, stale: 0, recent_failures: 0, unknown_submissions: 1 },
        unknown_submissions: [{
          call_sid: 'local-unknown-1',
          destination: '•••0199',
          status: 'unknown',
          telephony_provider: 'twilio',
          provider_call_id: 'CA_PROVIDER_123',
          last_event_at: '2026-11-14T11:00:00.000Z',
        }],
        active_by_provider: { twilio: 1 },
        notification_delivery: { pending: 0, retrying: 0, failed: 1 },
        webhook_processing_errors_24h: { count: 2 },
      },
    };
  };
  try {
    await handleCallMonitor({
      from: { id: 7001 },
      session: { accessProfile: { isAdmin: true, checkedAt: Date.now() } },
      reply: async (message, options) => replies.push({ message, options }),
    });
  } finally {
    httpClient.get = originalGet;
  }

  assert.equal(replies.length, 1);
  assert.match(replies[0].message, /Active: <b>1<\/b>/);
  assert.match(replies[0].message, /Webhook processing errors \(24h\): 2/);
  assert.match(replies[0].message, /Telephony configuration readiness: TWILIO ready/);
  assert.match(replies[0].message, /Provider configuration: TWILIO ready · PLIVO not ready · VONAGE ready/);
  assert.match(replies[0].message, /Provider health alert: degraded\/circuit-open/);
  assert.match(replies[0].message, /Unknown submissions/);
  assert.match(replies[0].message, /CA_PROVIDER_123/);
  assert.match(replies[0].message, /does not perform provider lookups or retries/);
  assert.match(replies[0].message, /Verify state directly with the provider before any retry/);
  assert.match(replies[0].message, /•••0199/);
  assert.doesNotMatch(replies[0].message, /\+15555550199/);
  assert.match(replies[0].message, /Vapi activity/);
  assert.match(replies[0].message, /vapi-call-1.*ended/);
  assert.match(replies[0].message, /CALL-E activity \(operator-scoped\)/);
  assert.match(replies[0].message, /call_e_123.*completed.*answered/);
  const callERequest = requested.find(({ url }) => url.endsWith('/api/call-e/call-results'));
  assert.equal(callERequest.options.params.actor_id, '7001');
  assert.equal(callERequest.options.params.limit, 5);
});

test('call monitoring reports an absent CALL-E operator scope without querying global records', async () => {
  const originalGet = httpClient.get;
  const replies = [];
  httpClient.get = async (_ctx, url) => {
    if (url.endsWith('/api/call-e/call-results')) {
      const error = new Error('forbidden');
      error.response = { status: 403 };
      throw error;
    }
    if (url.endsWith('/api/vapi/call-events')) return { data: { events: [] } };
    if (url.endsWith('/admin/provider')) throw new Error('provider status unavailable');
    return { data: { counts: {}, active_calls: [], stale_calls: [], recent_failures: [] } };
  };
  try {
    await handleCallMonitor({
      from: { id: 7003 },
      session: { accessProfile: { isAdmin: true, checkedAt: Date.now() } },
      reply: async (message) => replies.push(message),
    });
  } finally {
    httpClient.get = originalGet;
  }
  assert.match(replies[0], /No CALL-E operator scope/);
  assert.match(replies[0], /Telephony configuration readiness temporarily unavailable/);
});

test('non-admin users cannot request call operations monitoring', async () => {
  let message = '';
  await handleCallMonitor({
    from: { id: 7002 },
    session: { accessProfile: { isAdmin: false, checkedAt: Date.now() } },
    reply: async (value) => { message = value; },
  });
  assert.match(message, /Access denied/);
});
