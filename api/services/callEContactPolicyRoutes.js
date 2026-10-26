const POLICY_MANAGER_ROLE = "policy_manager";
const OPERATOR_ROLES = new Set([POLICY_MANAGER_ROLE, "call_operator"]);
const CONSENT_FIELDS = new Set(["template_id", "destination", "event_key", "source", "occurred_at", "expires_at", "evidence_reference"]);
const OPTOUT_FIELDS = new Set(["template_id", "destination", "event_key", "source", "occurred_at"]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorResponse(res, error) {
  const code = String(error?.code || "call_e_contact_policy_unavailable");
  const status = Number.isInteger(error?.status) ? error.status : code === "call_e_contact_policy_unavailable" ? 503 : 400;
  return res.status(status).json({ success: false, code, error: error?.message || "CALL-E contact policy operation failed" });
}

function registerCallEContactPolicyRoutes(app, options = {}) {
  const db = options.db;
  const getTemplate = options.getTemplate;
  const policyService = options.policyService;
  const adminAuth = options.requireAdminToken;
  const miniAppAuth = options.requireMiniAppSession;
  const requireCapability = options.requireMiniAppCapability;
  const policyAdminLimiter = options.policyAdminLimiter || ((_req, _res, next) => next());
  const policyWriteLimiter = options.policyWriteLimiter || ((_req, _res, next) => next());

  app.put("/api/call-e/business-operators", adminAuth, policyAdminLimiter, async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    if (Object.keys(body).some((key) => !["business_id", "telegram_id", "role"].includes(key))) {
      return res.status(400).json({ success: false, code: "call_e_business_operator_invalid", error: "Unsupported membership fields" });
    }
    const businessId = String(body.business_id || "").trim();
    const telegramId = String(body.telegram_id || "").trim();
    const role = String(body.role || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(telegramId) || !OPERATOR_ROLES.has(role)) {
      return res.status(400).json({ success: false, code: "call_e_business_operator_invalid", error: "Business operator assignment is invalid" });
    }
    try {
      if (typeof db?.hasCallTemplateBusinessId !== "function" || typeof db?.grantCallEBusinessOperator !== "function") {
        throw Object.assign(new Error("CALL-E business membership storage is unavailable"), { code: "call_e_business_membership_unavailable", status: 503 });
      }
      if (!await db.hasCallTemplateBusinessId(businessId)) {
        return res.status(404).json({ success: false, code: "call_e_business_not_found", error: "No call template exists for this business" });
      }
      await db.grantCallEBusinessOperator({ business_id: businessId, telegram_id: telegramId, role });
      return res.json({ success: true, role });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.delete("/api/call-e/business-operators", adminAuth, policyAdminLimiter, async (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    if (Object.keys(body).some((key) => !["business_id", "telegram_id"].includes(key))) {
      return res.status(400).json({ success: false, code: "call_e_business_operator_invalid", error: "Unsupported membership fields" });
    }
    const businessId = String(body.business_id || "").trim();
    const telegramId = String(body.telegram_id || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(businessId) || !/^\d{1,20}$/.test(telegramId)) {
      return res.status(400).json({ success: false, code: "call_e_business_operator_invalid", error: "Business operator assignment is invalid" });
    }
    try {
      if (typeof db?.revokeCallEBusinessOperator !== "function") {
        throw Object.assign(new Error("CALL-E business membership storage is unavailable"), { code: "call_e_business_membership_unavailable", status: 503 });
      }
      const revoked = await db.revokeCallEBusinessOperator({ business_id: businessId, telegram_id: telegramId });
      return res.json({ success: true, revoked });
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  async function handlePolicyEvent(req, res, kind) {
    const body = isPlainObject(req.body) ? req.body : {};
    const fields = kind === "consent" ? CONSENT_FIELDS : OPTOUT_FIELDS;
    if (Object.keys(body).some((key) => !fields.has(key))) {
      return res.status(400).json({ success: false, code: "call_e_contact_policy_invalid", error: "Unsupported contact policy fields" });
    }
    const templateId = Number(body.template_id);
    if (!Number.isSafeInteger(templateId) || templateId <= 0) {
      return res.status(400).json({ success: false, code: "call_e_contact_policy_invalid", error: "A valid template_id is required" });
    }
    try {
      if (typeof getTemplate !== "function" || typeof db?.getCallEBusinessOperator !== "function") {
        throw Object.assign(new Error("CALL-E business policy authorization is unavailable"), { code: "call_e_business_membership_unavailable", status: 503 });
      }
      const template = await getTemplate(templateId);
      if (!template) return res.status(404).json({ success: false, code: "call_e_template_not_found", error: "Call template was not found" });
      const businessId = String(template.business_id || "").trim();
      if (!businessId) return res.status(409).json({ success: false, code: "call_e_business_scope_required", error: "Template has no business scope" });
      const telegramId = String(req.miniAppSession?.telegram_id || "").trim();
      const membership = await db.getCallEBusinessOperator(businessId, telegramId);
      if (membership?.role !== POLICY_MANAGER_ROLE) {
        return res.status(403).json({ success: false, code: "call_e_business_policy_access_denied", error: "A business policy manager membership is required" });
      }
      const input = {
        ...body,
        businessId,
        recordedByTelegramId: telegramId,
      };
      const result = kind === "consent"
        ? await policyService.recordConsent(input)
        : await policyService.recordOptOut(input);
      return res.status(result.idempotentReplay ? 200 : 201).json({ success: true, ...result });
    } catch (error) {
      return errorResponse(res, error);
    }
  }

  app.post("/miniapp/call-e/contact-policy/consent", miniAppAuth, policyWriteLimiter, async (req, res) => {
    if (typeof requireCapability === "function" && !requireCapability(req, res, "provider_manage")) return;
    return handlePolicyEvent(req, res, "consent");
  });

  app.post("/miniapp/call-e/contact-policy/opt-out", miniAppAuth, policyWriteLimiter, async (req, res) => {
    if (typeof requireCapability === "function" && !requireCapability(req, res, "provider_manage")) return;
    return handlePolicyEvent(req, res, "optout");
  });
}

module.exports = { registerCallEContactPolicyRoutes };
