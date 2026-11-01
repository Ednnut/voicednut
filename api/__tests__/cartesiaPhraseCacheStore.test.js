'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CartesiaPhraseCacheStore } = require('../services/cartesiaPhraseCacheStore');

describe('CartesiaPhraseCacheStore', () => {
  let directory;
  let now;
  let store;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cartesia-phrase-cache-'));
    now = 1_800_000_000_000;
    store = new CartesiaPhraseCacheStore({ directory, now: () => now, ttlMs: 60_000, maxBytes: 1024 * 1024 });
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it('stores and retrieves bounded audio with private file permissions', async () => {
    const key = 'a'.repeat(64);
    await store.set(key, { audio: Buffer.from('phrase-audio'), contentType: 'audio/wav' });
    const result = await store.get(key);
    assert.equal(result.audio.toString(), 'phrase-audio');
    assert.equal(result.contentType, 'audio/wav');
    const stat = await fs.stat(path.join(directory, `${key}.audio`));
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('expires entries and rejects invalid keys or oversized audio', async () => {
    const key = 'b'.repeat(64);
    await store.set(key, { audio: Buffer.from('phrase-audio') });
    now += 60_001;
    assert.equal(await store.get(key), null);
    await assert.rejects(store.get('../outside'), { code: 'cartesia_phrase_cache_key_invalid' });
    await assert.rejects(store.set('c'.repeat(64), { audio: Buffer.alloc(8 * 1024 * 1024 + 1) }), { code: 'cartesia_phrase_audio_invalid' });
  });
});
