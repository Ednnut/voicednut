'use strict';

const assert = require('node:assert/strict');
const { CallECampaignRetentionService, CONFIRMATION } = require('../services/callECampaignRetentionService');

describe('CALL-E sensitive-data retention', () => {
  it('previews scoped expiry and requires a separate policy manager plus exact confirmation to purge', async () => {
    const calls = [];
    const service = new CallECampaignRetentionService({
      retentionDays: 30,
      now: () => new Date('2026-10-31T00:00:00.000Z'),
      db: {
        async getCallESensitiveRetentionPreview(businessId, cutoff) { calls.push({ action: 'preview', businessId, cutoff }); return { expired_goal_runs: 2, expired_missions: 1, cutoff }; },
        async purgeCallESensitiveData(input) { calls.push({ action: 'purge', input }); return { expired_goal_runs: 2, expired_missions: 1, cutoff: input.cutoff }; },
      },
      campaignService: { async assertMembership(_businessId, actorId, roles) {
        const role = actorId === '54321' ? 'policy_manager' : 'call_operator';
        if (roles && !roles.has(role)) throw Object.assign(new Error('role denied'), { status: 403, code: 'call_e_business_operator_access_denied' });
        return { role };
      } },
    });
    const preview = await service.preview({ business_id: 'biz-a', actor_id: '12345' });
    assert.equal(preview.retention.retention_days, 30);
    assert.equal(preview.retention.expired_goal_runs, 2);
    assert.equal(preview.retention.confirmation_phrase, CONFIRMATION);
    await assert.rejects(service.purge({ business_id: 'biz-a', actor_id: '12345', confirmation: CONFIRMATION }), (error) => error.code === 'call_e_business_operator_access_denied');
    await assert.rejects(service.purge({ business_id: 'biz-a', actor_id: '54321', confirmation: 'purge' }), (error) => error.code === 'call_e_retention_confirmation_required');
    const purged = await service.purge({ business_id: 'biz-a', actor_id: '54321', confirmation: CONFIRMATION });
    assert.equal(purged.retention.purged, true);
    assert.equal(calls.filter((entry) => entry.action === 'purge').length, 1);
  });
});
