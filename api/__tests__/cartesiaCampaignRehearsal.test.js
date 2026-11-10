const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('../db/db');
const { CartesiaCampaignService, confirmationPhrase } = require('../services/cartesiaCampaignService');

describe('Cartesia offline campaign rehearsal', () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `voicednut-cartesia-rehearsal-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database();
    db.dbPath = dbPath;
    await db.initialize();
    await new Promise((resolve, reject) => db.db.run(
      `INSERT INTO call_e_business_safety_policies
       (business_id, max_calls_per_day, timezone, emergency_stop, updated_by)
       VALUES ('business_rehearsal_001', 10, 'UTC', 0, '7001')`,
      (error) => error ? reject(error) : resolve(),
    ));
  });

  afterEach(async () => {
    if (db?.db) await new Promise((resolve) => db.db.close(resolve));
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.unlinkSync(file); } catch (_) {}
    }
  });

  it('persists an accepted campaign safely, reconciles it, and fences uncertain acceptance without a second submit', async () => {
    let providerSubmissions = 0;
    let failNextSubmission = false;
    let latestBatchRequest = null;
    const client = {
      async listAgents() {
        return { summaries: [{ id: 'agent_rehearsal', phone_numbers: [{ id: 'number_rehearsal' }] }] };
      },
      async createCallBatch(request) {
        providerSubmissions += 1;
        latestBatchRequest = request;
        if (failNextSubmission) {
          failNextSubmission = false;
          throw Object.assign(new Error('synthetic timeout'), {
            code: 'synthetic_timeout',
            providerSubmissionState: 'unknown',
          });
        }
        return { batchId: `batch_rehearsal_${providerSubmissions}`, status: 'pending' };
      },
      async getCallBatch(id) {
        return {
          id,
          name: latestBatchRequest.name,
          agent_id: latestBatchRequest.agentId,
          from_number_id: latestBatchRequest.fromNumberId,
          status: 'completed',
          retry_count: 0,
          recipients: latestBatchRequest.recipients.map((recipient, index) => ({
            id: `recipient_${index}`,
            to_number: recipient.to_number,
            status: 'completed',
            agent_call_id: `call_rehearsal_${index}`,
          })),
        };
      },
      async listCallBatches() { return { data: [], has_more: false, next_page: null }; },
    };
    const authorizationAttempts = [];
    const reservations = [];
    const outboundSafety = {
      async authorizeActor(input) {
        authorizationAttempts.push(input);
        if (input.business_id !== 'business_rehearsal_001' || input.actor_id !== '7001') {
          throw Object.assign(new Error('scope denied'), { code: 'cartesia_campaign_operator_required' });
        }
      },
      contactPolicy: {
        async checkEligibility({ businessId, destination }) {
          return {
            eligible: businessId === 'business_rehearsal_001' && /^\+1415555\d{4}$/.test(destination),
            reason: 'consent_missing',
          };
        },
      },
      async reserveDispatch(input) {
        const reservation = { reservationKey: `rehearsal:${reservations.length}`, input };
        reservations.push(reservation);
        return reservation;
      },
      async completeDispatch(reservation, status) {
        reservation.status = status;
        return true;
      },
    };
    const service = new CartesiaCampaignService({
      client,
      db,
      outboundSafety,
      enabled: true,
      dispatchEnabled: true,
      idempotencySecret: 'offline-cartesia-campaign-secret-0001',
      encryptionKeys: { 1: 'offline-cartesia-encryption-secret-0001' },
      now: () => new Date('2026-11-10T12:00:00.000Z'),
    });
    const input = {
      business_id: 'business_rehearsal_001',
      actor_id: '7001',
      request_key: 'offline:campaign:accepted-01',
      agent_id: 'agent_rehearsal',
      from_number_id: 'number_rehearsal',
      name: 'Offline rehearsal',
      target_concurrency_limit: 1,
      destinations: ['+14155550123'],
      dynamic_variables: { first_name: 'Synthetic' },
    };

    const draft = await service.createDraft(input);
    assert.equal(draft.campaign.status, 'draft');
    assert.equal(draft.campaign.recipients[0].destination_masked.endsWith('0123'), true);
    const confirmation = confirmationPhrase({
      campaign_id: draft.campaign.campaign_id,
      ready_count: draft.campaign.ready_count,
      scheduled_at: draft.campaign.scheduled_at,
    });
    const submitted = await service.submit({ ...input, campaign_id: draft.campaign.campaign_id, confirmation_phrase: confirmation });
    assert.equal(submitted.campaign.status, 'submitted');
    assert.equal(providerSubmissions, 1);
    assert.equal(reservations[0].status, 'accepted');

    const replay = await service.submit({ ...input, campaign_id: draft.campaign.campaign_id, confirmation_phrase: confirmation });
    assert.equal(replay.idempotent_replay, true);
    assert.equal(providerSubmissions, 1);
    await assert.rejects(service.createDraft({ ...input, name: 'Changed request' }), {
      code: 'cartesia_campaign_idempotency_conflict',
    });

    const reconciled = await service.reconcileCampaign({
      campaign_id: draft.campaign.campaign_id,
      business_id: input.business_id,
      actor_id: input.actor_id,
    });
    assert.equal(reconciled.campaign.outcome_summary.completed, 1);
    assert.equal(JSON.stringify(reconciled).includes('+14155550123'), false);
    const stored = await db.getCartesiaCampaign(draft.campaign.campaign_id, input.business_id);
    assert.equal(JSON.stringify(stored).includes('+14155550123'), false);
    assert.equal(JSON.stringify(stored).includes('Synthetic'), false);

    const uncertainInput = { ...input, request_key: 'offline:campaign:uncertain-01', name: 'Uncertain rehearsal' };
    const uncertainDraft = await service.createDraft(uncertainInput);
    failNextSubmission = true;
    const uncertainConfirmation = confirmationPhrase({
      campaign_id: uncertainDraft.campaign.campaign_id,
      ready_count: uncertainDraft.campaign.ready_count,
      scheduled_at: uncertainDraft.campaign.scheduled_at,
    });
    await assert.rejects(service.submit({
      ...uncertainInput,
      campaign_id: uncertainDraft.campaign.campaign_id,
      confirmation_phrase: uncertainConfirmation,
    }), { code: 'cartesia_campaign_outcome_unresolved' });
    await assert.rejects(service.submit({
      ...uncertainInput,
      campaign_id: uncertainDraft.campaign.campaign_id,
      confirmation_phrase: uncertainConfirmation,
    }), { code: 'cartesia_campaign_outcome_unresolved' });
    assert.equal(providerSubmissions, 2);
    await assert.rejects(service.getCampaign({
      campaign_id: uncertainDraft.campaign.campaign_id,
      business_id: 'other_business',
      actor_id: input.actor_id,
    }), { code: 'cartesia_campaign_operator_required' });
    assert.deepEqual(authorizationAttempts.at(-1), { business_id: 'other_business', actor_id: '7001' });
  });
});
