const assert = require('node:assert/strict');
const { decideCallAgentToolFailure } = require('../services/callAgentToolFailurePolicy');

describe('call agent tool failure policy', () => {
  it('ends the call with a sanitized response when configured', () => {
    const decision = decideCallAgentToolFailure(
      { on_tool_error: 'end_call' },
      Object.assign(new Error('provider detail that must not reach the model'), {
        code: 'voice_agent_function_timeout:lookupInformation',
      }),
    );

    assert.equal(decision.action, 'end_call');
    assert.equal(decision.errorCode, 'tool_timeout');
    assert.deepEqual(decision.response, {
      ok: false,
      error: 'tool_execution_failed',
      next_action: 'call_ending',
    });
    assert.equal(JSON.stringify(decision.response).includes('provider detail'), false);
  });

  it('returns a generic failure response for explicitly configured continue mode', () => {
    const decision = decideCallAgentToolFailure(
      { on_tool_error: 'continue' },
      new Error('provider detail'),
    );

    assert.equal(decision.action, 'continue');
    assert.deepEqual(decision.response, { ok: false, error: 'tool_execution_failed' });
  });

  it('preserves legacy error response behavior when no policy is configured', () => {
    const decision = decideCallAgentToolFailure(null, new Error('legacy error'));

    assert.equal(decision.action, null);
    assert.deepEqual(decision.response, { ok: false, error: 'legacy error' });
  });
});
