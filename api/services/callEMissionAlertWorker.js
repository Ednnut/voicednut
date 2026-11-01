'use strict';

const ATTENTION_STATES = new Set(['pending_approval', 'needs_review', 'failed', 'blocked', 'recovery_required', 'budget_exceeded']);

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

class CallEMissionAlertWorker {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.db = options.db;
    this.botToken = String(options.botToken || '');
    this.fetch = options.fetch || globalThis.fetch;
    this.intervalMs = Math.max(15000, Math.min(3600000, Number(options.intervalMs) || 60000));
    this.setInterval = options.setIntervalFn || setInterval;
    this.clearInterval = options.clearIntervalFn || clearInterval;
    this.timer = null;
    this.inflight = null;
  }

  isConfigured() {
    return this.enabled && this.botToken.length >= 20 && typeof this.fetch === 'function' &&
      typeof this.db?.listCallEMissionAlertSubscriptions === 'function' &&
      typeof this.db?.listCallEMissionAlertsForSubscription === 'function' &&
      typeof this.db?.advanceCallEMissionAlertCursor === 'function';
  }

  async send(actorId, event) {
    const state = String(event?.state || 'unknown');
    const notify = (event?.event_type === 'mission_created' && state === 'pending_approval') ||
      (event?.event_type === 'mission_advanced' && ['review_escalated', 'budget_exceeded'].includes(state)) ||
      (event?.event_type === 'recipient_retry_requested') ||
      (event?.event_type === 'recipient_transition' && ATTENTION_STATES.has(state));
    if (!notify) return false;
    const missionId = String(event?.mission_id || '');
    if (!/^mission_[a-f0-9]{64}$/.test(missionId) || !/^\d{1,20}$/.test(String(actorId || ''))) return false;
    const position = Number.isSafeInteger(Number(event.recipient_position)) ? ` · recipient ${Number(event.recipient_position) + 1}` : '';
    const error = /^[a-z][a-z0-9_]{0,79}$/.test(String(event.error_code || '')) ? ` · ${event.error_code}` : '';
    const title = state === 'review_escalated' ? 'CALL-E review deadline reached'
      : state === 'budget_exceeded' ? 'CALL-E mission budget exceeded' : 'CALL-E mission attention';
    const text = `<b>${title}</b>\n<code>${missionId}</code>${position}\nState: <b>${escapeHtml(state)}</b>${error}\nOpen the CALL-E Operations menu for the timeline and review options.`;
    const response = await this.fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(actorId), text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response?.ok) throw Object.assign(new Error('Telegram alert delivery failed'), { code: 'call_e_alert_delivery_failed' });
    return true;
  }

  async drain() {
    if (!this.enabled) return { state: 'disabled', delivered: 0 };
    if (!this.isConfigured()) return { state: 'not_configured', delivered: 0 };
    if (this.inflight) return { state: 'already_running', delivered: 0 };
    this.inflight = (async () => {
      const subscriptions = await this.db.listCallEMissionAlertSubscriptions();
      let delivered = 0;
      for (const subscription of subscriptions) {
        try {
          const events = await this.db.listCallEMissionAlertsForSubscription({
            business_id: subscription.business_id, after_event_id: subscription.last_notified_event_id,
          }, 50);
          for (const event of events) {
            const sent = await this.send(subscription.actor_id, { ...event });
            await this.db.advanceCallEMissionAlertCursor({
              business_id: subscription.business_id, actor_id: subscription.actor_id, event_id: event.event_id,
            });
            if (sent) delivered += 1;
          }
        } catch (error) {
          await this.db.touchCallEMissionAlertSubscription?.({ business_id: subscription.business_id, actor_id: subscription.actor_id });
          console.warn('CALL-E mission alert subscription delivery deferred', {
            code: String(error?.code || 'call_e_alert_delivery_failed'),
          });
        }
      }
      return { state: 'completed', delivered };
    })();
    try { return await this.inflight; }
    finally { this.inflight = null; }
  }

  start() {
    if (this.timer) return true;
    if (!this.isConfigured()) return false;
    this.timer = this.setInterval(() => {
      void this.drain().catch((error) => console.warn('CALL-E alert delivery failed', { code: String(error?.code || 'call_e_alert_delivery_failed') }));
    }, this.intervalMs);
    this.timer?.unref?.();
    void this.drain().catch((error) => console.warn('CALL-E initial alert delivery failed', { code: String(error?.code || 'call_e_alert_delivery_failed') }));
    return true;
  }

  async stop() {
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
  }
}

module.exports = { CallEMissionAlertWorker, ATTENTION_STATES };
