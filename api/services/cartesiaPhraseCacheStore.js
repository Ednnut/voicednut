'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const KEY_PATTERN = /^[a-f0-9]{64}$/;

class CartesiaPhraseCacheStore {
  constructor(options = {}) {
    this.directory = path.resolve(options.directory || path.join(__dirname, '..', 'data', 'cartesia-phrase-cache'));
    this.ttlMs = Math.max(60_000, Number(options.ttlMs) || 30 * 24 * 60 * 60 * 1000);
    this.maxBytes = Math.max(1024 * 1024, Number(options.maxBytes) || 100 * 1024 * 1024);
    this.now = options.now || Date.now;
    this.pending = Promise.resolve();
  }

  paths(key) {
    if (!KEY_PATTERN.test(String(key || ''))) throw Object.assign(new Error('Invalid Cartesia phrase cache key'), { code: 'cartesia_phrase_cache_key_invalid', status: 400 });
    return {
      audio: path.join(this.directory, `${key}.audio`),
      metadata: path.join(this.directory, `${key}.json`),
      temporary: path.join(this.directory, `${key}.${process.pid}.${Date.now()}.tmp`),
    };
  }

  async ensureDirectory() { await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); }

  async get(key) {
    const files = this.paths(key);
    try {
      const metadata = JSON.parse(await fs.readFile(files.metadata, 'utf8'));
      if (Number(metadata.createdAt) + this.ttlMs <= this.now()) {
        await Promise.allSettled([fs.unlink(files.audio), fs.unlink(files.metadata)]);
        return null;
      }
      const audio = await fs.readFile(files.audio);
      if (!audio.length || audio.length > 8 * 1024 * 1024) {
        await Promise.allSettled([fs.unlink(files.audio), fs.unlink(files.metadata)]);
        return null;
      }
      return { audio, contentType: typeof metadata.contentType === 'string' ? metadata.contentType.slice(0, 80) : 'audio/wav' };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async set(key, value = {}) {
    const files = this.paths(key);
    const audio = Buffer.isBuffer(value.audio) ? value.audio : Buffer.from(value.audio || '');
    if (!audio.length || audio.length > 8 * 1024 * 1024) {
      throw Object.assign(new Error('Cached phrase audio must be between 1 byte and 8 MB'), { code: 'cartesia_phrase_audio_invalid', status: 400 });
    }
    const operation = this.pending.then(async () => {
      await this.ensureDirectory();
      const entries = [];
      for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.audio$/.test(entry.name)) continue;
        const existingKey = entry.name.slice(0, 64);
        let stat;
        try { stat = await fs.stat(path.join(this.directory, entry.name)); } catch { continue; }
        let createdAt = stat.mtimeMs;
        try {
          const metadata = JSON.parse(await fs.readFile(path.join(this.directory, `${existingKey}.json`), 'utf8'));
          createdAt = Number(metadata.createdAt) || createdAt;
          if (createdAt + this.ttlMs <= this.now()) {
            await Promise.allSettled([fs.unlink(path.join(this.directory, entry.name)), fs.unlink(path.join(this.directory, `${existingKey}.json`))]);
            continue;
          }
        } catch { /* Keep recoverable audio and use its filesystem timestamp. */ }
        entries.push({ key: existingKey, size: stat.size, createdAt });
      }
      const current = entries.find((entry) => entry.key === key);
      let total = entries.reduce((sum, entry) => sum + entry.size, 0) - (current?.size || 0) + audio.length;
      for (const entry of entries.filter((item) => item.key !== key).sort((left, right) => left.createdAt - right.createdAt)) {
        if (total <= this.maxBytes) break;
        await Promise.allSettled([fs.unlink(path.join(this.directory, `${entry.key}.audio`)), fs.unlink(path.join(this.directory, `${entry.key}.json`))]);
        total -= entry.size;
      }
      if (total > this.maxBytes) throw Object.assign(new Error('Cartesia phrase cache capacity is full'), { code: 'cartesia_phrase_cache_full', status: 507 });
      const tempAudio = `${files.audio}.${process.pid}.tmp`;
      const tempMetadata = `${files.metadata}.${process.pid}.tmp`;
      await fs.writeFile(tempAudio, audio, { mode: 0o600 });
      await fs.writeFile(tempMetadata, JSON.stringify({ createdAt: this.now(), contentType: String(value.contentType || 'audio/wav').slice(0, 80) }), { mode: 0o600 });
      await fs.rename(tempAudio, files.audio);
      await fs.rename(tempMetadata, files.metadata);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

module.exports = { CartesiaPhraseCacheStore };
