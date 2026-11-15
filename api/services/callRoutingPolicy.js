'use strict';

const { PROVIDER_CHANNELS, resolveProviderExecutionOrder, normalizeProviderName } = require('../adapters/providerFlowPolicy');
const { VOICE_PROVIDER_OPERATIONS } = require('../adapters/voiceProviderRegistry');

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
    failoverEnabled: options.failoverEnabled === true,
    isProviderDegraded: options.isProviderDegraded,
  });
  const openCircuits = order.filter((provider) => options.circuitState?.[provider] === 'open');
  return Object.freeze({
    configured_order: Object.freeze(order),
    failover_enabled: options.failoverEnabled === true,
    selected_provider: plan.selected_provider,
    eligible_order: Object.freeze(plan.attempt_order),
    blocked_providers: Object.freeze(plan.blocked_providers),
    degraded_providers: Object.freeze(plan.degraded_providers),
    open_circuits: Object.freeze(openCircuits),
    uncertain_submission_failover: false,
  });
}

function recommendationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function recommendVoiceProvider(options = {}) {
  const operation = String(options.operation || VOICE_PROVIDER_OPERATIONS.OUTBOUND_CREATE).trim().toLowerCase();
  if (!Object.values(VOICE_PROVIDER_OPERATIONS).includes(operation)) {
    throw recommendationError('provider_operation_unknown', 'The requested provider operation is unknown');
  }
  if (![VOICE_PROVIDER_OPERATIONS.OUTBOUND_CREATE, VOICE_PROVIDER_OPERATIONS.OUTBOUND_TASK_CREATE].includes(operation)) {
    throw recommendationError('provider_operation_not_recommendable', 'Provider readiness is only defined for outbound call and task creation');
  }
  const descriptors = Array.isArray(options.descriptors) ? options.descriptors : [];
  const knownCapabilities = new Set(descriptors.flatMap((descriptor) =>
    Array.isArray(descriptor?.capabilities) ? descriptor.capabilities.map((value) => String(value).trim().toLowerCase()) : []));
  const requiredCapabilities = Array.isArray(options.requiredCapabilities)
    ? [...new Set(options.requiredCapabilities.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  if (requiredCapabilities.length > 8) {
    throw recommendationError('provider_capability_limit_exceeded', 'At most 8 required capabilities may be requested');
  }
  const unknownCapabilities = requiredCapabilities.filter((value) => !knownCapabilities.has(value));
  if (unknownCapabilities.length) {
    throw recommendationError('provider_capability_unknown', 'One or more requested capabilities are not registered');
  }

  const preferredProvider = normalizeProviderName(options.preferredProvider);
  const descriptorByProvider = new Map(descriptors.map((descriptor) => [
    normalizeProviderName(descriptor?.provider), descriptor,
  ]).filter(([provider]) => provider));
  const descriptorOrder = descriptors.map((descriptor) => normalizeProviderName(descriptor?.provider)).filter(Boolean);
  const order = buildConfiguredProviderOrder(null, options.configuredOrder || descriptorOrder, descriptorOrder);
  const readiness = options.readiness && typeof options.readiness === 'object' ? options.readiness : {};
  const health = options.health && typeof options.health === 'object' ? options.health : {};

  const providers = order.map((provider) => {
    const descriptor = descriptorByProvider.get(provider);
    const supportedCapabilities = new Set(Array.isArray(descriptor?.capabilities)
      ? descriptor.capabilities.map((value) => String(value).trim().toLowerCase())
      : []);
    const operationSupported = descriptor?.operations?.[operation] === true;
    const unsupportedCapabilities = requiredCapabilities.filter((capability) => !supportedCapabilities.has(capability));
    const configured = Object.hasOwn(readiness, provider) ? readiness[provider] === true : null;
    const healthEntry = health[provider] && typeof health[provider] === 'object' ? health[provider] : {};
    const circuitState = ['closed', 'half_open', 'open'].includes(String(healthEntry.circuit_state || '').toLowerCase())
      ? String(healthEntry.circuit_state).toLowerCase()
      : null;
    const operationalState = healthEntry.operational_state === 'available'
      ? 'available'
      : healthEntry.degraded === true || circuitState === 'open'
        ? 'temporarily_unavailable'
        : 'unverified';
    const blockers = [];
    const reasons = [];
    if (operationSupported) reasons.push('operation_supported');
    else blockers.push('operation_unsupported');
    if (!unsupportedCapabilities.length) reasons.push('required_capabilities_supported');
    else blockers.push('required_capabilities_unsupported');
    if (configured === true) reasons.push('provider_configured');
    else blockers.push(configured === false ? 'provider_not_configured' : 'configuration_unknown');
    if (operationalState === 'available') reasons.push('provider_available');
    else if (operationalState === 'temporarily_unavailable') blockers.push('provider_temporarily_unavailable');
    else reasons.push('provider_health_not_verified');
    return {
      provider,
      operation_supported: operationSupported,
      required_capabilities_supported: unsupportedCapabilities.length === 0,
      unsupported_capabilities: unsupportedCapabilities,
      configuration_state: configured === true ? 'configured' : configured === false ? 'missing' : 'unknown',
      operational_state: operationalState,
      circuit_state: circuitState,
      observation_scope: healthEntry.observation_scope || 'unknown',
      eligible: blockers.length === 0,
      reasons,
      blockers,
    };
  });

  const eligible = providers.filter((provider) => provider.eligible);
  const preferred = preferredProvider ? providers.find((provider) => provider.provider === preferredProvider) : null;
  let recommended = null;
  let reason = 'no_eligible_provider';
  if (preferredProvider) {
    if (preferred?.eligible) {
      recommended = preferred.provider;
      reason = 'explicit_preference';
    } else {
      reason = preferred ? 'explicit_preference_ineligible' : 'explicit_provider_not_registered';
    }
  } else if (eligible.length) {
    recommended = eligible[0].provider;
    reason = 'configured_order';
  }

  return {
    registry_scope: 'voice_provider_registry',
    operation,
    required_capabilities: requiredCapabilities,
    explicit_preference: preferredProvider || null,
    recommendation: { provider: recommended, reason },
    alternatives: eligible.filter((candidate) => candidate.provider !== recommended),
    providers,
  };
}

module.exports = { buildConfiguredProviderOrder, summarizeCallRoutingPolicy, recommendVoiceProvider };
