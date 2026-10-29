const { VoiceResponse } = require('twilio').twiml;
const { runWithTimeout } = require('../utils/asyncControl');

const HANDOFF_CONFIRMATION_PROMPT =
  'To connect you with a representative, press 1. To stay on this call, press 2.';
const HANDOFF_CONFIRMATION_TTL_MS = 30_000;

function resolveCallAgentHandoffPolicy(callConfig = {}) {
  const policy = callConfig?.script_policy?.agent_config?.handoff_policy;
  if (
    callConfig?.provider !== 'twilio' ||
    callConfig?.script_policy?.lifecycle_state !== 'live' ||
    policy?.enabled !== true ||
    policy?.confirmation !== 'dtmf_1' ||
    !/^\+[1-9]\d{7,14}$/.test(String(policy?.destination_e164 || '')) ||
    callConfig?.payment_in_progress === true ||
    callConfig?.digit_capture_active === true ||
    callConfig?.call_mode === 'dtmf_capture' ||
    !['normal', undefined, null].includes(callConfig?.flow_state)
  ) {
    return null;
  }
  return Object.freeze({
    provider: 'twilio',
    destination_e164: policy.destination_e164,
    confirmation: 'dtmf_1',
  });
}

function classifyCallAgentHandoffDtmf(digits) {
  const normalized = String(digits || '').trim();
  if (normalized === '1') return 'confirm';
  if (normalized === '2') return 'cancel';
  return 'invalid';
}

function exposeCallAgentHandoffAction(tool, enabled) {
  if (!enabled || !tool || typeof tool !== 'object' || !tool.function) return tool;
  if (String(tool.function.name || '').trim() !== 'route_to_agent') return tool;
  const parameters = tool.function.parameters || {};
  const properties = parameters.properties || {};
  const action = properties.action || {};
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        ...parameters,
        properties: {
          ...properties,
          action: {
            ...action,
            enum: Array.from(new Set([
              ...(Array.isArray(action.enum) ? action.enum : []),
              'live_transfer',
            ])),
          },
        },
      },
    },
  };
}

function buildTwilioCallHandoffTwiml(destination) {
  if (!/^\+[1-9]\d{7,14}$/.test(String(destination || ''))) {
    throw new Error('Invalid handoff destination.');
  }
  const response = new VoiceResponse();
  response.say('Connecting you now.');
  response.dial({ timeout: 25 }, destination);
  return response.toString();
}

