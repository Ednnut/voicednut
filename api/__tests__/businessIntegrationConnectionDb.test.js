const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");

describe("business integration connection persistence", () => {
  it("creates an additive scoped table and keeps all connection lookups within the requested business", async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-business-integration-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    try {
      await new Promise((resolve, reject) => db.db.run(
        "INSERT INTO call_templates (name, business_id) VALUES (?, ?)",
        ["Synthetic connection owner", "biz-a"],
        (error) => error ? reject(error) : resolve(),
      ));
      const secretReference = "env://BUSINESS_INTEGRATION_SECRET_BIZ_A_HUBSPOT";
      const created = await db.createBusinessIntegrationConnection({
        connection_id: "6aa1bb51-227b-49e3-b17e-c8dbd92c7d4d",
        business_id: "biz-a",
        provider: "hubspot",
        secret_reference: secretReference,
        created_by: "admin_token",
      });
      assert.equal(created.created, true);
      assert.equal(created.row.secret_reference, secretReference);
      assert.deepEqual(await db.listBusinessIntegrationConnections("biz-b"), []);
      assert.equal(await db.getBusinessIntegrationConnection("biz-b", created.row.connection_id), null);

      const duplicate = await db.createBusinessIntegrationConnection({
        connection_id: "a0d74f24-1bcf-4351-866f-a57f3982db45",
        business_id: "biz-a",
        provider: "hubspot",
        secret_reference: secretReference,
        created_by: "admin_token",
      });
      assert.equal(duplicate.created, false);
      assert.equal(duplicate.row.connection_id, created.row.connection_id);

      const revoked = await db.revokeBusinessIntegrationConnection("biz-a", created.row.connection_id, "admin_token");
      assert.equal(revoked.status, "revoked");
      assert.equal(revoked.revoked_by, "admin_token");
      assert.equal((await db.revokeBusinessIntegrationConnection("biz-b", created.row.connection_id, "admin_token")), null);

      const columns = await new Promise((resolve, reject) => db.db.all(
        "PRAGMA table_info(business_integration_connections)",
        (error, rows) => error ? reject(error) : resolve(rows.map((row) => row.name)),
      ));
      assert.ok(columns.includes("secret_reference"));
      assert.ok(columns.includes("status"));
      assert.equal(columns.includes("credential"), false);
    } finally {
      await new Promise((resolve) => db.db.close(resolve));
      [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
    }
  });
});
