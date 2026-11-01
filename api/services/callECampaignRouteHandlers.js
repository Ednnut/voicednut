'use strict';

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createCallECampaignRouteHandlers(options = {}) {
  const createService = options.createService;
  const sendApiError = options.sendApiError;
  const parseBoundedInteger = options.parseBoundedInteger;
  if (typeof createService !== 'function' || typeof sendApiError !== 'function' || typeof parseBoundedInteger !== 'function') {
    throw new TypeError('CALL-E campaign route dependencies are required');
  }
  const requestId = (req) => req.requestId || null;
  const errorResponse = (req, res, status, code, message) => sendApiError(res, status, code, message, requestId(req));

  return Object.freeze({
    create: async (req, res) => {
      const body = isRecord(req.body) ? req.body : {};
      const idempotencyKey = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || body.idempotency_key || '').trim();
      try {
        const result = await createService().createDraft({ ...body, idempotency_key: idempotencyKey });
        return res.status(result.idempotentReplay ? 200 : 201).json({
          success: true,
          request_id: requestId(req),
          campaign: result.campaign,
          recipients: result.recipients,
          idempotent_replay: result.idempotentReplay === true,
          provider_requests: 0,
        });
      } catch (error) {
        const code = String(error?.code || 'call_e_campaign_create_failed');
        const status = Number(error?.status) || (code === 'call_e_business_operator_access_denied' ? 403
          : code === 'call_e_template_not_found' ? 404
            : ['call_e_campaign_review_cap_reached', 'call_e_template_not_live', 'call_e_campaign_idempotency_conflict'].includes(code) ? 409
              : code === 'call_e_campaign_unavailable' ? 503 : 400);
        return errorResponse(req, res, status, code,
          status >= 500 ? 'CALL-E campaign review could not be created' : error?.message || 'CALL-E campaign review could not be created');
      }
    },

    list: async (req, res) => {
      try {
        const result = await createService().list({
          business_id: req.query?.business_id,
          actor_id: req.query?.actor_id,
          limit: parseBoundedInteger(req.query?.limit, { defaultValue: 20, min: 1, max: 50 }),
          offset: parseBoundedInteger(req.query?.offset, { defaultValue: 0, min: 0, max: 10000 }),
        });
        return res.json({ success: true, request_id: requestId(req), ...result });
      } catch (error) {
        const code = String(error?.code || 'call_e_campaign_list_failed');
        const status = Number(error?.status) || (code === 'call_e_business_operator_access_denied' ? 403 : 503);
        return errorResponse(req, res, status, code, 'CALL-E campaign reviews could not be loaded');
      }
    },

    get: async (req, res) => {
      try {
        const result = await createService().get({
          campaign_id: req.params?.campaignId,
          business_id: req.query?.business_id,
          actor_id: req.query?.actor_id,
        });
        return res.json({ success: true, request_id: requestId(req), ...result });
      } catch (error) {
        const code = String(error?.code || 'call_e_campaign_read_failed');
        const status = Number(error?.status) || (code === 'call_e_business_operator_access_denied' ? 403
          : code === 'call_e_campaign_not_found' ? 404 : 400);
        return errorResponse(req, res, status, code,
          status >= 500 ? 'CALL-E campaign review is unavailable' : error?.message || 'CALL-E campaign review is unavailable');
      }
    },

    review: async (req, res) => {
      const body = isRecord(req.body) ? req.body : {};
      try {
        const result = await createService().review({
          campaign_id: req.params?.campaignId,
          business_id: body.business_id,
          actor_id: body.actor_id,
          decision: body.decision,
        });
        return res.json({ success: true, request_id: requestId(req), ...result });
      } catch (error) {
        const code = String(error?.code || 'call_e_campaign_review_failed');
        const status = Number(error?.status) || (code === 'call_e_business_operator_access_denied' ? 403
          : code === 'call_e_campaign_not_found' ? 404
            : ['call_e_campaign_review_final', 'call_e_campaign_four_eyes_required', 'call_e_campaign_blocked_recipients'].includes(code) ? 409 : 400);
        return errorResponse(req, res, status, code,
          status >= 500 ? 'CALL-E campaign decision could not be recorded' : error?.message || 'CALL-E campaign decision could not be recorded');
      }
    },
  });
}

module.exports = { createCallECampaignRouteHandlers };
