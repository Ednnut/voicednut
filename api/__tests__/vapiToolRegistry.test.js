const assert = require('node:assert/strict');
const {
  VAPI_BUSINESS_CONTEXT_TOOL_ID,
  VapiToolRegistry,
} = require('../services/vapiToolRegistry');

const assistantId = 'asst_tool_registry_1';
const fingerprint = 'a'.repeat(64);
const template = {
  id: 12,
  version: 3,
  lifecycle_state: 'live',
  agent_config_json: JSON.stringify({
    schema_version: 2,
    approved_tools: [VAPI_BUSINESS_CONTEXT_TOOL_ID],
    business_context: {
      business_name: 'Northwind Support',
      facts: [
        { label: 'Hours', value: 'Weekdays, 9 AM to 5 PM.' },
        { label: 'Refund policy', value: 'Refunds are available within 30 days.' },
      ],
    },
  }),
};

function makeMessage(overrides = {}) {
  return {
    assistant: {
      id: assistantId,
      metadata: { voicednutTemplateMapping: { templateId: 12, templateVersion: 3, configFingerprint: fingerprint } },
    },
    call: { id: 'call_tool_registry_1' },
    toolCallList: [{ id: 'tool-call-1', function: { name: 'lookup_business_context', arguments: { query: 'refund 30 days' } } }],
    ...overrides,
  };
}

function makeDb(mappingOverrides = {}, templateOverride = template) {
  const records = [{
    template_id: 12,
    template_version: 3,
    config_fingerprint: fingerprint,
    vapi_assistant_id: assistantId,
    compatibility_status: 'compatible',
    mapping_status: 'provisioned',
    sync_status: 'synced',
    summary: { approved_tools: [VAPI_BUSINESS_CONTEXT_TOOL_ID] },
    ...mappingOverrides,
  }];
  return {
    async listVapiTemplateMappings() {
      return records;
    },
    async listVapiTemplateMappingsByAssistantId(id) { assert.equal(id, assistantId); return records; },
    async getCallTemplateById() { return templateOverride; },
  };
}

describe('Vapi approved business context tool registry', () => {
  it('returns only matching administrator-approved reference facts', async () => {
    const registry = new VapiToolRegistry({ db: makeDb() });
    const response = await registry.processMessage(makeMessage());
    assert.equal(response.results.length, 1);
    assert.equal(response.results[0].toolCallId, 'tool-call-1');
    assert.equal(response.results[0].error, undefined);
    const result = JSON.parse(response.results[0].result);
    assert.equal(result.business_name, 'Northwind Support');
    assert.deepEqual(result.facts, [{ label: 'Refund policy', value: 'Refunds are available within 30 days.' }]);
  });

  it('correlates documented tool-call payloads through call.assistantId when metadata is absent', async () => {
    const registry = new VapiToolRegistry({ db: makeDb() });
    const message = makeMessage({
      assistant: { name: 'VOICEDNUT assistant' },
      call: { id: 'call_tool_registry_1', assistantId },
    });
    const response = await registry.processMessage(message);
    assert.equal(response.results[0].error, undefined);
    assert.match(response.results[0].result, /Northwind Support/);
  });

  it('fails closed for stale assistant mappings and disabled template approval', async () => {
    const stale = new VapiToolRegistry({ db: makeDb({ sync_status: 'failed' }) });
    const staleResponse = await stale.processMessage(makeMessage());
    assert.equal(staleResponse.results[0].error, 'Approved business context is unavailable for this call.');

    const disabledTemplate = { ...template, agent_config_json: JSON.stringify({ schema_version: 2, approved_tools: [], business_context: template.agent_config_json && JSON.parse(template.agent_config_json).business_context }) };
    const disabled = new VapiToolRegistry({ db: makeDb({}, disabledTemplate) });
    const disabledResponse = await disabled.processMessage(makeMessage());
    assert.equal(disabledResponse.results[0].error, 'This function is not approved for this assistant.');
  });

  it('rejects malformed arguments and never returns their contents', async () => {
    const registry = new VapiToolRegistry({ db: makeDb() });
    const response = await registry.processMessage(makeMessage({
      toolCallList: [{ id: 'tool-call-1', function: { name: 'lookup_business_context', arguments: { query: 'private@example.test', extra: 'do not echo' } } }],
    }));
    assert.equal(response.results[0].error, 'The function arguments are invalid.');
    assert.doesNotMatch(JSON.stringify(response), /private@example\.test|do not echo/);
  });
});
