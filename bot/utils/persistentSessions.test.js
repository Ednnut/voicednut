const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { createPersistentSessionStore } = require('../db/persistentSessionStore');
const {
  getActorSessionKey,
  createPersistentSessionStorage,
  createActorSequentializer,
  SESSION_TTL_MS,
} = require('./persistentSessions');

test('session keys bind state to both the current Telegram actor and chat', () => {
  assert.equal(getActorSessionKey({ from: { id: 42 }, chat: { id: -1007 } }), '-1007:42');
  assert.equal(getActorSessionKey({ from: { id: 42 }, chat: { id: 42 } }), '42:42');
  assert.equal(getActorSessionKey({ chat: { id: -1007 } }), undefined);
});

test('persistent storage restores values, reports expiry, and applies the short TTL', async () => {
  const values = new Map();
  const writes = [];
  const store = {
    async getPersistentSession(key) { return values.get(key) || null; },
    async savePersistentSession(key, value, ttl) { writes.push([key, ttl]); values.set(key, { value, expired: false }); },
    async deletePersistentSession(key) { values.delete(key); },
  };
  const storage = createPersistentSessionStorage(store);
  const session = { currentOp: { command: 'call' }, conversation: [{ id: 'call-conversation' }] };
  await storage.write('-1:42', session);
  assert.deepEqual(await storage.read('-1:42'), session);
  assert.equal(writes[0][1], SESSION_TTL_MS);
  values.set('-1:42', { expired: true });
  assert.deepEqual(await storage.read('-1:42'), { __sessionRecoveryNotice: true });
  await storage.delete('-1:42');
  assert.equal(values.has('-1:42'), false);
});

test('updates for one actor are serialized while different actors remain independent', async () => {
  const middleware = createActorSequentializer();
  const order = [];
  let releaseFirst;
  const firstWait = new Promise((resolve) => { releaseFirst = resolve; });
  const first = middleware({ from: { id: 1 }, chat: { id: 10 } }, async () => {
    order.push('first-start');
    await firstWait;
    order.push('first-end');
  });
  const second = middleware({ from: { id: 1 }, chat: { id: 10 } }, async () => order.push('second'));
  const independent = middleware({ from: { id: 2 }, chat: { id: 10 } }, async () => order.push('independent'));
  await independent;
  assert.deepEqual(order, ['first-start', 'independent']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'independent', 'first-end', 'second']);
});

test('SQLite session storage survives adapter recreation and removes expired, corrupt, or invalid records', async (t) => {
  const db = new sqlite3.Database(':memory:');
  t.after(() => new Promise((resolve) => db.close(resolve)));
  await new Promise((resolve, reject) => db.run(`CREATE TABLE bot_persistent_sessions (
    session_key TEXT PRIMARY KEY, session_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`, (error) => error ? reject(error) : resolve()));
  const firstProcess = createPersistentSessionStore(db);
  await firstProcess.save('private:42', { conversation: [{ id: 'call' }], owner: 42 }, 60_000);
  const restartedProcess = createPersistentSessionStore(db);
  assert.deepEqual(await restartedProcess.get('private:42'), {
    value: { conversation: [{ id: 'call' }], owner: 42 }, expired: false,
  });
  await assert.rejects(() => restartedProcess.save('invalid key', {}), /Invalid Bot session key/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(() => restartedProcess.save('private:42', cyclic), /not serializable/);

  await new Promise((resolve, reject) => db.run('UPDATE bot_persistent_sessions SET expires_at_ms = 1 WHERE session_key = ?', ['private:42'], (error) => error ? reject(error) : resolve()));
  assert.deepEqual(await restartedProcess.get('private:42'), { expired: true });
  assert.equal(await restartedProcess.purge(Date.now() + 1000), 0);

  await new Promise((resolve, reject) => db.run(`INSERT INTO bot_persistent_sessions (session_key, session_json, expires_at_ms)
    VALUES (?, ?, ?)`, ['private:42', '{bad-json', Date.now() + 60_000], (error) => error ? reject(error) : resolve()));
  assert.deepEqual(await restartedProcess.get('private:42'), { expired: true });
  assert.equal(await restartedProcess.get('private:42'), null);
});
