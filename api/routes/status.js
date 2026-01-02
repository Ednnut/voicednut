let axios;
try {
  axios = require('axios');
} catch (e) {
  // Minimal fallback for environments where axios isn't installed (e.g., unit tests).
  axios = {
    async post(url, payload, opts = {}) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        body: JSON.stringify(payload),
        // Note: fetch timeout handling would require AbortController; omitted here.
      });
      const data = await res.json().catch(() => ({}));
      return { data };
    }
  };
}
const fetch = require('node-fetch');
const config = require('../config');

class EnhancedWebhookService {
  constructor(httpClient = axios) {
    this.isRunning = false;
    this.interval = null;
    this.db = null;
    this.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    this.http = httpClient;
    this.processInterval = 3000; // Check every 3 seconds for faster updates
    this.activeCallStatus = new Map(); // Track call status to avoid duplicates
    this.callTimestamps = new Map(); // Track call timing for better status management
    this.statusOrder = [
      'queued',
      'initiated',
      'ringing',
      'in-progress',
      'answered',
      'completed',
      'busy',
      'no-answer',
      'failed',
      'canceled',
      'ended'
    ];

    // --- Live call console state (Telegram message edits) ---
    this.liveCalls = new Map();
    this.liveEditMinIntervalMs = 900; // avoid Telegram rate-limits / edit storms
    this.liveMaxTranscriptLines = 4; // last N turns (user+ai)
    this.liveMaxTextLength = 3500; // keep well under Telegram's 4096 limit

    // --- Telegram send debouncing ---
    this.debounceIntervalMs = 1000; // max 1 update / sec
    this.lastSendAt = new Map();
    this.sendQueues = new Map();
    this.sendLocks = new Map();
    this.maxTelegramRetries = 3;

    // Alert mutes
    this.mutedCallAlerts = new Set();
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
    console.log('ð Starting enhanced webhook service with no-answer detection...'.green);
    
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
    this.callTimestamps.clear();
    this.liveCalls.clear();
    console.log('Enhanced webhook service stopped'.yellow);
  }

  /**
   * Initialize a single "live console" message for a call.
   * Subsequent updates will edit the same message instead of sending many.
   */
  async initLiveCallConsole(callSid, telegramChatId, meta = {}) {
    if (!this.telegramBotToken) return false;
    if (!callSid || !telegramChatId) return false;

    const existing = this.liveCalls.get(callSid);
    if (existing?.messageId) {
      // already created
      return true;
    }

    const state = {
      callSid,
      chatId: telegramChatId,
      messageId: null,
      phoneNumber: meta.phoneNumber,
      customerName: meta.customerName,
      templateName: meta.templateName,
      phase: 'started',
      transcriptLines: [],
      currentLine: '⏳ Status: Call queued',
      durationSeconds: 0,
      lastText: '',
      lastEditAt: 0,
      pendingText: null,
      pendingTimer: null
    };

    const initialText = this.renderLiveCallConsole(state);
    const res = await this.sendTelegramMessage(
      telegramChatId,
      initialText,
      true,
      this.getLiveCallKeyboard(state)
    );
    const messageId = res?.result?.message_id;
    if (!messageId) return false;

    state.messageId = messageId;
    state.lastText = initialText;
    state.lastEditAt = Date.now();
    this.liveCalls.set(callSid, state);
    return true;
  }

  /**
   * Update the call console phase (e.g. listening/thinking/speaking/ended).
   */
  async setLiveCallPhase(callSid, phase) {
    const state = this.liveCalls.get(callSid);
    if (!state?.messageId) return false;
    state.phase = phase;
    state.currentLine = this.phaseToTicker(phase, state.currentLine);
    return this.flushLiveCallConsole(callSid);
  }

  /**
   * Append a transcript turn and update the edited Telegram message.
   */
  async appendLiveTranscript(callSid, speaker, text) {
    const state = this.liveCalls.get(callSid);
    if (!state?.messageId) return false;
    if (!text || !text.trim()) return true;

    state.phase = speaker === 'user' ? 'listening' : 'speaking';
    state.currentLine = speaker === 'user'
      ? '🎙 Status: Caller speaking'
      : '🤖 Status: Agent responding';
    return this.flushLiveCallConsole(callSid);
  }

  /**
   * Best-effort: mark live call as ended and cleanup after a short delay.
   */
  async endLiveCallConsole(callSid, reason = 'ended') {
    const state = this.liveCalls.get(callSid);
    if (!state?.messageId) return false;
    state.phase = reason;
    state.currentLine = this.phaseToTicker(reason, state.currentLine);
    await this.flushLiveCallConsole(callSid, { force: true });

    // cleanup after 10 minutes (keeps message editable briefly for late updates)
    setTimeout(() => {
      this.liveCalls.delete(callSid);
    }, 10 * 60 * 1000);

    return true;
  }

  renderLiveCallConsole(state) {
    const title = '📞 Outbound Call';
    const customer = this.escapeMarkdown(state.customerName || 'Unknown');
    const phone = this.escapeMarkdown(state.phoneNumber || 'Unknown');
    const template = this.escapeMarkdown(state.templateName || 'Custom');
    const line = state.currentLine || this.phaseToTicker(state.phase, '⏳ Status: Call queued');
    const duration = this.formatDurationClock(state.durationSeconds);
    const text = [
      title,
      '',
      `👤 Customer: ${customer}`,
      `📱 Number: ${phone}`,
      `📄 Template: ${template}`,
      '',
      line,
      `⏱ Duration: ${duration}`
    ].join('\n');
    if (text.length > this.liveMaxTextLength) {
      return text.slice(0, this.liveMaxTextLength - 1) + '…';
    }
    return text;
  }

  /**
   * Inline keyboard for the live call console.
   * Kept compact to stay within Telegram callback_data limits.
   */
  getLiveCallKeyboard(state) {
    if (!state?.callSid) return null;

    // Remove controls for terminal phases.
    const terminal = new Set(['ended', 'completed', 'failed', 'canceled', 'no-answer', 'busy']);
    if (terminal.has(state.phase)) return null;

    const sid = state.callSid;
    const rows = [
      [
        { text: 'â Interrupt', callback_data: `lc:int:${sid}` },
        { text: 'ð End', callback_data: `lc:end:${sid}` }
      ]
    ];

    if (process.env.TRANSFER_NUMBER) {
      rows.push([{ text: 'ð Transfer', callback_data: `lc:xfer:${sid}` }]);
    }

    return { inline_keyboard: rows };
  }

