const assert = require('node:assert/strict');
const { VapiToolPolicyService, VAPI_BUSINESS_CONTEXT_TOOL_ID } = require('../services/vapiToolPolicyService');

function setup(initial = {}) {
  let template = {
    id: 8,
    version: 2,
    lifecycle_state: 'live',
    agent_config_json: JSON.stringify({
      schema_version: 2,
      approved_tools: ['lookupInformation'],
      business_context: { business_name: 'Northwind', facts: [{ label: 'Hours', value: 'Weekdays' }] },
      ...initial,
    }),
  };
  const lifecycleChanges = [];
  const snapshots = [];
  const db = {
    async getCallTemplateById() { return template; },
    async updateCallTemplate(id, changes) {
      assert.equal(id, 8);
      template = { ...template, version: template.version + 1, agent_config_json: JSON.stringify(changes.agent_config) };
      return template;
    },
    async setCallTemplateLifecycle(id, changes) {
      lifecycleChanges.push({ id, changes });
      template = { ...template, lifecycle_state: changes.lifecycle_state };
    },
  };
  const service = new VapiToolPolicyService({
    db,
    getAvailableToolNames: () => ['lookupInformation'],
    validateTemplateConfig: (_template, candidate) => ({ valid: true, normalized: candidate }),
    onTemplateUpdated: async (updated, actor) => snapshots.push({ updated, actor }),
  });
  return { service, db, lifecycleChanges, snapshots, getTemplate: () => template };
}

describe('Vapi tool policy service', () => {
  it('enables only the dedicated tool, preserves other approvals and returns live templates to draft', async () => {
    const state = setup();
    const result = await state.service.setBusinessContextLookup(8, true, 'admin');
    assert.equal(result.changed, true);
    assert.equal(result.tool.enabled, true);
    assert.deepEqual(JSON.parse(state.getTemplate().agent_config_json).approved_tools, ['lookupInformation', VAPI_BUSINESS_CONTEXT_TOOL_ID]);
    assert.equal(state.lifecycleChanges[0].changes.lifecycle_state, 'draft');
    assert.equal(state.snapshots.length, 1);
  });

  it('requires approved context and is idempotent for an unchanged policy', async () => {
    const noContext = setup({ business_context: null });
    await assert.rejects(noContext.service.setBusinessContextLookup(8, true), (error) => error.code === 'vapi_tool_business_context_required');
    const unchanged = setup({ approved_tools: [VAPI_BUSINESS_CONTEXT_TOOL_ID] });
    const result = await unchanged.service.setBusinessContextLookup(8, true);
    assert.equal(result.changed, false);
    assert.equal(unchanged.snapshots.length, 0);
  });

  it('disables the dedicated tool while preserving other approved tools', async () => {
    const state = setup({ approved_tools: ['lookupInformation', VAPI_BUSINESS_CONTEXT_TOOL_ID] });
    const result = await state.service.setBusinessContextLookup(8, false);
    assert.equal(result.tool.enabled, false);
    assert.deepEqual(JSON.parse(state.getTemplate().agent_config_json).approved_tools, ['lookupInformation']);
  });
});
