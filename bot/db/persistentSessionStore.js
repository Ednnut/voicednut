function createPersistentSessionStore(connection) {
  const validateKey = (value) => {
    const key = String(value || '');
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(key)) throw new Error('Invalid Bot session key');
    return key;
  };
  return {
    get(sessionKey) {
      let key;
      try { key = validateKey(sessionKey); } catch (error) { return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        connection.get('SELECT session_json, expires_at_ms FROM bot_persistent_sessions WHERE session_key = ?', [key], (error, row) => {
          if (error) return reject(error);
          if (!row) return resolve(null);
          if (Number(row.expires_at_ms) <= Date.now()) {
            return connection.run('DELETE FROM bot_persistent_sessions WHERE session_key = ?', [key], (deleteError) => {
              if (deleteError) return reject(deleteError);
              resolve({ expired: true });
            });
          }
          try { resolve({ value: JSON.parse(row.session_json), expired: false }); }
          catch (_) {
            connection.run('DELETE FROM bot_persistent_sessions WHERE session_key = ?', [key], (deleteError) => {
              if (deleteError) return reject(deleteError);
              resolve({ expired: true });
            });
          }
        });
      });
    },
    save(sessionKey, value, ttlMs = 15 * 60 * 1000) {
      let key;
      try { key = validateKey(sessionKey); } catch (error) { return Promise.reject(error); }
      let serialized;
      try { serialized = JSON.stringify(value); }
      catch (_) { return Promise.reject(new Error('Bot session state is not serializable')); }
      if (!serialized || Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) return Promise.reject(new Error('Bot session state exceeds 1 MB'));
      const ttl = Number.isFinite(Number(ttlMs)) ? Math.max(60_000, Math.min(30 * 60_000, Number(ttlMs))) : 15 * 60 * 1000;
      return new Promise((resolve, reject) => {
        connection.run('DELETE FROM bot_persistent_sessions WHERE expires_at_ms <= ?', [Date.now()], (purgeError) => {
          if (purgeError) return reject(purgeError);
          connection.run(`INSERT INTO bot_persistent_sessions (session_key, session_json, expires_at_ms, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(session_key) DO UPDATE SET session_json = excluded.session_json,
              expires_at_ms = excluded.expires_at_ms, updated_at = CURRENT_TIMESTAMP`,
          [key, serialized, Date.now() + ttl], (error) => error ? reject(error) : resolve());
        });
      });
    },
    delete(sessionKey) {
      let key;
      try { key = validateKey(sessionKey); } catch (error) { return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        connection.run('DELETE FROM bot_persistent_sessions WHERE session_key = ?', [key], (error) => error ? reject(error) : resolve());
      });
    },
    purge(now = Date.now()) {
      return new Promise((resolve, reject) => {
        connection.run('DELETE FROM bot_persistent_sessions WHERE expires_at_ms <= ?', [Number(now) || Date.now()], function (error) {
          if (error) return reject(error);
          resolve(this.changes || 0);
        });
      });
    },
  };
}

module.exports = { createPersistentSessionStore };
