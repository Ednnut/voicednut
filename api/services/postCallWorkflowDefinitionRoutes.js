function routeErrorStatus(error) {
  if (error?.code === "validation_error") return 400;
  if (error?.code === "not_found") return 404;
  if (error?.code === "conflict") return 409;
  if (error?.code === "service_unavailable") return 503;
  return 500;
}

function routeErrorMessage(error, fallback) {
  return ["validation_error", "not_found", "conflict", "service_unavailable"].includes(error?.code)
    ? error.message || fallback
    : fallback;
}

function registerPostCallWorkflowDefinitionRoutes(app, options = {}) {
  const requireAdminToken = options.requireAdminToken;
  const getService = options.getService;
  const sendApiError = options.sendApiError;
  if (!app || typeof requireAdminToken !== "function" || typeof getService !== "function" || typeof sendApiError !== "function") {
    throw new TypeError("Workflow definition routes require app, admin authorization, service resolver, and API error handler");
  }

  const getWorkflowService = (req, res) => {
    const service = getService();
    if (service) return service;
    sendApiError(res, 503, "post_call_workflow_unavailable", "Workflow definition service is not initialized", req.requestId);
    return null;
  };

  app.get("/post-call/workflows", requireAdminToken, async (req, res) => {
    try {
      const service = getWorkflowService(req, res);
      if (!service) return;
      const versions = await service.listVersions("", req.query?.limit);
      res.json({ success: true, request_id: req.requestId || null, versions });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "post_call_workflows_list_failed", routeErrorMessage(error, "Workflow definitions could not be listed"), req.requestId);
    }
  });

  app.get("/post-call/workflows/:workflow_id/versions", requireAdminToken, async (req, res) => {
    try {
      const service = getWorkflowService(req, res);
      if (!service) return;
      const versions = await service.listVersions(req.params.workflow_id, req.query?.limit);
      res.json({ success: true, request_id: req.requestId || null, workflow_id: req.params.workflow_id, versions });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "post_call_workflow_versions_failed", routeErrorMessage(error, "Workflow versions could not be listed"), req.requestId);
    }
  });

  app.post("/post-call/workflows", requireAdminToken, async (req, res) => {
    try {
      const service = getWorkflowService(req, res);
      if (!service) return;
      const version = await service.createDraft(req.body || {}, "admin_token");
      res.status(201).json({ success: true, request_id: req.requestId || null, version });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "post_call_workflow_save_failed", routeErrorMessage(error, "Workflow draft could not be saved"), req.requestId);
    }
  });

  app.post("/post-call/workflows/:workflow_id/versions/:version/approve", requireAdminToken, async (req, res) => {
    try {
      const service = getWorkflowService(req, res);
      if (!service) return;
      const version = await service.approveVersion(req.params.workflow_id, req.params.version, "admin_token");
      res.json({ success: true, request_id: req.requestId || null, version });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "post_call_workflow_approval_failed", routeErrorMessage(error, "Workflow version could not be approved"), req.requestId);
    }
  });
}

module.exports = { registerPostCallWorkflowDefinitionRoutes };
