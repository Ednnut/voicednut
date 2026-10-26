import type Vapi from '@vapi-ai/web';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useMiniAppCommandSession } from '@/hooks/useMiniAppCommandSession';
import {
  UiBadge,
  UiButton,
  UiCard,
  UiSelect,
} from '@/components/ui/AdminPrimitives';

type VapiWebAssistant = {
  mappingId: number;
  templateId: number;
  templateName: string;
  templateVersion: number;
};

type VapiWebCallResponse = {
  success: boolean;
  call: {
    id: string;
    webCallUrl: string;
    transport: { callToken?: string };
    assistant?: { voice?: { provider?: string } };
  };
  template: { mappingId: number };
};

type VapiRequestError = Error & { code?: string };

export function VapiWebCallPanel() {
  const { request, hasCapability, sessionTelegramId } = useMiniAppCommandSession();
  const [assistants, setAssistants] = useState<VapiWebAssistant[]>([]);
  const [selectedMappingId, setSelectedMappingId] = useState('');
  const [status, setStatus] = useState('Loading');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const vapiRef = useRef<Vapi | null>(null);
  const mountedRef = useRef(false);
  const attemptRef = useRef<{ owner: string; mappingId: number; key: string } | null>(null);
  const selectedAssistant = useMemo(
    () => assistants.find((assistant) => String(assistant.mappingId) === selectedMappingId) || null,
    [assistants, selectedMappingId],
  );

  const getAttemptKey = (mappingId: number) => {
    const owner = sessionTelegramId || 'miniapp-session';
    if (attemptRef.current?.owner === owner && attemptRef.current.mappingId === mappingId) return attemptRef.current.key;
    const storageKey = `vapi-web-call-attempt:${owner}:${mappingId}`;
    let key = '';
    try {
      key = sessionStorage.getItem(storageKey) || '';
    } catch {
      // Keep the attempt key in memory when browser storage is unavailable.
    }
    if (!key) key = globalThis.crypto?.randomUUID?.() || `vapi-web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    attemptRef.current = { owner, mappingId, key };
    try {
      sessionStorage.setItem(storageKey, key);
    } catch {
      // The in-memory key still prevents duplicate clicks in this page session.
    }
    return key;
  };

  const clearAttemptKey = () => {
    const current = attemptRef.current;
    if (!current) return;
    try {
      sessionStorage.removeItem(`vapi-web-call-attempt:${current.owner}:${current.mappingId}`);
    } catch {
      // Ignore unavailable browser storage.
    }
    attemptRef.current = null;
  };

  useEffect(() => {
    let active = true;
    if (!hasCapability('provider_manage')) {
      setStatus('Restricted');
      return () => { active = false; };
    }
    void request<{ success: boolean; assistants: VapiWebAssistant[] }>('/miniapp/vapi/web-assistants', { method: 'GET' })
      .then((result) => {
        if (!active) return;
        const safeAssistants = Array.isArray(result.assistants) ? result.assistants : [];
        setAssistants(safeAssistants);
        setSelectedMappingId(safeAssistants[0] ? String(safeAssistants[0].mappingId) : '');
        setStatus(safeAssistants.length ? 'Ready' : 'No live templates');
      })
      .catch(() => {
        if (!active) return;
        setStatus('Unavailable');
        setError('Web calling is not configured for this Mini App origin, or no synced live template is available.');
      });
    return () => { active = false; };
  }, [hasCapability, request]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const vapi = vapiRef.current;
      vapiRef.current = null;
      if (vapi) {
        void vapi.stop();
        vapi.removeAllListeners();
      }
    };
  }, []);

  const startCall = async () => {
    if (!selectedAssistant || starting || vapiRef.current) return;
    setStarting(true);
    setError('');
    setStatus('Connecting');
    let startingVapi: Vapi | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone unavailable');
      const microphoneCheck = await navigator.mediaDevices.getUserMedia({ audio: true });
      microphoneCheck.getTracks().forEach((track) => track.stop());
      if (!mountedRef.current) return;
      const idempotencyKey = getAttemptKey(selectedAssistant.mappingId);
      const access = await request<VapiWebCallResponse>('/miniapp/vapi/web-calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ mappingId: selectedAssistant.mappingId }),
      });
      if (!mountedRef.current) return;
      if (!access.success || !access.call?.id || !access.call.webCallUrl || access.template?.mappingId !== selectedAssistant.mappingId) {
        throw new Error('Unavailable');
      }

      const { default: VapiClient } = await import('@vapi-ai/web');
      if (!mountedRef.current) return;
      // The backend creates the call using its private API key. The browser receives
      // only this call's join URL/token and reconnects without assistant overrides.
      const vapi = new VapiClient('');
      startingVapi = vapi;
      vapi.on('call-start', () => { if (mountedRef.current) setStatus('In call'); });
      vapi.on('call-end', () => {
        vapiRef.current = null;
        clearAttemptKey();
        if (mountedRef.current) setStatus('Ready');
      });
      vapi.on('error', () => {
        if (mountedRef.current) {
          setStatus('Call error');
          setError('The voice session could not continue. Check microphone access and try again.');
        }
      });
      vapiRef.current = vapi;
      await vapi.reconnect(access.call);
      if (mountedRef.current) {
        setStatus('In call');
      }
    } catch (caught) {
      if (startingVapi) {
        try {
          await startingVapi.stop();
        } catch {
          // Keep the user-facing error generic; the SDK error is not logged.
        }
      }
      vapiRef.current = null;
      if (mountedRef.current) {
        setStatus('Unavailable');
        const code = String((caught as VapiRequestError)?.code || '');
        setError(code === 'vapi_web_call_outcome_unknown'
          ? 'Vapi may have created this call, but the connection result was lost. Check Vapi call logs before starting another call.'
          : 'Unable to start the voice session. Check microphone permission and Vapi web-call configuration.');
      }
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  const stopCall = async () => {
    const vapi = vapiRef.current;
    if (!vapi) return;
    setStarting(true);
    try {
      await vapi.stop();
      vapiRef.current = null;
      clearAttemptKey();
      setStatus('Ready');
      vapi.removeAllListeners();
    } catch {
      setError('Unable to close the voice session.');
    } finally {
      setStarting(false);
    }
  };

  return (
    <UiCard>
      <div className="va-ops-card-header">
        <div className="va-ops-card-headline">
          <h3>Vapi web call test</h3>
          <p className="va-muted">Start a browser voice session with a currently published, compatible Vapi template.</p>
        </div>
        <UiBadge role="status" aria-live="polite" variant={status === 'In call' ? 'success' : status === 'Unavailable' ? 'warning' : 'info'}>
          {status}
        </UiBadge>
      </div>
      <label className="va-field-label" htmlFor="vapi-web-template">Live call template</label>
      <UiSelect
        id="vapi-web-template"
        value={selectedMappingId}
        disabled={starting || Boolean(vapiRef.current) || assistants.length === 0}
        onChange={(event) => setSelectedMappingId(event.target.value)}
      >
        {assistants.length === 0 ? <option value="">No synced live templates</option> : null}
        {assistants.map((assistant) => (
          <option key={assistant.mappingId} value={assistant.mappingId}>
            {assistant.templateName} · v{assistant.templateVersion}
          </option>
        ))}
      </UiSelect>
      <p className="va-muted" aria-live="polite">{error || 'Microphone permission is requested only after you start a call. Vapi usage may be billed.'}</p>
      <div className="va-inline-tools">
        {!vapiRef.current ? (
          <UiButton variant="primary" disabled={starting || !selectedAssistant} onClick={() => { void startCall(); }}>
            {starting ? 'Connecting…' : 'Start browser call'}
          </UiButton>
        ) : (
          <UiButton variant="secondary" disabled={starting} onClick={() => { void stopCall(); }}>
            {starting ? 'Closing…' : 'End browser call'}
          </UiButton>
        )}
      </div>
    </UiCard>
  );
}
