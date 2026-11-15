'use strict';

const { randomUUID } = require('node:crypto');

const AUTH_FAILURE_REASONS = Object.freeze([
  'missing_headers',
  'invalid_timestamp',
  'timestamp_out_of_range',
  'invalid_signature',
  'replay_detected',
  'other',
]);
const MINIAPP_AUTH_FAILURE_REASONS = Object.freeze([
  'miniapp_missing_session',
  'miniapp_invalid_session',
  'miniapp_access_denied',
  'miniapp_revoked_session',
  'miniapp_missing_init_data',
  'miniapp_invalid_init_data',
  'miniapp_invalid_init_signature',
  'miniapp_replayed_init_data',
]);
const ADMIN_AUTH_FAILURE_REASONS = Object.freeze([
  'admin_token_missing',
  'admin_token_invalid',
]);
const WEBHOOK_AUTH_FAILURE_REASONS = Object.freeze(['webhook_auth_rejected']);
const ALL_AUTH_FAILURE_REASONS = Object.freeze([
  ...AUTH_FAILURE_REASONS,
  ...MINIAPP_AUTH_FAILURE_REASONS,
  ...ADMIN_AUTH_FAILURE_REASONS,
  ...WEBHOOK_AUTH_FAILURE_REASONS,
]);
const AUTH_FAILURE_REASON_SET = new Set(ALL_AUTH_FAILURE_REASONS);
const BUCKET_MS = 60_000;
const MAX_WINDOW_MINUTES = 1440;

class ApiAuthFailureMetrics {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.buckets = new Map();
    this.pending = new Set();
    this.flushInProgress = false;
    this.activeFlushPromise = null;
    this.processInstanceId = typeof options.processInstanceId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(options.processInstanceId)
      ? options.processInstanceId
      : randomUUID();
  }

  record(reason, atMs = this.now()) {
    const time = Number(atMs);
    if (!Number.isFinite(time)) return false;
    const bucket = Math.floor(time / BUCKET_MS);
    const key = AUTH_FAILURE_REASON_SET.has(reason) ? reason : 'other';
    let counts = this.buckets.get(bucket);
    if (!counts) {
      counts = Object.fromEntries(ALL_AUTH_FAILURE_REASONS.map((name) => [name, 0]));
      this.buckets.set(bucket, counts);
    }
    counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + 1);
    this.pending.add(bucket);
    this.prune(Math.floor(Number(this.now()) / BUCKET_MS));
    return true;
  }

  async flush(persist) {
    if (typeof persist !== 'function') return false;
    if (this.flushInProgress) {
      await this.activeFlushPromise;
      return this.pending.size ? this.flush(persist) : false;
    }
    if (this.pending.size === 0) return false;
    this.flushInProgress = true;
    const pending = this.pending;
    this.pending = new Set();
    const entries = [];
    for (const bucket of pending) {
      const counts = this.buckets.get(bucket);
      if (!counts) continue;
      for (const reason of ALL_AUTH_FAILURE_REASONS) {
        const count = counts[reason];
        if (count > 0) entries.push({ bucket_minute: bucket, process_instance_id: this.processInstanceId, reason, count });
      }
    }
    if (!entries.length) {
      this.flushInProgress = false;
      return false;
    }
    this.activeFlushPromise = (async () => {
      try {
        await persist(entries);
        return true;
      } catch (error) {
        for (const bucket of pending) this.pending.add(bucket);
        throw error;
      }
    })();
    try {
      return await this.activeFlushPromise;
    } finally {
      this.flushInProgress = false;
      this.activeFlushPromise = null;
    }
  }

  get(windowMinutes = 60) {
    const requested = Number(windowMinutes);
    const window = Number.isFinite(requested)
      ? Math.max(1, Math.min(MAX_WINDOW_MINUTES, Math.floor(requested)))
      : 60;
    const currentBucket = Math.floor(Number(this.now()) / BUCKET_MS);
    const firstBucket = currentBucket - window + 1;
    const totals = Object.fromEntries(ALL_AUTH_FAILURE_REASONS.map((name) => [name, 0]));
    for (const [bucket, counts] of this.buckets) {
      if (bucket < firstBucket || bucket > currentBucket) continue;
      for (const reason of ALL_AUTH_FAILURE_REASONS) {
        totals[reason] = Math.min(Number.MAX_SAFE_INTEGER, totals[reason] + counts[reason]);
      }
    }
    this.prune(currentBucket);
    const byReason = Object.fromEntries(AUTH_FAILURE_REASONS.map((reason) => [reason, totals[reason]]));
    const miniappByReason = Object.fromEntries(MINIAPP_AUTH_FAILURE_REASONS.map((reason) => [reason, totals[reason]]));
    return {
      window_minutes: window,
      total: AUTH_FAILURE_REASONS.reduce((sum, reason) => sum + totals[reason], 0),
      by_reason: byReason,
      miniapp_session: {
        total: MINIAPP_AUTH_FAILURE_REASONS.reduce((sum, reason) => sum + totals[reason], 0),
        by_reason: miniappByReason,
      },
      admin_token: {
        total: ADMIN_AUTH_FAILURE_REASONS.reduce((sum, reason) => sum + totals[reason], 0),
        by_reason: Object.fromEntries(ADMIN_AUTH_FAILURE_REASONS.map((reason) => [reason, totals[reason]])),
      },
      webhook_auth: {
        total: WEBHOOK_AUTH_FAILURE_REASONS.reduce((sum, reason) => sum + totals[reason], 0),
        by_reason: Object.fromEntries(WEBHOOK_AUTH_FAILURE_REASONS.map((reason) => [reason, totals[reason]])),
      },
      scope: 'api_process_memory',
    };
  }

  prune(currentBucket = Math.floor(Number(this.now()) / BUCKET_MS)) {
    const oldest = currentBucket - MAX_WINDOW_MINUTES + 1;
    for (const bucket of this.buckets.keys()) {
      if (bucket < oldest || bucket > currentBucket) this.buckets.delete(bucket);
    }
    for (const bucket of this.pending) {
      if (bucket < oldest || bucket > currentBucket) this.pending.delete(bucket);
    }
  }
}

module.exports = { ApiAuthFailureMetrics, AUTH_FAILURE_REASONS, MINIAPP_AUTH_FAILURE_REASONS, ADMIN_AUTH_FAILURE_REASONS, WEBHOOK_AUTH_FAILURE_REASONS };
