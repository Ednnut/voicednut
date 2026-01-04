const axios = require('axios');
const config = require('../config');

class EnhancedWebhookService {
  constructor() {
    this.isRunning = false;
    this.interval = null;
    this.db = null;
    this.telegramBotToken = config.telegram.botToken;
    this.processInterval = 3000; // Check every 3 seconds for faster updates
    this.activeCallStatus = new Map(); // Track call status to avoid duplicates
    this.callTimestamps = new Map(); // Track call timing for better status management
    this.noRingTimers = new Map(); // Track no-ring detection timers
    this.webhookStatusSeen = new Map(); // Track real webhook status arrival
    this.noRingTimeoutMs = 25000;
    this.statusOrder = [
      'queued',
      'initiated',
      'in-progress',
      'ringing',
      'answered',
      'completed',
      'busy',
      'no-answer',
      'failed',
      'canceled',
      'ended'
    ];
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
    this.callTimestamps.clear();
    this.noRingTimers.forEach((timer) => clearTimeout(timer));
    this.noRingTimers.clear();
    this.webhookStatusSeen.clear();
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

  normalizeStatus(status) {
    if (!status) return '';
    const normalized = String(status).toLowerCase();
    if (normalized === 'no_answer') return 'no-answer';
    if (normalized === 'in_progress') return 'in-progress';
    return normalized;
  }

  // Enhanced call status update with proper no-answer detection
  async sendCallStatusUpdate(call_sid, status, telegram_chat_id, additionalData = {}) {
    try {
      // Check if we should send this status
      if (!this.shouldSendStatus(call_sid, status)) {
        return true; // Return success to mark notification as processed
      }

      const normalizedStatus = this.normalizeStatus(status);
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
          message = 'Calling...';
          if (!callTiming.initiated) {
            callTiming.initiated = new Date();
          }
          this.scheduleNoRingCheck(call_sid, telegram_chat_id);
          break;
          
        case 'in-progress':
          emoji = '📞';
          message = 'Calling...';
          if (!callTiming.inProgress) {
            callTiming.inProgress = new Date();
          }
          this.scheduleNoRingCheck(call_sid, telegram_chat_id);
          break;

        case 'ringing':
          emoji = '🔔';
          message = 'Ringing...';
          if (!callTiming.ringing) {
            callTiming.ringing = new Date();
          }
          this.clearNoRingTimer(call_sid);
          // Calculate time to ring
          if (callTiming.initiated) {
            const ringDelay = ((new Date() - callTiming.initiated) / 1000).toFixed(1);
            if (ringDelay > 2) {
              message += ` (${ringDelay}s)`;
            }
          }
          break;
          
        case 'answered':
          emoji = '✅';
          message = 'Call answered';
          if (!callTiming.answered) {
            callTiming.answered = new Date();
          }
          this.clearNoRingTimer(call_sid);
          // Calculate ring duration
          if (callTiming.ringing) {
            const ringDuration = ((new Date() - callTiming.ringing) / 1000).toFixed(0);
            message += ` (rang ${ringDuration}s)`;
          }
          break;
          
        case 'completed':
          emoji = '🔴';
          if (!callTiming.completed) {
            callTiming.completed = new Date();
          }
          this.clearNoRingTimer(call_sid);
          
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
          this.clearNoRingTimer(call_sid);
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
          emoji = '❌';
          message = 'No-answered';
          this.clearNoRingTimer(call_sid);
          
          // Enhanced no-answer timing calculation
          let ringTime = 0;
          
          if (additionalData.ring_duration) {
            // Use ring duration from database if available
            ringTime = additionalData.ring_duration;
            console.log(`📞 Using database ring duration: ${ringTime}s`.cyan);
          } else if (callTiming.ringing) {
            // Calculate from our timing data
            ringTime = Math.round((new Date() - callTiming.ringing) / 1000);
            console.log(`📞 Calculated ring duration: ${ringTime}s`.cyan);
          } else if (callTiming.initiated) {
            // Fall back to total time since call started
            ringTime = Math.round((new Date() - callTiming.initiated) / 1000);
            console.log(`📞 Using total call time: ${ringTime}s`.cyan);
          }
          
          if (ringTime > 0) {
            message += ` (rang ${ringTime}s)`;
          }
          
          console.log(`📞 No-answer notification: ${message}`.yellow);
          break;
          
        case 'failed':
          emoji = '❌';
          message = 'Call failed';
          this.clearNoRingTimer(call_sid);
          if (additionalData.error || additionalData.error_message) {
            const errorMsg = additionalData.error || additionalData.error_message;
            message += ` (${errorMsg})`;
          }
          break;
          
        case 'canceled':
          emoji = '🚫';
          message = 'Call canceled';
          this.clearNoRingTimer(call_sid);
          break;

        case 'ended':
          emoji = '🔴';
          message = 'Call ended';
          this.clearNoRingTimer(call_sid);
          break;
          
        default:
          emoji = '📱';
          message = `Call ${status}`;
      }

      const fullMessage = `${emoji} ${message}`;

      await this.sendTelegramMessage(telegram_chat_id, fullMessage);
      console.log(`✅ Sent enhanced status update: ${normalizedStatus} for call ${call_sid}`.green);
      
      // Log notification metric
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric(`call_${normalizedStatus}`, true);
      }

      // Schedule cleanup for terminal states
      if (['completed', 'failed', 'no-answer', 'busy', 'canceled', 'ended'].includes(normalizedStatus)) {
        setTimeout(() => {
          this.cleanupCallData(call_sid);
        }, 5 * 60 * 1000); // Cleanup after 5 minutes
      }

      return true;
    } catch (error) {
      console.error('❌ Failed to send enhanced call status update:', error);
      
      // Log failed notification metric
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric(`call_${status.toLowerCase()}`, false);
      }
      
