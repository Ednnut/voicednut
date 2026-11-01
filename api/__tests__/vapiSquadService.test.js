'use strict';

const assert = require('node:assert/strict');
const { VapiSquadService, summarizeSquad } = require('../services/vapiSquadService');

function createClient(overrides = {}) {
  return {
    isConfigured: () => true,
    listSquads: async () => [{
      id: 'squad-1', name: 'Support squad', latestVersion: 'v3',
      members: [{ assistantId: 'assistant-1', assistantVersion: 'v2', assistantDestinations: [{
        type: 'assistant', assistantName: 'Billing', assistantId: 'assistant-2', description: 'Billing questions',
      }] }],
    }],
    getSquad: async (id) => ({ id, members: [] }),
    ...overrides,
  };
}

describe('VapiSquadService', () => {
  it('lists compact squad summaries with member and handoff counts', async () => {
    const result = await new VapiSquadService({ client: createClient() }).list({ limit: 10 });
    assert.equal(result.squads[0].id, 'squad-1');
    assert.equal(result.squads[0].latest_version, 'v3');
    assert.equal(result.squads[0].member_count, 1);
    assert.equal(result.squads[0].handoff_count, 1);
    assert.equal(result.squads[0].members[0].assistant_version, 'v2');
  });

  it('summarizes fixed and dynamic handoff routes without exposing server settings or prompts', () => {
    const result = summarizeSquad({
      id: 'squad-2',
      name: 'Escalation',
      members: [{
        assistantId: 'assistant-private',
        assistant: { name: 'Front desk', model: { systemPrompt: 'private prompt', tools: [{
          type: 'handoff', destinations: [{ type: 'dynamic', server: { url: 'https://private.example/route' } }],
        }] } },
        assistantDestinations: [{ type: 'squad', squadId: 'squad-specialist', entryAssistantName: 'Specialist', description: 'Escalate a complex issue' }],
      }],
    });
    assert.equal(result.members[0].handoffs.length, 2);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /private prompt|private\.example/);
    assert.match(serialized, /dynamic|squad-specialist/);
  });

  it('rejects malformed squad IDs without calling the Vapi client', async () => {
    let requests = 0;
    const service = new VapiSquadService({ client: createClient({ getSquad: async () => { requests += 1; return {}; } }) });
    await assert.rejects(service.get('../other'), (error) => error.code === 'vapi_squad_id_invalid');
    assert.equal(requests, 0);
  });

  it('checks that Vapi returned the requested squad ID', async () => {
    const service = new VapiSquadService({ client: createClient({ getSquad: async () => ({ id: 'different-squad' }) }) });
    await assert.rejects(service.get('squad-1'), (error) => error.code === 'vapi_squad_not_found');
  });
});
