const assert = require('node:assert/strict');
const test = require('node:test');
const { ensureSession, ensureFlow, SESSION_SCHEMA_VERSION } = require('./sessionState');

test('rehydrates only live abort controllers and reconstructs persisted flow objects', () => {
  const ctx = { session: {
    sessionSchemaVersion: SESSION_SCHEMA_VERSION,
    pendingControllers: [{}, { abort() {} }],
    flow: { name: 'call', createdAt: Date.now(), updatedAt: Date.now(), step: 'destination', state: { masked: true } },
  } };
  ensureSession(ctx);
  assert.equal(ctx.session.pendingControllers.length, 1);
  const flow = ensureFlow(ctx, 'call');
  assert.equal(flow.step, 'destination');
  assert.deepEqual(flow.state, { masked: true });
  assert.equal(typeof flow.touch, 'function');
});

test('expired or incompatible persisted sessions recover into a clean, announced state', () => {
  const expired = { session: { __sessionRecoveryNotice: true, conversation: [{ stale: true }], currentOp: { id: 'old' } } };
  ensureSession(expired);
  assert.equal(expired.session.recoveryNotice, true);
  assert.equal(expired.session.conversation, undefined);
  assert.equal(expired.session.currentOp, null);

  const oldVersion = { session: { sessionSchemaVersion: -1, flow: { name: 'old' }, meta: { secret: true } } };
  ensureSession(oldVersion);
  assert.equal(oldVersion.session.recoveryNotice, true);
  assert.deepEqual(oldVersion.session.meta, {});
});
