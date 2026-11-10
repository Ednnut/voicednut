const assert = require("node:assert/strict");
const {
  PLATFORM_CAPABILITY_STATES,
  PROVIDER_CONTRACT_STATES,
  VOICE_PROVIDER_CAPABILITY_REGISTRY,
  getVoiceProviderCapability,
  getVoiceProviderMode,
  isVoiceProviderCapabilityImplemented,
  listVoiceProviderCapabilities,
} = require("../adapters/voiceProviderCapabilityRegistry");
const { listSupportedProviders } = require("../adapters/providerFlowPolicy");

describe("voice provider capability registry", () => {
  it("separates Cartesia vendor support from VOICEDNUT implementation status", () => {
    const outbound = getVoiceProviderCapability(" CARTESIA ", "managed_agents", "outbound_call");
    assert.equal(outbound.providerContract, PROVIDER_CONTRACT_STATES.DOCUMENTED);
    assert.equal(outbound.platform, PLATFORM_CAPABILITY_STATES.IMPLEMENTED);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "outbound_call"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "inbound_call"), false);
  });

  it("reports the implemented Cartesia speech services without claiming WebSocket TTS support", () => {
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "sonic", "tts_sse"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "sonic", "tts_bytes"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "sonic", "tts_websocket"), false);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "sonic", "voice_catalog_read"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "ink", "batch_stt"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "ink", "realtime_stt_auto_turns"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "ink", "realtime_stt_manual_turns"), false);
  });

  it("exposes implemented Cartesia phone management and verified provider lifecycle operations", () => {
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "phone_number_inventory_read"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "phone_number_agent_assignment"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "phone_number_list_import_and_assignment"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "phone_number_provisioning"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "phone_number_release"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "twilio_provider_link"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "sip_trunk_provider_link"), false);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "telephony_provider_inventory_read"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "sip_trunk_provider_create"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "telephony_provider_detail_read"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "twilio_provider_credential_rotation"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "telephony_provider_delete"), true);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "sip_trunk_provider_update"), true);
  });

  it("marks documented lifecycle webhooks implemented without implying registration support", () => {
    const webhook = getVoiceProviderCapability("cartesia", "managed_agents", "call_status_webhook");
    assert.equal(webhook.providerContract, PROVIDER_CONTRACT_STATES.DOCUMENTED);
    assert.equal(isVoiceProviderCapabilityImplemented("cartesia", "managed_agents", "call_status_webhook"), true);
    assert.match(webhook.note, /does not configure webhook delivery/);
    assert.equal(getVoiceProviderCapability("cartesia", "managed_agents", "ivr_dtmf").providerContract, PROVIDER_CONTRACT_STATES.UNKNOWN);
    assert.equal(getVoiceProviderCapability("cartesia", "managed_agents", "call_transfer").providerContract, PROVIDER_CONTRACT_STATES.UNKNOWN);
    const sipHealth = getVoiceProviderCapability("cartesia", "managed_agents", "sip_trunk_health_probe");
    assert.equal(sipHealth.providerContract, PROVIDER_CONTRACT_STATES.UNKNOWN);
    assert.equal(sipHealth.platform, PLATFORM_CAPABILITY_STATES.NOT_IMPLEMENTED);
    assert.match(sipHealth.note, /does not report carrier health/);
  });

  it("distinguishes the hosted Managed Agent WebSocket adapter from full Line runtime support", () => {
    const managedWs = getVoiceProviderCapability("cartesia", "managed_agents", "managed_agent_websocket");
    assert.equal(managedWs.platform, PLATFORM_CAPABILITY_STATES.IMPLEMENTED);
    assert.match(managedWs.note, /wired to the existing Twilio Media Streams path/);
    const lineRuntime = getVoiceProviderCapability("cartesia", "line", "realtime_agent_runtime");
    assert.equal(lineRuntime.platform, PLATFORM_CAPABILITY_STATES.PLANNED);
    assert.match(lineRuntime.note, /deployment CLI are Python based/);
  });

  it("does not expose catalogued Cartesia features as executable telephony routing providers", () => {
    assert.deepEqual(listSupportedProviders("call"), ["twilio", "vonage", "plivo", "call_e"]);
    assert.equal(getVoiceProviderMode("cartesia", "managed_agents").layer, "telephony_and_agent_runtime");
  });

  it("returns empty lists for unknown providers or modes and immutable source metadata", () => {
    assert.deepEqual(listVoiceProviderCapabilities("unknown", "managed_agents"), []);
    assert.deepEqual(listVoiceProviderCapabilities("cartesia", "unknown"), []);
    assert.equal(getVoiceProviderMode("constructor", "prototype"), null);
    assert.equal(getVoiceProviderCapability("cartesia", "managed_agents", "toString"), null);
    assert.equal(Object.isFrozen(VOICE_PROVIDER_CAPABILITY_REGISTRY.cartesia.managed_agents.capabilities), true);
  });
});
