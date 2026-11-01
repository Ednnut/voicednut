const assert = require('node:assert/strict');
const { CallEReconciliationService, createCallEOperatorReconciliationHandler } = require('../services/callEReconciliationService');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('CALL-E operator reconciliation handler', () => {
  it('enforces operator service scope and returns only bounded state metadata', async () => {
    let received;
    const handler = createCallEOperatorReconciliationHandler({ service: {
      async reconcileLocalCallForOperator(localCallId, actorId) {
        received = { localCallId, actorId };
        return {
          localCallId, executionStatus: 'completed', callOutcome: 'completed', resultStatus: 'available',
          resultAvailable: true, errorCode: null, events: [{ id: 'event-1', type: 'call.dtmf' }],
          eventPagesRead: 2, eventsHaveMore: true, updatedAt: '2026-10-31T12:00:00.000Z',
          transcript: [{ text: 'private transcript' }], phone: '+14155550123',
        };
      },
    } });
    const res = responseRecorder();
    await handler({
      params: { localCallId: 'call_e_123e4567-e89b-12d3-a456-426614174001' },
      body: { actor_id: '12345' },
      requestId: 'request-1',
    }, res);

    assert.deepEqual(received, { localCallId: 'call_e_123e4567-e89b-12d3-a456-426614174001', actorId: '12345' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.result, {
      localCallId: received.localCallId,
      provider: 'call_e',
      executionStatus: 'completed',
      callOutcome: 'completed',
      resultStatus: 'available',
      resultAvailable: true,
      errorCode: null,
      eventCount: 1,
      eventPagesRead: 2,
      eventsHaveMore: true,
      updatedAt: '2026-10-31T12:00:00.000Z',
    });
    assert.equal(JSON.stringify(res.body).includes('private transcript'), false);
    assert.equal(JSON.stringify(res.body).includes('+14155550123'), false);
  });

  it('does not expose whether an out-of-scope call exists', async () => {
    const handler = createCallEOperatorReconciliationHandler({ service: {
      async reconcileLocalCallForOperator() { throw Object.assign(new Error('not found'), { code: 'call_e_call_not_found' }); },
    } });
    const res = responseRecorder();
    await handler({ params: { localCallId: 'call_e_123e4567-e89b-12d3-a456-426614174001' }, body: { actor_id: '99999' } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.error, 'CALL-E call was not found in the current operator scope');
  });
});

describe('CALL-E operator reconciliation authorization', () => {
  it('rejects a non-member before provider reads or snapshot writes', async () => {
    let providerReads = 0;
    let snapshotWrites = 0;
    const service = new CallEReconciliationService({
      db: {
        async getCallEReconciliationRecord() {
          return { business_id: 'business_1', provider_call_id: 'call_provider_123' };
        },
        async getCallEBusinessOperator() { return null; },
        async updateCallEReconciliationSnapshot() { snapshotWrites += 1; },
      },
      client: {
        isConfigured: () => true,
        async getCall() { providerReads += 1; throw new Error('must not read provider for a non-member'); },
        async listCallEvents() { providerReads += 1; throw new Error('must not read provider for a non-member'); },
      },
      loadState: async () => ({}),
      saveState: async () => {},
    });

    await assert.rejects(
      service.reconcileLocalCallForOperator('call_e_123e4567-e89b-12d3-a456-426614174001', '99999'),
      (error) => error.code === 'call_e_call_not_found',
    );
    assert.equal(providerReads, 0);
    assert.equal(snapshotWrites, 0);
  });
});
