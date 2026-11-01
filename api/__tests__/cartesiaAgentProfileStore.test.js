'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CartesiaAgentProfileStore } = require('../services/cartesiaAgentProfileStore');

describe('CartesiaAgentProfileStore', () => {
  it('persists bounded profiles with atomic private files and deletes by ID', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cartesia-agent-profiles-'));
    const store = new CartesiaAgentProfileStore({ filePath: path.join(directory, 'profiles.json'), now: () => '2026-10-31T00:00:00.000Z' });
    const profile = { id: 'a2f4f0b8-62f3-49be-9d37-3e33d66b6421', name: 'Support', config: { audio: { output: { voice_id: 'voice_1' } } }, updatedAt: '2026-10-31T00:00:00.000Z', updatedBy: '7001' };
    try {
      await store.set(profile);
      assert.deepEqual(await store.get(profile.id), profile);
      assert.deepEqual(await store.list(), [profile]);
      const mode = (await fs.stat(path.join(directory, 'profiles.json'))).mode & 0o777;
      assert.equal(mode, 0o600);
      assert.equal(await store.delete(profile.id), true);
      assert.equal(await store.get(profile.id), null);
      assert.equal(await store.delete(profile.id), false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
