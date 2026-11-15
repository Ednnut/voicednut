function routeErrorStatus(error) {
  if (error?.code === "validation_error") return 400;
  if (error?.code === "not_found") return 404;
  if (error?.code === "conflict") return 409;
  if (error?.code === "service_unavailable") return 503;
  return 500;
}

function registerOutgoingWebhookRoutes(app, options = {}) {
  const { db, getService, requireMiniAppSession, sendApiError } = options;
  if (!app || typeof getService !== "function" || typeof requireMiniAppSession !== "function" || typeof sendApiError !== "function") {
    throw new TypeError("Outgoing webhook routes require app, session authorization, service resolver, and API error handler");
  }
  const path = "/miniapp/businesses/:business_id/webhooks";
  const route = (roles, operation) => async (req, res) => {
    try {
      const businessId = String(req.params?.business_id || "").trim();
      const actor = String(req.miniAppSession?.telegram_id || "").trim();
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actor)) {
        return sendApiError(res, 400, "outgoing_webhook_scope_invalid", "Business webhook scope is invalid", req.requestId);
      }
      if (typeof db?.getCallEBusinessOperator !== "function") {
        return sendApiError(res, 503, "outgoing_webhook_scope_unavailable", "Business membership is unavailable", req.requestId);
      }
      const membership = await db.getCallEBusinessOperator(businessId, actor);
      if (!roles.includes(membership?.role)) {
        return sendApiError(res, 403, "outgoing_webhook_access_denied", "Business webhook access is denied", req.requestId);
      }
      const service = getService();
      if (!service) return sendApiError(res, 503, "outgoing_webhook_unavailable", "Outgoing webhook service is unavailable", req.requestId);
      const result = await operation({ req, service, businessId, actor });
      res.status(result.status || 200).json({ success: true, request_id: req.requestId || null, business_id: businessId, ...result.body });
    } catch (error) {
      const status = routeErrorStatus(error);
      const message = status < 500 ? error.message : "Outgoing webhook operation failed";
      sendApiError(res, status, error.code || "outgoing_webhook_failed", message, req.requestId);
    }
  };

  app.get(path, requireMiniAppSession, route(["policy_manager", "call_operator"], async ({ service, businessId }) => ({
    body: { subscriptions: await service.listSubscriptions(businessId) },
  })));
  app.post(path, requireMiniAppSession, route(["policy_manager"], async ({ req, service, businessId, actor }) => ({
    status: 201, body: { subscription: await service.createSubscription(req.body || {}, businessId, actor) },
  })));
  app.put(`${path}/:subscription_id`, requireMiniAppSession, route(["policy_manager"], async ({ req, service, businessId, actor }) => ({
    body: { subscription: await service.updateSubscription(req.params.subscription_id, businessId, req.body || {}, actor) },
  })));
  app.get(`${path}/:subscription_id/revisions`, requireMiniAppSession, route(["policy_manager"], async ({ req, service, businessId }) => ({
    body: { revisions: await service.listRevisions(req.params.subscription_id, businessId, req.query?.limit) },
  })));
  app.get(`${path}/:subscription_id/deliveries`, requireMiniAppSession, route(["policy_manager", "call_operator"], async ({ req, service, businessId }) => ({
    body: { deliveries: await service.listDeliveries(req.params.subscription_id, businessId, req.query?.limit) },
  })));
  app.post(`${path}/:subscription_id/deliveries/:delivery_id/replay`, requireMiniAppSession, route(["policy_manager"], async ({ req, service, businessId }) => {
    const body = req.body || {};
    if (Object.keys(body).length !== 1 || body.confirm !== true) {
      const error = new Error("Replay requires { confirm: true }");
      error.code = "validation_error";
      throw error;
    }
    return { status: 202, body: { delivery: await service.replay(req.params.delivery_id, req.params.subscription_id, businessId) } };
  }));
}

module.exports = { registerOutgoingWebhookRoutes };
