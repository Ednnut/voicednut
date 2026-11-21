const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("../db/db");

describe("Speko persistent lifecycle ordering", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `voicednut-speko-sequence-${Date.now()}-${Math.random()}.sqlite`,
    );
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
  });

  afterEach(async () => {
    if (db?.db) {
      await new Promise((resolve) => db.db.close(() => resolve()));
    }
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((file) => {
      try {
        fs.unlinkSync(file);
      } catch (_) {}
    });
  });

  it("atomically advances sequence numbers and ignores duplicate or stale events", async () => {
    const callSid = "speko_internal_test";
    assert.deepEqual(
      await db.advanceSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 4,
      }),
      { advanced: true },
    );
    assert.deepEqual(
      await db.advanceSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 4,
      }),
      { advanced: false },
    );
    assert.deepEqual(
      await db.advanceSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 3,
      }),
      { advanced: false },
    );
    assert.deepEqual(
      await db.advanceSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 5,
      }),
      { advanced: true },
    );
  });

  it("serializes in-flight event sequences and releases failed claims for retry", async () => {
    const callSid = "speko_internal_claim_test";
    const firstClaim = await db.claimSpekoCallSequence({
      call_sid: callSid,
      sequence_number: 10,
      event_key: "webhook-10",
    });
    assert.equal(firstClaim.claimed, true);

    const overlapping = await db.claimSpekoCallSequence({
      call_sid: callSid,
      sequence_number: 11,
      event_key: "webhook-11",
    });
    assert.equal(overlapping.claimed, false);
    assert.equal(overlapping.busy, true);

    await db.releaseSpekoCallSequenceClaim({
      call_sid: callSid,
      sequence_number: 10,
      event_key: "webhook-10",
    });
    const retryClaim = await db.claimSpekoCallSequence({
      call_sid: callSid,
      sequence_number: 11,
      event_key: "webhook-11",
    });
    assert.equal(retryClaim.claimed, true);
    assert.deepEqual(
      await db.finishSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 11,
        event_key: "webhook-11",
      }),
      { advanced: true },
    );
    assert.equal(await db.getSpekoCallSequence({ call_sid: callSid }), 11);
    assert.deepEqual(
      await db.claimSpekoCallSequence({
        call_sid: callSid,
        sequence_number: 10,
        event_key: "old-webhook",
      }),
      { claimed: false, stale: true, busy: false },
    );
  });

  it("allows only one concurrent reservation for a repeated outbound idempotency key", async () => {
    const attempts = await Promise.all([
      db.reserveOutboundCallIdempotency({
        idempotency_key: "speko-concurrent-key",
        provider: "speko",
        request_hash: "same-request",
      }),
      db.reserveOutboundCallIdempotency({
        idempotency_key: "speko-concurrent-key",
        provider: "speko",
        request_hash: "same-request",
      }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.reserved).length, 1);
    assert.equal(attempts.filter((attempt) => !attempt.reserved).length, 1);
  });

  it("uses an expiring application attempt lease to block concurrent retries", async () => {
    const claims = await Promise.all([
      db.claimOutboundCallAttempt({
        idempotency_key: "speko-attempt-lease",
        lease_seconds: 60,
      }),
      db.claimOutboundCallAttempt({
        idempotency_key: "speko-attempt-lease",
        lease_seconds: 60,
      }),
    ]);
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    assert.equal(claims.filter((claim) => !claim.claimed).length, 1);
    await db.releaseOutboundCallAttempt({
      idempotency_key: "speko-attempt-lease",
    });
    assert.deepEqual(
      await db.claimOutboundCallAttempt({
        idempotency_key: "speko-attempt-lease",
        lease_seconds: 60,
      }),
      { claimed: true },
    );
  });
});
