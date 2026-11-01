'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { isValidBusinessId, isValidRequestKey, parseDestinationList } = require('./callMissionInputs');

describe('BOT CALL-E campaign and mission inputs', () => {
  it('accepts bounded unique E.164 destinations and rejects malformed or duplicate values', () => {
    assert.deepEqual(parseDestinationList('+14155550123\n+442071838750'), ['+14155550123', '+442071838750']);
    assert.deepEqual(parseDestinationList('+14155550123, +442071838750'), ['+14155550123', '+442071838750']);
    assert.equal(parseDestinationList('+14155550123\n+14155550123'), null);
    assert.equal(parseDestinationList('4155550123'), null);
    assert.equal(parseDestinationList(''), null);
    assert.equal(parseDestinationList(Array.from({ length: 26 }, (_, index) => `+1415555${String(index).padStart(4, '0')}`).join('\n')), null);
  });

  it('validates business identifiers and reusable idempotency keys', () => {
    assert.equal(isValidBusinessId('business_1'), true);
    assert.equal(isValidBusinessId('business/other'), false);
    assert.equal(isValidRequestKey('bot-campaign:request-001'), true);
    assert.equal(isValidRequestKey('short'), false);
  });
});
