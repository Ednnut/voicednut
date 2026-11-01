'use strict';

class CallECampaignRetentionWorker {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.db = options.db;
    this.intervalMs = Math.max(60000, Math.min(86400000, Number(options.intervalMs) || 3600000));
    this.batchSize = Math.max(1, Math.min(500, Number(options.batchSize) || 100));
    this.setInterval = options.setIntervalFn || setInterval;
    this.clearInterval = options.clearIntervalFn || clearInterval;
    this.timer = null;
    this.inflight = null;
  }

  isConfigured() {
    return this.enabled && typeof this.db?.listCallESensitiveRetentionScopes === 'function' &&
      typeof this.db?.purgeCallESensitiveData === 'function';
  }

  async drain() {
    if (!this.enabled) return { state: 'disabled', businesses_processed: 0, records_purged: 0 };
    if (!this.isConfigured()) return { state: 'not_configured', businesses_processed: 0, records_purged: 0 };
    if (this.inflight) return { state: 'already_running', businesses_processed: 0, records_purged: 0 };
    this.inflight = (async () => {
      const cutoff = new Date().toISOString();
      const businesses = await this.db.listCallESensitiveRetentionScopes(cutoff, this.batchSize);
      let processed = 0;
      let records = 0;
      for (const businessId of businesses) {
        const result = await this.db.purgeCallESensitiveData({ business_id: businessId, actor_id: '0', cutoff });
        processed += 1;
        records += Number(result.expired_goal_runs || 0) + Number(result.expired_missions || 0);
      }
      return { state: 'completed', businesses_processed: processed, records_purged: records };
    })();
    try { return await this.inflight; }
    finally { this.inflight = null; }
  }

  start() {
    if (this.timer) return true;
    if (!this.isConfigured()) return false;
    this.timer = this.setInterval(() => { void this.drain().catch((error) => console.error('CALL-E retention sweep failed', { code: String(error?.code || 'retention_worker_failed') })); }, this.intervalMs);
    this.timer?.unref?.();
    void this.drain().catch((error) => console.error('CALL-E initial retention sweep failed', { code: String(error?.code || 'retention_worker_failed') }));
    return true;
  }

  async stop() {
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
  }
}

module.exports = { CallECampaignRetentionWorker };
