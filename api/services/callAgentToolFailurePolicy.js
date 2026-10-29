'use strict';

const { resolveCallAgentToolFailureAction } = require('./callAgentDefinition');

function decideCallAgentToolFailure(policy, error) {
  const action = resolveCallAgentToolFailureAction(policy);
  const errorCode = error?.code === 'voice_agent_function_timeout'
    || String(error?.code || '').startsWith('voice_agent_function_timeout:')
    ? 'tool_timeout'
    : 'tool_execution_failed';

  if (action === 'end_call') {
    return {
      action,
      errorCode,
      response: {
        ok: false,
        error: 'tool_execution_failed',
        next_action: 'call_ending',
      },
    };
  }

  if (action === 'continue') {
    return {
      action,
      errorCode,
      response: { ok: false, error: 'tool_execution_failed' },
    };
  }

  return {
    action: null,
    errorCode,
    response: {
      ok: false,
      error: error?.message || 'function_execution_failed',
    },
  };
}

module.exports = { decideCallAgentToolFailure };
