const PLATFORM_CAPABILITY_STATES = Object.freeze({
  IMPLEMENTED: "implemented",
  PLANNED: "planned",
  NOT_IMPLEMENTED: "not_implemented",
});

const PROVIDER_CONTRACT_STATES = Object.freeze({
  DOCUMENTED: "documented",
  UNKNOWN: "unknown",
  UNSUPPORTED: "unsupported",
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function capability(providerContract, platform, documentation, note = null) {
  return deepFreeze({
    providerContract,
    platform,
    documentation,
    ...(note ? { note } : {}),
  });
}

// This catalog describes vendor contracts separately from VOICEDNUT runtime
// support. It is deliberately not a routing registry: only an adapter that is
// registered in VoiceProviderRegistry can execute provider operations.
const VOICE_PROVIDER_CAPABILITY_REGISTRY = deepFreeze({
  cartesia: {
    managed_agents: {
      layer: "telephony_and_agent_runtime",
      capabilities: {
        inbound_call: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.PLANNED,
          "https://docs.cartesia.ai/api-reference/agents/phone-numbers/import",
          "Inbound assignment is configured through an associated phone number and agent.",
        ),
        outbound_call: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/calls/create-outbound-call",
          "Available through the guarded Cartesia admin call service; real dispatch is default-off, requires an exact preview approval and local idempotency key.",
        ),
        scheduled_call_batch: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.PLANNED,
          "https://docs.cartesia.ai/api-reference/agents/call-batches/create-call-batch",
          "Batch requests support scheduling; current documented maximum is 5,000 recipients.",
        ),
        call_status_read: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/calls/get-call",
        ),
        phone_number_inventory_read: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/phone-numbers/list",
          "Admin-only list and detail routes normalize provider ownership and omit credential fields.",
        ),
        phone_number_agent_assignment: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/phone-numbers/update",
          "Admin-only assignment updates require an exact current-state preview, explicit approval, an independent default-off gate, and local idempotency; inbound routing follows Cartesia's assignment.",
        ),
        call_transcript_read: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/calls/get-call",
          "Provider responses may omit transcript content when zero-data-retention is enabled.",
        ),
        call_audio_read: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/calls/download-call-audio",
          "Admin-only download enforces business scope, ended-call status, retention checks, and a 25 MiB response limit.",
        ),
        managed_agent_websocket: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/agent-websocket",
          "Server-side session connector is wired to the existing Twilio Media Streams path for raw μ-law/8000 audio, interruption clearing, DTMF input, turn events, and guarded client tools. Runtime selection requires a live script, two default-off Cartesia gates, and server-side credentials. This does not deploy the standalone Python Line SDK.",
        ),
        cancel_started_call: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/calls/cancel-call",
          "Cancellation is documented for calls in the started state.",
        ),
        phone_number_list_import_and_assignment: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/phone-numbers/import",
          "Inventory, provider-number import, and agent assignment are exposed through admin-only preview/confirmation routes with local idempotency.",
        ),
        phone_number_provisioning: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/phone-numbers/provision",
          "Admin-only, independently default-off, idempotent operation requires exact preview approval and typed label confirmation because it may create a billable number.",
        ),
        phone_number_release: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/phone-numbers/delete",
          "Admin-only release is preview-confirmed, typed-number-confirmed, locally idempotent, and reconciles an ambiguous DELETE by reading inventory; Cartesia-owned numbers can be permanently released.",
        ),
        twilio_provider_link: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/providers/create",
          "Admin-only HTTPS workflow is separately default-off, preview-confirmed, requires typed account SID confirmation, and uses local idempotency; Twilio credentials are never persisted or returned.",
        ),
        telephony_provider_inventory_read: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/providers/list",
          "Admin-only provider inventory exposes normalized metadata and never returns credentials.",
        ),
        telephony_provider_detail_read: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/providers/get",
          "Admin-only provider detail is normalized and strips any credential values returned by Cartesia.",
        ),
        twilio_provider_credential_rotation: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/providers/update",
          "HTTPS-only update is default-off, preview-confirmed, locally idempotent, and sends credentials only to Cartesia; the provider validates credentials against assigned numbers and VOICEDNUT returns sanitized errors.",
        ),
        telephony_provider_delete: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/providers/delete",
          "HTTPS-only deletion is default-off, requires an exact preview, typed label, idempotency key, and complete paginated verification that no phone numbers remain linked.",
        ),
        sip_trunk_provider_create: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/providers/create",
          "Admin-only create is default-off, preview-confirmed, HTTPS-only, and locally idempotent; inbound access requires digest credentials or a source IP allowlist, and credentials are never persisted or returned.",
        ),
        sip_trunk_provider_update: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/providers/update",
          "Admin-only update sends a complete validated inbound/outbound SIP configuration, requires HTTPS, preview approval, typed provider ID and linked-number count, and remains behind the SIP-specific default-off mutation gate.",
        ),
        sip_trunk_health_probe: capability(
          PROVIDER_CONTRACT_STATES.UNKNOWN,
          PLATFORM_CAPABILITY_STATES.NOT_IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/providers/get",
          "The provider detail API exposes configuration metadata; no active SIP reachability probe is documented, so VOICEDNUT does not report carrier health.",
        ),
        sip_trunk_provider_link: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.PLANNED,
          "https://docs.cartesia.ai/api-reference/agents/providers/create",
          "The current provider API documents Twilio and SIP Trunk types; no direct Plivo or Vonage type was found.",
        ),
        call_status_webhook: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/line/infrastructure/observability#webhooks",
          "Processes documented lifecycle events with the shared webhook secret and stable webhook_request_id deduplication; it does not configure webhook delivery.",
        ),
        ivr_dtmf: capability(
          PROVIDER_CONTRACT_STATES.UNKNOWN,
          PLATFORM_CAPABILITY_STATES.NOT_IMPLEMENTED,
          "https://docs.cartesia.ai/_llms/en/api.txt",
          "No verified Managed Agents DTMF/IVR API contract is recorded here.",
        ),
        call_transfer: capability(
          PROVIDER_CONTRACT_STATES.UNKNOWN,
          PLATFORM_CAPABILITY_STATES.NOT_IMPLEMENTED,
          "https://docs.cartesia.ai/_llms/en/api.txt",
          "Line runtime transfer tools are a separate mode and do not establish Managed Agents API support.",
        ),
        managed_agent_interruption_handling: capability(
          PROVIDER_CONTRACT_STATES.UNKNOWN,
          PLATFORM_CAPABILITY_STATES.NOT_IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/agents/agent-websocket",
          "Interruption and turn-taking are documented for Line; Managed Agents support is not inferred from that runtime.",
        ),
      },
    },
    sonic: {
      layer: "speech_generation",
      capabilities: {
        tts_sse: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/tts/sse",
          "Incremental PCM playback is implemented only through the Twilio adaptive stream queue. Cache hits and bytes transport remain buffered; Vonage and Plivo use their provider-specific buffered audio envelopes.",
        ),
        voice_catalog_read: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/voices/list",
          "Admin-only paginated search returns a curated voice schema; preview URLs and unneeded provider metadata are not exposed.",
        ),
        tts_bytes: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/tts/bytes",
          "Optional complete-response HTTP transport returns raw PCM16 through the existing buffered TTS event contract; SSE remains the default.",
        ),
        tts_websocket: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/tts/websocket",
          "Admin-only server session supports bounded text continuations, validated contexts, cancellation, documented raw PCM formats, timestamps, flushes, and generation controls. It is not wired as an automatic telephony media bridge.",
        ),
      },
    },
    ink: {
      layer: "speech_recognition",
      capabilities: {
        realtime_stt_auto_turns: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/stt/turns/websocket",
          "Optional server-side Ink 2 auto-turn adapter maps incremental and completed transcript events into the existing transcription service event contract. It maps VOICEDNUT linear16/μ-law to documented pcm_s16le/pcm_mulaw, preserves sample rate, uses 2026-08-14 versioned WSS authentication, and is documented for English, French, Hindi, Japanese, and Spanish.",
        ),
        realtime_stt_manual_turns: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/stt/websocket",
          "Bounded uploaded PCM uses the manual WebSocket endpoint and explicit finalize/close commands; this is not live microphone streaming.",
        ),
        batch_stt: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.IMPLEMENTED,
          "https://docs.cartesia.ai/api-reference/stt/transcribe",
          "Admin-only raw audio upload is size/type/language validated; normalized transcript data is returned without persisting or logging audio or transcript content.",
        ),
      },
    },
    line: {
      layer: "agent_runtime",
      capabilities: {
        realtime_agent_runtime: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.PLANNED,
          "https://docs.cartesia.ai/line/introduction",
          "The official cartesia-line SDK and deployment CLI are Python based. VOICEDNUT's optional Node call path runs a hosted Managed Agent WebSocket only; it does not embed/deploy arbitrary Python Line agent code. Call-specific consent verification and the Line authoring/deployment workflows remain unimplemented.",
        ),
        interruption_and_turn_taking: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.PLANNED,
          "https://docs.cartesia.ai/line/introduction",
        ),
        agent_tools_and_handoffs: capability(
          PROVIDER_CONTRACT_STATES.DOCUMENTED,
          PLATFORM_CAPABILITY_STATES.PLANNED,
          "https://github.com/cartesia-ai/line",
        ),
      },
    },
  },
});

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function getOwn(object, key) {
  return object && Object.hasOwn(object, key) ? object[key] : null;
}

