'use strict';

function escapeLegacyMarkdown(value) {
  return [...String(value || '')].map((character) => '_*`[]'.includes(character) ? `\\${character}` : character).join('');
}

function formatVoiceCapabilityMatrix(status = {}) {
  const descriptors = Array.isArray(status.voice_provider_capabilities) ? status.voice_provider_capabilities : [];
  const lines = descriptors.map((descriptor) => {
    const provider = escapeLegacyMarkdown(String(descriptor?.provider || 'unknown').toUpperCase());
    const capabilities = Array.isArray(descriptor?.capabilities) ? descriptor.capabilities : [];
    const operations = descriptor?.operations && typeof descriptor.operations === 'object'
      ? Object.entries(descriptor.operations).filter(([, available]) => available === true).map(([name]) => name)
      : [];
    const reported = [...capabilities, ...operations];
    return `• ${provider}: ${reported.length ? reported.map(escapeLegacyMarkdown).join(', ') : 'no registered call operations'}`;
  });
  const callE = status.call_e_provider;
  if (callE && typeof callE === 'object') {
    const configured = callE.configured === true ? 'configured' : 'not configured';
    const circuit = String(callE.health?.circuitState || 'unknown').replace(/[^a-z_]/g, '');
    const dispatch = callE.health?.dispatchAllowed === true ? 'dispatch available' : 'dispatch blocked';
    lines.push(`• CALL-E: ${configured} · create circuit ${circuit || 'unknown'} · ${dispatch}`);
  }
  const routing = status.call_routing_policy;
  const sections = [];
  if (lines.length) sections.push(`*🧭 Registered Voice Capabilities*\n${lines.join('\n')}`);
  if (routing && typeof routing === 'object') {
    const order = Array.isArray(routing.configured_order) ? routing.configured_order : [];
    const eligible = Array.isArray(routing.eligible_order) ? routing.eligible_order : [];
    const open = Array.isArray(routing.open_circuits) ? routing.open_circuits : [];
    const blocked = Array.isArray(routing.blocked_providers) ? routing.blocked_providers : [];
    sections.push(`*🛣 Call Routing Policy*\n` + [
      `• Order: ${order.length ? order.map(escapeLegacyMarkdown).join(' → ') : 'none'}`,
      `• Eligible now: ${eligible.length ? eligible.map(escapeLegacyMarkdown).join(' → ') : 'none'}`,
      `• Failover: ${routing.failover_enabled === true ? 'enabled for confirmed not-submitted/rejected attempts' : 'disabled'}`,
      `• Open circuits: ${open.length ? open.map(escapeLegacyMarkdown).join(', ') : 'none'}`,
      `• Blocked: ${blocked.length ? blocked.map((item) => `${escapeLegacyMarkdown(item.provider)} (${escapeLegacyMarkdown(item.reason)})`).join(', ') : 'none'}`,
    ].join('\n'));
  }
  return sections.join('\n\n');
}

module.exports = { formatVoiceCapabilityMatrix };
