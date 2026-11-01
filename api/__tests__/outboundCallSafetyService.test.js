const assert = require('node:assert/strict');
const { OutboundCallSafetyService } = require('../services/outboundCallSafetyService');

describe('OutboundCallSafetyService', () => {
  function createService(overrides = {}) {
    const calls = [];
    const db = {
      async getCallEBusinessOperator(businessId, actorId) {
        calls.push(['membership', businessId, actorId]);
        return { role: 'call_operator' };
      },
      async reserveOutboundContactDispatch(input) {
        calls.push(['reserve', input]);
        return { allowed: true, idempotent_replay: false };
      },
      ...overrides.db,
    };
    const service = new OutboundCallSafetyService({
      db,
      secret: 'test-secret-that-is-long-enough-for-hmac',
      contactPolicy: { async checkEligibility(input) { calls.push(['consent', input]); return { eligible: true }; } },
      safetyPolicy: { async assertDispatchAllowed(input) { calls.push(['safety', input]); return { policy: { configured: true } }; } },
    });
    return { service, calls };
  }

  const validRequest = {
    business_id: 'business_001', actor_id: '123456789', destination: '+14155550123',
    provider: 'twilio', idempotency_key: 'request:key:0001',
  };

  it('requires membership, safety policy, current consent and atomically reserves before dispatch', async () => {
    const { service, calls } = createService();
    const reservation = await service.reserveDispatch(validRequest);
    assert.equal(reservation.provider, 'twilio');
    assert.equal(reservation.idempotentReplay, false);
    assert.deepEqual(calls.map(([kind]) => kind), ['membership', 'safety', 'consent', 'reserve']);
    assert.match(calls.find(([kind]) => kind === 'reserve')[1].destination_hash, /^[a-f0-9]{64}$/);
    assert.equal(await service.completeDispatch(reservation, 'accepted'), false);
  });

  it('blocks unverified actors before checking consent or reserving', async () => {
    const { service, calls } = createService({ db: {
      async getCallEBusinessOperator() { return null; },
    } });
    await assert.rejects(service.reserveDispatch(validRequest), (error) => error.code === 'outbound_business_operator_required');
    assert.deepEqual(calls, []);
  });

  it('maps opt-out and cooldown blocks to safe API errors', async () => {
    const optedOut = createService();
    optedOut.service.contactPolicy = { async checkEligibility() { return { eligible: false, reason: 'opted_out' }; } };
    await assert.rejects(optedOut.service.reserveDispatch(validRequest), (error) => error.code === 'outbound_contact_opted_out' && error.status === 403);
    assert.equal(optedOut.calls.some(([kind]) => kind === 'reserve'), false);

    const cooldown = createService({ db: {
      async reserveOutboundContactDispatch() { return { allowed: false, reason: 'cooldown_active' }; },
    } });
    await assert.rejects(cooldown.service.reserveDispatch(validRequest), (error) => error.code === 'outbound_contact_cooldown_active' && error.status === 409);
  });
});
