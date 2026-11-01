'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class CartesiaSttProfileStore {
  constructor(options = {}) {
    this.filePath = path.resolve(options.filePath || path.join(__dirname, '..', 'data', 'cartesia-stt-profile.json'));
    this.now = options.now || (() => new Date().toISOString());
    this.pending = Promise.resolve();
  }

  async get() {
    try {
      const stored = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!stored || stored.version !== 1 || !stored.profile) return null;
      return stored;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async set(profile, actorId) {
    const operation = this.pending.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      const value = {
        version: 1,
        profile: {
          keyterms: Array.isArray(profile?.keyterms) ? profile.keyterms.slice(0, 100) : [],
          turnSettings: profile?.turnSettings || {},
        },
        updatedAt: this.now(),
        updatedBy: String(actorId || '').slice(0, 20),
      };
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      return value;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

module.exports = { CartesiaSttProfileStore };
