const assert = require('node:assert/strict');
const {
  HANDOFF_CONFIRMATION_PROMPT,
  buildTwilioCallHandoffTwiml,
  classifyCallAgentHandoffDtmf,
  createCallAgentHandoffService,
  exposeCallAgentHandoffAction,
  resolveCallAgentHandoffPolicy,
} = require('../services/callAgentHandoff');

function createFakeDb() {
  let session = null;
  const states = [];
  return {
    states,
    setSessionState(state, updatedAtMs) {
      session = { ...session, state, updated_at_ms: updatedAtMs };
    },
    async createCallHandoffSession(callSid, destination, expiresAt) {
      if (session) return false;
      session = {
        call_sid: callSid,
        state: 'awaiting_confirmation',
        destination_e164: destination,
        expires_at: expiresAt,
      };
      return true;
    },
    async getCallHandoffSession() {
      return session && { ...session };
    },
    async transitionCallHandoffSession(callSid, fromState, toState, options = {}) {
      if (!session || session.call_sid !== callSid || session.state !== fromState) return false;
      if (options.require_unexpired && session.expires_at <= options.now) return false;
      session.state = toState;
      return true;
    },
    async updateCallState(callSid, state, data) {
      states.push({ callSid, state, data });
    },
  };
}

function liveTwilioCallConfig(overrides = {}) {
  return {
    provider: 'twilio',
    call_mode: 'normal',
    flow_state: 'normal',
    script_policy: {
      lifecycle_state: 'live',
      agent_config: {
        handoff_policy: {
          enabled: true,
          destination_e164: '+15555550123',
          confirmation: 'dtmf_1',
        },
      },
    },
    ...overrides,
  };
}