      return false;
    }
  }

  scheduleNoRingCheck(call_sid, telegram_chat_id) {
    if (this.noRingTimers.has(call_sid)) return;
    const startedAt = Date.now();
    const timer = setTimeout(async () => {
      this.noRingTimers.delete(call_sid);
      if (this.webhookStatusSeen.get(call_sid)) {
        return;
      }
      const statusInfo = this.activeCallStatus.get(call_sid);
      const lastStatus = statusInfo?.lastStatus;
      if (!['queued', 'initiated', 'in-progress'].includes(lastStatus)) {
        return;
      }
      const callTiming = this.callTimestamps.get(call_sid);
      if (callTiming?.ringing || callTiming?.answered) {
        return;
      }

      if (this.db?.getCall) {
        try {
          const call = await this.db.getCall(call_sid);
          const persisted = this.normalizeStatus(call?.twilio_status || call?.status);
          if (['ringing', 'answered', 'completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(persisted)) {
            return;
          }
        } catch {
          // best-effort; continue with timeout handling
        }
      }

      if (Date.now() - startedAt < this.noRingTimeoutMs) {
        return;
      }

      await this.sendCallStatusUpdate(call_sid, 'failed', telegram_chat_id, {
        error_message: 'Number not reachable'
      });
      await this.sendCallStatusUpdate(call_sid, 'ended', telegram_chat_id);
    }, this.noRingTimeoutMs);
    this.noRingTimers.set(call_sid, timer);
  }

  clearNoRingTimer(call_sid) {
    const timer = this.noRingTimers.get(call_sid);
    if (timer) {
      clearTimeout(timer);
      this.noRingTimers.delete(call_sid);
    }
  }

  // Enhanced transcript sending with better formatting
  async sendCallTranscript(call_sid, telegram_chat_id) {
    try {
      const callDetails = await this.db.getCall(call_sid);
      const transcripts = await this.db.getCallTranscripts(call_sid);
      
      if (!callDetails || !transcripts || transcripts.length === 0) {
        await this.sendTelegramMessage(telegram_chat_id, '📋 No transcript available for this call');
        return true;
      }

      // Enhanced transcript header with call details
      let message = `📋 *Call Transcript*\n\n`;
      
      // Call information
      message += `📞 *Phone:* ${callDetails.phone_number}\n`;
      
      // Enhanced duration display
      if (callDetails.duration && callDetails.duration > 0) {
        const minutes = Math.floor(callDetails.duration / 60);
        const seconds = callDetails.duration % 60;
        message += `⏱️ *Duration:* ${minutes}:${String(seconds).padStart(2, '0')}\n`;
      }
      
      // Call timing if available
      if (callDetails.started_at && callDetails.ended_at) {
        const startTime = new Date(callDetails.started_at).toLocaleTimeString();
        message += `🕐 *Time:* ${startTime}\n`;
      }
      
      message += `💬 *Messages:* ${transcripts.length}\n`;
      
      // Add status info with proper emoji
      if (callDetails.status) {
        const statusEmoji = this.getStatusEmoji(callDetails.status);
        message += `📊 *Status:* ${statusEmoji} ${callDetails.status}\n`;
      }
      
      message += `\n*Conversation:*\n`;
      message += `${'─'.repeat(25)}\n`;

      // Process conversation with better formatting
      const maxMessages = 12; // Show more messages
      let conversationLength = 0;
      
      for (let i = 0; i < Math.min(transcripts.length, maxMessages); i++) {
        const t = transcripts[i];
        const speaker = t.speaker === 'user' ? '👤 *Customer*' : '🤖 *AI*';
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
        message += `\n📝 *Summary:* ${callDetails.call_summary}`;
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

      console.log(`✅ Sent enhanced transcript for call ${call_sid}`.green);
      
      // Log transcript metric
      if (this.db && this.db.logNotificationMetric) {
        await this.db.logNotificationMetric('call_transcript', true);
      }
      
      return true;
      
    } catch (error) {
      console.error('❌ Failed to send enhanced call transcript:', error);
      
      // Log failed transcript metric
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

  // Process individual notification with enhanced error handling
  async sendNotification(notification) {
    const { id, call_sid, notification_type, telegram_chat_id, phone_number } = notification;

    try {
      let success = false;
      this.webhookStatusSeen.set(call_sid, true);

      switch (notification_type) {
        case 'call_initiated':
        case 'call_queued':
          success = await this.sendCallStatusUpdate(call_sid, 'in-progress', telegram_chat_id);
          break;
        case 'call_ringing':
          success = await this.sendCallStatusUpdate(call_sid, 'ringing', telegram_chat_id);
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
          if (success) {
            await this.sendCallStatusUpdate(call_sid, 'ended', telegram_chat_id);
          }
          break;
        case 'call_transcript':
          success = await this.sendCallTranscript(call_sid, telegram_chat_id);
          break;
        case 'call_failed':
          const failedCall = await this.db.getCall(call_sid);
          success = await this.sendCallStatusUpdate(call_sid, 'failed', telegram_chat_id, { 
            error_message: failedCall?.error_message 
          });
          if (success) {
            await this.sendCallStatusUpdate(call_sid, 'ended', telegram_chat_id);
          }
          break;
        case 'call_busy':
          success = await this.sendCallStatusUpdate(call_sid, 'busy', telegram_chat_id);
          if (success) {
            await this.sendCallStatusUpdate(call_sid, 'ended', telegram_chat_id);
          }
          break;
        case 'call_no_answer':
        case 'call_no-answer':
          const noAnswerCall = await this.db.getCall(call_sid);
          success = await this.sendCallStatusUpdate(call_sid, 'no-answer', telegram_chat_id, {
            ring_duration: noAnswerCall?.ring_duration
          });
          if (success) {
            await this.sendCallStatusUpdate(call_sid, 'ended', telegram_chat_id);
          }
          break;
        case 'call_canceled':
          success = await this.sendCallStatusUpdate(call_sid, 'canceled', telegram_chat_id);
          if (success) {
            await this.sendCallStatusUpdate(call_sid, 'ended', telegram_chat_id);
          }
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
      if (['call_failed', 'call_transcript'].includes(notification_type)) {
        try {
          await this.sendTelegramMessage(telegram_chat_id, `❌ Error processing ${notification_type.replace('_', ' ')}`);
        } catch (errorNotificationError) {
          console.error('Failed to send error notification:', errorNotificationError);
        }
      }
    }
  }

  // Enhanced Telegram message sending with markdown support
  async sendTelegramMessage(chatId, message, enableMarkdown = false) {
    const url = `https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`;
    
    const payload = {
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true
    };

    if (enableMarkdown) {
      payload.parse_mode = 'Markdown';
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

  // Debug method for troubleshooting
  async sendDebugInfo(call_sid, telegram_chat_id, webhookData) {
    try {
      const debugMessage = `🔍 *Debug Info* for Call ${call_sid.slice(-6)}:
      
📊 *Status:* ${webhookData.CallStatus}
⏱️ *Duration:* ${webhookData.Duration || 'N/A'}
📱 *AnsweredBy:* ${webhookData.AnsweredBy || 'N/A'}
🔢 *CallDuration:* ${webhookData.CallDuration || 'N/A'}
📞 *DialDuration:* ${webhookData.DialCallDuration || 'N/A'}
❌ *Error:* ${webhookData.ErrorCode || 'None'}
🔗 *From:* ${webhookData.From || 'N/A'}
🎯 *To:* ${webhookData.To || 'N/A'}`;

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

  cleanMessageForTelegram(message) {
    // Clean up message for better Telegram display
    return message
      .replace(/[*_`\[\]()~>#+=|{}.!-]/g, '\\$&') // Escape markdown chars
      .replace(/•/g, '') // Remove TTS markers
      .trim();
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
