'use strict';

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,180}$/;

function parseDestinationList(value, maximum = 25) {
  const items = String(value || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  if (items.length < 1 || items.length > maximum || items.some((item) => !E164_PATTERN.test(item))) return null;
  if (new Set(items).size !== items.length) return null;
  return items;
}

function isValidBusinessId(value) {
  return /^[A-Za-z0-9._:-]{1,120}$/.test(String(value || '').trim());
}

function isValidRequestKey(value) {
  return REQUEST_KEY_PATTERN.test(String(value || '').trim());
}

module.exports = { parseDestinationList, isValidBusinessId, isValidRequestKey };
