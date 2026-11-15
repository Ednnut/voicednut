'use strict';

const AUTH_FAILURE_REASONS = Object.freeze([
  'missing_headers',
  'invalid_timestamp',
  'timestamp_out_of_range',
  'invalid_signature',
  'replay_detected',
  'other',
]);
const AUTH_FAILURE_REASON_SET = new Set(AUTH_FAILURE_REASONS);
const BUCKET_MS = 60_000;
const MAX_WINDOW_MINUTES = 1440;

class ApiAuthFailureMetrics {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.buckets = new Map();
  }

  record(reason, atMs = this.now()) {
    const time = Number(atMs);
    if (!Number.isFinite(time)) return false;
    const bucket = Math.floor(time / BUCKET_MS);
    const key = AUTH_FAILURE_REASON_SET.has(reason) ? reason : 'other';
    let counts = this.buckets.get(bucket);
    if (!counts) {
      counts = Object.fromEntries(AUTH_FAILURE_REASONS.map((name) => [name, 0]));
      this.buckets.set(bucket, counts);
    }
    counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + 1);
    this.prune(Math.floor(Number(this.now()) / BUCKET_MS));
    return true;
  }

  get(windowMinutes = 60) {
    const requested = Number(windowMinutes);
    const window = Number.isFinite(requested)
      ? Math.max(1, Math.min(MAX_WINDOW_MINUTES, Math.floor(requested)))
      : 60;
    const currentBucket = Math.floor(Number(this.now()) / BUCKET_MS);
    const firstBucket = currentBucket - window + 1;
    const totals = Object.fromEntries(AUTH_FAILURE_REASONS.map((name) => [name, 0]));
    for (const [bucket, counts] of this.buckets) {
      if (bucket < firstBucket || bucket > currentBucket) continue;
      for (const reason of AUTH_FAILURE_REASONS) {
        totals[reason] = Math.min(Number.MAX_SAFE_INTEGER, totals[reason] + counts[reason]);
      }
    }
    this.prune(currentBucket);
    return {
      window_minutes: window,
      total: AUTH_FAILURE_REASONS.reduce((sum, reason) => sum + totals[reason], 0),
      by_reason: totals,
      scope: 'api_process_memory',
    };
  }

  prune(currentBucket = Math.floor(Number(this.now()) / BUCKET_MS)) {
    const oldest = currentBucket - MAX_WINDOW_MINUTES + 1;
    for (const bucket of this.buckets.keys()) {
      if (bucket < oldest || bucket > currentBucket) this.buckets.delete(bucket);
    }
  }
}

module.exports = { ApiAuthFailureMetrics, AUTH_FAILURE_REASONS };
