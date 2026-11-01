const assert = require('node:assert/strict');
const { createCallECampaignRouteHandlers } = require('../services/callECampaignRouteHandlers');

function recorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createHandlers(service, errors = []) {
  return createCallECampaignRouteHandlers({
    createService: () => service,
    parseBoundedInteger(value, bounds) {
      const number = Number(value);
      return Number.isInteger(number) ? Math.min(bounds.max, Math.max(bounds.min, number)) : bounds.defaultValue;
    },
    sendApiError(res, status, code, message, requestId) {
      errors.push({ status, code, message, requestId });
      return res.status(status).json({ success: false, code, error: message, request_id: requestId });
    },
  });
}

describe('CALL-E campaign HTTP route handlers', () => {
  it('uses the header idempotency key and returns safe no-dispatch draft envelopes', async () => {
    const requests = [];
    let replay = false;
    const handlers = createHandlers({ async createDraft(input) {
      requests.push(input);
      return { campaign: { campaign_id: 'campaign_test', status: 'draft' }, recipients: [], idempotentReplay: replay };
    } });
    const res = recorder();
    const req = {
      body: { business_id: 'biz-1', actor_id: '12345', idempotency_key: 'body-key-0001', authorized: true },
      get: (header) => header === 'Idempotency-Key' ? 'header-key-0001' : undefined,
      requestId: 'request-1',
    };

    await handlers.create(req, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.provider_requests, 0);
    assert.equal(requests[0].idempotency_key, 'header-key-0001');
    assert.equal(requests[0].actor_id, '12345');
    replay = true;
    const replayResponse = recorder();
    await handlers.create(req, replayResponse);
    assert.equal(requests[1].idempotency_key, 'header-key-0001');
    assert.equal(replayResponse.statusCode, 200);
    assert.equal(replayResponse.body.idempotent_replay, true);
  });

  it('bounds list pagination and forwards authenticated business scope to the service', async () => {
    let input;
    const handlers = createHandlers({ async list(value) { input = value; return { campaigns: [] }; } });
    const res = recorder();
    await handlers.list({ query: { business_id: 'biz-1', actor_id: '12345', limit: '500', offset: '-4' } }, res);
    assert.deepEqual(input, { business_id: 'biz-1', actor_id: '12345', limit: 50, offset: 0 });
    assert.deepEqual(res.body.campaigns, []);
  });

  it('preserves business-scope and four-eyes errors in the standard API envelope', async () => {
    const errors = [];
    const handlers = createHandlers({
      async get() { throw Object.assign(new Error('not found'), { code: 'call_e_campaign_not_found' }); },
      async review(input) {
        assert.equal(input.actor_id, '12345');
        throw Object.assign(new Error('different policy manager required'), { code: 'call_e_campaign_four_eyes_required' });
      },
    }, errors);
    const getResponse = recorder();
    await handlers.get({ params: { campaignId: 'campaign_missing' }, query: { business_id: 'biz-1', actor_id: '12345' }, requestId: 'get-1' }, getResponse);
    assert.equal(getResponse.statusCode, 404);
    const reviewResponse = recorder();
    await handlers.review({ params: { campaignId: 'campaign_test' }, body: { business_id: 'biz-1', actor_id: '12345', decision: 'approve' } }, reviewResponse);
    assert.equal(reviewResponse.statusCode, 409);
    assert.equal(errors[1].code, 'call_e_campaign_four_eyes_required');
  });
});
