const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Database = require("../db/db");

describe("Call outcome recording", () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `voicednut-call-outcome-${Date.now()}-${Math.random()}.sqlite`,
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

  it("records and enriches unified call outcomes across call creation and follow-up actions", async () => {
    const callSid = "CA_test_outcome_001";
    await db.createCall({
      call_sid: callSid,
      phone_number: "+15555550123",
      prompt: "prompt",
      first_message: "hello",
      user_chat_id: "1",
      business_context: "{}",
      generated_functions: "[]",
      direction: "outbound",
    });

    await db.recordCallOutcomeFromCallCreated(callSid, {
      script: "seller_followup_v1",
      script_id: "seller_followup",
      script_version: "7",
      call_profile: "marketplace_seller",
      conversation_profile: "marketplace_seller",
      purpose: "marketplace_seller",
      flow_types: ["marketplace_seller"],
      primary_flow: "marketplace_seller",
      objective_tags: ["marketplace_seller_engagement"],
      provider: "twilio",
      voice_model: "alloy",
      first_message_version: "v3",
    });

    let outcome = await db.getCallOutcome(callSid);
    assert.equal(outcome.script_used, "seller_followup");
    assert.equal(outcome.script_version, "7");
    assert.equal(outcome.profile_used, "marketplace_seller");
    assert.equal(outcome.primary_flow, "marketplace_seller");
    assert.deepEqual(outcome.objective_tags, ["marketplace_seller_engagement"]);
    assert.equal(outcome.provider_used, "twilio");
    assert.equal(outcome.voice_used, "alloy");
    assert.equal(outcome.first_message_version, "v3");
    assert.equal(outcome.callback_action_created, false);
    assert.equal(outcome.review_case_action_created, false);
    assert.equal(outcome.secure_follow_up_action_created, false);

    await db.setCallDisposition(callSid, "tax_missing_docs_followup", { source: "test" });
    await db.createReviewCase({
      call_sid: callSid,
      phone_number: "+15555550123",
      requested_action: "review_case",
      reason: "test",
      source: "test",
    });
    await db.markCallOutcomeAction(callSid, "callback");
    await db.markCallOutcomeAction(callSid, "secure_follow_up");

    outcome = await db.getCallOutcome(callSid);
    assert.equal(outcome.disposition, "tax_missing_docs_followup");
    assert.equal(outcome.callback_action_created, true);
    assert.equal(outcome.review_case_action_created, true);
    assert.equal(outcome.secure_follow_up_action_created, true);
  });
});
