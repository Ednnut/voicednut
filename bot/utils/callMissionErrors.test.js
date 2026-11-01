'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { formatCallMissionAdvanceError } = require('./callMissionErrors');

describe('BOT CALL-E mission clarification errors', () => {
  it('shows only allowlisted clarification fields and does not invite mutation or retry', () => {
    const message = formatCallMissionAdvanceError({ response: { data: {
      clarification: { missing_inputs: ['region', 'result_schema', 'destination', 'region'] },
    } } }, 'fallback');
    assert.match(message, /region, result_schema/);
    assert.doesNotMatch(message, /destination/);
    assert.match(message, /No call was placed/);
    assert.match(message, /create and review a new mission/);
  });

  it('uses the existing safe fallback when no recognized clarification is returned', () => {
    assert.equal(formatCallMissionAdvanceError({ response: { data: { clarification: { fields: ['token'] } } } }, 'safe fallback'), 'safe fallback');
  });
});
