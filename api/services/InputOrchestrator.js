const { normalizeStage, getStageDefinition } = require('../utils/dtmf');

function parseJson(payload) {
  if (!payload) {
    return null;
  }
  if (typeof payload === 'object') {
    return payload;
  }
  try {
    return JSON.parse(payload);
  } catch (error) {
    console.warn('InputOrchestrator: failed to parse metadata payload:', error.message);
    return null;
  }
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

class InputOrchestrator {
  constructor(callConfig = {}) {
    this.callConfig = callConfig || {};
    this.callType = (this.callConfig.call_type || 'service').toLowerCase();
    this.metadata = parseJson(this.callConfig.metadata_json) || parseJson(this.callConfig.metadata) || {};
    this.stageMap = new Map();
    this.stageOrder = [];
    this.stageProgress = new Map();
    this.loadStages();
  }

  loadStages() {
    const sequenceSources = [];
    if (Array.isArray(this.callConfig.collect_input_sequence)) {
      sequenceSources.push(...this.callConfig.collect_input_sequence);
    }
    if (Array.isArray(this.metadata?.input_sequence)) {
      sequenceSources.push(...this.metadata.input_sequence);
    }

    sequenceSources.forEach((entry, index) => {
      const payload = { ...entry };
      if (!payload.stage && !payload.stage_key && !payload.label) {
        payload.stage = `STEP_${index + 1}`;
      }
      this.addStageDefinition(payload);
    });

    [this.metadata?.dtmf_expectations, this.metadata?.input_expectations, this.metadata?.secure_inputs].forEach(
      (group) => this.addExpectationGroup(group)
    );

    if (!this.stageMap.size) {
      const fallbackOtp =
        this.metadata?.expected_otp ||
        this.metadata?.otp_code ||
        this.metadata?.one_time_passcode ||
        this.metadata?.expected_passcode ||
        this.metadata?.passcode;
      if (fallbackOtp) {
        this.addStageDefinition({
          stage: 'OTP',
          label: 'OTP',
          expectedValue: fallbackOtp,
          numDigits:
            this.metadata?.default_digit_length ||
            fallbackOtp.length ||
            this.callConfig.collect_digits ||
            this.metadata?.expected_length,
        });
      }
    }
  }

  addExpectationGroup(group) {
    if (!group) {
      return;
    }
    if (Array.isArray(group)) {
      group.forEach((entry) => this.addStageDefinition(entry));
      return;
    }
    if (typeof group === 'object') {
      Object.entries(group).forEach(([stage, value]) => {
        if (value == null) {
          return;
        }
        if (typeof value === 'object') {
          this.addStageDefinition({ stage, ...value });
        } else {
          this.addStageDefinition({ stage, expectedValue: value });
        }
      });
    }
  }

  createDefinition(stageKey) {
    const normalized = normalizeStage(stageKey);
    const base = getStageDefinition(normalized);
    return {
      stageKey: normalized,
      label: base.label || stageKey || normalized,
      expectedValue: null,
      expectedLength: null,
      pattern: null,
      prompt: null,
      instructions: null,
      successMessage: null,
      failureMessage: null,
    };
  }

  addStageDefinition(entry = {}) {
    const normalizedKey = normalizeStage(
      entry.stage || entry.stage_key || entry.label || entry.name || entry.stageKey || entry.key || 'GENERIC'
    );
    const definition = this.stageMap.get(normalizedKey) || this.createDefinition(normalizedKey);
    if (!this.stageMap.has(normalizedKey)) {
      this.stageMap.set(normalizedKey, definition);
      this.stageOrder.push(normalizedKey);
    }

    if (entry.label || entry.name) {
      definition.label = entry.label || entry.name;
    }
    if (entry.prompt) {
      definition.prompt = entry.prompt;
    }
    if (entry.instructions) {
      definition.instructions = entry.instructions;
    }
    if (entry.thankYou || entry.thank_you) {
      definition.thankYou = entry.thankYou || entry.thank_you;
    }
    const expectedValue = entry.expectedValue ?? entry.value ?? entry.code ?? entry.digits;
    if (expectedValue !== undefined && expectedValue !== null && expectedValue !== '') {
      definition.expectedValue = String(expectedValue).trim();
    }
    const expectedLength =
      toNumber(entry.expectedLength) ??
      toNumber(entry.numDigits) ??
      toNumber(entry.length) ??
      toNumber(entry.defaultDigits);
    if (expectedLength) {
      definition.expectedLength = expectedLength;
    }
    if (entry.pattern) {
      definition.pattern = entry.pattern;
    }
    const successMessage = entry.successMessage || entry.success_message || entry.thankYou;
    if (successMessage) {
      definition.successMessage = successMessage;
    }
    const failureMessage = entry.failureMessage || entry.failure_message || entry.retryPrompt;
    if (failureMessage) {
      definition.failureMessage = failureMessage;
    }
    return definition;
  }

  ensureStage(stageKey, fallbackLabel) {
    const normalized = normalizeStage(stageKey || 'GENERIC');
    if (!this.stageMap.has(normalized)) {
      const definition = this.createDefinition(normalized);
      if (fallbackLabel) {
        definition.label = fallbackLabel;
      }
      this.stageMap.set(normalized, definition);
      this.stageOrder.push(normalized);
    }
    return this.stageMap.get(normalized);
  }

  isFinalStage(stageKey) {
    if (!this.stageOrder.length) {
      return false;
    }
    const normalized = normalizeStage(stageKey || 'GENERIC');
    return this.stageOrder[this.stageOrder.length - 1] === normalized;
  }

  evaluateStage(stage, digits) {
    if (!digits) {
      return 'no_input';
    }
    if (stage.expectedLength && digits.length !== stage.expectedLength) {
      return 'length_mismatch';
    }
    if (stage.pattern) {
      try {
        const regex = new RegExp(stage.pattern);
        if (!regex.test(digits)) {
          return 'pattern_mismatch';
        }
      } catch (error) {
        console.warn('InputOrchestrator: invalid stage pattern supplied:', error.message);
      }
    }
    if (stage.expectedValue && digits !== stage.expectedValue) {
      return 'value_mismatch';
    }
    if (stage.expectedValue || stage.expectedLength || stage.pattern) {
      return 'success';
    }
    return 'captured';
  }

  composeAgentPrompt(stage, digits, status) {
    return this.composeAgentPrompt(stage, digits, status, {});
  }

  composeAgentPrompt(stage, digits, status, context = {}) {
    const stageLabel = stage.label || stage.stageKey || 'the requested information';
    const acknowledgement = stage.instructions
      ? stage.instructions.replace('{digits}', digits)
      : `Let the caller know you received "${digits}" for ${stageLabel}.`;

    const isPositive = status === 'success' || status === 'captured';
    const lines = [acknowledgement];

    if (isPositive) {
      const successLine =
        stage.successMessage ||
        (this.callType === 'collect_input' && (context.workflowComplete || this.isFinalStage(stage.stageKey))
          ? 'Confirm the verification is complete and deliver the thank-you script or wrap-up instructions.'
          : 'Confirm everything looks good and continue with the next step of the call.');
      lines.push(successLine);

      if (context.workflowComplete) {
        if (stage.thankYou) {
          lines.push(stage.thankYou);
        }
      } else if (context.nextStage && context.nextStage.stageKey !== stage.stageKey) {
        const nextLabel = context.nextStage.label || context.nextStage.stageKey || 'the next item';
        if (context.nextStage.prompt) {
          lines.push(`Guide them into ${nextLabel} by saying "${context.nextStage.prompt}".`);
        } else {
          lines.push(`Guide them directly into collecting ${nextLabel} like a live agent would.`);
        }
      }

      return lines.filter(Boolean).join(' ').trim();
    }

    let failureLine = stage.failureMessage;
    if (!failureLine) {
      if (status === 'length_mismatch') {
        const expectedText = stage.expectedLength ? `${stage.expectedLength} digits` : 'the required number of digits';
        failureLine = `Explain that the entry did not include ${expectedText} and politely ask them to try again slowly.`;
      } else if (status === 'pattern_mismatch') {
        failureLine = 'Explain that the format looks off and guide them through the correct format before asking them to retry.';
      } else if (status === 'value_mismatch') {
        failureLine = 'Let them know the code does not match our records and offer to resend or have them re-enter it carefully.';
      } else {
        failureLine = 'Ask them to re-enter the digits carefully.';
      }
    }
    lines.push(failureLine);
    return lines.filter(Boolean).join(' ').trim();
  }

  handleInput(stageKey, digits) {
    if (!digits) {
      return null;
    }
    const stage = this.ensureStage(stageKey);
    const status = this.evaluateStage(stage, digits);
    const progress = this.stageProgress.get(stage.stageKey) || { attempts: 0, status: 'pending' };
    progress.attempts += 1;
    progress.lastValue = digits;
    progress.status = ['success', 'captured'].includes(status) ? 'completed' : 'retry';
    this.stageProgress.set(stage.stageKey, progress);

    const workflowComplete = this.isWorkflowComplete();
    const nextStage = progress.status === 'completed' ? this.getNextPendingStage(stage.stageKey) : null;

    const needsRetry = ['value_mismatch', 'length_mismatch', 'pattern_mismatch'].includes(status);

    return {
      stageKey: stage.stageKey,
      stageLabel: stage.label,
      status,
      expectedValue: stage.expectedValue || null,
      expectedLength: stage.expectedLength || null,
      agentPrompt: this.composeAgentPrompt(stage, digits, status, {
        nextStage,
        workflowComplete,
      }),
      needsRetry,
      workflowComplete,
      nextStage,
      attempts: progress.attempts,
      isFinalStage: this.isFinalStage(stage.stageKey),
    };
  }

  getNextPendingStage(currentStageKey = null) {
    if (!this.stageOrder.length) {
      return null;
    }
    const normalizedCurrent = currentStageKey ? normalizeStage(currentStageKey) : null;
    let startIndex = 0;
    if (normalizedCurrent) {
      const idx = this.stageOrder.indexOf(normalizedCurrent);
      startIndex = idx >= 0 ? idx + 1 : 0;
    }
    for (let i = startIndex; i < this.stageOrder.length; i += 1) {
      const stageKey = this.stageOrder[i];
      const progress = this.stageProgress.get(stageKey);
      if (!progress || progress.status !== 'completed') {
        return this.stageMap.get(stageKey);
      }
    }
    return null;
  }

  isWorkflowComplete() {
    if (!this.stageOrder.length) {
      return false;
    }
    return this.stageOrder.every((stageKey) => {
      const progress = this.stageProgress.get(stageKey);
      return progress && progress.status === 'completed';
    });
  }
}

module.exports = InputOrchestrator;
