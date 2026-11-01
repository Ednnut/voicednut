'use strict';

const { PROVIDER_CHANNELS, resolveProviderExecutionOrder, normalizeProviderName } = require('../adapters/providerFlowPolicy');

function buildConfiguredProviderOrder(preferredProvider, configuredOrder = [], supportedProviders = []) {
  const supported = new Set((Array.isArray(supportedProviders) ? supportedProviders : []).map(normalizeProviderName).filter(Boolean));
  const ordered = [];
  const append = (provider) => {
    const normalized = normalizeProviderName(provider);
    if (normalized && supported.has(normalized) && !ordered.includes(normalized)) ordered.push(normalized);
  };
  append(preferredProvider);
  for (const provider of Array.isArray(configuredOrder) ? configuredOrder : []) append(provider);
  for (const provider of Array.isArray(supportedProviders) ? supportedProviders : []) append(provider);
  return ordered;
}

function summarizeCallRoutingPolicy(options = {}) {
  const order = buildConfiguredProviderOrder(options.preferredProvider, options.configuredOrder, options.supportedProviders);
  const plan = resolveProviderExecutionOrder({
    channel: PROVIDER_CHANNELS.CALL,
    preferredProvider: options.preferredProvider,
    providers: order,
    readiness: options.readiness || {},
    requestedFlow: options.requestedFlow || 'outbound_voice',
    context: options.context || {},
    failoverEnabled: options.failoverEnabled !== false,
    isProviderDegraded: options.isProviderDegraded,
  });
  const openCircuits = order.filter((provider) => options.circuitState?.[provider] === 'open');
  return Object.freeze({
    configured_order: Object.freeze(order),
    failover_enabled: options.failoverEnabled !== false,
    selected_provider: plan.selected_provider,
    eligible_order: Object.freeze(plan.attempt_order),
    blocked_providers: Object.freeze(plan.blocked_providers),
    degraded_providers: Object.freeze(plan.degraded_providers),
    open_circuits: Object.freeze(openCircuits),
    uncertain_submission_failover: false,
  });
}

module.exports = { buildConfiguredProviderOrder, summarizeCallRoutingPolicy };
