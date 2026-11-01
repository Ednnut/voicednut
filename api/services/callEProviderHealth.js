'use strict';

class CallEProviderHealth {
  constructor(options = {}) {
    this.threshold = Math.max(1, Math.min(20, Number(options.threshold) || 3));
    this.windowMs = Math.max(1000, Math.min(60 * 60 * 1000, Number(options.windowMs) || 120000));
    this.cooldownMs = Math.max(1, Math.min(60 * 60 * 1000, Number(options.cooldownMs) || 120000));
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.failures = [];
    this.lastErrorAt = null;
    this.lastSuccessAt = null;
    this.openUntil = 0;
    this.halfOpenInFlight = false;
  }

  canDispatch() {
    const now = this.now();
    this.failures = this.failures.filter((timestamp) => now - timestamp <= this.windowMs);
    if (this.openUntil > now) return false;
    if (this.openUntil && this.openUntil <= now) {
      if (this.halfOpenInFlight) return false;
      this.halfOpenInFlight = true;
    }
    return true;
  }

  observe(metric = {}) {
    if (!['call.create', 'goal_run.create'].includes(metric.operation)) return;
    const now = this.now();
    if (metric.outcome === 'success') {
      this.lastSuccessAt = new Date(now).toISOString();
      this.failures = [];
      this.openUntil = 0;
      this.halfOpenInFlight = false;
      return;
    }

    const status = Number(metric.statusCode);
    const retryableFailure = status === 429 || status >= 500 ||
      ['call_e_timeout', 'call_e_network_error'].includes(String(metric.errorCode || ''));
    this.halfOpenInFlight = false;
    if (!retryableFailure) return;
    this.lastErrorAt = new Date(now).toISOString();
    this.failures = this.failures.filter((timestamp) => now - timestamp <= this.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.threshold) this.openUntil = now + this.cooldownMs;
  }

  snapshot() {
    const now = this.now();
    this.failures = this.failures.filter((timestamp) => now - timestamp <= this.windowMs);
    const circuitState = this.openUntil > now
      ? 'open'
      : this.openUntil > 0
        ? 'half_open'
        : 'closed';
    return Object.freeze({
      scope: 'api_process_memory',
      circuitState,
      dispatchAllowed: circuitState !== 'open' && !this.halfOpenInFlight,
      recentFailureCount: this.failures.length,
      failureThreshold: this.threshold,
      windowMs: this.windowMs,
      cooldownMs: this.cooldownMs,
      lastErrorAt: this.lastErrorAt,
      lastSuccessAt: this.lastSuccessAt,
      retryAt: circuitState === 'open' ? new Date(this.openUntil).toISOString() : null,
    });
  }
}

const sharedCallEProviderHealth = new CallEProviderHealth();

module.exports = { CallEProviderHealth, sharedCallEProviderHealth };
