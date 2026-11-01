'use strict';

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

function isValidPhone(value) {
  return E164_PATTERN.test(String(value || '').trim());
}

function isValidGoalText(value) {
  const input = String(value || '').trim();
  return input.length >= 8 && input.length <= 500;
}

function isValidRegion(value) {
  const input = String(value || '').trim();
  return input === '' || /^[A-Za-z]{2}$/.test(input);
}

function isValidLocale(value) {
  const input = String(value || '').trim();
  return input === '' || /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input);
}

function parseResultSchema(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = { isValidPhone, isValidGoalText, isValidRegion, isValidLocale, parseResultSchema };
