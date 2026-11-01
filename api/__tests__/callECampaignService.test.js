const assert = require('node:assert/strict');
const { CallECampaignService } = require('../services/callECampaignService');

const destinations = ['+14155550123', '+442071838750'];
const resultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmed'],
  properties: { confirmed: { type: 'boolean' } },
};
const template = {
  id: 17,
  version: 4,
  business_id: 'business_1',
  lifecycle_state: 'live',
  prompt: 'Confirm whether the appointment reminder was received.',
  first_message: 'Hello, I am calling with a brief appointment reminder.',
};

function createService(overrides = {}) {
  const stored = { campaign: { campaign_id: `campaign_${'a'.repeat(64)}`, status: 'draft', recipient_count: 2 }, recipients: [] };
  return new CallECampaignService({
    idempotencySecret: 'campaign-unit-test-secret-which-is-long-enough',
    getTemplate: async () => template,
    contactPolicy: { async checkEligibility() { return { eligible: true }; } },
    db: {
      async getCallEBusinessOperator(_businessId, actorId) { return { telegram_id: actorId, role: 'call_operator' }; },
      async createCallECampaignReviewDraft(input) {
        stored.input = input;
        stored.recipients = input.recipients.map((row) => ({
          position: row.position,
          destination_masked: row.phone_masked,
          status: row.status,
          reason_code: row.reason_code,
        }));
        return { ...stored, idempotentReplay: false };
      },
    },
    ...overrides,
  });
}

describe('CALL-E campaign draft service', () => {
  it('creates a consent-checked masked draft without provider dispatch', async () => {
    let dispatches = 0;
    const service = createService({ dispatchRecipient: async () => { dispatches += 1; } });
    const result = await service.createDraft({
      business_id: 'business_1', actor_id: '12345', template_id: 17,
      destinations, result_schema: resultSchema, authorized: true, idempotency_key: 'campaign-request-001',
    });
    assert.equal(result.campaign.status, 'draft');
    assert.equal(result.recipients.length, 2);
    assert.ok(result.recipients.every((row) => row.status === 'ready'));
    assert.equal(JSON.stringify(result).includes(destinations[0]), false);
    assert.equal(dispatches, 0);
  });

  it('requires an explicit authorization confirmation before checking or saving a draft', async () => {
    let checks = 0;
    const service = createService({ contactPolicy: { async checkEligibility() { checks += 1; return { eligible: true }; } } });
    await assert.rejects(service.createDraft({
      business_id: 'business_1', actor_id: '12345', template_id: 17,
      destinations, result_schema: resultSchema, authorized: false, idempotency_key: 'campaign-request-002',
    }), (error) => error.code === 'call_e_campaign_invalid');
    assert.equal(checks, 0);
  });

  it('returns only bounded reviewer history for the business-scoped campaign detail', async () => {
    const service = createService({
      db: {
        async getCallEBusinessOperator() { return { role: 'policy_manager' }; },
        async getCallECampaignReviewForBusiness() {
          return {
            campaign: { campaign_id: `campaign_${'a'.repeat(64)}`, business_id: 'business_1', status: 'approved', recipient_count: 1, ready_count: 1 },
            recipients: [],
            reviewHistory: [
              { reviewed_by: '12345', decision: 'approve', request_hash: 'a'.repeat(64), created_at: '2026-10-31T12:00:00Z' },
              { reviewed_by: 'not-an-actor', decision: 'unknown', request_hash: 'bad', created_at: '2026-10-31T12:01:00Z' },
            ],
          };
        },
      },
    });
    const result = await service.get({ business_id: 'business_1', actor_id: '12345', campaign_id: `campaign_${'a'.repeat(64)}` });
    assert.deepEqual(result.review_history, [
      { reviewed_by: '12345', decision: 'approve', request_hash: 'a'.repeat(64), created_at: '2026-10-31T12:00:00Z' },
      { reviewed_by: null, decision: null, request_hash: null, created_at: '2026-10-31T12:01:00Z' },
    ]);
  });
});
