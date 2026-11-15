'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');

describe('outgoing webhook persistence', function () {
  this.timeout(120000);

  it('deduplicates deliveries, records attempts, and allows confirmed dead-letter recovery', async () => {
    const dbPath = path.join(os.tmpdir(), `voicednut-outgoing-webhooks-${Date.now()}-${Math.random()}.sqlite`);
    const db = new Database();
    db.dbPath = dbPath;
    try {
      await db.initialize();
      const subscription = await db.createOutgoingWebhookSubscription({
        subscription_id: 'subscription-1', business_id: 'business-1', name: 'Test',
        target_url: 'https://hooks.example.com/events', secret_env_ref: 'env://VOICEDNUT_TEST_SECRET',
        event_types: ['post_call_completed'], created_by: '7001', failure_threshold: 3,
      });
      assert.equal(subscription.enabled, 1);
      const delivery = {
        delivery_id: 'delivery-1', subscription_id: subscription.subscription_id,
        event_id: 'event-1', event_type: 'post_call_completed', payload_json: '{"id":"event-1"}', max_attempts: 1,
      };
      const first = await db.enqueueOutgoingWebhookDelivery(delivery);
      const duplicate = await db.enqueueOutgoingWebhookDelivery({ ...delivery, delivery_id: 'delivery-duplicate' });
      assert.equal(duplicate.delivery_id, first.delivery_id);
      assert.equal(first.config_revision, 1);
      await db.updateOutgoingWebhookSubscription(subscription.subscription_id, 'business-1', {
        name: 'Updated', target_url: 'https://next.example.com/events', secret_env_ref: 'env://VOICEDNUT_NEXT_SECRET',
        enabled: true, event_types: ['post_call_completed'], failure_threshold: 5,
      }, '7002');
      const revisions = await db.listOutgoingWebhookSubscriptionRevisions(subscription.subscription_id, 'business-1');
      assert.deepEqual(revisions.map((row) => row.revision), [2, 1]);
      assert.equal(revisions[0].actor_id, '7002');
      const due = await db.listDueOutgoingWebhookDeliveries();
      assert.equal(due[0].target_url, 'https://hooks.example.com/events');
      assert.equal(due[0].secret_env_ref, 'env://VOICEDNUT_TEST_SECRET');
      assert.equal(due[0].config_revision, 1);
      await assert.rejects(new Promise((resolve, reject) => db.db.run(
        "UPDATE outgoing_webhook_subscription_revisions SET name = 'tampered' WHERE revision = 1",
        (error) => error ? reject(error) : resolve(),
      )), /append-only/);
      assert.equal(await db.claimOutgoingWebhookDelivery(first.delivery_id), 1);
      assert.equal(await db.claimOutgoingWebhookDelivery(first.delivery_id), 0);
      await db.finishOutgoingWebhookAttempt(first.delivery_id, {
        subscription_id: subscription.subscription_id, error_code: 'webhook_delivery_failed',
      });
      const history = await db.listOutgoingWebhookDeliveries(subscription.subscription_id, 'business-1');
      assert.equal(history[0].status, 'dead_letter');
      assert.equal(history[0].attempts, 1);
      assert.equal(await db.replayOutgoingWebhookDelivery(first.delivery_id, subscription.subscription_id), 1);
      const replayed = await db.getOutgoingWebhookDelivery(first.delivery_id, subscription.subscription_id);
      assert.equal(replayed.status, 'pending');
      assert.equal(replayed.max_attempts, 9);
      await db.claimOutgoingWebhookDelivery(first.delivery_id);
      await db.finishOutgoingWebhookAttempt(first.delivery_id, {
        subscription_id: subscription.subscription_id, delivered: true, response_status: 204,
      });
      const current = await db.getOutgoingWebhookSubscription(subscription.subscription_id, 'business-1');
      assert.equal(current.enabled, 1);
      assert.equal(current.updated_by, '7002');
      assert.equal((await db.listOutgoingWebhookSubscriptionRevisions(subscription.subscription_id, 'business-1')).length, 2);
      await db.ensureOutgoingWebhookConfigurationHistory();
      assert.equal((await db.listOutgoingWebhookSubscriptionRevisions(subscription.subscription_id, 'business-1')).length, 2);
    } finally {
      if (db.db) await new Promise((resolve) => db.db.close(resolve));
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
      }
    }
  });
});
