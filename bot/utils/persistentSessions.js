const SESSION_TTL_MS = 15 * 60 * 1000;
const CONVERSATION_VERSION = 1;
const CONVERSATION_EXTERNAL = Symbol.for('voicednut.conversation.external');

function getActorSessionKey(ctx) {
  const actorId = String(ctx?.from?.id ?? '').trim();
  const chatId = String(ctx?.chat?.id ?? ctx?.callbackQuery?.message?.chat?.id ?? '').trim();
  if (!/^\d{1,20}$/.test(actorId)) return undefined;
  if (chatId && !/^-?\d{1,20}$/.test(chatId)) return undefined;
  return chatId ? `${chatId}:${actorId}` : `inline:${actorId}`;
}

function createPersistentSessionStorage(store, ttlMs = SESSION_TTL_MS) {
  if (!store || typeof store.getPersistentSession !== 'function' ||
      typeof store.savePersistentSession !== 'function' || typeof store.deletePersistentSession !== 'function') {
    throw new TypeError('Persistent Bot session storage requires get, save, and delete operations');
  }
  return {
    async read(key) {
      const stored = await store.getPersistentSession(key);
      if (stored?.expired) return { __sessionRecoveryNotice: true };
      return stored?.value;
    },
    async write(key, value) {
      await store.savePersistentSession(key, value, ttlMs);
    },
    async delete(key) {
      await store.deletePersistentSession(key);
    },
  };
}

function createActorSequentializer(keyFn = getActorSessionKey) {
  const tails = new Map();
  return async (ctx, next) => {
    const key = keyFn(ctx);
    if (!key) return next();
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;
    try {
      return await next();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

module.exports = {
  SESSION_TTL_MS,
  CONVERSATION_VERSION,
  CONVERSATION_EXTERNAL,
  getActorSessionKey,
  createPersistentSessionStorage,
  createActorSequentializer,
};
