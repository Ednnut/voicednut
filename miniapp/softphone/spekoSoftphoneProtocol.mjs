const DTMF_CODES = Object.freeze({
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '*': 10, '#': 11, A: 12, B: 13, C: 14, D: 15,
});

/** @param {string} topic @param {Uint8Array} payload */
export function parseSpekoDataMessage(topic, payload) {
  if (topic !== 'speko.human_call' && topic !== 'speko.call_control') return null;
  try {
    const message = JSON.parse(new TextDecoder().decode(payload));
    if (topic === 'speko.human_call') {
      if (message.type === 'incoming_call' && message.callId && message.controlId) {
        return {
          type: 'incoming_call', callId: message.callId, controlId: message.controlId,
          ...(message.caller && typeof message.caller === 'object' && !Array.isArray(message.caller)
            ? { caller: message.caller }
            : {}),
        };
      }
      if (message.type === 'call_event' && message.event && typeof message.event === 'object') {
        return {
          type: 'call_event',
          eventType: typeof message.event.type === 'string' ? message.event.type : 'Call updated',
          callId: typeof message.event.callId === 'string' ? message.event.callId : '',
        };
      }
      return null;
    }
    if (message.type === 'dtmf.press' && typeof message.digits === 'string') {
      return { type: 'dtmf.press', digits: message.digits };
    }
    return null;
  } catch {
    return null;
  }
}

/** @param {string} digit */
export function getDtmfCode(digit) {
  return DTMF_CODES[digit.toUpperCase()];
}
