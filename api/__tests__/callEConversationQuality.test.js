'use strict';

const assert = require('node:assert/strict');
const { CallEReconciliationService, evaluateCallEConversationQuality } = require('../services/callEReconciliationService');

describe('CALL-E conversation quality signals', () => {
  it('reports bounded transcript shape, result completeness, and possible IVR prompts without returning content', () => {
    const resultSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['account_type', 'confirmed'],
      properties: {
        account_type: { type: 'string', enum: ['personal', 'business'] },
        confirmed: { type: 'boolean' },
      },
    };
    const quality = evaluateCallEConversationQuality({
      resultStatus: 'available',
      result: { account_type: 'business', confirmed: true },
      transcript: [
        { speaker: 'bot', text: 'For billing press 2. private prompt' },
        { speaker: 'user', text: 'I need help.' },
      ],
    }, resultSchema);

    assert.equal(quality.transcript.shape, 'two_sided');
    assert.equal(quality.transcript.turnCount, 2);
    assert.equal(quality.structuredResult.schemaValid, true);
    assert.equal(quality.structuredResult.requiredFieldCompletenessPercent, 100);
    assert.equal(quality.ivr.possibleMenuPromptDetected, true);
    assert.equal(JSON.stringify(quality).includes('private prompt'), false);
    assert.equal('transcriptText' in quality, false);
  });

  it('does not claim a schema result or IVR evidence before they are present', () => {
    const quality = evaluateCallEConversationQuality({ resultStatus: 'pending', transcript: [] }, {
      type: 'object', additionalProperties: false, required: [], properties: {},
    });

    assert.equal(quality.transcript.shape, 'no_transcript');
    assert.equal(quality.structuredResult.schemaValid, null);
    assert.equal(quality.structuredResult.requiredFieldCompletenessPercent, null);
    assert.equal(quality.ivr.possibleMenuPromptDetected, false);
    assert.equal(quality.ivr.dtmfEventObserved, null);
    assert.equal(quality.ivr.dtmfEventEvidenceAvailable, false);
    const partialEvents = evaluateCallEConversationQuality({ transcript: [], resultStatus: 'pending' }, {
      type: 'object', additionalProperties: false, required: [], properties: {},
    }, { available: false, observed: false });
    assert.equal(partialEvents.ivr.dtmfEventObserved, null);
  });

  it('records only DTMF event presence and does not expose event details or entered digits', async () => {
    const localCallId = 'call_e_123e4567-e89b-12d3-a456-426614174002';
    let savedState;
    const service = new CallEReconciliationService({
      db: {
        async getCallEReconciliationRecord() { return { business_id: 'business_1', provider_call_id: 'call_test_456', result_schema: { type: 'object', additionalProperties: false, required: [], properties: {} } }; },
        async getCallEBusinessOperator() { return { role: 'call_operator' }; },
      },
      client: {
        isConfigured: () => true,
        async getCall(id) { return { id, object: 'call', status: 'completed', call_outcome: 'completed', result_status: 'unavailable', result: null, transcript: [], error: null }; },
        async listCallEvents() { return { object: 'list', data: [{ id: 'evt_dtmf', call_id: 'call_test_456', type: 'call.dtmf', details: { digit: '9' } }], next_cursor: null }; },
      },
      loadState: async () => savedState || {},
      saveState: async (_id, state) => { savedState = state; },
    });
    const result = await service.getConversationQualityForOperator(localCallId, '12345');
    assert.equal(result.quality.ivr.dtmfEventObserved, true);
    assert.equal(result.quality.ivr.dtmfEventEvidenceAvailable, true);
    assert.equal(savedState.ivrDtmfObserved, true);
    assert.equal(JSON.stringify(result).includes('"digit"'), false);
    assert.equal(JSON.stringify(result).includes('"digit":"9"'), false);
  });

  it('requires current business operator membership and returns no transcript or result content', async () => {
    const localCallId = 'call_e_123e4567-e89b-12d3-a456-426614174000';
    const service = new CallEReconciliationService({
      db: {
        async getCallEReconciliationRecord(id) {
          return id === localCallId ? {
            business_id: 'business_1',
            provider_call_id: 'call_test_123',
            result_schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
          } : null;
        },
        async getCallEBusinessOperator(businessId, actorId) {
          return businessId === 'business_1' && actorId === '12345' ? { role: 'call_operator' } : null;
        },
      },
      client: {
        isConfigured: () => true,
        async getCall(id) {
          return {
            id, object: 'call', status: 'completed', call_outcome: 'completed', result_status: 'available',
            result: { ok: true }, transcript: [{ speaker: 'bot', text: 'private transcript content' }, { speaker: 'user', text: 'yes' }], error: null,
          };
        },
      },
    });

    const result = await service.getConversationQualityForOperator(localCallId, '12345');
    assert.equal(result.quality.transcript.shape, 'two_sided');
    assert.equal('transcript' in result, false);
    assert.equal('result' in result, false);
    assert.equal(JSON.stringify(result).includes('private transcript content'), false);
    await assert.rejects(service.getConversationQualityForOperator(localCallId, '99999'), (error) => error.code === 'call_e_call_not_found');
  });

  it('returns only a schema-validated structured result to a current business operator', async () => {
    const localCallId = 'call_e_123e4567-e89b-12d3-a456-426614174003';
    const service = new CallEReconciliationService({
      db: {
        async getCallEReconciliationRecord(id) { return id === localCallId ? { business_id: 'business_1', provider_call_id: 'call_test_789', result_schema: { type: 'object', additionalProperties: false, required: ['confirmed'], properties: { confirmed: { type: 'boolean' } } } } : null; },
        async getCallEBusinessOperator(businessId, actorId) { return businessId === 'business_1' && actorId === '12345' ? { role: 'call_operator' } : null; },
      },
      client: {
        isConfigured: () => true,
        async getCall(id) { return { id, object: 'call', status: 'completed', call_outcome: 'completed', result_status: 'available', result: { confirmed: true }, transcript: [{ speaker: 'user', text: 'private transcript' }], error: null }; },
      },
    });
    const result = await service.getStructuredResultForOperator(localCallId, '12345');
    assert.deepEqual(result.result, { confirmed: true });
    assert.equal(result.resultAvailable, true);
    assert.equal('transcript' in result, false);
    await assert.rejects(service.getStructuredResultForOperator(localCallId, '99999'), (error) => error.code === 'call_e_call_not_found');
  });
});
