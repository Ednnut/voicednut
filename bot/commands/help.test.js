const assert = require('node:assert/strict');
const test = require('node:test');
const { buildContextualSuggestions } = require('./help');

test('help suggestions guide authorized users through existing safe Bot workflows', () => {
  const suggestions = buildContextualSuggestions({ isAuthorized: true, isAdmin: false }).join('\n');
  assert.match(suggestions, /\/callplan.*without dialing/i);
  assert.match(suggestions, /\/call.*asks for confirmation/i);
  assert.match(suggestions, /\/calle/);
  assert.doesNotMatch(suggestions, /\/callmonitor/);
  assert.doesNotMatch(suggestions, /\/provider status|\/provider recommend/);
  assert.doesNotMatch(suggestions, /\/workflowruns/);
});

test('help exposes admin workflows only to administrators and explains organization checks', () => {
  const suggestions = buildContextualSuggestions({ isAuthorized: true, isAdmin: true }).join('\n');
  assert.match(suggestions, /\/scripts and \/persona/);
  assert.match(suggestions, /\/workflowruns.*private chat/);
  assert.match(suggestions, /Admin Console.*Post-call Workflows/);
  assert.match(suggestions, /\/callmonitor/);
  assert.match(suggestions, /\/provider recommend.*without dispatch/);
});

test('help gives unauthenticated users an access path without advertising operational actions', () => {
  const suggestions = buildContextualSuggestions({ isAuthorized: false, isAdmin: false }).join('\n');
  assert.match(suggestions, /Request Bot access/i);
  assert.doesNotMatch(suggestions, /\/callplan|\/call\b|\/calle/);
});
