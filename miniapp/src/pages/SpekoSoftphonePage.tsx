import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { useMiniAppCommandSession } from '@/hooks/useMiniAppCommandSession';
import { Link } from '@/components/Link/Link';
import { getDtmfCode, parseSpekoDataMessage } from '@/services/spekoSoftphoneProtocol';
import './SpekoSoftphonePage.css';

type JoinCredentials = { token: string; url: string };
type CallLeg = { controlId: string; kind: string; status?: string; brokerId?: string | null };
type CallSummary = { id: string; status: string; legs: CallLeg[] };
type ActiveCall = { callId: string; controlId: string; dtmfControlId?: string };
type RingOffer = { callId: string; controlId: string; caller?: { name?: string; phoneNumber?: string } };
type ApiEnvelope<T> = T & { success?: boolean; error?: string };

export function SpekoSoftphonePage(): JSX.Element {
  const session = useMiniAppCommandSession();
  const [phoneNumber, setPhoneNumber] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Offline');
  const [error, setError] = useState('');
  const [offer, setOffer] = useState<RingOffer | null>(null);
  const [recentCalls, setRecentCalls] = useState<CallSummary[]>([]);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [digits, setDigits] = useState('');
  const presenceRoom = useRef<Room | null>(null);
  const callRoom = useRef<Room | null>(null);
  const audioRoot = useRef<HTMLDivElement | null>(null);
  const heartbeat = useRef<number | null>(null);
  const activeCallRef = useRef<ActiveCall | null>(null);

  const setCurrentCall = useCallback((call: ActiveCall | null) => {
    activeCallRef.current = call;
    setActiveCall(call);
  }, []);

  const api = useCallback(async <T,>(path: string, body?: Record<string, unknown>): Promise<T> => {
    const response = await session.request<ApiEnvelope<T>>(path, {
      method: body ? 'POST' : 'GET',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response?.success === false) throw new Error(response.error || 'Speko request failed');
    return response as T;
  }, [session.request]);

  const pressDigits = useCallback(async (value: string) => {
    const room = callRoom.current;
    if (!room) return;
    for (const digit of value.toUpperCase()) {
      if (digit === 'W') {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        continue;
      }
      const code = getDtmfCode(digit);
      if (code !== undefined) await room.localParticipant.publishDtmf(code, digit);
    }
  }, []);

  const listenForPresenceMessages = useCallback((room: Room) => {
    room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
      const message = parseSpekoDataMessage(topic || '', payload);
      if (message?.type === 'incoming_call') {
        setOffer({ callId: message.callId, controlId: message.controlId, caller: message.caller });
        setStatus('Incoming call');
      } else if (message?.type === 'call_event') {
        const type = message.eventType;
        setStatus(type);
        if (['call.hangup', 'call.leg.hangup'].includes(type) && activeCallRef.current?.callId === message.callId) {
          void callRoom.current?.disconnect();
          callRoom.current = null;
          setCurrentCall(null);
          setMuted(false);
          setHeld(false);
        }
      } else if (message?.type === 'dtmf.press') {
        void pressDigits(message.digits).catch(() => setStatus('DTMF relay failed'));
      }
    });
  }, [pressDigits, setCurrentCall]);

  const connectCallRoom = useCallback(async (credentials: JoinCredentials, callId: string, controlId: string, dtmfControlId?: string) => {
    if (callRoom.current) await callRoom.current.disconnect();
    const room = new Room({ adaptiveStream: false, dynacast: false });
    listenForPresenceMessages(room);
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio || !audioRoot.current) return;
      const element = track.attach();
      element.autoplay = true;
      audioRoot.current.appendChild(element);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((element) => element.remove());
    });
    room.on(RoomEvent.Disconnected, () => {
      setStatus('Call media disconnected');
    });
    callRoom.current = room;
    try {
      await room.connect(credentials.url, credentials.token);
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (error) {
      await room.disconnect().catch(() => {});
      if (callRoom.current === room) callRoom.current = null;
      throw error;
    }
    setCurrentCall({ callId, controlId, dtmfControlId });
    setStatus('Call connected');
  }, [listenForPresenceMessages, setCurrentCall]);

  const startPresence = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await api('/miniapp/speko/call-control/presence/register', {});
      const credentials = await api<JoinCredentials>('/miniapp/speko/call-control/presence/token', {});
      const room = new Room({ adaptiveStream: false, dynacast: false });
      listenForPresenceMessages(room);
      presenceRoom.current = room;
      await room.connect(credentials.url, credentials.token);
      await api('/miniapp/speko/call-control/presence/status', { status: 'available' });
      const calls = await api<{ calls: CallSummary[] }>('/miniapp/speko/call-control/calls');
      setRecentCalls(calls.calls || []);
      heartbeat.current = window.setInterval(() => {
        void api('/miniapp/speko/call-control/presence/heartbeat', {}).catch(() => setStatus('Presence heartbeat failed'));
      }, 30_000);
      setConnected(true);
      setStatus('Available');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to connect presence');
      if (heartbeat.current != null) window.clearInterval(heartbeat.current);
      heartbeat.current = null;
      if (presenceRoom.current) await presenceRoom.current.disconnect().catch(() => {});
      presenceRoom.current = null;
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }, [api, listenForPresenceMessages]);

  const refreshRecentCalls = useCallback(async () => {
    try {
      const response = await api<{ calls: CallSummary[] }>('/miniapp/speko/call-control/calls');
      setRecentCalls(response.calls || []);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to refresh calls');
    }
  }, [api]);

  const stopPresence = useCallback(async () => {
    if (heartbeat.current != null) window.clearInterval(heartbeat.current);
    heartbeat.current = null;
    await api('/miniapp/speko/call-control/presence/status', { status: 'offline' }).catch(() => {});
    await presenceRoom.current?.disconnect().catch(() => {});
    presenceRoom.current = null;
    setConnected(false);
    setOffer(null);
    setStatus(activeCall ? 'Call still active; media remains connected' : 'Offline');
  }, [activeCall, api]);

  const answerOffer = useCallback(async () => {
    if (!offer) return;
    setBusy(true);
    setError('');
    try {
      const credentials = await api<JoinCredentials>(`/miniapp/speko/call-control/legs/${encodeURIComponent(offer.controlId)}/join`, {});
      setCurrentCall({ callId: offer.callId, controlId: offer.controlId });
      await connectCallRoom(credentials, offer.callId, offer.controlId);
      await api(`/miniapp/speko/call-control/controls/${encodeURIComponent(offer.controlId)}/answer`, {});
      const current = await api<{ call: CallSummary }>(`/miniapp/speko/call-control/calls/${encodeURIComponent(offer.callId)}`);
      const pstnLeg = current.call.legs.find((leg) => leg.kind === 'pstn');
      setCurrentCall({ callId: offer.callId, controlId: offer.controlId, dtmfControlId: pstnLeg?.controlId });
      setOffer(null);
      setStatus('Call answered');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to answer call');
    } finally {
      setBusy(false);
    }
  }, [api, connectCallRoom, offer, setCurrentCall]);

  const dial = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!phoneNumber.trim()) return;
    setBusy(true);
    setError('');
    try {
      const response = await api<{ call: CallSummary; join: JoinCredentials }>('/miniapp/speko/call-control/dial', { to: phoneNumber.trim() });
      const browserLeg = response.call.legs.find((leg) => leg.kind === 'browser');
      const pstnLeg = response.call.legs.find((leg) => leg.kind === 'pstn');
      if (!browserLeg) throw new Error('Speko did not return the broker browser leg');
      setCurrentCall({ callId: response.call.id, controlId: browserLeg.controlId, dtmfControlId: pstnLeg?.controlId });
      await connectCallRoom(response.join, response.call.id, browserLeg.controlId, pstnLeg?.controlId);
      setPhoneNumber('');
    } catch (nextError) {
      const error = nextError as Error & { code?: string };
      setError(error.code === 'speko_human_dial_uncertain'
        ? 'The call may have been placed. Refresh recent calls before trying again.'
        : error.message || 'Unable to dial');
      await refreshRecentCalls();
    } finally {
      setBusy(false);
    }
  }, [api, connectCallRoom, phoneNumber, refreshRecentCalls, setCurrentCall]);

  const reconnectCall = useCallback(async (call: CallSummary) => {
    const browserLeg = call.legs.find((leg) => leg.kind === 'browser');
    const pstnLeg = call.legs.find((leg) => leg.kind === 'pstn');
    if (!browserLeg) return;
    setBusy(true);
    setError('');
    try {
      const credentials = await api<JoinCredentials>(`/miniapp/speko/call-control/legs/${encodeURIComponent(browserLeg.controlId)}/join`, {});
      await connectCallRoom(credentials, call.id, browserLeg.controlId, pstnLeg?.controlId);
      if (browserLeg.status === 'ringing') {
        await api(`/miniapp/speko/call-control/controls/${encodeURIComponent(browserLeg.controlId)}/answer`, {});
      }
      setStatus('Call media reconnected');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to reconnect call media');
    } finally {
      setBusy(false);
    }
  }, [api, connectCallRoom]);

  const runCommand = useCallback(async (command: string, body: Record<string, unknown> = {}) => {
    if (!activeCall) return;
    setBusy(true);
    setError('');
    try {
      const targetControlId = command === 'dtmf' ? activeCall.dtmfControlId : activeCall.controlId;
      if (!targetControlId) throw new Error('No PSTN leg is available for DTMF');
      await api(`/miniapp/speko/call-control/controls/${encodeURIComponent(targetControlId)}/${command}`, body);
      if (command === 'mute') setMuted(true);
      if (command === 'unmute') setMuted(false);
      if (command === 'hold') setHeld(true);
      if (command === 'unhold') setHeld(false);
      if (command === 'hangup') {
        await callRoom.current?.disconnect();
        callRoom.current = null;
        setCurrentCall(null);
        setMuted(false);
        setHeld(false);
        setStatus(connected ? 'Available' : 'Offline');
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : `Unable to ${command}`);
    } finally {
      setBusy(false);
    }
  }, [activeCall, api, connected, setCurrentCall]);

  useEffect(() => () => {
    if (heartbeat.current != null) window.clearInterval(heartbeat.current);
    void api('/miniapp/speko/call-control/presence/status', { status: 'offline' }).catch(() => {});
    void presenceRoom.current?.disconnect();
    void callRoom.current?.disconnect();
  }, [api]);

  if (!session.hasCapability('provider_manage')) {
    return <main className="speko-softphone"><h1>Speko softphone</h1><p>Your Mini App role cannot control provider calls.</p></main>;
  }

  return (
    <main className="speko-softphone">
      <header className="speko-softphone__header">
        <div><p className="speko-softphone__eyebrow">Human calls</p><h1>Speko softphone</h1></div>
        <div className="speko-softphone__header-actions">
          <Link to="/" className="speko-softphone__back">Dashboard</Link>
          <span className={connected ? 'speko-softphone__badge speko-softphone__badge--on' : 'speko-softphone__badge'}>{status}</span>
        </div>
      </header>
      {error && <p className="speko-softphone__error" role="alert">{error}</p>}
      {!connected ? <button className="speko-softphone__primary" disabled={busy || session.loading} onClick={() => void startPresence()}>
        {busy ? 'Connecting…' : 'Go available'}
      </button> : <button className="speko-softphone__secondary" disabled={busy} onClick={() => void stopPresence()}>Go offline</button>}

      {offer && <section className="speko-softphone__card" aria-live="polite">
        <h2>Incoming call</h2>
        <p>{offer.caller?.name || offer.caller?.phoneNumber || 'Caller'}</p>
        <button className="speko-softphone__primary" disabled={busy || !connected} onClick={() => void answerOffer()}>Join and answer</button>
        <button className="speko-softphone__secondary" disabled={busy} onClick={() => setOffer(null)}>Dismiss</button>
      </section>}

      <section className="speko-softphone__card">
        <h2>Dial out</h2>
        <form onSubmit={(event) => void dial(event)}>
          <label htmlFor="speko-phone">Destination number</label>
          <input id="speko-phone" type="tel" inputMode="tel" autoComplete="tel" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} placeholder="+12015550123" />
          <button className="speko-softphone__primary" disabled={!connected || busy || !phoneNumber.trim()}>Call</button>
        </form>
      </section>

      {connected && <section className="speko-softphone__card">
        <div className="speko-softphone__section-heading"><h2>Recent broker calls</h2><button className="speko-softphone__secondary" disabled={busy} onClick={() => void refreshRecentCalls()}>Refresh</button></div>
        {recentCalls.length === 0 ? <p>No recent calls for this broker.</p> : recentCalls.slice(0, 10).map((call) => {
          const browserLeg = call.legs.find((leg) => leg.kind === 'browser');
          const live = !['ended', 'failed', 'declined', 'missed', 'cancelled'].includes(call.status);
          return <div className="speko-softphone__recent-call" key={call.id}>
            <span>{call.status} · {call.id}</span>
            {live && browserLeg && <button className="speko-softphone__secondary" disabled={busy} onClick={() => void reconnectCall(call)}>Reconnect media</button>}
          </div>;
        })}
      </section>}

      {activeCall && <section className="speko-softphone__card">
        <h2>Active call</h2><p>Call {activeCall.callId}</p>
        <div className="speko-softphone__controls">
          <button disabled={busy} onClick={() => void runCommand(muted ? 'unmute' : 'mute')}>{muted ? 'Unmute' : 'Mute'}</button>
          <button disabled={busy} onClick={() => void runCommand(held ? 'unhold' : 'hold')}>{held ? 'Resume' : 'Hold'}</button>
          <button className="speko-softphone__danger" disabled={busy} onClick={() => void runCommand('hangup')}>Hang up</button>
        </div>
        <form className="speko-softphone__dtmf" onSubmit={(event) => { event.preventDefault(); void runCommand('dtmf', { digits }); }}>
          <label htmlFor="speko-dtmf">DTMF digits</label>
          <input id="speko-dtmf" value={digits} onChange={(event) => setDigits(event.target.value)} maxLength={64} placeholder="0–9, *, #" />
          <button disabled={busy || !digits}>Send</button>
        </form>
      </section>}

      <div ref={audioRoot} className="speko-softphone__audio" aria-label="Call audio" />
      <p className="speko-softphone__note">Keep this screen open while available. Call controls are limited to your assigned broker.</p>
    </main>
  );
}
