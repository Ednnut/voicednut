/**
 * Utilities for working with Twilio Answering Machine Detection (AMD) payloads.
 * Centralized here so both the HTTP layer and hint state machine share the same normalization.
 */
const HUMAN_ANSWER_VALUES = new Set(['human', 'person', 'live', 'positive_human']);
const MACHINE_ANSWER_VALUES = new Set(['machine', 'machine_start', 'fax', 'positive_machine', 'unknown_machine', 'answering_machine']);

function normalizeAnsweredBy(value) {
  if (!value) {
    return '';
  }
  return value.toString().trim().toLowerCase();
}

function isHumanAnsweredBy(value) {
  return HUMAN_ANSWER_VALUES.has(normalizeAnsweredBy(value));
}

function isMachineAnsweredBy(value) {
  return MACHINE_ANSWER_VALUES.has(normalizeAnsweredBy(value));
}

module.exports = {
  HUMAN_ANSWER_VALUES,
  MACHINE_ANSWER_VALUES,
  normalizeAnsweredBy,
  isHumanAnsweredBy,
  isMachineAnsweredBy
};
