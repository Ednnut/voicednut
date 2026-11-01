'use strict';

const assert = require('node:assert/strict');
const { CallEMissionAutomationWorker } = require('../services/callEMissionAutomationWorker');

describe('CALL-E mission automation worker', () => {
  const missionId = `mission_${'a'.repeat(64)}`;

  it('keeps the background automation disabled by default', async () => {
    let reads = 0;
    const worker = new CallEMissionAutomationWorker({ db: { async listDueCallECampaignMissions() { reads += 1; } } });
    assert.equal(worker.start(), false);
    assert.deepEqual(await worker.drain(), { state: 'disabled', scheduled: 0, escalated: 0, digests: 0 });
    assert.equal(reads, 0);
  });

  it('advances due missions, escalates reviews once, and sends mock report digests', async () => {
    const missionSteps = [];
    const escalationRecords = [];
    const digestClaims = [];
    const digestAdvances = [];
    const requests = [];
    const worker = new CallEMissionAutomationWorker({
      enabled: true, botToken: 'mock-only-telegram-bot-token-long-enough', now: () => new Date('2026-10-31T12:00:00.000Z'),
      db: {
        async listDueCallEMissionEscalations() { return [{ mission_id: missionId, business_id: 'biz-a' }]; },
        async recordCallEMissionEscalation(input) { escalationRecords.push(input); return true; },
        async listDueCallECampaignMissions() { return [{ mission_id: missionId, business_id: 'biz-a', actor_id: '222' }]; },
        async listDueCallEMissionReportDigests() { return [{ business_id: 'biz-a', actor_id: '222', interval_hours: 24, next_delivery_at: '2026-10-31 11:00:00' }]; },
        async claimCallEMissionReportDigest(input) { digestClaims.push(input); return true; },
        async advanceCallEMissionReportDigest(input) { digestAdvances.push(input); return true; },
        async touchCallEMissionReportDigest() { assert.fail('Successful delivery must not touch for retry'); },
      },
      createMissionService: () => ({ async advance(input) { missionSteps.push(input); return { state: 'call_accepted', provider_requests: 1 }; } }),
      createOperationsService: () => ({ async report(input) {
        assert.equal(input.business_id, 'biz-a');
        assert.equal(input.actor_id, '222');
        assert.equal(input.from, '2026-10-31');
        assert.equal(input.to, '2026-10-31');
        return { report: { from: input.from, to: input.to, mission_count: 4, completed_missions: 2, attention_missions: 1, recipient_count: 5, completed_recipients: 3, failed_recipients: 1, review_recipients: 1, completion_rate: 60 } };
      } }),
      fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true }; },
    });

    assert.deepEqual(await worker.drain(), { state: 'completed', scheduled: 1, escalated: 1, digests: 1 });
    assert.deepEqual(missionSteps, [{ business_id: 'biz-a', actor_id: '222', mission_id: missionId, source: 'worker' }]);
    assert.deepEqual(escalationRecords, [{ mission_id: missionId, business_id: 'biz-a', now_iso: '2026-10-31T12:00:00.000Z' }]);
    assert.equal(digestClaims.length, 1);
    assert.equal(digestAdvances.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.endsWith('/sendMessage'), true);
    assert.equal(requests[0].body.chat_id, '222');
    assert.equal(requests[0].body.text.includes('4'), true);
  });

  it('defers digest delivery and keeps the due cursor when the mock Telegram request fails', async () => {
    let advanced = 0;
    let touched = 0;
    const worker = new CallEMissionAutomationWorker({
      enabled: true, botToken: 'mock-only-telegram-bot-token-long-enough',
      db: {
        async listDueCallEMissionEscalations() { return []; },
        async listDueCallECampaignMissions() { return []; },
        async listDueCallEMissionReportDigests() { return [{ business_id: 'biz-a', actor_id: '222', interval_hours: 168, next_delivery_at: '2026-10-31 11:00:00' }]; },
        async claimCallEMissionReportDigest() { return true; },
        async advanceCallEMissionReportDigest() { advanced += 1; },
        async touchCallEMissionReportDigest() { touched += 1; },
      },
      createMissionService: () => ({ async advance() {} }),
      createOperationsService: () => ({ async report(input) {
        assert.equal(input.from, '2026-10-25');
        assert.equal(input.to, '2026-10-31');
        return { report: { from: input.from, to: input.to } };
      } }),
      fetch: async () => { throw Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' }); },
    });
    assert.deepEqual(await worker.drain(), { state: 'completed', scheduled: 0, escalated: 0, digests: 0 });
    assert.equal(advanced, 0);
    assert.equal(touched, 1);
  });
});
