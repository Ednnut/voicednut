const assert = require("node:assert/strict");

const { EmailService } = require("../routes/email");

function createEmailService({ templates = [], emailConfig = {} } = {}) {
  const byId = new Map(templates.map((template) => [template.template_id, template]));
  return new EmailService({
    db: {
      listEmailTemplates: async () => templates,
      getEmailTemplate: async (templateId) => byId.get(templateId) || null,
    },
    logger: {
      error: () => {},
      warn: () => {},
      log: () => {},
    },
    config: {
      email: {
        provider: "sendgrid",
        defaultFrom: "agent@example.com",
        verifiedDomains: ["example.com"],
        sendgrid: {
          apiKey: "SG.test",
          baseUrl: "https://api.sendgrid.test/v3",
        },
        ...emailConfig,
      },
    },
  });
}

describe("EmailService template selection and SendGrid validation", () => {
  it("selects an approved payment receipt template from call context", async () => {
    const service = createEmailService({
      templates: [
        {
          template_id: "generic_followup",
          subject: "Thanks for calling",
          text: "Thanks {{first_name}}",
          lifecycle_state: "draft",
        },
        {
          template_id: "payment_receipt_live",
          subject: "Your payment receipt",
          text: "Hi {{first_name}}, your payment is complete.",
          required_vars: JSON.stringify(["first_name"]),
          lifecycle_state: "live",
        },
      ],
    });

    const result = await service.selectTemplateForContext({
      payment_state: "paid",
      variables: { first_name: "Ada" },
    });

    assert.equal(result.selected_template_id, "payment_receipt_live");
    assert.equal(result.lifecycle_state, "live");
    assert.ok(result.matched_tokens.includes("payment"));
  });

  it("renders the selected template through preview without explicit script id", async () => {
    const service = createEmailService({
      templates: [
        {
          template_id: "booking_reschedule",
          subject: "Reschedule your appointment",
          text: "Hi {{first_name}}, here is your booking link.",
          required_vars: JSON.stringify(["first_name"]),
          lifecycle_state: "approved",
        },
      ],
    });

    const result = await service.previewScript({
      select_template: true,
      booking_state: "missed",
      variables: { first_name: "Lin" },
    });

    assert.equal(result.ok, true);
    assert.equal(result.script_id, "booking_reschedule");
    assert.equal(result.text, "Hi Lin, here is your booking link.");
    assert.equal(result.template_selection.selected_template_id, "booking_reschedule");
  });

  it("reports dry-run health failures for unapproved senders and draft templates", async () => {
    const service = createEmailService({
      templates: [
        {
          template_id: "draft_followup",
          subject: "Draft",
          lifecycle_state: "draft",
        },
      ],
    });

    const result = await service.validateProviderHealth({
      from: "agent@unapproved.test",
      template_ids: ["draft_followup"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.mode, "dry_run");
    assert.ok(
      result.checks.some((check) => check.name === "sender_identity" && check.status === "fail"),
    );
    assert.ok(
      result.checks.some((check) => check.name === "approved_template" && check.status === "fail"),
    );
  });

  it("normalizes SendGrid delivery, failure, complaint, and unsubscribe events", () => {
    const service = createEmailService();
    const events = service.normalizeProviderEvents({
      provider: "sendgrid",
      events: [
        { event: "delivered", sg_message_id: "sg-delivered", custom_args: { message_id: "email_1" } },
        { event: "blocked", sg_message_id: "sg-blocked", custom_args: { message_id: "email_2" } },
        { event: "dropped", sg_message_id: "sg-dropped", custom_args: { message_id: "email_3" } },
        { event: "spamreport", sg_message_id: "sg-spam", custom_args: { message_id: "email_4" } },
        { event: "unsubscribe", sg_message_id: "sg-unsub", custom_args: { message_id: "email_5" } },
      ],
    });

    assert.deepEqual(
      events.map((event) => event.type),
      ["delivered", "failed", "failed", "complained", "complained"],
    );
    assert.equal(events[1].reason, "blocked");
    assert.equal(events[3].suppression_reason, "complaint");
    assert.equal(events[4].suppression_reason, "unsubscribe");
  });
});
