'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

describe('platform anomaly metrics', function () {
  this.timeout(120000);

  it('returns bounded aggregates from calls, provider diagnostics, retries, and auth alerts', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-anomaly-metrics-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      await new Promise((resolve, reject) => db.db.run(
        `INSERT INTO calls (call_sid, phone_number, status, telephony_provider, error_code, created_at) VALUES
          ('call-current', '+15555550101', 'completed', NULL, NULL, CURRENT_TIMESTAMP),
          ('call-previous', '+15555550102', 'failed', NULL, NULL, datetime('now', '-90 minutes')),
          ('call-error-twilio', '+15555550103', 'failed', 'twilio', 'provider_rejected', CURRENT_TIMESTAMP),
          ('call-error-plivo', '+15555550104', 'error', 'plivo', 'provider_timeout', CURRENT_TIMESTAMP)`,
        (error) => error ? reject(error) : resolve(),
      ));
      await new Promise((resolve, reject) => db.db.run(
        `INSERT INTO call_jobs (job_type, run_at, status, attempts, updated_at) VALUES ('callback', CURRENT_TIMESTAMP, 'pending', 3, CURRENT_TIMESTAMP)`,
        (error) => error ? reject(error) : resolve(),
      ));
      await db.logProviderDiagnosticsSnapshot([{ provider: 'twilio', ready: false, circuit_state: 'open', reason_code: 'provider_unavailable' }]);
      await db.logServiceHealth('miniapp_alert', 'auth_failures_threshold', { signal: 'auth_failures' });

      const metrics = await db.getPlatformAnomalyMetrics(60);
      assert.deepEqual(metrics.calls, { current_window: 3, previous_window: 1, failed: 2 });
      assert.equal(metrics.provider_open_count, 1);
      assert.equal(metrics.open_providers[0].provider, 'twilio');
      assert.equal(metrics.provider_call_error_count, 2);
      assert.deepEqual(metrics.provider_call_errors, [{ provider: 'plivo', count: 1 }, { provider: 'twilio', count: 1 }]);
      assert.equal(JSON.stringify(metrics).includes('provider_rejected'), false);
      assert.equal(JSON.stringify(metrics).includes('+15555550103'), false);
      assert.equal(metrics.dispatch_retry_count, 1);
      assert.equal(metrics.authorization_alert_count, 1);
      assert.equal(metrics.campaign_reservations_active, 0);
      assert.equal(metrics.campaign_dispatches_today, 0);
      assert.equal(metrics.webhook_failure_count, 0);
      assert.equal(metrics.workflow_failure_count, 0);
      assert.equal(metrics.workflow_retry_count, 0);

      await new Promise((resolve, reject) => db.db.run(
        `INSERT INTO post_call_workflow_events
          (event_id, event_key, trigger_event, definition_versions_json, payload_json, status, attempts, created_at, updated_at)
         VALUES ('event-retry', 'event-retry-key', 'call.completed', '[]', '{}', 'pending', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        (error) => error ? reject(error) : resolve(),
      ));
      const retried = await db.getPlatformAnomalyMetrics(60);
      assert.equal(retried.workflow_retry_count, 1);
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
      }
    }
  });

  it('aggregates retry-safe HMAC failure buckets across process instances without exposing process IDs', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-auth-failure-metrics-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      const bucket = Math.floor(Date.now() / 60000);
      const entries = [
        { bucket_minute: bucket, process_instance_id: 'process-one', reason: 'invalid_signature', count: 4 },
        { bucket_minute: bucket, process_instance_id: 'process-two', reason: 'invalid_signature', count: 3 },
        { bucket_minute: bucket, process_instance_id: 'process-one', reason: 'replay_detected', count: 2 },
        { bucket_minute: bucket, process_instance_id: 'process-one', reason: 'miniapp_missing_session', count: 5 },
        { bucket_minute: bucket, process_instance_id: 'process-two', reason: 'miniapp_access_denied', count: 2 },
        { bucket_minute: bucket, process_instance_id: 'process-one', reason: 'admin_token_missing', count: 4 },
        { bucket_minute: bucket, process_instance_id: 'process-two', reason: 'admin_token_invalid', count: 1 },
        { bucket_minute: bucket, process_instance_id: 'process-one', reason: 'webhook_auth_rejected', count: 6 },
      ];
      await db.recordApiAuthFailureBuckets(entries);
      // Replaying a process snapshot keeps the same aggregate rather than adding it twice.
      await db.recordApiAuthFailureBuckets(entries);
      const result = await db.getApiAuthFailureMetrics(60);
      assert.equal(result.scope, 'shared_sqlite');
      assert.equal(result.retention_minutes, 1440);
      assert.equal(result.total, 9);
      assert.equal(result.by_reason.invalid_signature, 7);
      assert.equal(result.by_reason.replay_detected, 2);
      assert.equal(result.miniapp_session.total, 7);
      assert.equal(result.miniapp_session.by_reason.miniapp_missing_session, 5);
      assert.equal(result.miniapp_session.by_reason.miniapp_access_denied, 2);
      assert.equal(result.admin_token.total, 5);
      assert.equal(result.admin_token.by_reason.admin_token_missing, 4);
      assert.equal(result.admin_token.by_reason.admin_token_invalid, 1);
      assert.equal(result.webhook_auth.total, 6);
      assert.deepEqual(Object.keys(result.by_reason).sort(), [
        'invalid_signature', 'invalid_timestamp', 'missing_headers', 'other', 'replay_detected', 'timestamp_out_of_range',
      ]);
      assert.equal(JSON.stringify(result).includes('process-one'), false);
      assert.equal(JSON.stringify(result).includes('admin-token-secret'), false);
      const largeBatch = Array.from({ length: 8641 }, () => ({
        bucket_minute: bucket, process_instance_id: 'process-three', reason: 'miniapp_invalid_session', count: 1,
      }));
      assert.deepEqual(await db.recordApiAuthFailureBuckets(largeBatch), { recorded: 8641 });
      await assert.rejects(() => db.recordApiAuthFailureBuckets([
        { bucket_minute: bucket, process_instance_id: 'process-one', reason: 'invalid_signature', count: -1 },
      ]), { code: 'api_auth_metrics_invalid' });
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
      }
    }
  });
});
