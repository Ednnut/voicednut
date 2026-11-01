'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class CartesiaAgentProfileStore {
  constructor(options = {}) {
    this.filePath = path.resolve(options.filePath || path.join(__dirname, '..', 'data', 'cartesia-agent-profiles.json'));
    this.now = options.now || (() => new Date().toISOString());
    this.pending = Promise.resolve();
  }

  async _read() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.profiles)) return [];
      return data.profiles.filter((profile) => profile && /^[a-f0-9-]{36}$/i.test(String(profile.id || '')) && typeof profile.name === 'string' && profile.config && typeof profile.config === 'object');
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  async list() {
    return (await this._read()).map((profile) => ({ ...profile }));
  }

  async get(id) {
    return (await this._read()).find((profile) => profile.id === String(id)) || null;
  }

  async set(profile) {
    const operation = this.pending.then(async () => {
      const profiles = await this._read();
      const index = profiles.findIndex((item) => item.id === profile.id);
      if (index < 0 && profiles.length >= 50) throw Object.assign(new Error('At most 50 reusable Cartesia agent profiles can be stored'), { code: 'cartesia_agent_profile_limit', status: 409 });
      if (index >= 0) profiles[index] = profile;
      else profiles.push(profile);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, profiles }), { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      return { ...profile };
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async delete(id) {
    const operation = this.pending.then(async () => {
      const profiles = await this._read();
      const next = profiles.filter((profile) => profile.id !== String(id));
      if (next.length === profiles.length) return false;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, profiles: next }), { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      return true;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

module.exports = { CartesiaAgentProfileStore };
