'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

describe('post-call workflow event queue persistence', function () {
  this.timeout(120000);

  it('deduplicates durable events and dead-letters after bounded attempts', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-post-call-events-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      const event = await db.createPostCallWorkflowEvent({
        event_id: 'workflow-event-1',
        event_key: 'post-call:post_call_completed:global:call-hash',
        call_sid: 'local-call-1',
        trigger_event: 'post_call_completed',
        definition_versions_json: '[]',
        payload_json: JSON.stringify({ call_sid: 'local-call-1' }),
        max_attempts: 1,
      });
      const duplicate = await db.createPostCallWorkflowEvent({
        event_id: 'workflow-event-duplicate',
        event_key: event.event_key,
        trigger_event: 'post_call_completed',
        definition_versions_json: '[]',
        payload_json: '{}',
        max_attempts: 1,
      });

      assert.equal(duplicate.event_id, event.event_id);
      assert.equal(await db.claimPostCallWorkflowEvent(event.event_id), 1);
      assert.equal(await db.claimPostCallWorkflowEvent(event.event_id), 0);
      assert.equal(await db.resetPostCallWorkflowEvent(
        event.event_id,
        'workflow_definition_unavailable',
        new Date(Date.now() + 60_000).toISOString(),
      ), 1);

      const deadLetter = await db.getPostCallWorkflowEvent(event.event_id);
      assert.equal(deadLetter.status, 'dead_letter');
      assert.equal(deadLetter.attempts, 1);
      assert.equal(deadLetter.error_code, 'workflow_definition_unavailable');
      assert.ok(deadLetter.dead_lettered_at);
      assert.deepEqual(await db.listPendingPostCallWorkflowEvents(), []);
      const visible = await db.listPostCallWorkflowEvents({ status: 'dead_letter', business_id: null });
      assert.equal(visible.length, 1);
      assert.equal(visible[0].call_sid, 'local-call-1');
      assert.equal(visible[0].payload_json, undefined);
      assert.equal(await db.requeueDeadLetterPostCallWorkflowEvent(event.event_id), 1);
      const retried = await db.getPostCallWorkflowEvent(event.event_id);
      assert.equal(retried.status, 'pending');
      assert.equal(retried.attempts, 0);
      assert.equal(retried.error_code, null);
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
      }
    }
  });

  it('loads execution context and steps with a bounded query even after newer status events', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-call-execution-states-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      await db.createCall({ call_sid: 'local-call-progress', phone_number: '+14155550123', user_chat_id: '7001', status: 'initiated' });
      const context = { internal_execution_id: 'exec_progress_1', request_id: 'request_progress_1', status: 'accepted' };
      const rows = [
        ['call_created', JSON.stringify({ execution_context: context }), 1],
        ['execution_step', JSON.stringify({ execution_id: context.internal_execution_id, step_name: 'provider_dispatch' }), 2],
        ...Array.from({ length: 25 }, (_, index) => ['ringing', JSON.stringify({ index }), index + 3]),
        ['post_call_automation_completed', JSON.stringify({ event_id: 'event-progress-1' }), 28],
      ];
      for (const [state, data, sequence] of rows) {
        await new Promise((resolve, reject) => db.db.run(
          'INSERT INTO call_states (call_sid, state, data, sequence_number) VALUES (?, ?, ?, ?)',
          ['local-call-progress', state, data, sequence],
          (error) => error ? reject(error) : resolve(),
        ));
      }

      const states = await db.getCallExecutionStates('local-call-progress', { limit: 40 });
      assert.deepEqual(states.map((state) => state.state), ['execution_step', 'call_created']);
      assert.equal(states[1].data.execution_context.request_id, 'request_progress_1');
      assert.equal(states[0].data.step_name, 'provider_dispatch');
      assert.deepEqual(await db.getCallExecutionStates('missing-call'), []);
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
      }
    }
  });
});
