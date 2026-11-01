"use strict";

const assert = require("node:assert/strict");
const sqlite3 = require("sqlite3").verbose();
const Database = require("../db/db");

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}
function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

describe("Cartesia outbound contact dispatch provider migration", () => {
  it("preserves existing reservations and permits Cartesia in a legacy database", async () => {
    const database = new Database();
    database.db = new sqlite3.Database(":memory:");
    try {
      await run(database.db, `CREATE TABLE outbound_contact_dispatch_history (
        reservation_key TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        destination_hash TEXT NOT NULL CHECK(length(destination_hash) = 64),
        provider TEXT NOT NULL CHECK(provider IN ('twilio', 'plivo', 'vonage', 'vapi', 'call_e')),
        status TEXT NOT NULL CHECK(status IN ('reserved', 'accepted', 'released')),
        attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await run(database.db, "CREATE INDEX idx_outbound_contact_dispatch_cooldown ON outbound_contact_dispatch_history(business_id, destination_hash, status, attempted_at DESC)");
      await run(database.db, "INSERT INTO outbound_contact_dispatch_history (reservation_key, business_id, destination_hash, provider, status) VALUES (?, ?, ?, ?, ?)", ["twilio:reservation-1", "biz-1", "a".repeat(64), "twilio", "accepted"]);

      await database.ensureOutboundContactDispatchCartesiaProvider();
      const cooldownIndex = await get(database.db, "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_outbound_contact_dispatch_cooldown'");
      assert.deepEqual(cooldownIndex, { tbl_name: "outbound_contact_dispatch_history" });
      const preserved = await get(database.db, "SELECT * FROM outbound_contact_dispatch_history WHERE reservation_key = ?", ["twilio:reservation-1"]);
      assert.equal(preserved.provider, "twilio");
      assert.equal(preserved.status, "accepted");
      await run(database.db, "INSERT INTO outbound_contact_dispatch_history (reservation_key, business_id, destination_hash, provider, status) VALUES (?, ?, ?, ?, ?)", ["cartesia:reservation-1", "biz-1", "b".repeat(64), "cartesia", "reserved"]);
      await database.ensureOutboundContactDispatchCartesiaProvider();
      assert.deepEqual(await get(database.db, "SELECT reservation_key FROM outbound_contact_dispatch_history WHERE provider = 'cartesia'"), { reservation_key: "cartesia:reservation-1" });
    } finally {
      if (database.db) await new Promise((resolve) => database.db.close(resolve));
    }
  });
});
