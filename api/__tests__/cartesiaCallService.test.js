const assert = require('node:assert/strict');
const { CartesiaCallService, normalizeOutboundCallInput } = require('../services/cartesiaCallService');

const outboundInput = {
  businessId: 'business_test',
  toNumber: '+15555550123',
  fromNumberId: 'phone_test_01',
  agentId: 'agent_test_01',
  dynamicVariables: { customer_name: 'Test Customer' },
};

function makeHarness(overrides = {}) {
  let record = null;
  let callRecord = null;
  let createCalls = 0;
  const client = {
    isConfigured: () => true,
    createOutboundCall: async (payload) => {
      createCalls += 1;
      return { calls: [{ number: payload.outbound_calls[0].to_number, agent_call_id: 'ac_test_01', error: null }] };
    },
    getCall: async (callId) => ({ id: callId, agent_id: 'agent_test_01', status: 'started', transcript: [] }),
    cancelCall: async () => ({ cancelled: true }),
  };
  const db = {
    async getOutboundCallIdempotency() { return record; },
    async reserveOutboundCallIdempotency(payload) {
      if (record) return { reserved: false };
      record = { ...payload, status: 'pending' };
      return { reserved: true };
    },
    async completeOutboundCallIdempotency(payload) {
      record = { ...record, ...payload };
      return 1;
    },
    async upsertCartesiaCallRecord(payload) {
      callRecord = { ...callRecord, ...payload };
      return { saved: true };
    },
  };
  const service = new CartesiaCallService({
    client,
    db,
    enabled: true,
    dispatchEnabled: true,
    allowedDestinations: ['+15555550123'],
    contactPolicy: { async checkEligibility() { return { eligible: true }; } },
    ...overrides,
  });
  return {
    service,
    client,
    db,
    getRecord: () => record,
    getCallRecord: () => callRecord,
    getCreateCalls: () => createCalls,
  };
}

describe('Cartesia Managed Agents call service', () => {
  it('normalizes a single E.164 recipient and rejects credential-like agent variables', () => {
    const prepared = normalizeOutboundCallInput(outboundInput);
    assert.equal(prepared.request.outbound_calls.length, 1);
    assert.equal(prepared.request.outbound_calls[0].to_number, '+15555550123');
    assert.throws(
      () => normalizeOutboundCallInput({ ...outboundInput, dynamicVariables: { api_key: 'secret' } }),
      { code: 'cartesia_dynamic_variables_invalid' },
    );
  });

  it('requires an allowlisted destination and current consent before preparing a call', async () => {
    const blockedByAllowlist = makeHarness({ allowedDestinations: [] });
    await assert.rejects(blockedByAllowlist.service.prepareOutboundCall(outboundInput), {
      code: 'cartesia_destination_not_allowlisted',
    });

    const blockedByConsent = makeHarness({
      contactPolicy: { async checkEligibility() { return { eligible: false, reason: 'opted_out' }; } },
    });
    await assert.rejects(blockedByConsent.service.prepareOutboundCall(outboundInput), {
      code: 'cartesia_contact_opted_out',
    });
  });

  it('requires dispatch enablement and an exact approved preview before provider submission', async () => {
    const disabled = makeHarness({ dispatchEnabled: false });
    const preview = await disabled.service.prepareOutboundCall(outboundInput);
    await assert.rejects(disabled.service.createOutboundCall({
      ...outboundInput,
      approved: true,
      confirmedFingerprint: preview.requestFingerprint,
      idempotencyKey: 'cartesia-test-key',
    }), { code: 'cartesia_dispatch_disabled' });
    assert.equal(disabled.getCreateCalls(), 0);

    const harness = makeHarness();
    await assert.rejects(harness.service.createOutboundCall({
      ...outboundInput,
      approved: true,
      confirmedFingerprint: 'f'.repeat(64),
      idempotencyKey: 'cartesia-test-key',
    }), { code: 'cartesia_confirmation_mismatch' });
    assert.equal(harness.getCreateCalls(), 0);
  });

  it('submits one approved call and returns an idempotent result on replay', async () => {
    const harness = makeHarness();
    const preview = await harness.service.prepareOutboundCall(outboundInput);
    const input = {
      ...outboundInput,
      approved: true,
      confirmedFingerprint: preview.requestFingerprint,
      idempotencyKey: 'cartesia-test-key',
    };

    const first = await harness.service.createOutboundCall(input);
    const replay = await harness.service.createOutboundCall(input);

    assert.equal(first.providerCallId, 'ac_test_01');
    assert.equal(first.status, 'created');
    assert.equal(first.idempotentReplay, false);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(harness.getCreateCalls(), 1);
    assert.equal(harness.getRecord().provider, 'cartesia');
    assert.equal(harness.getCallRecord().business_id, 'business_test');
  });

  it('does not retry an ambiguous provider submission on the same idempotency key', async () => {
    const harness = makeHarness();
    harness.client.createOutboundCall = async () => {
      harness.client.calls = (harness.client.calls || 0) + 1;
      throw new Error('network disconnected');
    };
    const preview = await harness.service.prepareOutboundCall(outboundInput);
    const input = {
      ...outboundInput,
      approved: true,
      confirmedFingerprint: preview.requestFingerprint,
      idempotencyKey: 'cartesia-unknown-key',
    };

    await assert.rejects(harness.service.createOutboundCall(input), { code: 'cartesia_outcome_unknown' });
    await assert.rejects(harness.service.createOutboundCall(input), { code: 'cartesia_outcome_unknown' });
    assert.equal(harness.client.calls, 1);
    assert.equal(harness.getRecord().status, 'pending');
  });

  it('normalizes provider call details without inventing states and requires approval to cancel an active call', async () => {
    const harness = makeHarness();
    harness.client.getCall = async (callId) => ({
      id: callId,
      agent_id: 'agent_test_01',
      status: 'started',
      telephony_params: { from: '+15555550001', to: '+15555550123', direction: 'outbound' },
      transcript: [{ role: 'assistant', text: 'Hello', start_timestamp: 0, end_timestamp: 1 }],
      summary: 'Test summary',
    });
    const call = await harness.service.getCall('ac_test_01');
    assert.equal(call.direction, 'outbound');
    assert.equal(call.summary, 'Test summary');
    assert.equal(call.transcript[0].role, 'assistant');
    await assert.rejects(harness.service.cancelCall('ac_test_01', false), {
      code: 'cartesia_cancel_confirmation_required',
    });
    assert.deepEqual(await harness.service.cancelCall('ac_test_01', true), {
      providerCallId: 'ac_test_01',
      cancelled: true,
    });
  });

  it('marks retryable or unconfirmed cancellation responses as ambiguous', async () => {
    const harness = makeHarness();
    const transient = Object.assign(new Error('network failure'), { retryable: true, code: 'cartesia_network_error' });
    harness.client.cancelCall = async () => { throw transient; };
    await assert.rejects(harness.service.cancelCall('ac_test_01', true), {
      code: 'cartesia_cancel_outcome_unknown',
    });
    harness.client.cancelCall = async () => ({ cancelled: false });
    await assert.rejects(harness.service.cancelCall('ac_test_01', true), {
      code: 'cartesia_cancel_outcome_unknown',
    });
  });
});
