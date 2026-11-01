'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CartesiaSttProfileStore } = require('../services/cartesiaSttProfileStore');

describe('CartesiaSttProfileStore', () => {
  let directory;
  let store;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cartesia-stt-profile-'));
    store = new CartesiaSttProfileStore({ filePath: path.join(directory, 'profile.json'), now: () => '2026-10-31T12:00:00.000Z' });
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('persists only bounded profile settings and reads the saved value', async () => {
    const result = await store.set({ keyterms: ['VOICEDNUT'], turnSettings: { start_threshold: 0.8 } }, '7001');
    assert.equal(result.updatedBy, '7001');
    assert.deepEqual((await store.get()).profile, { keyterms: ['VOICEDNUT'], turnSettings: { start_threshold: 0.8 } });
    const stat = await fs.stat(path.join(directory, 'profile.json'));
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('returns an empty profile when no configuration exists', async () => {
    assert.equal(await store.get(), null);
  });
});
