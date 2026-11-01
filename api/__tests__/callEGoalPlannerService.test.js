const assert = require('node:assert/strict');
const { CallEGoalPlannerService } = require('../services/callEGoalPlannerService');

const template = {
  id: 73,
  name: 'Reminder confirmation',
  version: 3,
  business_id: 'biz_planner_1',
  lifecycle_state: 'live',
  prompt: 'Confirm whether the synthetic appointment reminder was received.',
  first_message: 'Hello, I am calling with a brief appointment reminder.',
  supports_payment: 0,
  supports_digit_capture: 0,
  requires_otp: 0,
  payment_enabled: 0,
  allow_terminator: 0,
};
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['received'],
  properties: { received: { type: 'boolean' } },
};

function createService(consent = { eligible: true }) {
  return new CallEGoalPlannerService({
    db: {
      async getCallEBusinessOperator(businessId, actorId) {
        return businessId === 'biz_planner_1' && actorId === '1234' ? { role: 'call_operator' } : null;
      },
      async getCallTemplates() { return [template, { ...template, id: 74, lifecycle_state: 'draft' }]; },
    },
    async getTemplate(id) { return id === template.id ? template : null; },
    contactPolicy: { async checkEligibility() { return consent; } },
  });
}

describe('CALL-E goal planner service', () => {
  it('returns an ephemeral masked plan after business role, template, result schema, and consent checks', async () => {
    const service = createService();
    const listed = await service.listTemplates({ business_id: 'biz_planner_1', actor_id: '1234' });
    assert.deepEqual(listed.templates.map((row) => row.template_id), [73]);

    const result = await service.plan({
      business_id: 'biz_planner_1', actor_id: '1234', template_id: 73,
      phone: '+14155550123', result_schema: schema,
    });
    assert.equal(result.plan.compatible, true);
    assert.equal(result.plan.consent_eligible, true);
    assert.equal(result.plan.destination_masked.includes('+14155550123'), false);
    assert.equal(result.plan.dispatch_enabled, false);
    assert.equal(result.plan.persisted, false);
    assert.equal(JSON.stringify(result).includes('+14155550123'), false);
  });

  it('returns clarification and consent blockers without exposing a dispatch path', async () => {
    const service = createService({ eligible: false, reason: 'opted_out' });
    const result = await service.plan({
      business_id: 'biz_planner_1', actor_id: '1234', template_id: 73,
      phone: 'bad-number', result_schema: {},
    });
    assert.equal(result.plan.compatible, false);
    assert.equal(result.plan.consent_eligible, false);
    assert.ok(result.plan.clarification_questions.some((question) => question.includes('E.164')));
    const consentResult = await service.plan({
      business_id: 'biz_planner_1', actor_id: '1234', template_id: 73,
      phone: '+14155550123', result_schema: schema,
    });
    assert.ok(consentResult.plan.clarification_questions.some((question) => question.includes('opted_out')));
    assert.equal(result.plan.dispatch_enabled, false);
  });

  it('rejects template access outside the actor business', async () => {
    const service = createService();
    await assert.rejects(service.plan({
      business_id: 'other_business', actor_id: '1234', template_id: 73,
      phone: '+14155550123', result_schema: schema,
    }), (error) => error.code === 'call_e_business_operator_access_denied');
  });

  it('ranks only live templates in the authorized business against a free-form goal', async () => {
    const result = await createService().suggestTemplates({
      business_id: 'biz_planner_1', actor_id: '1234',
      goal_text: 'Please confirm whether the appointment reminder was received',
    });
    assert.equal(result.matching_method, 'deterministic_keyword_overlap');
    assert.deepEqual(result.templates.map((row) => row.template_id), [73]);
    assert.ok(result.templates[0].goal_match_percent > 0);
    assert.equal(JSON.stringify(result).includes('Please confirm'), false);
    await assert.rejects(createService().suggestTemplates({
      business_id: 'biz_planner_1', actor_id: '1234', goal_text: 'hi',
    }), (error) => error.code === 'call_e_goal_text_invalid');
  });
});
