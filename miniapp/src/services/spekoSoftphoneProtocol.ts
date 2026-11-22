const DTMF_CODES: Readonly<Record<string, number>> = Object.freeze({
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  '*': 10, '#': 11, A: 12, B: 13, C: 14, D: 15,
});

export type SpekoDataMessage =
  | { type: 'incoming_call'; callId: string; controlId: string; caller?: { name?: string; phoneNumber?: string } }
  | { type: 'call_event'; eventType: string; callId: string }
  | { type: 'dtmf.press'; digits: string };

export function parseSpekoDataMessage(topic: string, payload: Uint8Array): SpekoDataMessage | null {
  if (topic !== 'speko.human_call' && topic !== 'speko.call_control') return null;
  try {
    const message = JSON.parse(new TextDecoder().decode(payload)) as {
      type?: string; callId?: string; controlId?: string; caller?: unknown;
      event?: { type?: string; callId?: string }; digits?: string;
    };
    if (topic === 'speko.human_call') {
      if (message.type === 'incoming_call' && message.callId && message.controlId) {
        const caller = message.caller as { name?: string; phoneNumber?: string } | undefined;
        return {
          type: 'incoming_call', callId: message.callId, controlId: message.controlId,
          ...(caller && typeof caller === 'object' ? { caller } : {}),
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

export function getDtmfCode(digit: string): number | undefined {
  return DTMF_CODES[digit.toUpperCase()];
}
