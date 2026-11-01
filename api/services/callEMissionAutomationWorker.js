'use strict';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

class CallEMissionAutomationWorker {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.db = options.db;
    this.createMissionService = options.createMissionService;
    this.createOperationsService = options.createOperationsService;
    this.botToken = String(options.botToken || '');
    this.fetch = options.fetch || globalThis.fetch;
    this.intervalMs = Math.max(15000, Math.min(3600000, Number(options.intervalMs) || 60000));
    this.now = typeof options.now === 'function' ? options.now : () => new Date();
    this.setInterval = options.setIntervalFn || setInterval;
    this.clearInterval = options.clearIntervalFn || clearInterval;
    this.timer = null;
    this.inflight = null;
  }

  isConfigured() {
    return this.enabled && typeof this.db?.listDueCallECampaignMissions === 'function' &&
      typeof this.db?.listDueCallEMissionEscalations === 'function' &&
      typeof this.db?.listDueCallEMissionReportDigests === 'function' &&
      typeof this.db?.claimCallEMissionReportDigest === 'function' && typeof this.db?.advanceCallEMissionReportDigest === 'function' &&
      typeof this.createMissionService === 'function' && typeof this.createOperationsService === 'function' &&
      this.botToken.length >= 20 && typeof this.fetch === 'function';
  }

  async sendDigest(actorId, report, intervalHours) {
    if (!/^\d{1,20}$/.test(String(actorId || ''))) return false;
    const lines = [
      '<b>CALL-E mission report digest</b>',
      `${intervalHours === 24 ? 'Daily' : 'Weekly'} · ${escapeHtml(report.from)} to ${escapeHtml(report.to)}`,
      `Missions: ${Number(report.mission_count) || 0} · completed: ${Number(report.completed_missions) || 0} · attention: ${Number(report.attention_missions) || 0}`,
      `Recipients: ${Number(report.recipient_count) || 0} · completed: ${Number(report.completed_recipients) || 0} · failed: ${Number(report.failed_recipients) || 0} · review: ${Number(report.review_recipients) || 0}`,
      `Completion rate: ${Number(report.completion_rate) || 0}%`,
    ];
    const response = await this.fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(actorId), text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response?.ok) throw Object.assign(new Error('Telegram report digest delivery failed'), { code: 'call_e_report_digest_delivery_failed' });
    return true;
  }

  async drain() {
    if (!this.enabled) return { state: 'disabled', scheduled: 0, escalated: 0, digests: 0 };
    if (!this.isConfigured()) return { state: 'not_configured', scheduled: 0, escalated: 0, digests: 0 };
    if (this.inflight) return { state: 'already_running', scheduled: 0, escalated: 0, digests: 0 };
    this.inflight = (async () => {
      const now = this.now().toISOString();
      let scheduled = 0;
      let escalated = 0;
      let digests = 0;
      const dueEscalations = await this.db.listDueCallEMissionEscalations(now, 100);
      for (const mission of dueEscalations) {
        try {
          if (await this.db.recordCallEMissionEscalation({ mission_id: mission.mission_id, business_id: mission.business_id, now_iso: now })) escalated += 1;
        } catch (error) {
          console.warn('CALL-E review escalation deferred', { code: String(error?.code || 'call_e_review_escalation_failed') });
        }
      }
      const dueMissions = await this.db.listDueCallECampaignMissions(now, 25);
      for (const mission of dueMissions) {
        try {
          await this.createMissionService().advance({
            business_id: mission.business_id, actor_id: mission.actor_id,
            mission_id: mission.mission_id, source: 'worker',
          });
          scheduled += 1;
        } catch (error) {
          console.warn('CALL-E scheduled mission step deferred', { code: String(error?.code || 'call_e_scheduled_mission_failed') });
        }
      }
      const subscriptions = await this.db.listDueCallEMissionReportDigests(now, 100);
      for (const subscription of subscriptions) {
        try {
          const claimed = await this.db.claimCallEMissionReportDigest?.({
            business_id: subscription.business_id, actor_id: subscription.actor_id,
            previous_due_at: subscription.next_delivery_at, now,
          });
          if (claimed !== true) continue;
          const intervalHours = Number(subscription.interval_hours) === 168 ? 168 : 24;
          const to = new Date(now).toISOString().slice(0, 10);
          const coveredDays = intervalHours === 168 ? 7 : 1;
          const fromDate = new Date(Date.parse(`${to}T00:00:00.000Z`) - (coveredDays - 1) * 86400000).toISOString().slice(0, 10);
          const operations = this.createOperationsService();
          const { report } = await operations.report({
            business_id: subscription.business_id, actor_id: subscription.actor_id, from: fromDate, to,
          });
          await this.sendDigest(subscription.actor_id, report, intervalHours);
          await this.db.advanceCallEMissionReportDigest({
            business_id: subscription.business_id, actor_id: subscription.actor_id,
            previous_due_at: subscription.next_delivery_at,
          });
          digests += 1;
        } catch (error) {
          await this.db.touchCallEMissionReportDigest?.({ business_id: subscription.business_id, actor_id: subscription.actor_id });
          console.warn('CALL-E report digest deferred', { code: String(error?.code || 'call_e_report_digest_delivery_failed') });
        }
      }
      return { state: 'completed', scheduled, escalated, digests };
    })();
    try { return await this.inflight; }
    finally { this.inflight = null; }
  }

  start() {
    if (this.timer) return true;
    if (!this.isConfigured()) return false;
    this.timer = this.setInterval(() => {
      void this.drain().catch((error) => console.warn('CALL-E mission automation cycle failed', { code: String(error?.code || 'call_e_automation_failed') }));
    }, this.intervalMs);
    this.timer?.unref?.();
    void this.drain().catch((error) => console.warn('CALL-E initial mission automation cycle failed', { code: String(error?.code || 'call_e_automation_failed') }));
    return true;
  }

  async stop() {
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
  }
}

module.exports = { CallEMissionAutomationWorker, escapeHtml };
