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
  const requireMiniAppSession = options.requireMiniAppSession;
  const db = options.db;
  const getService = options.getService;
  const getExecutionService = options.getExecutionService || (() => null);
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

  const getWorkflowExecutionService = (req, res) => {
    const service = getExecutionService();
    if (service) return service;
    sendApiError(res, 503, "post_call_workflow_execution_unavailable", "Workflow execution service is not initialized", req.requestId);
    return null;
  };

  app.get("/post-call/workflows/runs", requireAdminToken, async (req, res) => {
    try {
      const service = getWorkflowExecutionService(req, res);
      if (!service) return;
      const runs = await service.listRuns({
        workflow_id: String(req.query?.workflow_id || "").trim() || undefined,
        status: String(req.query?.status || "").trim() || undefined,
        trigger_reference: String(req.query?.trigger_reference || "").trim() || undefined,
        limit: req.query?.limit,
      });
      res.json({ success: true, request_id: req.requestId || null, runs });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "post_call_workflow_runs_failed", routeErrorMessage(error, "Workflow runs could not be listed"), req.requestId);
    }
  });

  app.get("/post-call/workflows/runs/:run_id", requireAdminToken, async (req, res) => {
    try {
      const service = getWorkflowExecutionService(req, res);
      if (!service) return;
      const run = await service.getRun(req.params.run_id);
      if (!run) return sendApiError(res, 404, "not_found", "Workflow run was not found", req.requestId);
      res.json({ success: true, request_id: req.requestId || null, run });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "post_call_workflow_run_failed", routeErrorMessage(error, "Workflow run could not be loaded"), req.requestId);
    }
  });

  app.post("/post-call/workflows/runs/:run_id/approve", requireAdminToken, async (req, res) => {
    try {
      const service = getWorkflowExecutionService(req, res);
      if (!service) return;
      const run = await service.approveRun(req.params.run_id, "admin_token");
      res.json({ success: true, request_id: req.requestId || null, run });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "post_call_workflow_run_approval_failed", routeErrorMessage(error, "Workflow run could not be approved"), req.requestId);
    }
  });

  app.post("/post-call/workflows/runs/:run_id/cancel", requireAdminToken, async (req, res) => {
    try {
      const service = getWorkflowExecutionService(req, res);
      if (!service) return;
      const run = await service.cancelRun(req.params.run_id, "admin_token");
      res.json({ success: true, request_id: req.requestId || null, run });
    } catch (error) {
      sendApiError(res, routeErrorStatus(error), error.code || "post_call_workflow_run_cancel_failed", routeErrorMessage(error, "Workflow run could not be canceled"), req.requestId);
    }
  });

  app.get("/post-call/workflows", requireAdminToken, async (req, res) => {
    try {
      const service = getWorkflowService(req, res);
      if (!service) return;
      const versions = await service.listVersions(req.query?.workflow_id || "", req.query?.limit);
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

  if (typeof requireMiniAppSession === "function") {
    const tenantPath = "/miniapp/businesses/:business_id/post-call";
    const authorizeBusiness = async (req, res, allowedRoles) => {
      const businessId = String(req.params?.business_id || "").trim();
      const telegramId = String(req.miniAppSession?.telegram_id || "").trim();
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(telegramId)) {
        sendApiError(res, 400, "post_call_workflow_scope_invalid", "Business workflow scope is invalid", req.requestId);
        return null;
      }
      if (typeof db?.getCallEBusinessOperator !== "function") {
        sendApiError(res, 503, "post_call_workflow_scope_unavailable", "Business membership is unavailable", req.requestId);
        return null;
      }
      const membership = await db.getCallEBusinessOperator(businessId, telegramId);
      if (!allowedRoles.includes(membership?.role)) {
        sendApiError(res, 403, "post_call_workflow_access_denied", "Business workflow access is denied", req.requestId);
        return null;
      }
      return { businessId, actor: telegramId };
    };
    const tenantRoute = (roles, fallback, operation) => async (req, res) => {
      try {
        const scope = await authorizeBusiness(req, res, roles);
        if (!scope) return;
        const service = getWorkflowExecutionService(req, res);
        if (!service) return;
        const definitions = getWorkflowService();
        if (!definitions) {
          sendApiError(res, 503, "post_call_workflow_unavailable", "Workflow definition service is not initialized", req.requestId);
          return;
        }
        const result = await operation({ req, scope, service, definitions });
        res.status(result.status || 200).json({ success: true, request_id: req.requestId || null, ...result.body });
      } catch (error) {
        sendApiError(res, routeErrorStatus(error), error.code || "post_call_workflow_failed", routeErrorMessage(error, fallback), req.requestId);
      }
    };
    const businessReaders = ["policy_manager", "call_operator"];
    app.get(`${tenantPath}/workflows`, requireMiniAppSession, tenantRoute(businessReaders, "Business workflows could not be listed", async ({ req, scope, definitions }) => ({
      body: {
        business_id: scope.businessId,
        versions: await definitions.listVersions(req.query?.workflow_id, req.query?.limit, scope.businessId),
      },
    })));
    app.post(`${tenantPath}/workflows`, requireMiniAppSession, tenantRoute(["policy_manager"], "Business workflow draft could not be saved", async ({ req, scope, definitions }) => ({
      status: 201,
      body: { version: await definitions.createDraft(req.body || {}, scope.actor, scope.businessId) },
    })));
    app.post(`${tenantPath}/workflows/:workflow_id/versions/:version/approve`, requireMiniAppSession, tenantRoute(["policy_manager"], "Business workflow approval could not be recorded", async ({ req, scope, definitions }) => ({
      body: { version: await definitions.approveVersion(req.params.workflow_id, req.params.version, scope.actor, scope.businessId) },
    })));
    app.get(`${tenantPath}/workflow-runs`, requireMiniAppSession, tenantRoute(businessReaders, "Business workflow runs could not be listed", async ({ req, scope, service }) => ({
      body: { business_id: scope.businessId, runs: await service.listRuns({ business_id: scope.businessId, limit: req.query?.limit }) },
    })));
    app.get(`${tenantPath}/workflow-runs/:run_id`, requireMiniAppSession, tenantRoute(businessReaders, "Business workflow run could not be retrieved", async ({ req, scope, service }) => ({
      body: { run: await service.getRun(req.params.run_id, scope.businessId) },
    })));
  }
}

module.exports = { registerPostCallWorkflowDefinitionRoutes };
