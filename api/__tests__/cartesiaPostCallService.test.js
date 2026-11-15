const assert = require('node:assert/strict');
const CartesiaPostCallService = require('../services/cartesiaPostCallService');
const sqlite3 = require('sqlite3');
const Database = require('../db/db');
const { PostCallWorkflowExecutionService } = require('../services/postCallWorkflowExecutionService');

describe('Cartesia metadata-only post-call processing', () => {
  it('deduplicates concurrent handoffs durably across workflow service restarts', async () => {
    const connection = new sqlite3.Database(':memory:');
    const run = (sql) => new Promise((resolve, reject) => connection.run(sql, (error) => error ? reject(error) : resolve()));
    try {
      await run(`CREATE TABLE post_call_workflow_runs (
        run_id TEXT PRIMARY KEY, workflow_id TEXT, workflow_version INTEGER,
        business_id TEXT, trigger_event TEXT, trigger_reference TEXT,
        idempotency_key TEXT UNIQUE, status TEXT, current_step_id TEXT,
        payload_json TEXT, expires_at TEXT, created_at TEXT, updated_at TEXT)`);
      const store = { db: connection, createPostCallWorkflowRun: Database.prototype.createPostCallWorkflowRun,
        async listApprovedPostCallWorkflowDefinitions() {
          return [{ workflow_id: 'workflow_test', version: 1, business_id: 'business_test',
            definition_json: JSON.stringify({ schema_version: 1, workflow_id: 'workflow_test',
              name: 'Metadata test', trigger_event: 'post_call_completed', start_step_id: 'done',
              steps: [{ id: 'done', type: 'end' }] }) }];
        },
      };
      const { payloads, service } = harness();
      await service.process('ac_test');
      const makeEngine = () => {
        const engine = new PostCallWorkflowExecutionService({ db: store, enabled: true });
        engine.drain = async () => {}; // Do not execute any workflow action.
        return engine;
      };
      const engine = makeEngine();
      await Promise.all([engine.trigger(payloads[0]), engine.trigger(payloads[0])]);
      const replay = await makeEngine().trigger(payloads[0]);
      assert.equal(replay.runs[0].deduped, true);
      const rows = await new Promise((resolve, reject) => connection.all('SELECT * FROM post_call_workflow_runs',
        (error, result) => error ? reject(error) : resolve(result)));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].business_id, 'business_test');
      assert.equal(rows[0].trigger_reference, 'local_test');
      assert.equal(rows[0].payload_json.includes('private'), false);
    } finally {
      await new Promise((resolve, reject) => connection.close((error) => error ? reject(error) : resolve()));
    }
  });

  function harness(overrides = {}) {
    const payloads = [];
    const db = {
      getCartesiaCallRecordByProviderId: async () => ({ local_call_id: 'local_test',
        business_id: 'business_test', direction: 'outbound', status: 'completed' }),
      getCall: async () => ({ business_id: 'business_test', direction: 'outbound', duration: 12,
        call_summary: 'Synthetic private content', phone_number: 'private-contact' }),
      getLatestCallState: async () => ({ provider: 'cartesia', provider_call_id: 'ac_test', business_id: 'business_test' }),
      ...overrides,
    };
    return { payloads, service: new CartesiaPostCallService({ db,
      workflowService: { async trigger(payload) { payloads.push(payload); return { matched: 0 }; } } }) };
  }

  it('forwards safe metadata with the shared deterministic deduplication key', async () => {
    const { service, payloads } = harness();
    await service.process('ac_test');
    await service.process('ac_test');
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].idempotency_key, 'call-completed:local_test');
    assert.deepEqual(payloads[0], payloads[1]);
    assert.equal(payloads[0].business_id, 'business_test');
    assert.equal(payloads[0].metadata.artifact_policy, 'metadata_only');
    assert.equal(JSON.stringify(payloads).includes('private'), false);
  });

  it('rejects missing, cross-tenant, and mismatched provider mappings', async () => {
    for (const overrides of [
      { getCartesiaCallRecordByProviderId: async () => null },
      { getCall: async () => ({ business_id: 'other_business' }) },
      { getCall: async () => ({ business_id: 'business_test', direction: 'inbound' }) },
      { getLatestCallState: async () => ({ provider: 'cartesia', provider_call_id: 'other' }) },
    ]) {
      const { service, payloads } = harness(overrides);
      await service.process('ac_test');
      assert.equal(payloads.length, 0);
    }
  });

  it('propagates storage failures so webhook delivery can be retried', async () => {
    const { service } = harness({ getCall: async () => { throw new Error('storage unavailable'); } });
    await assert.rejects(service.process('ac_test'), /storage unavailable/);
  });
});