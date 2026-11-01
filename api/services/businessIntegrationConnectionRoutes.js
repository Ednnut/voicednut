function routeErrorStatus(error) {
  if (error?.code === "validation_error") return 400;
  if (error?.code === "business_integration_secret_reference_invalid") return 400;
  if (error?.code === "not_found") return 404;
  if (error?.code === "conflict") return 409;
  if (error?.code === "service_unavailable" || error?.code === "business_integration_secret_unavailable") return 503;
  return 500;
}

function routeErrorMessage(error, fallback) {
  const safeCodes = new Set([
    "validation_error", "not_found", "conflict", "service_unavailable",
    "business_integration_secret_reference_invalid", "business_integration_secret_unavailable",
  ]);
  return safeCodes.has(error?.code) ? error.message || fallback : fallback;
}

function registerBusinessIntegrationConnectionRoutes(app, options = {}) {
  const getService = options.getService;
  const requireAdminToken = options.requireAdminToken;
  const sendApiError = options.sendApiError;
  if (!app || typeof getService !== "function" || typeof requireAdminToken !== "function" || typeof sendApiError !== "function") {
    throw new TypeError("Business integration routes require app, service resolver, admin authorization, and API error handler");
  }

  const serviceForRequest = (req, res) => {
    const service = getService();
    if (service) return service;
    sendApiError(res, 503, "business_integration_unavailable", "Business integration service is not initialized", req.requestId);
    return null;
  };

  app.get("/post-call/businesses/:business_id/integrations/connections", requireAdminToken, async (req, res) => {
    try {
      const service = serviceForRequest(req, res);
      if (!service) return;
      const connections = await service.list(req.params.business_id, { status: req.query?.status });
      res.json({ success: true, request_id: req.requestId || null, connections });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "business_integration_list_failed", routeErrorMessage(error, "Business integrations could not be listed"), req.requestId);
    }
  });

  app.post("/post-call/businesses/:business_id/integrations/connections", requireAdminToken, async (req, res) => {
    try {
      const service = serviceForRequest(req, res);
      if (!service) return;
      const result = await service.create(req.params.business_id, req.body || {}, "admin_token");
      res.status(result.created ? 201 : 200).json({
        success: true,
        request_id: req.requestId || null,
        connection: result.connection,
      });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "business_integration_create_failed", routeErrorMessage(error, "Business integration connection could not be created"), req.requestId);
    }
  });

  app.post("/post-call/businesses/:business_id/integrations/connections/:connection_id/revoke", requireAdminToken, async (req, res) => {
    try {
      const service = serviceForRequest(req, res);
      if (!service) return;
      if (Object.keys(req.body || {}).length > 0) {
        const error = new Error("Revoke request does not accept a body");
        error.code = "validation_error";
        throw error;
      }
      const connection = await service.revoke(req.params.business_id, req.params.connection_id, "admin_token");
      res.json({ success: true, request_id: req.requestId || null, connection });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "business_integration_revoke_failed", routeErrorMessage(error, "Business integration connection could not be revoked"), req.requestId);
    }
  });
}

module.exports = { registerBusinessIntegrationConnectionRoutes };
