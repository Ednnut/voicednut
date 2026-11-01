'use strict';

const crypto = require('node:crypto');
const { CallEContactPolicyService } = require('./callEContactPolicyService');
const { CallECampaignSafetyService } = require('./callECampaignSafetyService');
const { CallECampaignService } = require('./callECampaignService');

const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const ACTOR_ID_PATTERN = /^\d{1,20}$/;
const PROVIDERS = new Set(['twilio', 'plivo', 'vonage', 'vapi', 'call_e', 'cartesia']);

function outboundSafetyError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

function mapPolicyBlock(reason) {
  const failures = {
    opted_out: ['outbound_contact_opted_out', 'Contact has opted out of calls', 403],
    consent_expired: ['outbound_consent_expired', 'Recorded call consent has expired', 403],
    consent_not_effective: ['outbound_consent_not_effective', 'Recorded call consent is not yet effective', 403],
    consent_missing: ['outbound_consent_required', 'Current recorded call consent is required', 403],
    cooldown_active: ['outbound_contact_cooldown_active', 'Contact is inside the business call cooldown window', 409],
    scope_or_destination_invalid: ['outbound_contact_policy_invalid', 'Business and destination scope is invalid', 400],
  };
  const [code, message, status] = failures[reason] || [
    'outbound_contact_policy_unavailable', 'Outbound contact policy is unavailable; no call was placed', 503,
  ];
  return outboundSafetyError(code, message, status);
}

class OutboundCallSafetyService {
  constructor(options = {}) {
    this.db = options.db;
    this.secret = String(options.secret || '');
    this.contactPolicy = options.contactPolicy || new CallEContactPolicyService({ db: this.db, cooldownHashSecret: this.secret });
    const campaignService = options.campaignService || new CallECampaignService({ db: this.db });
    this.safetyPolicy = options.safetyPolicy || new CallECampaignSafetyService({ db: this.db, campaignService });
  }

  async resolveBusinessScope({ businessId, actorId }) {
    const business = String(businessId || '').trim();
    const actor = String(actorId || '').trim();
    if (!BUSINESS_ID_PATTERN.test(business)) throw outboundSafetyError('outbound_business_scope_required', 'A stored business scope is required before an outbound call', 403);
    if (!ACTOR_ID_PATTERN.test(actor) || typeof this.db?.getCallEBusinessOperator !== 'function') {
      throw outboundSafetyError('outbound_business_operator_required', 'A verified business call-operator identity is required', 403);
    }
    let membership;
    try { membership = await this.db.getCallEBusinessOperator(business, actor); }
    catch (_) { throw outboundSafetyError('outbound_business_operator_unavailable', 'Business operator authorization is unavailable', 503); }
    if (!['call_operator', 'policy_manager'].includes(String(membership?.role || ''))) {
      throw outboundSafetyError('outbound_business_operator_required', 'Caller is not assigned to this business', 403);
    }
    return { businessId: business, actorId: actor };
  }

  async authorizeActor(input = {}) {
    return this.resolveBusinessScope({
      businessId: input.business_id || input.businessId,
      actorId: input.actor_id || input.actorId,
    });
  }

  destinationHash(businessId, destination) {
    if (this.secret.length < 32) throw outboundSafetyError('outbound_contact_policy_unavailable', 'Outbound contact privacy key is not configured', 503);
    return crypto.createHmac('sha256', this.secret).update(`${businessId}:${destination}`).digest('hex');
  }

  async reserveDispatch(input = {}) {
    const businessId = String(input.business_id || input.businessId || '').trim();
    const actorId = String(input.actor_id || input.actorId || '').trim();
    const destination = String(input.destination || input.number || '').trim();
    const provider = String(input.provider || '').trim().toLowerCase();
    const key = String(input.idempotency_key || input.idempotencyKey || '').trim();
    if (!/^\+[1-9]\d{7,14}$/.test(destination) || !PROVIDERS.has(provider) || !/^[A-Za-z0-9._:-]{8,180}$/.test(key)) {
      throw outboundSafetyError('outbound_contact_policy_invalid', 'Outbound safety request is invalid', 400);
    }
    const scope = await this.resolveBusinessScope({ businessId, actorId });
    try { await this.safetyPolicy.assertDispatchAllowed({ businessId: scope.businessId }); }
    catch (error) {
      const code = String(error?.code || '');
      if (code.includes('quiet_hours')) throw outboundSafetyError('outbound_quiet_hours_active', 'Business quiet hours are active; no call was placed', 409);
      if (code.includes('emergency_stop')) throw outboundSafetyError('outbound_emergency_stop_active', 'Business outbound emergency stop is active', 409);
      throw outboundSafetyError('outbound_safety_policy_required', 'A valid outbound safety policy is required; no call was placed', Number(error?.status) || 503);
    }
    let eligibility;
    try { eligibility = await this.contactPolicy.checkEligibility({ businessId, destination }); }
    catch (_) { throw mapPolicyBlock('policy_storage_unavailable'); }
    if (eligibility?.eligible !== true) throw mapPolicyBlock(eligibility?.reason);

    const reservationKey = `${provider}:${crypto.createHash('sha256').update(key).digest('hex')}`;
    const destinationHash = this.destinationHash(businessId, destination);
    if (typeof this.db?.reserveOutboundContactDispatch !== 'function') {
      throw outboundSafetyError('outbound_contact_policy_unavailable', 'Outbound contact reservation storage is unavailable', 503);
    }
    let reservation;
    try {
      reservation = await this.db.reserveOutboundContactDispatch({
        reservation_key: reservationKey, business_id: businessId, destination_hash: destinationHash, provider,
      });
    } catch (_) { throw outboundSafetyError('outbound_contact_policy_unavailable', 'Outbound contact reservation storage is unavailable', 503); }
    if (!reservation?.allowed) throw mapPolicyBlock(reservation?.reason);
    return { reservationKey, businessId, destinationHash, provider, idempotentReplay: reservation.idempotent_replay === true };
  }

  async completeDispatch(reservation, status) {
    if (!reservation?.reservationKey || !['accepted', 'released'].includes(status)) return false;
    try {
      return await this.db.updateOutboundContactDispatch({ reservation_key: reservation.reservationKey, status });
    } catch (_) { return false; }
  }
}

module.exports = { OutboundCallSafetyService, outboundSafetyError, mapPolicyBlock };
