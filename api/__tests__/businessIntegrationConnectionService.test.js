const assert = require("node:assert/strict");
const { BusinessIntegrationConnectionService } = require("../services/businessIntegrationConnectionService");

const secretReference = "env://BUSINESS_INTEGRATION_SECRET_BIZ_A_HUBSPOT";

function createHarness() {
  const rows = new Map();
  const bySecret = new Map();
  const knownBusinesses = new Set(["biz-a", "biz-b"]);
  const db = {
    async hasCallTemplateBusinessId(businessId) { return knownBusinesses.has(businessId); },
    async createBusinessIntegrationConnection(input) {
      const priorId = bySecret.get(input.secret_reference);
      if (priorId) return { row: rows.get(priorId), created: false };
      const row = {
        ...input,
        status: "active",
        updated_by: input.created_by,
        created_at: "2026-10-30 00:00:00",
        updated_at: "2026-10-30 00:00:00",
      };
      rows.set(row.connection_id, row);
      bySecret.set(row.secret_reference, row.connection_id);
      return { row, created: true };
    },
    async listBusinessIntegrationConnections(businessId, status) {
      return [...rows.values()].filter((row) => row.business_id === businessId && (!status || row.status === status));
    },
    async getBusinessIntegrationConnection(businessId, connectionId) {
      const row = rows.get(connectionId);
      return row?.business_id === businessId ? row : null;
    },
    async revokeBusinessIntegrationConnection(businessId, connectionId, actor) {
      const row = rows.get(connectionId);
      if (!row || row.business_id !== businessId) return null;
      if (row.status === "active") {
        row.status = "revoked";
        row.revoked_by = actor;
        row.revoked_at = "2026-10-30 00:00:01";
      }
      return row;
    },
  };
  const resolved = [];
  const secretResolver = {
    async resolve(reference) {
      resolved.push(reference);
      if (reference !== secretReference) throw Object.assign(new Error("secret unavailable"), { code: "business_integration_secret_unavailable" });
      return "synthetic-hubspot-token";
    },
  };
  return {
    service: new BusinessIntegrationConnectionService({ db, secretResolver }),
    rows,
    resolved,
  };
}

describe("BusinessIntegrationConnectionService", () => {
  it("creates idempotent business-owned metadata without returning secret material or references", async () => {
    const { service, rows, resolved } = createHarness();
    const first = await service.create("biz-a", { provider: "hubspot", secret_reference: secretReference });
    const second = await service.create("biz-a", { provider: "hubspot", secret_reference: secretReference });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.connection.connection_id, first.connection.connection_id);
    assert.equal(first.connection.business_id, "biz-a");
    assert.equal(first.connection.status, "active");
    assert.equal(JSON.stringify(first).includes("synthetic-hubspot-token"), false);
    assert.equal(JSON.stringify(first).includes(secretReference), false);
    assert.equal(rows.size, 1);
    assert.deepEqual(resolved, [secretReference, secretReference]);
  });

  it("rejects unknown businesses, unsupported providers, extra fields, and unavailable references", async () => {
    const { service } = createHarness();
    await assert.rejects(service.create("unknown", { provider: "hubspot", secret_reference: secretReference }), (error) => error.code === "not_found");
    await assert.rejects(service.create("biz-a", { provider: "salesforce", secret_reference: secretReference }), /provider is not supported/);
    await assert.rejects(service.create("biz-a", { provider: "hubspot", secret_reference: secretReference, token: "secret" }), /unsupported field/);
    await assert.rejects(service.create("biz-a", { provider: "hubspot", secret_reference: "env://BUSINESS_INTEGRATION_SECRET_MISSING" }), (error) => error.code === "business_integration_secret_unavailable");
  });

  it("does not allow one secret reference to be attached to another business", async () => {
    const { service } = createHarness();
    await service.create("biz-a", { provider: "hubspot", secret_reference: secretReference });
    await assert.rejects(
      service.create("biz-b", { provider: "hubspot", secret_reference: secretReference }),
      (error) => error.code === "conflict" && !error.message.includes("biz-a"),
    );
  });

  it("lists sanitized metadata and resolves only an active connection owned by the requested business", async () => {
    const { service } = createHarness();
    const created = await service.create("biz-a", { provider: "hubspot", secret_reference: secretReference });
    const list = await service.list("biz-a");
    assert.equal(list.length, 1);
    assert.equal(JSON.stringify(list).includes("secret_reference"), false);

    const credential = await service.resolveForBusiness("biz-a", created.connection.connection_id, "hubspot");
    assert.deepEqual(credential, {
      connection_id: created.connection.connection_id,
      business_id: "biz-a",
      provider: "hubspot",
      credential: "synthetic-hubspot-token",
    });
    await assert.rejects(service.resolveForBusiness("biz-b", created.connection.connection_id, "hubspot"), (error) => error.code === "not_found");
    await assert.rejects(service.resolveForBusiness("biz-a", created.connection.connection_id, "salesforce"), (error) => error.code === "not_found");
  });

  it("revokes only a connection belonging to the exact business and blocks future resolution", async () => {
    const { service } = createHarness();
    const created = await service.create("biz-a", { provider: "hubspot", secret_reference: secretReference });
    await assert.rejects(service.revoke("biz-b", created.connection.connection_id), (error) => error.code === "not_found");
    const revoked = await service.revoke("biz-a", created.connection.connection_id);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revoked_by, "admin_token");
    await assert.rejects(service.resolveForBusiness("biz-a", created.connection.connection_id, "hubspot"), (error) => error.code === "not_found");
  });
});
