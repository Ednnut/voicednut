const { normalizeAnsweredBy, isHumanAnsweredBy, isMachineAnsweredBy } = require('../utils/amd');

const TERMINAL_STATUSES = new Set(['completed', 'no-answer', 'no_answer', 'failed', 'busy', 'canceled']);
const MACHINE_HINT_TYPE = 'call_hint_machine_detected';
const HUMAN_HINT_TYPE = 'call_hint_caller_listening';
const INPUT_HINT_TYPE = 'call_hint_input_detected';

/**
 * Lightweight in-memory state machine that turns low-level Twilio events into actionable hints.
 * The hints are enqueued as notifications so the Telegram UI can surface real-time prompts.
 */
class CallHintStateMachine {
  constructor() {
    this.db = null;
    this.callState = new Map();
  }

  setDatabase(db) {
    this.db = db;
  }

  _getState(callSid) {
    if (!callSid) {
      return null;
    }
    if (!this.callState.has(callSid)) {
      this.callState.set(callSid, {
        lastStatus: null,
        amdStatus: null,
        dtmfCount: 0,
        hintsSent: new Set(),
        createdAt: Date.now()
      });
    }
    return this.callState.get(callSid);
  }

  async handleTwilioStatus(callSid, status, context = {}) {
    if (!callSid || !status) {
      return;
    }
    const normalizedStatus = status.toLowerCase();
    const state = this._getState(callSid);
    if (!state) {
      return;
    }

    state.lastStatus = normalizedStatus;

    if (['in-progress', 'answered'].includes(normalizedStatus)) {
      const answeredBy = context.answeredBy || state.amdStatus;
      if (isMachineAnsweredBy(answeredBy)) {
        await this._emitMachineHint(callSid, context);
      } else if (isHumanAnsweredBy(answeredBy)) {
        await this._emitListeningHint(callSid, context);
      }
    }

    if (TERMINAL_STATUSES.has(normalizedStatus)) {
      this._cleanup(callSid);
    }
  }

  async handleAmdUpdate(callSid, answeredValue, context = {}) {
    if (!callSid || !answeredValue) {
      return;
    }
    const normalized = normalizeAnsweredBy(answeredValue);
    const state = this._getState(callSid);
    if (!state) {
      return;
    }

    state.amdStatus = normalized;

    if (isMachineAnsweredBy(normalized)) {
      await this._emitMachineHint(callSid, { ...context, answeredBy: normalized });
    } else if (isHumanAnsweredBy(normalized)) {
      await this._emitListeningHint(callSid, { ...context, answeredBy: normalized });
    }
  }

  async handleDtmfCapture(callSid, context = {}) {
    if (!callSid) {
      return;
    }
    if (context.provider && context.provider !== 'twilio') {
      return;
    }

    const state = this._getState(callSid);
    if (!state) {
      return;
    }

    state.dtmfCount += 1;

    if (!state.hintsSent.has(HUMAN_HINT_TYPE)) {
      await this._emitListeningHint(callSid, { ...context, inferredFrom: 'dtmf' });
    }

    await this._emitInputHint(callSid, context);
  }

  async _emitMachineHint(callSid, context = {}) {
    return this._emitHint(callSid, MACHINE_HINT_TYPE, context, 'high');
  }

  async _emitListeningHint(callSid, context = {}) {
    return this._emitHint(callSid, HUMAN_HINT_TYPE, context, 'normal');
  }

  async _emitInputHint(callSid, context = {}) {
    return this._emitHint(callSid, INPUT_HINT_TYPE, context, 'high');
  }

  async _emitHint(callSid, type, context = {}, priority = 'normal') {
    if (!this.db || !callSid || !type) {
      return false;
    }

    const state = this._getState(callSid);
    if (!state || state.hintsSent.has(type)) {
      return false;
    }

    let callRecord = context.call || null;
    if (!callRecord) {
      try {
        callRecord = await this.db.getCall(callSid);
      } catch (error) {
        console.warn('Call hint state machine could not load call record:', error.message);
        return false;
      }
    }
    if (!callRecord) {
      return false;
    }

    const targetChatId = callRecord.telegram_chat_id || callRecord.user_chat_id;
    if (!targetChatId) {
      return false;
    }

    try {
      await this.db.createEnhancedWebhookNotification(callSid, type, targetChatId, priority);
      state.hintsSent.add(type);

      if (this.db.updateCallState) {
        await this.db.updateCallState(callSid, 'call_hint_emitted', {
          hint_type: type,
          metadata: context.metadata || null,
          provider: context.provider || callRecord.provider || 'twilio'
        });
      }
      return true;
    } catch (error) {
      console.error('Failed to enqueue call hint notification:', error);
      return false;
    }
  }

  _cleanup(callSid) {
    this.callState.delete(callSid);
  }
}

module.exports = CallHintStateMachine;