describe('Call Agent Twilio handoff policy', () => {
  it('allows only an enabled live Twilio script with a fixed destination and no active secure flow', () => {
    assert.deepEqual(resolveCallAgentHandoffPolicy(liveTwilioCallConfig()), {
      provider: 'twilio',
      destination_e164: '+15555550123',
      confirmation: 'dtmf_1',
    });
    assert.equal(resolveCallAgentHandoffPolicy(liveTwilioCallConfig({ provider: 'plivo' })), null);
    assert.equal(resolveCallAgentHandoffPolicy(liveTwilioCallConfig({
      script_policy: { ...liveTwilioCallConfig().script_policy, lifecycle_state: 'draft' },
    })), null);
    assert.equal(resolveCallAgentHandoffPolicy(liveTwilioCallConfig({ payment_in_progress: true })), null);
    assert.equal(resolveCallAgentHandoffPolicy(liveTwilioCallConfig({ digit_capture_active: true })), null);
    assert.equal(resolveCallAgentHandoffPolicy(liveTwilioCallConfig({
      script_policy: {
        ...liveTwilioCallConfig().script_policy,
        agent_config: { handoff_policy: { enabled: false } },
      },
    })), null);
  });

  it('classifies only a single DTMF 1 as confirmation and 2 as cancellation', () => {
    assert.equal(classifyCallAgentHandoffDtmf('1'), 'confirm');
    assert.equal(classifyCallAgentHandoffDtmf('2'), 'cancel');
    assert.equal(classifyCallAgentHandoffDtmf('11'), 'invalid');
    assert.equal(classifyCallAgentHandoffDtmf('yes'), 'invalid');
  });

  it('advertises live_transfer only for route_to_agent when its server policy is enabled', () => {
    const tool = {
      function: {
        name: 'route_to_agent',
        parameters: {
          type: 'object',
          properties: { action: { enum: ['review_case', 'secure_follow_up'] } },
        },
      },
    };
    assert.equal(exposeCallAgentHandoffAction(tool, false), tool);
    assert.deepEqual(
      exposeCallAgentHandoffAction(tool, true).function.parameters.properties.action.enum,
      ['review_case', 'secure_follow_up', 'live_transfer'],
    );
  });

  it('requests confirmation once and does not dial until DTMF 1 arrives', async () => {
    const db = createFakeDb();
    let providerUpdates = 0;
    const service = createCallAgentHandoffService({
      db,
      now: () => 1000,
      twilioClientFactory: () => ({
        calls: () => ({ update: async () => { providerUpdates += 1; } }),
      }),
    });

    const requested = await service.request('CA123', liveTwilioCallConfig());
    assert.equal(requested.status, 'awaiting_confirmation');
    assert.equal(requested.confirmation_prompt, HANDOFF_CONFIRMATION_PROMPT);
    assert.equal(providerUpdates, 0);
    assert.equal((await service.request('CA123', liveTwilioCallConfig())).code, 'handoff_already_requested');

    const confirmed = await service.handleDtmf('CA123', '1', liveTwilioCallConfig());
    assert.equal(confirmed.status, 'started_unconfirmed');
    assert.equal(providerUpdates, 1);
    assert.equal((await service.handleDtmf('CA123', '1', liveTwilioCallConfig())).status, 'started_unconfirmed');
    assert.equal(providerUpdates, 1);
  });

  it('cancels on DTMF 2 and consumes unrelated digits while confirmation is pending', async () => {
    const db = createFakeDb();
    let providerUpdates = 0;
    const service = createCallAgentHandoffService({
      db,
      now: () => 1000,
      twilioClientFactory: () => ({
        calls: () => ({ update: async () => { providerUpdates += 1; } }),
      }),
    });
    await service.request('CA123', liveTwilioCallConfig());
    assert.equal((await service.handleDtmf('CA123', '9', liveTwilioCallConfig())).status, 'awaiting_confirmation');
    assert.equal((await service.handleDtmf('CA123', '2', liveTwilioCallConfig())).status, 'cancelled');
    assert.equal(providerUpdates, 0);
  });

  it('records an ambiguous provider result and never retries the transfer', async () => {
    const db = createFakeDb();
    let providerUpdates = 0;
    const service = createCallAgentHandoffService({
      db,
      now: () => 1000,
      twilioClientFactory: () => ({
        calls: () => ({ update: async () => { providerUpdates += 1; throw new Error('network'); } }),
      }),
    });
    await service.request('CA123', liveTwilioCallConfig());
    assert.equal((await service.handleDtmf('CA123', '1', liveTwilioCallConfig())).status, 'outcome_unknown');
    assert.equal((await service.handleDtmf('CA123', '1', liveTwilioCallConfig())).status, 'outcome_unknown');
    assert.equal(providerUpdates, 1);
    assert.ok(db.states.some(({ state }) => state === 'handoff_outcome_unknown'));
  });

  it('reconciles a stale dispatch after restart without retrying it', async () => {
    const db = createFakeDb();
    let providerUpdates = 0;
    const service = createCallAgentHandoffService({
      db,
      now: () => 100_000,
      twilioClientFactory: () => ({
        calls: () => ({ update: async () => { providerUpdates += 1; } }),
      }),
    });
    await service.request('CA123', liveTwilioCallConfig());
    db.setSessionState('dispatching', 1_000);
    assert.equal((await service.handleDtmf('CA123', '1', liveTwilioCallConfig())).status, 'outcome_unknown');
    assert.equal(providerUpdates, 0);
    assert.ok(db.states.some(({ state }) => state === 'handoff_outcome_unknown'));
  });

  it('expires unconfirmed requests and builds a TwiML dial only for a validated fixed number', async () => {
    const db = createFakeDb();
    let currentTime = 1000;
    let providerUpdates = 0;
    const service = createCallAgentHandoffService({
      db,
      now: () => currentTime,
      twilioClientFactory: () => ({
        calls: () => ({ update: async () => { providerUpdates += 1; } }),
      }),
    });
    await service.request('CA123', liveTwilioCallConfig());
    currentTime = 32_000;
    assert.equal((await service.handleDtmf('CA123', '1', liveTwilioCallConfig())).status, 'expired');
    assert.equal(providerUpdates, 0);

    const twiml = buildTwilioCallHandoffTwiml('+15555550123');
    assert.match(twiml, /<Dial timeout="25">/);
    assert.match(twiml, /<Dial timeout="25">\+15555550123<\/Dial>/);
    assert.throws(() => buildTwilioCallHandoffTwiml('5550100'), /Invalid handoff destination/);
  });
});
