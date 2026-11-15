const { matchesSchema, validateSchema } = require("./postCallExtractionService");

function sendError(res, sendApiError, req, status, code, message) {
  sendApiError(res, status, code, message, req.requestId);
}

function registerPostCallExtractionRoutes(app, options = {}) {
  const { db, requireAdminToken, requireMiniAppSession, sendApiError } = options;
  if (!app || typeof requireAdminToken !== "function" || typeof sendApiError !== "function") {
    throw new TypeError("Post-call extraction routes require app, admin authorization, and an API error handler");
  }
  app.get("/post-call/extractions", requireAdminToken, async (req, res) => {
    try {
      if (typeof db?.listCallStructuredExtractions !== "function") {
        return sendError(res, sendApiError, req, 503, "post_call_extraction_unavailable", "Structured extraction review is unavailable");
      }
      const extractions = await db.listCallStructuredExtractions({
        status: req.query?.status,
        business_id: req.query?.business_id,
        limit: req.query?.limit,
      });
      res.json({ success: true, request_id: req.requestId || null, extractions });
    } catch (_) {
      sendError(res, sendApiError, req, 500, "post_call_extractions_failed", "Structured extractions could not be listed");
    }
  });

  const review = async (req, res, { actor, businessId = null }) => {
    try {
      const body = req.body || {};
      const allowed = new Set(["decision", "corrected_data", "review_note"]);
      if (Object.keys(body).some((key) => !allowed.has(key)) ||
          !["approved", "corrected", "rejected"].includes(body.decision) ||
          (body.review_note !== undefined && (typeof body.review_note !== "string" || body.review_note.length > 1000)) ||
          (body.decision === "corrected" && !Object.hasOwn(body, "corrected_data")) ||
          (body.decision !== "corrected" && Object.hasOwn(body, "corrected_data"))) {
        return sendError(res, sendApiError, req, 400, "post_call_extraction_review_invalid", "Review decision or fields are invalid");
      }
      if (typeof db?.getCallStructuredExtraction !== "function" || typeof db?.reviewCallStructuredExtraction !== "function") {
        return sendError(res, sendApiError, req, 503, "post_call_extraction_unavailable", "Structured extraction review is unavailable");
      }
      const current = await db.getCallStructuredExtraction(req.params.call_sid, businessId);
      if (!current) return sendError(res, sendApiError, req, 404, "not_found", "Structured extraction was not found");
      if (body.decision === "corrected") {
        validateSchema(current.schema);
        const validationErrors = matchesSchema(body.corrected_data, current.schema);
        if (validationErrors.length) {
          return sendError(res, sendApiError, req, 400, "post_call_extraction_correction_invalid", "Corrected data does not match the extraction schema");
        }
      }
      const result = await db.reviewCallStructuredExtraction({
        call_sid: req.params.call_sid,
        decision: body.decision,
        corrected_data: body.corrected_data,
        reviewed_by: actor,
        business_id: businessId,
        reviewed_at: new Date().toISOString(),
        review_note: body.review_note,
      });
      if (!result) return sendError(res, sendApiError, req, 404, "not_found", "Structured extraction was not found");
      res.json({ success: true, request_id: req.requestId || null, extraction: result });
    } catch (error) {
      if (error?.code === "conflict") return sendError(res, sendApiError, req, 409, "post_call_extraction_already_reviewed", "Structured extraction has already been reviewed");
      sendError(res, sendApiError, req, 500, "post_call_extraction_review_failed", "Structured extraction review could not be saved");
    }
  };

  app.post("/post-call/extractions/:call_sid/review", requireAdminToken, (req, res) => review(req, res, { actor: "admin_token" }));

  if (typeof requireMiniAppSession === "function") {
    const businessPath = "/miniapp/businesses/:business_id/post-call/extractions";
    const authorizeBusiness = async (req, res, roles) => {
      const businessId = String(req.params?.business_id || "").trim();
      const actor = String(req.miniAppSession?.telegram_id || "").trim();
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(actor)) {
        sendError(res, sendApiError, req, 400, "post_call_extraction_scope_invalid", "Business extraction scope is invalid");
        return null;
      }
      if (typeof db?.getCallEBusinessOperator !== "function") {
        sendError(res, sendApiError, req, 503, "post_call_extraction_scope_unavailable", "Business membership is unavailable");
        return null;
      }
      const membership = await db.getCallEBusinessOperator(businessId, actor);
      if (!roles.includes(membership?.role)) {
        sendError(res, sendApiError, req, 403, "post_call_extraction_access_denied", "Business extraction access is denied");
        return null;
      }
      return { businessId, actor };
    };
    app.get(businessPath, requireMiniAppSession, async (req, res) => {
      try {
        const scope = await authorizeBusiness(req, res, ["policy_manager", "call_operator"]);
        if (!scope) return;
        const extractions = await db.listCallStructuredExtractions({
          status: req.query?.status,
          business_id: scope.businessId,
          limit: req.query?.limit,
        });
        res.json({ success: true, request_id: req.requestId || null, business_id: scope.businessId, extractions });
      } catch (_) {
        sendError(res, sendApiError, req, 500, "post_call_extractions_failed", "Business extractions could not be listed");
      }
    });
    app.post(`${businessPath}/:call_sid/review`, requireMiniAppSession, async (req, res) => {
      try {
        const scope = await authorizeBusiness(req, res, ["policy_manager"]);
        if (!scope) return;
        await review(req, res, { actor: scope.actor, businessId: scope.businessId });
      } catch (_) {
        sendError(res, sendApiError, req, 500, "post_call_extraction_review_failed", "Structured extraction review could not be saved");
      }
    });
  }
}

module.exports = { registerPostCallExtractionRoutes };
