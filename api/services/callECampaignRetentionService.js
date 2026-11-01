'use strict';

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const CONFIRMATION = 'PURGE EXPIRED SENSITIVE DATA';

function retentionError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

class CallECampaignRetentionService {
  constructor(options = {}) {
    this.db = options.db;
    this.campaignService = options.campaignService;
    this.retentionDays = Math.max(1, Math.min(3650, Math.floor(Number(options.retentionDays) || 90)));
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
  }

  async assertMembership(businessId, actorId, managerOnly = false) {
    if (!BUSINESS_ID_PATTERN.test(businessId) || !ACTOR_ID_PATTERN.test(actorId) || typeof this.campaignService?.assertMembership !== 'function') {
      throw retentionError('call_e_business_operator_access_denied', 'CALL-E business operator access is required', 403);
    }
    return this.campaignService.assertMembership(businessId, actorId, managerOnly ? new Set(['policy_manager']) : undefined);
  }

  async preview(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId);
    const now = this.now();
    const result = await this.db.getCallESensitiveRetentionPreview(businessId, now.toISOString());
    return { retention: { retention_days: this.retentionDays, ...result, requires_policy_manager: true,
      confirmation_phrase: CONFIRMATION } };
  }

  async purge(input = {}) {
    const businessId = String(input.business_id || '').trim();
    const actorId = String(input.actor_id || '').trim();
    await this.assertMembership(businessId, actorId, true);
    if (input.confirmation !== CONFIRMATION) throw retentionError('call_e_retention_confirmation_required', 'Exact purge confirmation is required', 400);
    const now = this.now();
    const result = await this.db.purgeCallESensitiveData({ business_id: businessId, actor_id: actorId, cutoff: now.toISOString() });
    return { retention: { ...result, retention_days: this.retentionDays, purged: true } };
  }
}

module.exports = { CallECampaignRetentionService, CONFIRMATION };
