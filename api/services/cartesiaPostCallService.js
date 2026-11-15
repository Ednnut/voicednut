const { buildCallCompletionAutomationPayload } = require('./postCallAutomationTriggers');

// This boundary intentionally forwards no customer content or contact details.
class CartesiaPostCallService {
  constructor({ db, workflowService }) {
    this.db = db;
    this.workflowService = workflowService;
  }

  async process(providerCallId) {
    if (!this.workflowService || typeof this.workflowService.trigger !== 'function') return;
    const stored = await this.db.getCartesiaCallRecordByProviderId(providerCallId);
    if (!stored || stored.direction !== 'outbound' || !stored.business_id ||
        !stored.local_call_id || !['completed', 'failed'].includes(stored.status)) return;
    const call = await this.db.getCall(stored.local_call_id);
    const created = await this.db.getLatestCallState(stored.local_call_id, 'call_created');
    if (!call || call.direction !== 'outbound' || String(call.business_id || '') !== String(stored.business_id) ||
        created?.provider !== 'cartesia' || created.provider_call_id !== providerCallId ||
        String(created.business_id || '') !== String(stored.business_id)) return;
    const payload = buildCallCompletionAutomationPayload({
      callSid: stored.local_call_id,
      call: { business_id: stored.business_id },
      transcripts: [],
      summary: {},
      finalStatus: stored.status,
      notificationType: stored.status === 'completed' ? 'call_completed' : 'call_failed',
      duration: Number(call.duration) || 0,
    });
    payload.metadata.provider = 'cartesia';
    payload.metadata.provider_call_id = providerCallId;
    payload.metadata.artifact_policy = 'metadata_only';
    // The existing durable workflow engine deduplicates by business/event/key
    // and honors its own default-off execution gate and published definitions.
    return this.workflowService.trigger(payload);
  }
}

module.exports = CartesiaPostCallService;