'use strict';

function cleanTranscript(raw = '') {
  return String(raw)
    .replace(/\r\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\\([\/"])/g, '$1')
    .replace(/[^\S\n]+/g, ' ') // collapse spaces but keep newlines
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '') // remove unsupported symbols
    .trim();
}

module.exports = {
  cleanTranscript,
};
