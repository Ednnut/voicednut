const crypto = require("crypto");

const SUPPORTED_BUSINESS_INTEGRATION_PROVIDERS = new Set(["hubspot"]);
const BUSINESS_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message, code = "validation_error") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function safeConnection(row) {
  if (!row) return null;
  return {
    connection_id: row.connection_id,
    business_id: row.business_id,
    provider: row.provider,
    status: row.status,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_by: row.revoked_by || null,
    revoked_at: row.revoked_at || null,
  };
}

class BusinessIntegrationConnectionService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.secretResolver = options.secretResolver || null;
  }

  async assertKnownBusiness(businessId) {
    if (!BUSINESS_ID_PATTERN.test(businessId)) fail("business_id is invalid");
    if (!this.db || typeof this.db.hasCallTemplateBusinessId !== "function") {
      fail("Business integration storage is not available", "service_unavailable");
    }
    if (!await this.db.hasCallTemplateBusinessId(businessId)) fail("Business was not found", "not_found");
  }

  async list(businessId, options = {}) {
    const status = options.status == null || options.status === "" ? null : String(options.status).trim().toLowerCase();
    if (status && !["active", "revoked"].includes(status)) fail("status is invalid");
    await this.assertKnownBusiness(businessId);
    if (typeof this.db.listBusinessIntegrationConnections !== "function") {
      fail("Business integration storage is not available", "service_unavailable");
    }
    const rows = await this.db.listBusinessIntegrationConnections(businessId, status);
    return rows.map(safeConnection);
  }

  async create(businessId, input = {}, actor = "admin_token") {
    await this.assertKnownBusiness(businessId);
    const allowed = new Set(["provider", "secret_reference"]);
    for (const key of Object.keys(input || {})) {
      if (!allowed.has(key)) fail(`Business integration connection contains unsupported field: ${key}`);
    }
    const provider = String(input.provider || "").trim().toLowerCase();
    if (!SUPPORTED_BUSINESS_INTEGRATION_PROVIDERS.has(provider)) fail("provider is not supported for business connections");
    const secretReference = typeof input.secret_reference === "string" ? input.secret_reference.trim() : "";
    if (!this.secretResolver || typeof this.secretResolver.resolve !== "function") {
      fail("Business integration secret resolution is not available", "service_unavailable");
    }
    // Resolve once before saving so a connection cannot be created with a missing secret.
    await this.secretResolver.resolve(secretReference);
    if (typeof this.db.createBusinessIntegrationConnection !== "function") {
      fail("Business integration storage is not available", "service_unavailable");
    }
    const connectionId = crypto.randomUUID();
    const result = await this.db.createBusinessIntegrationConnection({
      connection_id: connectionId,
      business_id: businessId,
      provider,
      secret_reference: secretReference,
      created_by: actor,
    });
    const row = result?.row;
    if (!row) fail("Business integration connection could not be saved", "service_unavailable");
    if (row.business_id !== businessId || row.provider !== provider) {
      fail("Secret reference is already assigned to another connection", "conflict");
    }
    if (row.status !== "active") fail("Secret reference belongs to a revoked connection", "conflict");
    return { connection: safeConnection(row), created: result.created === true };
  }

  async revoke(businessId, connectionId, actor = "admin_token") {
    await this.assertKnownBusiness(businessId);
    const id = String(connectionId || "").trim();
    if (!CONNECTION_ID_PATTERN.test(id)) fail("connection_id is invalid");
    if (typeof this.db.revokeBusinessIntegrationConnection !== "function") {
      fail("Business integration storage is not available", "service_unavailable");
    }
    const row = await this.db.revokeBusinessIntegrationConnection(businessId, id, actor);
    if (!row) fail("Business integration connection was not found", "not_found");
    return safeConnection(row);
  }

  async resolveForBusiness(businessId, connectionId, expectedProvider) {
    const id = String(connectionId || "").trim();
    const provider = String(expectedProvider || "").trim().toLowerCase();
    if (!BUSINESS_ID_PATTERN.test(String(businessId || "")) || !CONNECTION_ID_PATTERN.test(id) ||
        !SUPPORTED_BUSINESS_INTEGRATION_PROVIDERS.has(provider)) {
      fail("Business integration connection was not found", "not_found");
    }
    if (!this.db || typeof this.db.getBusinessIntegrationConnection !== "function" ||
        typeof this.secretResolver?.resolve !== "function") {
      fail("Business integration resolution is not available", "service_unavailable");
    }
    const row = await this.db.getBusinessIntegrationConnection(businessId, id);
    if (!row || row.status !== "active" || row.provider !== provider) {
      fail("Business integration connection was not found", "not_found");
    }
    const credential = await this.secretResolver.resolve(row.secret_reference);
    return { connection_id: id, business_id: businessId, provider, credential };
  }
}

module.exports = {
  BusinessIntegrationConnectionService,
  SUPPORTED_BUSINESS_INTEGRATION_PROVIDERS,
  BUSINESS_ID_PATTERN,
  CONNECTION_ID_PATTERN,
};