  phaseToTicker(phase, fallback = '⏳ Status: Call queued') {
    const map = {
      started: '⏳ Status: Call queued',
      calling: '📞 Status: Calling...',
      listening: '🎙 Status: Caller speaking',
      thinking: '🤖 Status: Agent responding',
      speaking: '🤖 Status: Agent responding',
      interrupted: '⚠️ Status: Call interrupted',
      ended: '🔴 Status: Call ended',
      completed: '🔴 Status: Call ended',
      failed: '🔴 Status: Call ended'
    };
    return map[phase] || fallback;
  }

  async markToolInvocation(callSid, toolName) {
    const state = this.liveCalls.get(callSid);
    if (!state?.messageId) return false;
    state.currentLine = `🔄 Tool invoked: ${toolName || 'unknown'}`;
    return this.flushLiveCallConsole(callSid, { force: true });
  }

  async markSentimentDrop(callSid) {
    const state = this.liveCalls.get(callSid);
    if (!state?.messageId) return false;
    state.currentLine = '⚠️ Sentiment drop detected';
    return this.flushLiveCallConsole(callSid, { force: true });
  }

  async answerCallbackQuery(callbackQueryId, text) {
    if (!this.telegramBotToken) return false;
    if (!callbackQueryId) return false;

    const url = `https://api.telegram.org/bot${this.telegramBotToken}/answerCallbackQuery`;
    const payload = {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      show_alert: false
    };

    try {
      const response = await this.http.post(url, payload, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' }
      });
      return !!response.data?.ok;
    } catch {
      return false;
    }
  }

  cleanPlainText(text) {
    // For edited plain text messages, keep it simple and safe.
    return String(text)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  enqueueTelegram(chatId, payload, meta = {}) {
    if (!chatId || !payload) return Promise.resolve(false);
    if (!this.sendQueues.has(chatId)) {
      this.sendQueues.set(chatId, []);
    }
    return new Promise((resolve) => {
      const queue = this.sendQueues.get(chatId);
      const item = { payload, meta, attempts: 0, resolve };
      if (meta.priority) {
        queue.unshift(item);
      } else {
        queue.push(item);
      }
      this.processSendQueue(chatId);
    });
  }

  async processSendQueue(chatId) {
    if (!this.telegramBotToken) return false;
    if (this.sendLocks.get(chatId)) return true;
    this.sendLocks.set(chatId, true);

    try {
      const queue = this.sendQueues.get(chatId) || [];
      while (queue.length > 0) {
        const item = queue[0];
        const now = Date.now();
        const lastSent = this.lastSendAt.get(chatId) || 0;
        const elapsed = now - lastSent;

        // Debounce unless priority
        if (!item.meta.priority && elapsed < this.debounceIntervalMs) {
          const delay = this.debounceIntervalMs - elapsed;
          await this.delay(delay);
        }

        const result = await this.sendTelegramRequestWithRetry(item);
        queue.shift();

        if (result.success) {
          this.lastSendAt.set(chatId, Date.now());
          item.resolve(result.data || true);
        } else {
          // Failure already logged; continue with next item
          item.resolve(false);
        }
      }
    } finally {
      this.sendLocks.set(chatId, false);
    }
    return true;
  }

  async sendTelegramRequestWithRetry(item) {
    const { payload, meta } = item;
    const callSid = meta.callSid || payload.call_sid || null;
    const fallbackText = meta.fallbackText;

    let attempt = 0;
    let delayMs = 400;
    while (attempt < this.maxTelegramRetries) {
      try {
        const response = await this.http.post(
          `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`,
          payload,
          {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' }
          }
        );
        if (response?.data?.ok) {
          return { success: true, data: response.data };
        }
        throw new Error(response?.data?.description || 'Unknown Telegram error');
      } catch (error) {
        attempt += 1;
        if (attempt >= this.maxTelegramRetries) {
          console.error(`❌ Telegram send failed after ${attempt} attempts:`, error.message);
          if (this.db && this.db.logServiceHealth) {
            await this.db.logServiceHealth('telegram_delivery', 'failed', {
              call_sid: callSid,
              error: error.message,
              payload_preview: (payload?.text || '').slice(0, 120)
            });
          }
          // Fallback: short summary-only message
          if (fallbackText) {
            try {
              const fallbackResponse = await this.http.post(
                `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`,
                {
                  chat_id: payload.chat_id,
                  text: fallbackText,
                  disable_web_page_preview: true
                },
                {
                  timeout: 8000,
                  headers: { 'Content-Type': 'application/json' }
                }
              );
              if (fallbackResponse?.data?.ok) {
                return { success: true, data: fallbackResponse.data };
              }
            } catch (fallbackError) {
              console.error('❌ Telegram fallback message failed:', fallbackError.message);
            }
          }
          return { success: false, data: null };
        }
        await this.delay(delayMs);
        delayMs *= 2;
      }
    }
    return { success: false, data: null };
  }

  async flushLiveCallConsole(callSid, opts = {}) {
    const state = this.liveCalls.get(callSid);
    if (!state?.messageId) return false;

    const nextText = this.renderLiveCallConsole(state);
    if (!opts.force && nextText === state.lastText) return true;

    const now = Date.now();
    const sinceLast = now - (state.lastEditAt || 0);

    // Debounce edits to avoid rate limits.
    if (!opts.force && sinceLast < this.liveEditMinIntervalMs) {
      state.pendingText = nextText;
      if (!state.pendingTimer) {
        state.pendingTimer = setTimeout(async () => {
          try {
            const s = this.liveCalls.get(callSid);
            if (!s?.pendingText) return;
            const pending = s.pendingText;
            s.pendingText = null;
            s.pendingTimer = null;
            console.log(`📝 Telegram edit attempt (status card): ${callSid}`);
            await this.editTelegramMessage(
              s.chatId,
              s.messageId,
              pending,
              true,
              this.getLiveCallKeyboard(s)
            );
            s.lastText = pending;
            s.lastEditAt = Date.now();
          } catch (e) {
            // don't throw; live console is best-effort
            console.error('â Live call console edit failed:', e.message);
          }
        }, this.liveEditMinIntervalMs - sinceLast);
      }
      return true;
    }

    try {
      console.log(`📝 Telegram edit attempt (status card): ${callSid}`);
      await this.editTelegramMessage(
        state.chatId,
        state.messageId,
        nextText,
        true,
        this.getLiveCallKeyboard(state)
      );
      state.lastText = nextText;
      state.lastEditAt = now;
      return true;
    } catch (e) {
      console.error('â Live call console edit failed:', e.message);
      return false;
    }
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
      console.log(`â­ï¸ Skipping duplicate status ${newStatus} for call ${call_sid}`.gray);
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

    console.log(`â­ï¸ Skipping out-of-order status ${newStatus} (current: ${lastStatus}) for call ${call_sid}`.gray);
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
          console.error(`â Failed to send notification ${notification.id}:`, error.message);
        }
      }
    } catch (error) {
      console.error('â Error processing notifications:', error);
    }
  }

  // Enhanced call status update with proper no-answer detection
  async sendCallStatusUpdate(call_sid, status, telegram_chat_id, additionalData = {}) {
    try {
      // Check if we should send this status
      if (!this.shouldSendStatus(call_sid, status)) {
        return true; // Return success to mark notification as processed
      }

      const normalizedStatus = status.toLowerCase();
      let message = '';
      let emoji = '';
      
      // Track call timing for duration calculations
      if (!this.callTimestamps.has(call_sid)) {
        this.callTimestamps.set(call_sid, { started: new Date() });
      }
      const callTiming = this.callTimestamps.get(call_sid);

      switch (normalizedStatus) {
        case 'queued':
        case 'initiated':
          emoji = '⏳';
          message = 'Initiating call...';
          if (!callTiming.initiated) {
            callTiming.initiated = new Date();
          }
          break;
          
        case 'ringing':
          emoji = '📞';
          message = 'Ringing...';
          if (!callTiming.ringing) {
            callTiming.ringing = new Date();
          }
          // Calculate time to ring
          if (callTiming.initiated) {
            const ringDelay = ((new Date() - callTiming.initiated) / 1000).toFixed(1);
            if (ringDelay > 2) {
              message += ` (${ringDelay}s)`;
            }
          }
          break;
          
        case 'in-progress':
          emoji = '📞';
          message = 'Calling...';
          if (!callTiming.inProgress) {
            callTiming.inProgress = new Date();
          }
          break;

        case 'answered':
          emoji = '🟢';
          message = 'Call answered';
          if (!callTiming.answered) {
            callTiming.answered = new Date();
          }
          // Calculate ring duration
          if (callTiming.ringing) {
            const ringDuration = ((new Date() - callTiming.ringing) / 1000).toFixed(0);
            message += ` (rang ${ringDuration}s)`;
          }
          break;
          
        case 'completed':
          emoji = '🔴';
          callTiming.completed = new Date();
          
          // Calculate call duration - be more careful about actual vs ring time
          let duration = '';
          const actualDuration = additionalData.duration;
          
          if (actualDuration && actualDuration > 3) {
            const minutes = Math.floor(actualDuration / 60);
            const seconds = actualDuration % 60;
            duration = ` (${minutes}:${String(seconds).padStart(2, '0')})`;
          } else if (callTiming.answered) {
            const totalTime = ((new Date() - callTiming.answered) / 1000).toFixed(0);
            if (totalTime > 3) {
              const minutes = Math.floor(totalTime / 60);
              const seconds = totalTime % 60;
              duration = ` (~${minutes}:${String(seconds).padStart(2, '0')})`;
            }
          }
          
          message = `Call completed${duration}`;
          break;
          
        case 'busy':
          emoji = '⚠️';
          message = 'Line busy';
          // Calculate time before busy signal
          if (callTiming.ringing || callTiming.initiated) {
            const busyTime = callTiming.ringing || callTiming.initiated;
            const timeBeforeBusy = ((new Date() - busyTime) / 1000).toFixed(0);
            if (timeBeforeBusy > 1) {
              message += ` (${timeBeforeBusy}s)`;
            }
          }
          break;
          
        case 'no-answer':
        case 'no_answer':
          emoji = '❌';
          message = 'No answer';
          
          // Enhanced no-answer timing calculation
          let ringTime = 0;
          
          if (additionalData.ring_duration) {
            // Use ring duration from database if available
            ringTime = additionalData.ring_duration;
            console.log(`ð Using database ring duration: ${ringTime}s`.cyan);
          } else if (callTiming.ringing) {
            // Calculate from our timing data
            ringTime = Math.round((new Date() - callTiming.ringing) / 1000);
            console.log(`ð Calculated ring duration: ${ringTime}s`.cyan);
          } else if (callTiming.initiated) {
            // Fall back to total time since call started
            ringTime = Math.round((new Date() - callTiming.initiated) / 1000);
            console.log(`ð Using total call time: ${ringTime}s`.cyan);
          }
          
          if (ringTime > 0) {
            message += ` (rang ${ringTime}s)`;
          }
          
          console.log(`ð No-answer notification: ${message}`.yellow);
          break;
          
        case 'failed':
          emoji = '❌';
          message = 'Call failed';
          if (additionalData.error || additionalData.error_message) {
            const errorMsg = additionalData.error || additionalData.error_message;
            message += ` (${errorMsg})`;
          }
          break;
          
        case 'canceled':
          emoji = '🚫';
          message = 'Call canceled';
          break;

        case 'ended':
          emoji = '🔴';
          message = 'Call ended';
          break;
          
        default:
          emoji = '📱';
          message = `Call ${status}`;
      }

      const durationFromProvider = Number.isFinite(additionalData.duration)
        ? additionalData.duration
        : null;
      const durationSeconds = durationFromProvider && durationFromProvider > 0
        ? durationFromProvider
        : this.deriveDurationSeconds(callTiming);
      const statusLine = this.buildStatusLine(normalizedStatus, message, emoji);
      const callMeta = await this.getCallMeta(call_sid);

      await this.initLiveCallConsole(call_sid, telegram_chat_id, callMeta);
      const state = this.liveCalls.get(call_sid);
      if (state) {
        if (callMeta.phoneNumber) state.phoneNumber = callMeta.phoneNumber;
        if (callMeta.customerName) state.customerName = callMeta.customerName;
        if (callMeta.templateName) state.templateName = callMeta.templateName;
        state.currentLine = statusLine;
        state.durationSeconds = durationSeconds;
        if (['completed', 'failed', 'no-answer', 'busy', 'canceled', 'ended'].includes(normalizedStatus)) {
          state.phase = 'ended';
        }
      }

      const success = await this.flushLiveCallConsole(call_sid, { force: true });
      if (success) {
        console.log(`â Sent enhanced status update: ${normalizedStatus} for call ${call_sid}`.green);
      } else {
        throw new Error('Telegram delivery failed');
      }
      
      // Log notification metric
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric(`call_${normalizedStatus}`, true);
      }

      // Schedule cleanup for terminal states
      if (['completed', 'failed', 'no-answer', 'busy', 'canceled'].includes(normalizedStatus)) {
        setTimeout(() => {
          this.cleanupCallData(call_sid);
        }, 5 * 60 * 1000); // Cleanup after 5 minutes
      }

      return true;
    } catch (error) {
      console.error('â Failed to send enhanced call status update:', error);
      
      // Log failed notification metric
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
      
      if (!callDetails || !transcripts || transcripts.length === 0) {
        await this.sendTelegramMessage(telegram_chat_id, 'ð No transcript available for this call');
        return true;
      }

      // Enhanced transcript header with call details
      let message = `ð *Call Transcript*\n\n`;
      
      // Call information
      message += `ð *Phone:* ${callDetails.phone_number}\n`;
      
      // Enhanced duration display
      if (callDetails.duration && callDetails.duration > 0) {
        const minutes = Math.floor(callDetails.duration / 60);
        const seconds = callDetails.duration % 60;
        message += `â±ï¸ *Duration:* ${minutes}:${String(seconds).padStart(2, '0')}\n`;
      }
      
      // Call timing if available
      if (callDetails.started_at && callDetails.ended_at) {
        const startTime = new Date(callDetails.started_at).toLocaleTimeString();
        message += `ð *Time:* ${startTime}\n`;
      }
      
      message += `ð¬ *Messages:* ${transcripts.length}\n`;
      
      // Add status info with proper emoji
      if (callDetails.status) {
        const statusEmoji = this.getStatusEmoji(callDetails.status);
        message += `ð *Status:* ${statusEmoji} ${callDetails.status}\n`;
      }
      
      message += `\n*Conversation:*\n`;
      message += `${'â'.repeat(25)}\n`;

      // Process conversation with better formatting
      const maxMessages = 12; // Show more messages
      let conversationLength = 0;
      
      for (let i = 0; i < Math.min(transcripts.length, maxMessages); i++) {
        const t = transcripts[i];
        const speaker = t.speaker === 'user' ? 'ð¤ *Customer*' : 'ð¤ *AI*';
        const cleanMessage = this.cleanMessageForTelegram(t.message);
        const messageText = `${speaker}: ${cleanMessage}\n\n`;
        
        // Check if adding this message would exceed Telegram's limit
        if ((message + messageText).length > 3800) {
          message += `_... conversation continues (${transcripts.length - i} more messages)_\n`;
          break;
        }
        
        message += messageText;
        conversationLength++;
      }

      if (transcripts.length > maxMessages && conversationLength === maxMessages) {
        message += `_... and ${transcripts.length - maxMessages} more messages_\n\n`;
        message += `Use \`/transcript ${call_sid}\` for full details`;
      }

      // Add call summary if available
      if (callDetails.call_summary) {
        message += `\nð *Summary:* ${callDetails.call_summary}`;
      }

      // Split and send message if too long
      if (message.length > 4000) {
        const chunks = this.splitMessage(message, 3900);
        for (let i = 0; i < chunks.length; i++) {
          await this.sendTelegramMessage(telegram_chat_id, chunks[i], true); // Enable markdown
          if (i < chunks.length - 1) {
            await this.delay(1500); // Longer delay for better UX
          }
        }
      } else {
        await this.sendTelegramMessage(telegram_chat_id, message, true); // Enable markdown
      }

      console.log(`â Sent enhanced transcript for call ${call_sid}`.green);
      
      // Log transcript metric
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_transcript', true);
      }
      
      return true;
      
    } catch (error) {
      console.error('â Failed to send enhanced call transcript:', error);
      
      // Log failed transcript metric
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_transcript', false);
      }
      
      try {
        await this.sendTelegramMessage(telegram_chat_id, 'â Error retrieving call transcript');
      } catch (fallbackError) {
        console.error('Failed to send error message:', fallbackError);
      }
      
      return false;
    }
  }

  parseJsonSafely(payload, fallback = null) {
    if (!payload) return fallback;
    if (typeof payload === 'object') return payload;
    try {
      return JSON.parse(payload);
    } catch {
      return fallback;
    }
  }

  maskSensitiveDigits(text = '') {
    return String(text || '').replace(/\b\d{6,}\b/g, (match) => {
      const prefix = match.slice(0, 2);
      const suffix = match.slice(-2);
      const hidden = '•'.repeat(Math.min(Math.max(match.length - 4, 0), 12));
      return `${prefix}${hidden}${suffix}`;
    });
  }

  formatDurationForCard(seconds, fallback = 'N/A') {
    if (!seconds || Number.isNaN(seconds)) return fallback;
    const total = Math.max(0, parseInt(seconds, 10));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    if (minutes === 0) return `${remainder}s`;
    return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  }

  formatDurationClock(seconds, fallback = '00:00') {
    if (!seconds || Number.isNaN(seconds)) return fallback;
    const total = Math.max(0, parseInt(seconds, 10));
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }

  deriveDurationSeconds(callTiming) {
    if (!callTiming) return 0;
    const anchor =
      callTiming.answered ||
      callTiming.inProgress ||
      callTiming.ringing ||
      callTiming.initiated ||
      callTiming.started;
    if (!anchor) return 0;
    return Math.max(0, Math.round((new Date() - anchor) / 1000));
  }

  buildStatusLine(status, message, emoji) {
    const statusTextMap = {
      queued: 'Call queued',
      initiated: 'Calling...',
      ringing: 'Ringing...',
      'in-progress': 'Calling...',
      answered: 'Call answered',
      completed: 'Call ended',
      busy: 'Line busy',
      'no-answer': 'No-answered',
      failed: 'Call ended',
      canceled: 'Call ended',
      ended: 'Call ended'
    };
    const label = statusTextMap[status] || message || `Call ${status}`;
    const icon = emoji || this.getStatusEmoji(status);
    return `${icon} Status: ${label}`;
  }

  async getCallMeta(callSid) {
    if (!this.db?.getCall) return {};
    try {
      const call = await this.db.getCall(callSid);
      if (!call) return {};
      return {
        phoneNumber: call.phone_number,
        customerName: call.customer_name || call.client_name || null,
        templateName: call.template || call.template_name || null
      };
    } catch (error) {
      console.warn(`⚠️ Failed to load call metadata for ${callSid}:`, error.message);
      return {};
    }
  }

  renderSummaryCard(call = {}, structured = {}, summaryText = '', confidence = null) {
    const divider = '━━━━━━━━━━━━━━━━━━━━━━━';
    const duration = structured.duration_label || this.formatDurationForCard(call.duration, 'N/A');
    const outcome = structured.outcome || call.status || 'completed';
    const intent = structured.key_intent || structured.intent || 'General';
    const escalation = structured.escalation_reason || 'None reported';
    const sentiment = structured.sentiment || {};
    const sentimentDisplay = this.maskSensitiveDigits(
      sentiment.emoji ||
      `${sentiment.start || 'neutral'} → ${sentiment.end || 'neutral'}` +
      (sentiment.trend ? ` (${sentiment.trend})` : '')
    );
    const quality = typeof structured.call_quality_score === 'number' ? `${structured.call_quality_score}/100` : 'N/A';
    const latency = structured.latency_metrics || {};
    const latencyLine = [
      latency.stt_ms ? `STT ${latency.stt_ms}ms` : null,
      latency.gpt_ms ? `GPT ${latency.gpt_ms}ms` : null,
      latency.tts_ms ? `TTS ${latency.tts_ms}ms` : null
    ].filter(Boolean).join(' • ');
    const phone = this.cleanMessageForTelegram(this.maskSensitiveDigits(call.phone_number || 'Unknown'));
    const customer = this.cleanMessageForTelegram(this.maskSensitiveDigits(
      call.customer_name || call.client_name || call.metadata?.customer_name || 'Client'
    ));
    const timestampSource = call.ended_at || call.started_at || call.created_at || new Date().toISOString();
    const timestamp = this.cleanMessageForTelegram(new Date(timestampSource).toLocaleString());

    const lines = [
      '📞 Call Summary',
      divider,
      `🕒 Duration: ${this.cleanMessageForTelegram(duration)}`,
      `🕵️ Outcome: ${this.cleanMessageForTelegram(outcome)}`,
      `😊 Sentiment: ${this.cleanMessageForTelegram(sentimentDisplay)}`,
      `🎯 Key intent: ${this.cleanMessageForTelegram(this.maskSensitiveDigits(intent))}`,
      `⚠️ Escalation: ${this.cleanMessageForTelegram(this.maskSensitiveDigits(escalation))}`,
      `📊 Quality: ${this.cleanMessageForTelegram(quality)}`,
      latencyLine ? `⏱️ Latency: ${this.cleanMessageForTelegram(latencyLine)}` : '',
      confidence ? `🤖 Agent confidence: ${confidence.bar} ${confidence.percent}%` : '',
      '',
      `📱 Number: ${phone}`,
      `👤 Client: ${customer}`,
      `🕒 Timestamp: ${timestamp}`,
      ''
    ];

    const highlights = Array.isArray(structured.highlights) ? structured.highlights.slice(0, 4) : [];
    if (highlights.length) {
      lines.push('*Highlights*');
      highlights.forEach((item) => lines.push(`• ${this.cleanMessageForTelegram(this.maskSensitiveDigits(item))}`));
      lines.push('');
    }

    const actions = Array.isArray(structured.actions) ? structured.actions.slice(0, 3) : [];
    if (actions.length) {
      lines.push('*Actions*');
      actions.forEach((item) => lines.push(`• ${this.cleanMessageForTelegram(this.maskSensitiveDigits(item))}`));
      lines.push('');
    }

    const nextSteps = Array.isArray(structured.next_steps) ? structured.next_steps.slice(0, 3) : [];
    if (nextSteps.length) {
      lines.push('*Next Steps*');
      nextSteps.forEach((item) => lines.push(`• ${this.cleanMessageForTelegram(this.maskSensitiveDigits(item))}`));
      lines.push('');
    }

    const alerts = Array.isArray(structured.alerts) ? structured.alerts.slice(0, 3) : [];
    if (alerts.length) {
      lines.push('*Alerts*');
      alerts.forEach((item) => lines.push(`• ${this.cleanMessageForTelegram(this.maskSensitiveDigits(item))}`));
      lines.push('');
    }

    if (structured.follow_up_sms) {
      lines.push('*SMS Draft*');
      lines.push(this.cleanMessageForTelegram(this.maskSensitiveDigits(structured.follow_up_sms)));
      lines.push('');
    }

    if (summaryText) {
      lines.push(`Recap: ${this.cleanMessageForTelegram(this.maskSensitiveDigits(summaryText))}`);
    }

    return this.truncateTelegramText(lines.join('\n'));
  }

  renderAlertMessage(alert = {}, call = {}) {
    const severityEmoji = {
      low: 'ℹ️',
      medium: '⚠️',
      high: '🚨',
      critical: '🛑'
    };
    const emoji = severityEmoji[alert.severity] || '⚠️';
    const reason = this.cleanMessageForTelegram(this.maskSensitiveDigits(alert.reason || 'Alert'));
    const action = this.cleanMessageForTelegram(this.maskSensitiveDigits(alert.recommended_action || 'Review and act.'));
    const callSid = call.call_sid || alert.callSid || 'unknown';

    const lines = [
      `${emoji} Call Alert`,
      '━━━━━━━━━━━━━━━━━━━━━━━',
      `Call: ${callSid}`,
      `Severity: ${alert.severity || 'medium'}`,
      `Reason: ${reason}`,
      `Action: ${action}`
    ];

    return this.truncateTelegramText(lines.join('\n'));
  }

  buildAlertKeyboard(callSid) {
    if (!callSid) return null;
    return {
      inline_keyboard: [
        [
          { text: '🔁 Retry step', callback_data: `alert:retry:${callSid}` },
          { text: '📞 Transfer', callback_data: `alert:transfer:${callSid}` }
        ],
        [
          { text: '🔕 Mute alerts', callback_data: `alert:mute:${callSid}` }
        ]
      ]
    };
  }

  computeConfidence(structured = {}, transcripts = [], call = {}) {
    let score = typeof structured.confidence === 'number' ? structured.confidence : 0.72;

    const sentimentEnd = (structured.sentiment?.end || '').toLowerCase();
    if (sentimentEnd.includes('negative')) score -= 0.1;
    if (sentimentEnd.includes('positive')) score += 0.05;

    if (call.status && call.status !== 'completed') score -= 0.15;
    if (call.error_message) score -= 0.15;

    const turns = Array.isArray(transcripts) ? transcripts.length : 0;
    if (turns > 12) score += 0.05;
    else if (turns < 4) score -= 0.05;

    score = Math.max(0, Math.min(0.98, score));
    const percent = Math.round(score * 100);
    const bars = Math.max(0, Math.min(10, Math.round(percent / 10)));
    const bar = '█'.repeat(bars) + '░'.repeat(10 - bars);

    return { percent, bar };
  }

  getThreadMessageId(callSid) {
    const state = this.liveCalls.get(callSid);
    if (state && state.messageId) {
      return state.messageId;
    }
    return null;
  }

  setCallAlertMute(callSid, muted) {
    if (!callSid) return;
    if (muted) {
      this.mutedCallAlerts.add(callSid);
    } else {
      this.mutedCallAlerts.delete(callSid);
    }
  }

  isCallAlertMuted(callSid) {
    return this.mutedCallAlerts.has(callSid);
  }

  async sendTelegramDocument(chatId, filename, content, mimeType = 'text/plain', replyToMessageId = null) {
    if (!this.telegramBotToken) return false;
    if (!chatId || !content) return false;

    const boundary = `----voicednut-${Date.now()}`;
    const url = `https://api.telegram.org/bot${this.telegramBotToken}/sendDocument`;
    const bufferContent = Buffer.isBuffer(content) ? content : Buffer.from(String(content));

    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`)
    ];

    if (replyToMessageId) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${replyToMessageId}\r\n`));
    }

    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      bufferContent,
      Buffer.from(`\r\n--${boundary}--`)
    );

    const body = Buffer.concat(parts);

    try {
      const response = await this.http.post(url, body, {
        timeout: 20000,
        maxBodyLength: Infinity,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
      });
      return !!response?.data?.ok;
    } catch (error) {
      console.error('Failed to send Telegram document:', error.message);
      return false;
    }
  }

  buildVoiceSummaryText(structured = {}, fallbackSummary = '') {
    const parts = [];
    parts.push('Here is your 30 second call recap.');

    if (structured.summary) {
      parts.push(structured.summary);
    } else if (fallbackSummary) {
      parts.push(fallbackSummary);
    }

    if (structured.outcome) {
      parts.push(`Outcome: ${structured.outcome}.`);
    }
    if (structured.key_intent) {
      parts.push(`Intent: ${structured.key_intent}.`);
    }
    if (Array.isArray(structured.next_steps) && structured.next_steps.length) {
      parts.push(`Next steps: ${structured.next_steps.slice(0, 2).join('; ')}.`);
    }
    if (Array.isArray(structured.alerts) && structured.alerts.length) {
      parts.push(`Alerts: ${structured.alerts.slice(0, 2).join('; ')}.`);
    }

    const joined = parts.join(' ');
    // Rough cap to keep audio short
    return joined.slice(0, 650);
  }

  async generateVoiceSummaryAudio(text) {
    if (!text || !config.deepgram?.apiKey) return null;
    try {
      const voiceModel = config.deepgram.voiceModel || 'aura-asteria-en';
      const url = `https://api.deepgram.com/v1/speak?model=${voiceModel}&encoding=mp3&container=mp3`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${config.deepgram.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text }),
        timeout: 12000
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Deepgram TTS failed: ${response.status} ${response.statusText} - ${errText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error('Voice summary generation error:', error.message);
      return null;
    }
  }

  async sendTelegramVoice(chatId, audioBuffer, caption = '', options = {}) {
    if (!this.telegramBotToken) return false;
    if (!chatId || !audioBuffer) return false;

    const boundary = `----voicednut-voice-${Date.now()}`;
    const url = `https://api.telegram.org/bot${this.telegramBotToken}/sendVoice`;

    const parts = [
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`)
    ];

    if (options.replyTo) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${options.replyTo}\r\n`));
    }

    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="summary.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
      Buffer.from(`--${boundary}--`)
    );

    const body = Buffer.concat(parts);

    try {
      const response = await this.http.post(url, body, {
        timeout: 20000,
        maxBodyLength: Infinity,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
      });
      if (response?.data?.ok) {
        return true;
      }
      throw new Error(response?.data?.description || 'Unknown Telegram voice error');
    } catch (error) {
      console.error('Failed to send voice summary:', error.message);
      if (this.db && this.db.logServiceHealth && options.callSid) {
        await this.db.logServiceHealth('telegram_delivery', 'failed', {
          call_sid: options.callSid,
          error: error.message,
          type: 'voice_summary'
        });
      }
      return false;
    }
  }

  async sendCallSummaryCard(callSid, telegramChatId) {
    try {
      const call = await this.db.getCall(callSid);
      if (!call) {
        return false;
      }

      const analysis = this.parseJsonSafely(call.ai_analysis, {});
      const structured = analysis?.smart_summary || analysis?.smartSummary || {};
      const summaryText = call.call_summary || structured.summary || 'Summary not available yet.';
      const safeSummaryText = this.maskSensitiveDigits(summaryText);

      const transcripts = await this.db.getCallTranscripts(callSid);
      const confidence = this.computeConfidence(structured, transcripts, call);

      const message = this.renderSummaryCard(call, structured, summaryText, confidence);
      await this.sendTelegramMessage(
        telegramChatId,
        message,
        true,
        null,
        { priority: true, callSid: callSid, fallbackText: `Call ${callSid.slice(-6)} summary: ${safeSummaryText.slice(0, 180)}`, replyTo: this.getThreadMessageId(callSid) }
      );

      const hasStructured = structured && Object.keys(structured).length > 0;
      const includeTranscript = structured.attachments?.include_transcript !== false;
      const includeJson = hasStructured && structured.attachments?.include_json !== false;

      if (includeTranscript) {
        if (transcripts && transcripts.length) {
          const transcriptLines = transcripts.map((entry) => {
            const ts = entry.timestamp ? new Date(entry.timestamp).toISOString() : null;
            const speaker = entry.speaker === 'user' ? 'Customer' : 'AI';
            const maskedMessage = this.maskSensitiveDigits(entry.message);
            return `${ts ? `[${ts}] ` : ''}${speaker}: ${maskedMessage}`;
          });
          const transcriptContent = transcriptLines.join('\n');
          await this.sendTelegramDocument(
            telegramChatId,
            `call-${callSid}-transcript.txt`,
            transcriptContent,
            'text/plain',
            this.getThreadMessageId(callSid)
          );
        }
      }

      if (includeJson) {
        const scrubbedStructured = hasStructured
          ? JSON.parse(JSON.stringify(structured, (key, value) => {
              if (typeof value === 'string') {
                return this.maskSensitiveDigits(value);
              }
              return value;
            }))
          : null;

        const summaryPayload = {
          call_sid: callSid,
          summary: scrubbedStructured,
          call_summary: safeSummaryText,
          raw_summary: analysis?.smart_summary_raw ? this.maskSensitiveDigits(analysis.smart_summary_raw) : null,
          generated_at: structured?.generated_at || new Date().toISOString()
        };
        await this.sendTelegramDocument(
          telegramChatId,
          `call-${callSid}-summary.json`,
          JSON.stringify(summaryPayload, null, 2),
          'application/json',
          this.getThreadMessageId(callSid)
        );
      }

      // Optional: send a voice note summary to delight the operator
      const voiceText = this.buildVoiceSummaryText(structured, safeSummaryText);
      const voiceBuffer = await this.generateVoiceSummaryAudio(voiceText);
      if (voiceBuffer) {
        await this.sendTelegramVoice(
          telegramChatId,
          voiceBuffer,
          `Call ${callSid.slice(-6)} summary`,
          { priority: true, callSid: callSid, replyTo: this.getThreadMessageId(callSid) }
        );
      }

      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_summary', true);
      }

      return true;
    } catch (error) {
      console.error('Failed to send call summary card:', error);
      
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_summary', false);
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
        case 'call_ringing':
          success = await this.sendCallStatusUpdate(call_sid, 'in-progress', telegram_chat_id);
          break;
        case 'call_answered':
          success = await this.sendCallStatusUpdate(call_sid, 'answered', telegram_chat_id);
          break;
        case 'call_in_progress':
          success = await this.sendCallStatusUpdate(call_sid, 'in-progress', telegram_chat_id);
          break;
        case 'call_completed':
          const callDetails = await this.db.getCall(call_sid);
          success = await this.sendCallStatusUpdate(call_sid, 'completed', telegram_chat_id, { 
            duration: callDetails?.duration 
          });
          break;
        case 'call_alert': {
          const callDetails = await this.db.getCall(call_sid);
          const analysis = this.parseJsonSafely(callDetails?.ai_analysis, {});
          const firstAlert = Array.isArray(analysis?.alerts) && analysis.alerts.length ? analysis.alerts[0] : null;
          if (this.isCallAlertMuted(call_sid)) {
            console.log(`🔕 Alerts muted for ${call_sid}; skipping alert delivery`);
            success = true;
            break;
          }
          const message = this.renderAlertMessage(firstAlert || {}, callDetails || {});
          const kb = this.buildAlertKeyboard(call_sid);
          success = await this.sendTelegramMessage(
            telegram_chat_id,
            message,
            false,
            kb,
            { priority: true, callSid: call_sid, fallbackText: `Alert for call ${call_sid.slice(-6)}: ${firstAlert?.reason || 'check call'}` }
          );
          break;
        }
        case 'call_summary':
          success = await this.sendCallSummaryCard(call_sid, telegram_chat_id);
          break;
        case 'call_transcript':
          success = await this.sendCallTranscript(call_sid, telegram_chat_id);
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
        case 'call_no-answer': {
          const noAnswerCall = await this.db.getCall(call_sid);
          success = await this.sendCallStatusUpdate(call_sid, 'no-answer', telegram_chat_id, {
            ring_duration: noAnswerCall?.ring_duration
          });
          if (success) {
            await this.sendCallStatusUpdate(call_sid, 'ended', telegram_chat_id);
          }
          break;
        }
        case 'call_canceled':
          success = await this.sendCallStatusUpdate(call_sid, 'canceled', telegram_chat_id);
          break;
        default:
          console.warn(`â ï¸ Unknown notification type: ${notification_type}`.yellow);
          success = await this.sendCallStatusUpdate(call_sid, notification_type.replace('call_', ''), telegram_chat_id);
      }

      if (success) {
        await this.db.updateEnhancedWebhookNotification(id, 'sent', null, null);
        console.log(`â Processed enhanced notification ${id} (${notification_type})`.green);
      } else {
        throw new Error('Failed to send notification');
      }

    } catch (error) {
      console.error(`â Failed to send notification ${id}:`, error.message);
      await this.db.updateEnhancedWebhookNotification(id, 'failed', error.message, null);
      
      // For critical failures, try to send error notification to user
      if (['call_failed', 'call_transcript'].includes(notification_type)) {
        try {
          await this.sendTelegramMessage(telegram_chat_id, `â Error processing ${notification_type.replace('_', ' ')}`);
        } catch (errorNotificationError) {
          console.error('Failed to send error notification:', errorNotificationError);
        }
      }
    }
  }

  // Enhanced Telegram message sending with markdown support
  async sendTelegramMessage(chatId, message, enableMarkdown = false, replyMarkup = null, options = {}) {
    const payload = {
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    if (enableMarkdown) {
      payload.parse_mode = 'Markdown';
    }

    const replyTo = options.replyTo || options.reply_to_message_id;
    if (replyTo) {
      payload.reply_to_message_id = replyTo;
      payload.allow_sending_without_reply = true;
    }

    const meta = {
      priority: !!options.priority,
      callSid: options.callSid,
      fallbackText: options.fallbackText
    };

    return this.enqueueTelegram(chatId, payload, meta);
  }

  // Edit an existing Telegram message (used for live call console)
  async editTelegramMessage(chatId, messageId, newText, enableMarkdown = false, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${this.telegramBotToken}/editMessageText`;
    console.log('📝 Telegram edit request', { chatId, messageId });

    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: newText,
      disable_web_page_preview: true
    };

    if (replyMarkup) {
      payload.reply_markup = replyMarkup;
    }

    if (enableMarkdown) {
      payload.parse_mode = 'Markdown';
    }

    const response = await this.http.post(url, payload, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.data.ok) {
      throw new Error(`Telegram API error: ${response.data.description || 'Unknown error'}`);
    }

    return response.data;
  }

  /**
   * Initialize or return a live-call console message.
   * Creates a single Telegram message per call and then edits it in-place.
   */
  async ensureLiveCallConsole(callSid, chatId, meta = {}) {
    if (!this.telegramBotToken) return null;

    const existing = this.liveCalls.get(callSid);
    if (existing && existing.chatId === chatId && existing.messageId) {
      return existing;
    }

    const phoneNumber = meta.phoneNumber || 'Unknown';
    const header = `ð¢ Call started\nð ${phoneNumber}\n`;
    const body = `\nStatus: connectingâ¦\n\nâ`;
    const text = this.truncateTelegramText(header + body);

    const sent = await this.sendTelegramMessage(chatId, text, false);
    const messageId = sent?.result?.message_id;

    const state = {
      chatId,
      messageId,
      phoneNumber,
      phase: 'connecting',
      lastTurns: [],
      lastText: text,
      pendingText: null,
      lastEditAt: 0,
      editTimer: null
    };
    this.liveCalls.set(callSid, state);
    return state;
  }

  /**
   * Update the live-call console status and optionally append transcript turns.
   * This is debounced to avoid Telegram rate limits.
   */
  async updateLiveCallConsole(callSid, patch = {}) {
    const state = this.liveCalls.get(callSid);
    if (!state || !state.chatId || !state.messageId) return;

    if (patch.phase) state.phase = patch.phase;
    if (patch.turn) {
      this.appendLiveTurn(state, patch.turn.speaker, patch.turn.text);
    }

    const newText = this.renderLiveConsoleText(state);
    if (newText === state.lastText) return;

    // Debounce edits
    state.pendingText = newText;
    const now = Date.now();
    const elapsed = now - (state.lastEditAt || 0);

    const flush = async () => {
      const textToSend = state.pendingText;
      state.pendingText = null;
      state.editTimer = null;

      if (!textToSend || textToSend === state.lastText) return;

      try {
        await this.editTelegramMessage(state.chatId, state.messageId, textToSend, false);
        state.lastText = textToSend;
        state.lastEditAt = Date.now();
      } catch (err) {
        // If edit fails (e.g. message too old or deleted), fall back to sending a new message.
        try {
          const sent = await this.sendTelegramMessage(state.chatId, textToSend, false);
          const newMessageId = sent?.result?.message_id;
          if (newMessageId) state.messageId = newMessageId;
          state.lastText = textToSend;
          state.lastEditAt = Date.now();
        } catch (fallbackErr) {
          console.error('â Live console update failed:', fallbackErr.message);
        }
      }
    };

    if (elapsed >= this.liveEditMinIntervalMs) {
      await flush();
      return;
    }

    if (!state.editTimer) {
      state.editTimer = setTimeout(() => {
        flush().catch(() => {});
      }, this.liveEditMinIntervalMs - elapsed);
    }
  }

  endLiveCallConsole(callSid) {
    const state = this.liveCalls.get(callSid);
    if (!state) return;
    if (state.editTimer) clearTimeout(state.editTimer);
    state.editTimer = null;
    state.pendingText = null;
    // Keep it around briefly; caller can call cleanupCallData which will clear maps.
  }

  appendLiveTurn(state, speaker, text) {
    const safeText = (text || '').toString().trim();
    if (!safeText) return;

    const prefix = speaker === 'user' ? 'ð¤' : 'ð¤';
    // Keep lines compact; Telegram has limited room.
    const line = `${prefix} ${this.compactLine(safeText)}`;

    state.lastTurns.push(line);
    while (state.lastTurns.length > this.liveMaxTranscriptLines) {
      state.lastTurns.shift();
    }
  }

  renderLiveConsoleText(state) {
    const header = `ð¢ Call in progress\nð ${state.phoneNumber}`;
    const statusLine = `Status: ${this.humanPhase(state.phase)}`;
    const transcript = state.lastTurns.length
      ? `\n\n${state.lastTurns.join('\n')}`
      : `\n\nâ`;
    return this.truncateTelegramText(`${header}\n${statusLine}${transcript}`);
  }

  humanPhase(phase) {
    const map = {
      connecting: 'connectingâ¦',
      listening: 'listeningâ¦',
      thinking: 'thinkingâ¦',
      speaking: 'speakingâ¦',
      interrupted: 'interrupted',
      ended: 'ended'
    };
    return map[phase] || String(phase || '');
  }

  compactLine(s) {
    // Collapse whitespace and trim to keep the console readable.
    return s.replace(/\s+/g, ' ').trim();
  }

  truncateTelegramText(text) {
    const t = (text || '').toString();
    if (t.length <= this.liveMaxTextLength) return t;
    return t.slice(0, this.liveMaxTextLength - 1) + 'â¦';
  }

  // Debug method for troubleshooting
  async sendDebugInfo(call_sid, telegram_chat_id, webhookData) {
    try {
      const debugMessage = `ð *Debug Info* for Call ${call_sid.slice(-6)}:
      
ð *Status:* ${webhookData.CallStatus}
â±ï¸ *Duration:* ${webhookData.Duration || 'N/A'}
ð± *AnsweredBy:* ${webhookData.AnsweredBy || 'N/A'}
ð¢ *CallDuration:* ${webhookData.CallDuration || 'N/A'}
ð *DialDuration:* ${webhookData.DialCallDuration || 'N/A'}
â *Error:* ${webhookData.ErrorCode || 'None'}
ð *From:* ${webhookData.From || 'N/A'}
ð¯ *To:* ${webhookData.To || 'N/A'}`;

      await this.sendTelegramMessage(telegram_chat_id, debugMessage, true);
      return true;
    } catch (error) {
      console.error('Failed to send debug info:', error);
      return false;
    }
  }

  // Utility methods
  getStatusEmoji(status) {
    const statusEmojis = {
      'completed': '🔴',
      'failed': '❌',
      'busy': '⚠️',
      'no-answer': '❌',
      'canceled': '🚫',
      'answered': '🟢',
      'ringing': '📞',
      'initiated': '⏳',
      'in-progress': '📞',
      'ended': '🔴'
    };
    return statusEmojis[status] || '📱';
  }

  cleanMessageForTelegram(message) {
    // Clean up message for better Telegram display
    return message
      .replace(/[*_`\[\]()~>#+=|{}.!-]/g, '\\$&') // Escape markdown chars
      .replace(/â¢/g, '') // Remove TTS markers
      .trim();
  }

  escapeMarkdown(text = '') {
    return String(text).replace(/([_*\[\]()])/g, '\\$1');
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
      console.log(`ð§¹ Cleaned up ${callsToCleanup.length} old call records`.gray);
    }
  }

  cleanupCallData(callSid) {
    this.activeCallStatus.delete(callSid);
    this.callTimestamps.delete(callSid);
  }

  // Enhanced immediate status update with better error handling
  async sendImmediateStatus(call_sid, status, telegram_chat_id) {
    try {
      return await this.sendCallStatusUpdate(call_sid, status, telegram_chat_id);
    } catch (error) {
      console.error(`â Failed to send immediate status for ${call_sid}:`, error);
      // Try to send a generic notification
      try {
        await this.sendTelegramMessage(telegram_chat_id, `ð± Call ${call_sid.slice(-6)} status: ${status}`);
        return true;
      } catch (fallbackError) {
        console.error(`â Fallback notification also failed:`, fallbackError);
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
    console.log(`ð§ª Testing notification: ${status} for call ${call_sid}`.blue);
    
    try {
      const success = await this.sendCallStatusUpdate(call_sid, status, telegram_chat_id);
      console.log(`ð§ª Test result: ${success ? 'SUCCESS' : 'FAILED'}`.cyan);
      return success;
    } catch (error) {
      console.error(`ð§ª Test failed:`, error);
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
module.exports = { webhookService: enhancedWebhookService, EnhancedWebhookService };