function createCallAgentHandoffService({
  db,
  twilioClientFactory,
  now = () => Date.now(),
  confirmationTtlMs = HANDOFF_CONFIRMATION_TTL_MS,
  providerTimeoutMs = 15_000,
}) {
  if (!db) throw new Error('Call agent handoff service requires a database.');
  if (typeof twilioClientFactory !== 'function') {
    throw new Error('Call agent handoff service requires a Twilio client factory.');
  }

  async function request(callSid, callConfig) {
    const policy = resolveCallAgentHandoffPolicy(callConfig);
    if (!policy) {
      return { status: 'blocked', code: 'handoff_policy_unavailable' };
    }
    const expiresAt = now() + Math.max(5000, Number(confirmationTtlMs) || HANDOFF_CONFIRMATION_TTL_MS);
    const created = await db.createCallHandoffSession(
      callSid,
      policy.destination_e164,
      expiresAt,
    );
    if (!created) {
      return { status: 'blocked', code: 'handoff_already_requested' };
    }
    const expiryTimer = setTimeout(async () => {
      const expired = await db.transitionCallHandoffSession(
        callSid,
        'awaiting_confirmation',
        'expired',
      ).catch(() => false);
      if (expired) {
        await db.updateCallState(callSid, 'handoff_confirmation_expired', {
          provider: 'twilio',
        }).catch(() => {});
      }
    }, Math.max(0, expiresAt - now()));
    if (typeof expiryTimer.unref === 'function') expiryTimer.unref();
    await db.updateCallState(callSid, 'handoff_confirmation_requested', {
      provider: 'twilio',
      confirmation: 'dtmf_1',
      expires_at: new Date(expiresAt).toISOString(),
    }).catch(() => {});
    return {
      status: 'awaiting_confirmation',
      confirmation_prompt: HANDOFF_CONFIRMATION_PROMPT,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  async function handleDtmf(callSid, digits, callConfig) {
    const session = await db.getCallHandoffSession(callSid);
    if (!session) return { handled: false };
    if (session.state === 'dispatching') {
      const dispatchStartedAt = Number(session.updated_at_ms);
      const dispatchIsStale = Number.isFinite(dispatchStartedAt) &&
        now() - dispatchStartedAt > Number(providerTimeoutMs || 15_000) + 5000;
      if (!dispatchIsStale) {
        return { handled: true, status: 'dispatching' };
      }
      const markedUnknown = await db.transitionCallHandoffSession(
        callSid,
        'dispatching',
        'outcome_unknown',
      ).catch(() => false);
      if (markedUnknown) {
        await db.updateCallState(callSid, 'handoff_outcome_unknown', {
          provider: 'twilio',
          retryable: false,
        }).catch(() => {});
      }
      return {
        handled: true,
        status: 'outcome_unknown',
        agent_message: 'The transfer status is unclear. Do not retry it.',
      };
    }
    if (session.state !== 'awaiting_confirmation') {
      return { handled: true, status: session.state };
    }

    if (Number(session.expires_at) <= now()) {
      await db.transitionCallHandoffSession(
        callSid,
        'awaiting_confirmation',
        'expired',
      );
      await db.updateCallState(callSid, 'handoff_confirmation_expired', {
        provider: 'twilio',
      }).catch(() => {});
      return {
        handled: true,
        status: 'expired',
        agent_message: 'The handoff request expired. No transfer was made.',
      };
    }

    const decision = classifyCallAgentHandoffDtmf(digits);
    if (decision === 'invalid') {
      return {
        handled: true,
        status: 'awaiting_confirmation',
        agent_message: HANDOFF_CONFIRMATION_PROMPT,
      };
    }
    if (decision === 'cancel') {
      const changed = await db.transitionCallHandoffSession(
        callSid,
        'awaiting_confirmation',
        'cancelled',
        { require_unexpired: true, now: now() },
      );
      if (!changed) return { handled: true, status: 'expired' };
      await db.updateCallState(callSid, 'handoff_cancelled', {
        provider: 'twilio',
        confirmation: 'dtmf_2',
      }).catch(() => {});
      return {
        handled: true,
        status: 'cancelled',
        agent_message: 'No transfer was made. Continue helping the caller.',
      };
    }

    const policy = resolveCallAgentHandoffPolicy(callConfig);
    if (!policy || policy.destination_e164 !== session.destination_e164) {
      await db.transitionCallHandoffSession(
        callSid,
        'awaiting_confirmation',
        'failed',
      );
      return { handled: true, status: 'failed' };
    }

    const claimed = await db.transitionCallHandoffSession(
      callSid,
      'awaiting_confirmation',
      'dispatching',
      { require_unexpired: true, now: now() },
    );
    if (!claimed) return { handled: true, status: 'expired' };

    await db.updateCallState(callSid, 'handoff_dispatching', {
      provider: 'twilio',
      confirmation: 'dtmf_1',
    }).catch(() => {});
    try {
      const twilioClient = twilioClientFactory();
      const twiml = buildTwilioCallHandoffTwiml(session.destination_e164);
      await runWithTimeout(
        twilioClient.calls(callSid).update({ twiml }),
        {
          timeoutMs: providerTimeoutMs,
          label: 'twilio_call_handoff_update',
          timeoutCode: 'twilio_handoff_update_timeout',
          logger: { error() {} },
        },
      );
      await db.transitionCallHandoffSession(
        callSid,
        'dispatching',
        'started_unconfirmed',
      );
      await db.updateCallState(callSid, 'handoff_started_unconfirmed', {
        provider: 'twilio',
        confirmation: 'dtmf_1',
      }).catch(() => {});
      return { handled: true, status: 'started_unconfirmed' };
    } catch (_) {
      await db.transitionCallHandoffSession(
        callSid,
        'dispatching',
        'outcome_unknown',
      ).catch(() => {});
      await db.updateCallState(callSid, 'handoff_outcome_unknown', {
        provider: 'twilio',
        retryable: false,
      }).catch(() => {});
      return {
        handled: true,
        status: 'outcome_unknown',
        agent_message: 'The transfer status is unclear. Do not retry it.',
      };
    }
  }

  return Object.freeze({ request, handleDtmf });
}

module.exports = {
  HANDOFF_CONFIRMATION_PROMPT,
  HANDOFF_CONFIRMATION_TTL_MS,
  resolveCallAgentHandoffPolicy,
  classifyCallAgentHandoffDtmf,
  exposeCallAgentHandoffAction,
  buildTwilioCallHandoffTwiml,
  createCallAgentHandoffService,
};
