const assert = require('node:assert/strict');
const { runWithTimeout } = require('../utils/asyncControl');

describe('async control timeouts', () => {
  it('rejects a pending operation with the configured timeout code', async () => {
    await assert.rejects(
      runWithTimeout(new Promise(() => {}), {
        timeoutMs: 5,
        timeoutCode: 'voice_agent_function_timeout',
        logger: { error() {}, warn() {} },
      }),
      (error) => error.code === 'voice_agent_function_timeout',
    );
  });

  it('returns a result before the timeout expires', async () => {
    const result = await runWithTimeout(Promise.resolve('complete'), {
      timeoutMs: 100,
      timeoutCode: 'voice_agent_function_timeout',
      logger: { error() {}, warn() {} },
    });
    assert.equal(result, 'complete');
  });
});
