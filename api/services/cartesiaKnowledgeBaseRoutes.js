"use strict";

const crypto = require("node:crypto");

function contentFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function sendError(ctx, req, res, status, code, message) {
  if (typeof ctx.sendApiError === "function") return ctx.sendApiError(res, status, code, message, req.requestId || null);
  return res.status(status).json({ success: false, code, error: message, request_id: req.requestId || null });
}

function registerCartesiaKnowledgeBaseRoutes(app, ctx = {}) {
  const limiter = typeof ctx.cartesiaApprovalLimiter === "function" ? ctx.cartesiaApprovalLimiter : (_req, _res, next) => next();
  const authorize = typeof ctx.requireOutboundAuthorization === "function" ? ctx.requireOutboundAuthorization : (_req, _res, next) => next();
  const actor = typeof ctx.requireCallEActorAssertion === "function" ? ctx.requireCallEActorAssertion : (_req, _res, next) => next();
  const root = "/api/cartesia/knowledge-base";

  const handle = (method, { status = 200, confirmation } = {}) => async (req, res) => {
    try {
      if (typeof ctx.isCartesiaAdminActor !== "function" || !(await ctx.isCartesiaAdminActor(req.callEActorId))) {
        return sendError(ctx, req, res, 403, "cartesia_admin_required", "Cartesia Knowledge Base actions are restricted to administrators");
      }
      const service = typeof ctx.createCartesiaKnowledgeBaseService === "function" ? ctx.createCartesiaKnowledgeBaseService() : null;
      if (!service) return sendError(ctx, req, res, 503, "cartesia_knowledge_base_unavailable", "Cartesia Knowledge Base is unavailable");
      if (confirmation) {
        const expected = confirmation(req);
        if (String(req.body?.confirmation_phrase || "") !== expected) {
          return sendError(ctx, req, res, 400, "cartesia_confirmation_required", "The exact Cartesia Knowledge Base confirmation phrase is required");
        }
      }
      const result = await method(service, req);
      return res.status(status).json({ success: true, ...(result || {}) });
    } catch (error) {
      const code = String(error?.code || "cartesia_knowledge_base_operation_failed");
      const mappedStatus = Number(error?.status) || (code.includes("not_found") ? 404 : code.includes("not_configured") ? 503 : code.includes("invalid") || code.includes("required") || code.includes("empty") ? 400 : 502);
      console.error("cartesia_knowledge_base_route_error", { code, status: mappedStatus });
      return sendError(ctx, req, res, mappedStatus, code, mappedStatus >= 500 ? "Cartesia Knowledge Base operation failed" : error.message);
    }
  };
  const chain = (handler) => [limiter, authorize, actor, handler];

  app.get(`${root}/folders`, ...chain(handle((service, req) => service.listFolders(req.query || {}))));
  app.get(`${root}/folders/:folderId`, ...chain(handle((service, req) => service.getFolder(req.params?.folderId))));
  app.post(`${root}/folders`, ...chain(handle((service, req) => service.createFolder(req.body || {}), {
    status: 201, confirmation: (req) => `CREATE CARTESIA KB FOLDER ${String(req.body?.name || "").trim().toUpperCase()}`,
  })));
  app.patch(`${root}/folders/:folderId`, ...chain(handle((service, req) => service.updateFolder(req.params?.folderId, req.body || {}), {
    confirmation: (req) => `UPDATE CARTESIA KB FOLDER ${String(req.params?.folderId || "")}`,
  })));
  app.put(`${root}/folders/:folderId/agents`, ...chain(handle((service, req) => service.assignFolderAgents(req.params?.folderId, req.body?.agent_ids), {
    confirmation: (req) => `SET CARTESIA KB AGENTS FOR FOLDER ${String(req.params?.folderId || "")}`,
  })));
  app.delete(`${root}/folders/:folderId`, ...chain(handle((service, req) => service.deleteFolder(req.params?.folderId), {
    confirmation: (req) => `DELETE CARTESIA KB FOLDER ${String(req.params?.folderId || "")}`,
  })));

  app.get(`${root}/documents`, ...chain(handle((service, req) => service.listDocuments(req.query || {}))));
  app.get(`${root}/documents/:documentId`, ...chain(handle((service, req) => service.getDocument(req.params?.documentId))));
  app.post(`${root}/documents`, ...chain(handle((service, req) => service.createDocument(req.body || {}), {
    status: 201, confirmation: (req) => `CREATE CARTESIA KB DOCUMENT ${String(req.body?.name || "").trim().toUpperCase()} IN FOLDER ${String(req.body?.folder_id || "")} CONTENT SHA256 ${contentFingerprint(req.body?.content)}`,
  })));
  app.post(`${root}/documents/bulk`, ...chain(handle((service, req) => service.createDocumentsBulk(req.body || {}), {
    status: 201, confirmation: (req) => `CREATE CARTESIA KB DOCUMENT BATCH SHA256 ${contentFingerprint(JSON.stringify(req.body?.documents || []))}`,
  })));
  app.patch(`${root}/documents/:documentId`, ...chain(handle((service, req) => service.updateDocument(req.params?.documentId, req.body || {}), {
    confirmation: (req) => `UPDATE CARTESIA KB DOCUMENT ${String(req.params?.documentId || "")}`,
  })));
  app.delete(`${root}/documents/:documentId`, ...chain(handle((service, req) => service.deleteDocument(req.params?.documentId), {
    confirmation: (req) => `DELETE CARTESIA KB DOCUMENT ${String(req.params?.documentId || "")}`,
  })));
}

module.exports = { contentFingerprint, registerCartesiaKnowledgeBaseRoutes };
