'use strict';

const CLARIFICATION_FIELDS = new Set(['task', 'phone', 'region', 'locale', 'result_schema']);

function formatCallMissionAdvanceError(error, fallback) {
  const data = error?.response?.data || {};
  const rawFields = Array.isArray(data.clarification?.missing_inputs)
    ? data.clarification.missing_inputs
    : data.clarification?.fields;
  const fields = Array.isArray(rawFields)
    ? [...new Set(rawFields.filter((field) => typeof field === 'string' && CLARIFICATION_FIELDS.has(field)))].slice(0, 5)
    : [];
  if (!fields.length) return fallback;

  return `CALL-E needs clarification for: ${fields.join(', ')}. No call was placed for this recipient. The approved mission inputs are immutable; correct the template or result schema, then create and review a new mission.`;
}

module.exports = { formatCallMissionAdvanceError };
