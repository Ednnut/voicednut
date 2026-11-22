export type SpekoDataMessage =
  | { type: 'incoming_call'; callId: string; controlId: string; caller?: { name?: string; phoneNumber?: string } }
  | { type: 'call_event'; eventType: string; callId: string }
  | { type: 'dtmf.press'; digits: string };

export declare function parseSpekoDataMessage(topic: string, payload: Uint8Array): SpekoDataMessage | null;
export declare function getDtmfCode(digit: string): number | undefined;
