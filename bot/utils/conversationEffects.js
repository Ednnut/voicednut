const { AsyncLocalStorage } = require('node:async_hooks');

const conversationStorage = new AsyncLocalStorage();

function runInConversation(conversation, task) {
  return conversationStorage.run(conversation, task);
}

function getCurrentConversation() {
  return conversationStorage.getStore() || null;
}

module.exports = { runInConversation, getCurrentConversation };