function getVoiceProviderMode(provider, mode) {
  const providerModes = getOwn(VOICE_PROVIDER_CAPABILITY_REGISTRY, normalizeKey(provider));
  return getOwn(providerModes, normalizeKey(mode));
}

function getVoiceProviderCapability(provider, mode, capabilityName) {
  const capabilities = getVoiceProviderMode(provider, mode)?.capabilities;
  return getOwn(capabilities, normalizeKey(capabilityName));
}

function listVoiceProviderCapabilities(provider, mode) {
  const modeDescriptor = getVoiceProviderMode(provider, mode);
  if (!modeDescriptor) return [];
  return Object.entries(modeDescriptor.capabilities).map(([name, descriptor]) => ({
    name,
    ...descriptor,
  }));
}

function isVoiceProviderCapabilityImplemented(provider, mode, capabilityName) {
  const descriptor = getVoiceProviderCapability(provider, mode, capabilityName);
  return descriptor?.providerContract === PROVIDER_CONTRACT_STATES.DOCUMENTED &&
    descriptor?.platform === PLATFORM_CAPABILITY_STATES.IMPLEMENTED;
}

module.exports = {
  PLATFORM_CAPABILITY_STATES,
  PROVIDER_CONTRACT_STATES,
  VOICE_PROVIDER_CAPABILITY_REGISTRY,
  getVoiceProviderMode,
  getVoiceProviderCapability,
  listVoiceProviderCapabilities,
  isVoiceProviderCapabilityImplemented,
};
